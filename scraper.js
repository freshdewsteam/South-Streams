/**
 * scraper.js - Complete Working Version
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
  CACHE_TTL: parseInt(process.env.CACHE_TTL) || 30 * 24 * 60 * 60 * 1000,
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
  RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 1000,
  GLOBAL_TIMEOUT: parseInt(process.env.GLOBAL_TIMEOUT) || 300000,
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
    const entries = Array.from(memoryCache.entries());
    const data = JSON.stringify(entries, null, 2);
    fs.writeFileSync(tempFile, data);
    fs.renameSync(tempFile, CONFIG.CACHE_FILE);
    console.log(`[Cache] Saved ${memoryCache.size} entries to disk`);
    cacheDirty = false;
  } catch (e) {
    console.warn('[Cache] Failed to save cache:', e.message);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (unlinkErr) {}
    }
  }
}

function getCacheKey(title, type, langCode) {
  const clean = title
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${clean}|${type}|${langCode}`;
}

function getCachedResult(key) {
  if (!CONFIG.ENABLE_CACHE) return null;
  const entry = memoryCache.get(key);
  if (!entry) return null;
  
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
  
  if (memoryCache.size >= CONFIG.MAX_CACHE_SIZE) {
    const toRemove = Math.floor(CONFIG.MAX_CACHE_SIZE * 0.2);
    const keys = Array.from(memoryCache.keys());
    for (let i = 0; i < Math.min(toRemove, keys.length); i++) {
      memoryCache.delete(keys[i]);
    }
    console.log(`[Cache] Removed ${Math.min(toRemove, keys.length)} oldest entries`);
  }
  
  memoryCache.set(key, {
    timestamp: Date.now(),
    data: data
  });
  cacheDirty = true;
}

// ── URLS ──────────────────────────────────────────────────────────────────────
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
// ── RATE LIMITING ─────────────────────────────────────────────────────────────
let requestCount = 0;
let lastReset = Date.now();
const RATE_LIMIT = 45;
const RATE_WINDOW = 10000;

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
    console.log(`[RateLimit] Waiting ${waitTime}ms...`);
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br',
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
      console.log(`[Fetch] Attempt ${attempt}/${retries}: ${url.substring(0, 50)}...`);
      const result = await fetchRaw(url, timeoutMs);
      
      if (url.includes('cinebuds.com') || url.includes('keralatv.in')) {
        if (!result.includes('<table') && !result.includes('table')) {
          throw new Error('Response missing table structure');
        }
        if (result.length < 1000) {
          throw new Error(`Response too small (${result.length} chars)`);
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
// ── DATE LOGIC ────────────────────────────────────────────────────────────────
function parseDate(str) {
  if (!str) return null;
  if (/soon|tba|tbd|upcoming|expected|coming soon/i.test(str)) return null;
  
  str = str.replace(/\s*\(.*?\)/g, '').trim();
  
  const indianDate = str.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i);
  if (indianDate) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, 
                     jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const d = new Date(parseInt(indianDate[3]), months[indianDate[2].toLowerCase()], parseInt(indianDate[1]));
    if (!isNaN(d.getTime())) return d;
  }
  
  const monthDayYear = str.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (monthDayYear) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, 
                     jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const d = new Date(parseInt(monthDayYear[3]), months[monthDayYear[1].toLowerCase()], parseInt(monthDayYear[2]));
    if (!isNaN(d.getTime())) return d;
  }
  
  const dmY = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmY) {
    const d = new Date(parseInt(dmY[3]), parseInt(dmY[2]) - 1, parseInt(dmY[1]));
    if (!isNaN(d.getTime())) return d;
  }
  
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function isAlreadyReleased(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;
  return d <= new Date();
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
  
  const cleaned = base.replace(/\b(malayalam|tamil|hindi|telugu|kannada)\b/gi, '').trim();
  if (cleaned !== base) variants.add(cleaned);

  return Array.from(variants).filter(v => v.length >= 2);
                       }
// ── TMDB SEARCH ──────────────────────────────────────────────────────────────
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
        console.log('[OMDb] Language mismatch for "' + variant + '"');
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
// ── RESOLVE IMDB ID ──────────────────────────────────────────────────────────
async function resolveImdbId(title, type, langCode) {
  const cacheKey = getCacheKey(title, type, langCode);
  
  const cached = getCachedResult(cacheKey);
  if (cached !== null && cached !== undefined) {
    if (cached === 'not_found') {
      console.log(`[Cache Hit] "${title}" -> not found`);
      return null;
    }
    console.log(`[Cache Hit] "${title}" -> ${cached.imdbId}`);
    return cached;
  }

  console.log(`[Resolve] Looking up "${title}"...`);
  
  let result = await searchTMDB(title, type, langCode);

  if (!result && CONFIG.ENABLE_OMDB) {
    console.log('[OMDb] Trying fallback for "' + title + '"...');
    result = await searchOMDb(title, type, langCode);
  }

  if (result && result.imdbId && !result.poster && CONFIG.TMDB_KEY) {
    console.log('[TMDB/find] Looking up poster for ' + result.imdbId);
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
    console.log(`[Resolve] No IMDb ID for "${title}"`);
    setCacheResult(cacheKey, 'not_found');
  }

  return result;
}

// ── CONCURRENT PROCESSING ────────────────────────────────────────────────────
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
        console.error(`[Concurrency] Error: ${e.message}`);
      } finally {
        activeCount--;
        processNext();
      }
    }
    
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      processNext();
    }
  });
                                 }
t
// ── BUILD METAS ──────────────────────────────────────────────────────────────
async function buildMetas(items, type, langCode) {
  const processor = async (item) => {
    const imdb = await resolveImdbId(item.title, type, langCode);
    if (!imdb || !imdb.imdbId) return null;

    let desc = '';
    if (imdb.overview) desc += imdb.overview + '\n\n';
    desc += '📺 Streaming on: ' + item.platform + '\n';
    desc += '📅 OTT Release: ' + item.releaseDate;
    if (imdb.rating) desc += '\n⭐ Rating: ' + imdb.rating + '/10';

    const meta = {
      id: imdb.imdbId,
      type,
      name: item.title,
      releaseInfo: imdb.year || item.releaseDate,
      description: desc.trim(),
      poster: imdb.poster || undefined,
      background: imdb.backdrop || undefined,
      genres: imdb.genres && imdb.genres.length ? imdb.genres : undefined,
    };

    Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);
    return meta;
  };

  console.log(`[Build] Processing ${items.length} items with concurrency ${CONFIG.CONCURRENCY}`);
  const metas = await processWithConcurrency(items, processor, CONFIG.CONCURRENCY);
  
  console.log('[scraper] Done: ' + metas.length + ' items with valid IMDb IDs');
  return metas;
}

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
async function healthCheck() {
  console.log('[Health] Running health checks...');
  const issues = [];
  
  if (CONFIG.TMDB_KEY) {
    try {
      const test = await fetchJson(
        'https://api.themoviedb.org/3/movie/550?api_key=' + CONFIG.TMDB_KEY
      );
      if (test && test.id === 550) {
        console.log('[Health] ✅ TMDB API is working');
      } else {
        issues.push('TMDB API returned unexpected response');
      }
    } catch (e) {
      issues.push(`TMDB API error: ${e.message}`);
    }
  } else {
    console.warn('[Health] ⚠️ TMDB_API_KEY not set');
  }
  
  if (CONFIG.OMDB_KEY && CONFIG.ENABLE_OMDB) {
    try {
      const test = await fetchJson(
        'https://www.omdbapi.com/?apikey=' + CONFIG.OMDB_KEY + '&t=Inception'
      );
      if (test && test.Response === 'True') {
        console.log('[Health] ✅ OMDb API is working');
      } else {
        issues.push('OMDb API returned unexpected response');
      }
    } catch (e) {
      issues.push(`OMDb API error: ${e.message}`);
    }
  }
  
  const sources = [
    { name: 'Cinebuds Malayalam', url: CINEBUDS_MAL },
    { name: 'Cinebuds Tamil', url: CINEBUDS_TAM },
    { name: 'KeralaTV', url: KERALATV_URL },
  ];
  
  for (const source of sources) {
    try {
      const html = await fetchRawWithRetry(source.url, 10000, 1);
      if (html.includes('<table') || html.includes('table')) {
        console.log(`[Health] ✅ ${source.name} is accessible`);
      } else {
        issues.push(`${source.name} returned no table structure`);
      }
    } catch (e) {
      issues.push(`${source.name} error: ${e.message}`);
    }
  }
  
  if (issues.length > 0) {
    console.warn('[Health] ⚠️ Issues found:', issues.join(', '));
  } else {
    console.log('[Health] ✅ All health checks passed');
  }
  
  return issues;
}

// ── SCRAPE FUNCTIONS ──────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  loadCache();
  
  if (CONFIG.RUN_HEALTH_CHECK) {
    await healthCheck();
  }
  
  try {
    if (type === 'movie') {
      console.log('[scraper] Malayalam movies: fetching...');
      const [html1, html2] = await Promise.all([
        fetchRawWithRetry(CINEBUDS_MAL, CONFIG.REQUEST_TIMEOUT),
        fetchRawWithRetry(KERALATV_URL, CONFIG.REQUEST_TIMEOUT),
      ]);
      
      const items1 = parseCinebudsTable(html1);
      const items2 = parseKeralaTVTable(html2, 'movie');
      
      const combined = deduplicate(
        [...items1, ...items2].filter(i => isAlreadyReleased(i.releaseDate))
      );
      combined.sort((a, b) => {
        const da = parseDate(a.releaseDate);
        const db = parseDate(b.releaseDate);
        if (da && db) return db - da;
        return 0;
      });
      
      console.log(`[scraper] Malayalam movies: ${combined.length} released items`);
      const result = await buildMetas(combined.slice(0, CONFIG.MAX_ITEMS), 'movie', 'ml');
      saveCache();
      return result;
    } else {
      console.log('[scraper] Malayalam series: fetching...');
      const html = await fetchRawWithRetry(KERALATV_URL, CONFIG.REQUEST_TIMEOUT);
      const items = parseKeralaTVTable(html, 'series');
      const released = deduplicate(items.filter(i => isAlreadyReleased(i.releaseDate)));
      released.sort((a, b) => {
        const da = parseDate(a.releaseDate);
        const db = parseDate(b.releaseDate);
        if (da && db) return db - da;
        return 0;
      });
      
      console.log(`[scraper] Malayalam series: ${released.length} released items`);
      const result = await buildMetas(released.slice(0, CONFIG.MAX_ITEMS), 'series', 'ml');
      saveCache();
      return result;
    }
  } catch (e) {
    console.warn('[scraper] Malayalam ' + type + ' error:', e.message);
    saveCache();
    return [];
  }
}

async function scrapeTamil(type) {
  loadCache();
  
  if (CONFIG.RUN_HEALTH_CHECK) {
    await healthCheck();
  }
  
  try {
    if (type === 'movie') {
      console.log('[scraper] Tamil movies: fetching...');
      const html = await fetchRawWithRetry(CINEBUDS_TAM, CONFIG.REQUEST_TIMEOUT);
      const items = parseCinebudsTable(html);
      const released = deduplicate(items.filter(i => isAlreadyReleased(i.releaseDate)));
      released.sort((a, b) => {
        const da = parseDate(a.releaseDate);
        const db = parseDate(b.releaseDate);
        if (da && db) return db - da;
        return 0;
      });
      
      console.log(`[scraper] Tamil movies: ${released.length} released items`);
      const result = await buildMetas(released.slice(0, CONFIG.MAX_ITEMS), 'movie', 'ta');
      saveCache();
      return result;
    } else {
      console.log('[scraper] Tamil series: fetching...');
      const html = await fetchRawWithRetry(KERALATV_URL, CONFIG.REQUEST_TIMEOUT);
      const items = parseKeralaTVTable(html, 'series');
      const released = deduplicate(items.filter(i => isAlreadyReleased(i.releaseDate)));
      released.sort((a, b) => {
        const da = parseDate(a.releaseDate);
        const db = parseDate(b.releaseDate);
        if (da && db) return db - da;
        return 0;
      });
      
      console.log(`[scraper] Tamil series: ${released.length} released items`);
      const result = await buildMetas(released.slice(0, CONFIG.MAX_ITEMS), 'series', 'ta');
      saveCache();
      return result;
    }
  } catch (e) {
    console.warn('[scraper] Tamil ' + type + ' error:', e.message);
    saveCache();
    return [];
  }
}

module.exports = { scrapeMalayalam, scrapeTamil };
