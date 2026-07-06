/**
 * scraper.js - Complete Updated Version
 * 
 * Features:
 * - Retry logic with exponential backoff
 * - Persistent caching with size limits
 * - Concurrent request limiting
 * - Health checks
 * - Atomic cache writes
 * - Rate limiting for TMDB
 * - Multiple parsing strategies
 * - Timezone-aware date handling
 * - Batch cache saves
 * - Configurable via environment variables
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ── CONFIGURATION ─────────────────────────────────────────────────────────────
const CONFIG = {
  TMDB_KEY: process.env.TMDB_API_KEY || '',
  OMDB_KEY: process.env.OMDB_API_KEY || '',
  MAX_ITEMS: parseInt(process.env.MAX_ITEMS) || 50,
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT) || 45000,
  REQUEST_DELAY: parseInt(process.env.REQUEST_DELAY) || 250,
  CONCURRENCY: parseInt(process.env.CONCURRENCY) || 5,
  ENABLE_OMDB: process.env.ENABLE_OMDB !== 'false',
  ENABLE_CACHE: process.env.ENABLE_CACHE !== 'false',
  CACHE_FILE: process.env.CACHE_FILE || './data/cache.json',
  MAX_CACHE_SIZE: parseInt(process.env.MAX_CACHE_SIZE) || 500,
  CACHE_TTL: parseInt(process.env.CACHE_TTL) || 30 * 24 * 60 * 60 * 1000, // 30 days
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
  RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 1000,
  GLOBAL_TIMEOUT: parseInt(process.env.GLOBAL_TIMEOUT) || 300000, // 5 minutes
  RUN_HEALTH_CHECK: process.env.RUN_HEALTH_CHECK !== 'false',
};

// ── CACHE MANAGEMENT ──────────────────────────────────────────────────────────
let memoryCache = new Map();
let cacheFileLoaded = false;
let cacheDirty = false;

function loadCache() {
  if (!CONFIG.ENABLE_CACHE) return;
  
  try {
    const cacheDir = path.dirname(CONFIG.CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const data = fs.readFileSync(CONFIG.CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      // Convert array back to Map if needed
      if (Array.isArray(parsed)) {
        memoryCache = new Map(parsed);
      } else {
        memoryCache = new Map(Object.entries(parsed));
      }
      console.log(`[Cache] Loaded ${memoryCache.size} cached entries`);
    } else {
      console.log('[Cache] No existing cache file found, starting fresh');
    }
    cacheFileLoaded = true;
  } catch (e) {
    console.warn('[Cache] Failed to load cache:', e.message);
    memoryCache = new Map();
    cacheFileLoaded = true;
  }
}

function saveCache() {
  if (!CONFIG.ENABLE_CACHE || !cacheFileLoaded || !cacheDirty) return;
  
  const tempFile = CONFIG.CACHE_FILE + '.tmp';
  try {
    // Convert Map to array of entries for better serialization
    const entries = Array.from(memoryCache.entries());
    const data = JSON.stringify(entries, null, 2);
    
    // Atomic write: write to temp file then rename
    fs.writeFileSync(tempFile, data);
    fs.renameSync(tempFile, CONFIG.CACHE_FILE);
    console.log(`[Cache] Saved ${memoryCache.size} entries to disk`);
    cacheDirty = false;
  } catch (e) {
    console.warn('[Cache] Failed to save cache:', e.message);
    // Clean up temp file if it exists
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (unlinkErr) {}
    }
  }
}

function getCacheKey(title, type, langCode) {
  // Normalize the title for consistent caching
  const clean = title
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, '') // Remove year
    .replace(/[^a-z0-9\s]/g, '')      // Remove special characters
    .replace(/\s+/g, ' ')             // Normalize spaces
    .trim();
  return `${clean}|${type}|${langCode}`;
}

function getCachedResult(key) {
  if (!CONFIG.ENABLE_CACHE) return null;
  const entry = memoryCache.get(key);
  if (!entry) return null;
  
  // Check TTL
  if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
    console.log(`[Cache] Entry expired for key: ${key}`);
    memoryCache.delete(key);
    cacheDirty = true;
    return null;
  }
  
  return entry.data;
}

function setCacheResult(key, data) {
  if (!CONFIG.ENABLE_CACHE) return;
  
  // Limit cache size - keep only most recent entries
  if (memoryCache.size >= CONFIG.MAX_CACHE_SIZE) {
    // Remove oldest 20% of entries
    const toRemove = Math.floor(CONFIG.MAX_CACHE_SIZE * 0.2);
    const keys = Array.from(memoryCache.keys());
    for (let i = 0; i < Math.min(toRemove, keys.length); i++) {
      memoryCache.delete(keys[i]);
    }
    console.log(`[Cache] Removed ${Math.min(toRemove, keys.length)} oldest entries to maintain size limit`);
  }
  
  memoryCache.set(key, {
    timestamp: Date.now(),
    data: data
  });
  cacheDirty = true;
}

// ── DYNAMIC KERALATV URL ──────────────────────────────────────────────────────
function getKeralaTVUrl() {
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
  ];
  const now = new Date();
  return 'https://www.keralatv.in/' + months[now.getMonth()] + '-' + now.getFullYear() + '-ott-release-guide/';
}

const CINEBUDS_MAL = 'https://cinebuds.com/malayalam-movies-ott-release-dates/';
const CINEBUDS_TAM = 'https://cinebuds.com/tamil-movies-digital-release-dates/';
const KERALATV_URL = getKeralaTVUrl();

const LANG_CODE = {
  'mal-movie': 'ml', 'mal-series': 'ml',
  'tam-movie': 'ta', 'tam-series': 'ta',
};

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
let requestCount = 0;
let lastReset = Date.now();
const RATE_LIMIT = 45; // TMDB allows 50 per 10 seconds, leave buffer
const RATE_WINDOW = 10000; // 10 seconds

async function rateLimitedFetch(url) {
  if (!url.includes('themoviedb.org')) {
    return fetchJson(url);
  }
  
  const now = Date.now();
  if (now - lastReset > RATE_WINDOW) {
    requestCount = 0;
    lastReset = now;
  }
  
  if (requestCount >= RATE_LIMIT) {
    const waitTime = RATE_WINDOW - (now - lastReset);
    console.log(`[RateLimit] Waiting ${waitTime}ms to avoid TMDB rate limit...`);
    await new Promise(r => setTimeout(r, waitTime + 100));
    requestCount = 0;
    lastReset = Date.now();
  }
  
  requestCount++;
  return fetchJson(url);
}

// ── HTTP FETCH WITH RETRY ────────────────────────────────────────────────────
function fetchRaw(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
    };
    const req = lib.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchRaw(res.headers.location, timeoutMs).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error('HTTP ' + res.statusCode));

      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || CONFIG.REQUEST_TIMEOUT, function() {
      this.destroy();
      reject(new Error('Timeout after ' + timeoutMs + 'ms'));
    });
  });
}

async function fetchRawWithRetry(url, timeoutMs, retries = CONFIG.MAX_RETRIES) {
  let lastError;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Fetch] Attempt ${attempt}/${retries}: ${url}`);
      const result = await fetchRaw(url, timeoutMs);
      
      // Health check: Validate response contains expected content
      if (url.includes('cinebuds.com') || url.includes('keralatv.in')) {
        if (!result.includes('<table') && !result.includes('table')) {
          throw new Error('Response missing expected table structure');
        }
        if (result.length < 1000) {
          throw new Error(`Response too small (${result.length} chars) - likely error page`);
        }
      }
      
      return result;
    } catch (e) {
      lastError = e;
      console.warn(`[Fetch] Attempt ${attempt} failed: ${e.message}`);
      
      if (attempt < retries) {
        const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log(`[Fetch] Waiting ${delay}ms before retry...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  throw new Error(`Failed after ${retries} attempts: ${lastError.message}`);
}

function fetchJson(url) {
  return fetchRawWithRetry(url, 15000).then(t => JSON.parse(t));
}

// ── DATE LOGIC WITH TIMEZONE SUPPORT ────────────────────────────────────────
function parseDate(str) {
  if (!str) return null;
  if (/soon|tba|tbd|announced|upcoming|expected|expect|confirm|tentative|coming soon|awaiting/i.test(str)) return null;
  
  // Clean the string
  str = str.replace(/\s*\(.*?\)/g, '').trim();
  
  // Handle "DD Month YYYY" format (common in India)
  const indianDate = str.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i);
  if (indianDate) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, 
                     jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const d = new Date(parseInt(indianDate[3]), months[indianDate[2].toLowerCase()], parseInt(indianDate[1]));
    if (!isNaN(d.getTime())) return d;
  }
  
  // Handle "Month DD, YYYY" format
  const monthDayYear = str.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (monthDayYear) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, 
                     jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const d = new Date(parseInt(monthDayYear[3]), months[monthDayYear[1].toLowerCase()], parseInt(monthDayYear[2]));
    if (!isNaN(d.getTime())) return d;
  }
  
  // Handle "DD/MM/YYYY" or "DD-MM-YYYY"
  const dmY = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmY) {
    const d = new Date(parseInt(dmY[3]), parseInt(dmY[2]) - 1, parseInt(dmY[1]));
    if (!isNaN(d.getTime())) return d;
  }
  
  // Try standard date parsing as fallback
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function isAlreadyReleased(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;
  
  // Use IST timezone for comparison
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  
  return d <= istNow;
}

// ── TITLE VARIANTS ────────────────────────────────────────────────────────────
function getTitleVariants(raw) {
  const base = raw
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s*[-–]\s*(official|trailer|teaser|movie|film|review|reviews?|watch|online|full|hd|download)/i, '')
    .replace(/\s*[Ss]eason\s*\d+/, '')
    .replace(/\s*[Ss]\d{2}/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const variants = new Set();
  variants.add(base);
  if (base.includes(':')) variants.add(base.split(':')[0].trim());
  if (base.includes(' - ')) variants.add(base.split(' - ')[0].trim());
  const noThe = base.replace(/\b(the|a|an)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (noThe !== base) variants.add(noThe);
  
  // Remove Hindi/other language indicators for better matching
  const cleaned = base.replace(/\b(malayalam|tamil|hindi|telugu|kannada)\b/gi, '').trim();
  if (cleaned !== base) variants.add(cleaned);

  return Array.from(variants).filter(v => v.length >= 2);
}

// ── TMDB SEARCH BY TITLE ──────────────────────────────────────────────────────
async function searchTMDB(title, type, langCode) {
  if (!CONFIG.TMDB_KEY) return null;
  const endpoint = type === 'series' ? 'tv' : 'movie';

  for (const variant of getTitleVariants(title)) {
    try {
      const data = await rateLimitedFetch(
        'https://api.themoviedb.org/3/search/' + endpoint
        + '?api_key=' + CONFIG.TMDB_KEY
        + '&query=' + encodeURIComponent(variant)
        + '&language=en-US&page=1'
      );
      if (!data.results || data.results.length === 0) continue;

      let best = null, bestScore = -1;
      for (const r of data.results) {
        let score = 0;
        const rTitle = (r.title || r.name || '').toLowerCase();
        const vLow = variant.toLowerCase();

        if (rTitle === vLow) score += 60;
        else if (rTitle.startsWith(vLow)) score += 35;
        else if (rTitle.includes(vLow)) score += 20;

        if (r.original_language === langCode) score += 50;
        else if (r.original_language === 'en') score -= 30;
        else score -= 10;

        if (r.origin_country && r.origin_country.includes('IN')) score += 15;

        if (score > bestScore && score >= 50) { bestScore = score; best = r; }
      }

      if (!best) continue;

      const detail = await rateLimitedFetch(
        'https://api.themoviedb.org/3/' + endpoint + '/' + best.id
        + '?api_key=' + CONFIG.TMDB_KEY
      );

      if (!detail.imdb_id) continue;
      return buildTMDBResult(detail);
    } catch (e) {
      console.warn('[TMDB] Error for "' + variant + '": ' + e.message);
    }
  }
  return null;
}

// ── TMDB LOOKUP BY IMDB ID ────────────────────────────────────────────────────
async function findTMDBByImdbId(imdbId, type) {
  if (!CONFIG.TMDB_KEY || !imdbId) return null;
  try {
    const data = await rateLimitedFetch(
      'https://api.themoviedb.org/3/find/' + imdbId
      + '?api_key=' + CONFIG.TMDB_KEY
      + '&external_source=imdb_id'
    );
    const results = type === 'series'
      ? (data.tv_results || [])
      : (data.movie_results || []);

    if (results.length === 0) return null;

    const endpoint = type === 'series' ? 'tv' : 'movie';
    const detail = await rateLimitedFetch(
      'https://api.themoviedb.org/3/' + endpoint + '/' + results[0].id
      + '?api_key=' + CONFIG.TMDB_KEY
    );

    return buildTMDBResult(detail, imdbId);
  } catch (e) {
    console.warn('[TMDB/find] Error for ' + imdbId + ': ' + e.message);
    return null;
  }
}

function buildTMDBResult(detail, fallbackImdbId) {
  return {
    imdbId: detail.imdb_id || fallbackImdbId || null,
    poster: detail.poster_path ? 'https://image.tmdb.org/t/p/w500' + detail.poster_path : null,
    backdrop: detail.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + detail.backdrop_path : null,
    overview: detail.overview || null,
    rating: detail.vote_average ? detail.vote_average.toFixed(1) : null,
    year: (detail.release_date || detail.first_air_date || '').slice(0, 4) || null,
    genres: (detail.genres || []).map(g => g.name),
  };
}

// ── OMDB FALLBACK ─────────────────────────────────────────────────────────────
async function searchOMDb(title, type, langCode) {
  if (!CONFIG.OMDB_KEY || !CONFIG.ENABLE_OMDB) return null;
  const omdbType = type === 'series' ? 'series' : 'movie';
  const targetLang = langCode === 'ml' ? 'malayalam' : 'tamil';

  for (const variant of getTitleVariants(title)) {
    try {
      const data = await fetchJson(
        'https://www.omdbapi.com/?apikey=' + CONFIG.OMDB_KEY
        + '&t=' + encodeURIComponent(variant)
        + '&type=' + omdbType
      );
      if (!data || data.Response !== 'True' || !data.imdbID) continue;

      const lang = (data.Language || '').toLowerCase();
      if (lang && !lang.includes(targetLang) && !lang.includes('hindi')) {
        console.log('[OMDb] Language mismatch for "' + variant + '": ' + data.Language);
        continue;
      }

      return {
        imdbId: data.imdbID,
        poster: data.Poster !== 'N/A' ? data.Poster : null,
        backdrop: null,
        overview: data.Plot !== 'N/A' ? data.Plot : null,
        rating: data.imdbRating !== 'N/A' ? data.imdbRating : null,
        year: data.Year || null,
        genres: data.Genre && data.Genre !== 'N/A' ? data.Genre.split(', ') : [],
      };
    } catch (e) {
      console.warn('[OMDb] Error for "' + variant + '": ' + e.message);
    }
  }
  return null;
}

// ── RESOLVE IMDB ID WITH CACHE ──────────────────────────────────────────────
async function resolveImdbId(title, type, langCode) {
  const cacheKey = getCacheKey(title, type, langCode);
  
  // Check cache first
  const cached = getCachedResult(cacheKey);
  if (cached !== null && cached !== undefined) {
    if (cached === 'not_found') {
      console.log(`[Cache Hit] "${title}" -> not found (cached negative)`);
      return null;
    }
    console.log(`[Cache Hit] "${title}" -> ${cached.imdbId}`);
    return cached;
  }

  console.log(`[Resolve] Looking up "${title}" (${type}, ${langCode})`);
  
  let result = await searchTMDB(title, type, langCode);

  if (!result && CONFIG.ENABLE_OMDB) {
    console.log('[OMDb] Trying title fallback for "' + title + '"...');
    result = await searchOMDb(title, type, langCode);
  }

  // If OMDb found an IMDb ID but no poster, try TMDB /find for poster
  if (result && result.imdbId && !result.poster && CONFIG.TMDB_KEY) {
    console.log('[TMDB/find] Looking up poster for ' + result.imdbId + '...');
    const tmdbResult = await findTMDBByImdbId(result.imdbId, type);
    if (tmdbResult && tmdbResult.poster) {
      result.poster = tmdbResult.poster;
      result.backdrop = tmdbResult.backdrop;
      result.overview = result.overview || tmdbResult.overview;
    }
  }

  if (result) {
    console.log(`[Resolve] "${title}" -> ${result.imdbId}`);
    setCacheResult(cacheKey, result);
  } else {
    console.log(`[Resolve] No IMDb ID for "${title}" — excluding`);
    // Cache negative result to avoid repeated lookups
    setCacheResult(cacheKey, 'not_found');
  }

  return result;
}

// ── CONCURRENT REQUEST LIMITING ──────────────────────────────────────────────
async function processWithConcurrency(items, processor, concurrency = CONFIG.CONCURRENCY) {
  const results = [];
  const queue = [...items];
  let activeCount = 0;
  
  return new Promise((resolve) => {
    async function processNext() {
      if (queue.length === 0) {
        if (activeCount === 0) resolve(results);
        return;
      }
      
      const item = queue.shift();
      activeCount++;
      
      try {
        const result = await processor(item);
        if (result) results.push(result);
      } catch (e) {
        console.error(`[Concurrency] Error processing item: ${e.message}`);
      } finally {
        activeCount--;
        processNext(); // Process next item in queue
      }
    }
    
    // Start concurrency number of workers
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      workers.push(processNext());
    }
  });
}

// ── PARSE CINEBUDS TABLE WITH FALLBACKS ─────────────────────────────────────
function parseCinebudsTable(html) {
  let items = [];
  
  // Try primary parsing
  items = parseCinebudsPrimary(html);
  
  // If no items, try alternative method
  if (items.length === 0) {
    console.warn('[Parse] Primary parser failed, trying alternative');
    items = parseCinebudsAlternative(html);
  }
  
  return items;
}

function parseCinebudsPrimary(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('thead th, thead td').each((_, th) =>
      headers.push($(th).text().trim().toLowerCase())
    );
    if (headers.length 
