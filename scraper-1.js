/**
 * scraper.js - Full-Fledged Version with Multi-Source Poster Fetching
 * 
 * Features:
 * ✅ Movies from TMDB Discover API
 * ✅ Series from Google Sheet CSV
 * ✅ Title variations for better matching
 * ✅ Strict date filtering (future releases skipped)
 * ✅ Better error handling (keeps running if one part fails)
 * ✅ Alerts on failure (Discord/Telegram)
 * ✅ Retry failed items (not permanently skipped)
 * ✅ Split cache (movies/series separate)
 * ✅ Health check status
 * ✅ Rate limit handling
 * ✅ Placeholder posters for missing images
 * ✅ Multi-source poster fetching (TMDB → OMDb → IMDb → Wikipedia)
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

// ── CONFIGURATION ─────────────────────────────────────────────────────────────
const TMDB_KEY   = process.env.TMDB_API_KEY || '';
const OMDB_KEY   = process.env.OMDB_API_KEY || ''; // For fallback poster fetching
const SHEET_URL  = process.env.GOOGLE_SHEET_URL || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // Discord/Telegram webhook
const BASE       = 'https://api.themoviedb.org/3';
const IMG        = 'https://image.tmdb.org/t/p/';

// Separate cache files for movies and series
const MOVIE_CACHE_FILE = path.join(__dirname, '..', 'data', 'movies-cache.json');
const SERIES_CACHE_FILE = path.join(__dirname, '..', 'data', 'series-cache.json');

// Lookback windows for TMDB Discover
const MOVIE_LOOKBACK  = 30;
const MOVIE_FIRST_RUN = 730;

// ── CACHE MANAGEMENT ──────────────────────────────────────────────────────────
let movieCache = {};
let seriesCache = {};
let seen  = {};
let cacheDirty = false;

function loadCache() {
  try {
    // Load movies cache
    if (fs.existsSync(MOVIE_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MOVIE_CACHE_FILE, 'utf8'));
      movieCache = raw._data || {};
      seen = raw._seen || {};
      console.log('[Cache] Loaded ' + Object.keys(movieCache).length + ' movie entries');
    } else {
      console.log('[Cache] Fresh movie cache');
    }

    // Load series cache
    if (fs.existsSync(SERIES_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SERIES_CACHE_FILE, 'utf8'));
      seriesCache = raw._data || {};
      console.log('[Cache] Loaded ' + Object.keys(seriesCache).length + ' series entries');
    } else {
      console.log('[Cache] Fresh series cache');
    }
  } catch (e) {
    console.warn('[Cache] Load failed: ' + e.message);
    movieCache = {};
    seriesCache = {};
    seen = {};
  }
}

function saveCache() {
  if (!cacheDirty) return;
  try {
    const dir = path.dirname(MOVIE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Save movies
    fs.writeFileSync(MOVIE_CACHE_FILE, JSON.stringify({ _data: movieCache, _seen: seen }, null, 2));
    
    // Save series
    fs.writeFileSync(SERIES_CACHE_FILE, JSON.stringify({ _data: seriesCache }, null, 2));
    
    console.log('[Cache] Saved movies: ' + Object.keys(movieCache).length + ', series: ' + Object.keys(seriesCache).length);
    cacheDirty = false;
  } catch (e) {
    console.warn('[Cache] Save failed: ' + e.message);
  }
}

// ── ALERT SYSTEM ──────────────────────────────────────────────────────────────
async function sendAlert(message, isError = true) {
  const emoji = isError ? '🚨' : 'ℹ️';
  const fullMessage = emoji + ' ' + message;
  
  console.log('[Alert] ' + fullMessage);
  
  if (!WEBHOOK_URL) {
    console.log('[Alert] No webhook URL set - alert not sent');
    return;
  }

  try {
    const data = JSON.stringify({
      content: fullMessage,
      username: 'South Streams Scraper'
    });

    const req = https.request(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('[Alert] ✅ Sent successfully');
      } else {
        console.log('[Alert] Failed with status: ' + res.statusCode);
      }
    });
    req.on('error', (e) => console.log('[Alert] Request failed: ' + e.message));
    req.write(data);
    req.end();
  } catch (e) {
    console.log('[Alert] Failed to send: ' + e.message);
  }
}

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
function getHealthStatus() {
  const movieCount  = Object.values(movieCache).filter(v => v && !v._status && typeof v !== 'string' && v.type).length;
  const seriesCount = Object.values(seriesCache).filter(v => v && !v._status && typeof v !== 'string' && v.imdbId).length;
  const total = movieCount + seriesCount;
  
  const status = {
    timestamp: new Date().toISOString(),
    movies: movieCount,
    series: seriesCount,
    total: total,
    status: total > 0 ? '✅ OK' : '⚠️ No items found'
  };
  
  console.log('[Health] 📊 Status: ' + status.movies + ' movies, ' + status.series + ' series, ' + status.total + ' total');
  return status;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'SouthStreams/1.0',
        ...options.headers
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let s = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    s = res.pipe(zlib.createGunzip());
      if (enc === 'br')      s = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      const c = [];
      s.on('data', d => c.push(d));
      s.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
      s.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJson(url) {
  return fetchUrl(url).then(t => JSON.parse(t));
}

// ── RATE LIMITER ──────────────────────────────────────────────────────────────
let reqCount = 0, reqReset = Date.now();

async function tmdb(endpoint, retries = 3) {
  if (!TMDB_KEY) {
    await sendAlert('❌ TMDB_API_KEY not set!');
    throw new Error('TMDB_API_KEY not set');
  }

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const now = Date.now();
      if (now - reqReset > 10000) { reqCount = 0; reqReset = now; }
      
      if (reqCount >= 35) {
        const wait = 15100 - (now - reqReset);
        console.log('[Rate] Pausing ' + Math.ceil(wait / 1000) + 's...');
        await new Promise(r => setTimeout(r, wait));
        reqCount = 0; reqReset = Date.now();
      }
      
      reqCount++;
      const sep = endpoint.includes('?') ? '&' : '?';
      const url = BASE + endpoint + sep + 'api_key=' + TMDB_KEY;
      return await fetchJson(url);
    } catch (e) {
      lastError = e;
      console.warn('[TMDB] Attempt ' + attempt + ' failed: ' + e.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw new Error('TMDB failed after ' + retries + ' attempts: ' + lastError.message);
}

// ── DATE HELPERS ──────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Robust date parser — handles YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY,
// "15 Jun 2026", "June 15 2026", "15th June 2026"
const _MONTHS = {
  jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
  january:0,february:1,march:2,april:3,june:5,july:6,august:7,
  september:8,october:9,november:10,december:11
};

function parseAnyDate(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/soon|tba|tbd|upcoming|expected|coming/i.test(s)) return null;
  let m;
  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  // DD/MM/YYYY or DD-MM-YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  // "15 Jun 2026" or "15th Jun 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) { const mo = _MONTHS[m[2].toLowerCase()]; if (mo !== undefined) return new Date(+m[3], mo, +m[1]); }
  // "Jun 15, 2026" or "June 15 2026"
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) { const mo = _MONTHS[m[1].toLowerCase()]; if (mo !== undefined) return new Date(+m[3], mo, +m[2]); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isReleased(dateStr) {
  const d = parseAnyDate(dateStr);
  if (!d) return false;
  const now = new Date(); now.setHours(23, 59, 59, 999);
  return d <= now;
}

// ── TITLE VARIATIONS ──────────────────────────────────────────────────────────
function getTitleVariations(title) {
  const variations = new Set();
  variations.add(title);
  
  variations.add(title.replace(/\band\b/gi, '&'));
  variations.add(title.replace(/&/g, ' and '));
  variations.add(title.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
  variations.add(title.replace(/\s*\(\d{4}\)\s*$/, '').trim());
  variations.add(title.replace(/\s*[-–]\s*season\s*\d+/i, '').trim());
  variations.add(title.replace(/\s*[Ss]\d{2}/, '').trim());
  variations.add(title.replace(/^(the|a|an)\s+/i, '').trim());
  variations.add(title.replace(/\s+(series|show|tv|web series)$/i, '').trim());
  
  return Array.from(variations);
}

// ── MULTI-SOURCE POSTER FETCHER ──────────────────────────────────────────────
// Tries multiple sources to find a poster when TMDB fails
async function fetchPosterFromMultipleSources(title, imdbId, type) {
  let posterUrl = null;
  
  // Source 1: OMDb API using IMDb ID
  async function fromOMDbWithId() {
    if (!OMDB_KEY || !imdbId) return null;
    try {
      const url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&i=${imdbId}`;
      const data = await fetchJson(url);
      if (data && data.Response === 'True' && data.Poster && data.Poster !== 'N/A') {
        console.log('[Poster] Found on OMDb (via ID): ' + data.Poster);
        return data.Poster;
      }
      return null;
    } catch (e) {
      return null;
    }
  }
  
  // Source 2: OMDb API by title
  async function fromOMDbByTitle() {
    if (!OMDB_KEY) return null;
    try {
      const variations = getTitleVariations(title);
      for (const variant of variations.slice(0, 3)) {
        const searchTitle = encodeURIComponent(variant);
        const mediaType = type === 'series' ? 'series' : 'movie';
        const url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${searchTitle}&type=${mediaType}`;
        const data = await fetchJson(url);
        if (data && data.Response === 'True' && data.Poster && data.Poster !== 'N/A') {
          console.log('[Poster] Found on OMDb (by title): ' + data.Poster);
          return data.Poster;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }
  
  // Source 3: IMDb Direct (using IMDb's CDN)
  async function fromImdbDirect() {
    if (!imdbId) return null;
    try {
      // IMDb poster URL pattern
      const url = `https://img.omdbapi.com/?apikey=${OMDB_KEY || 'your_key'}&i=${imdbId}`;
      const data = await fetchJson(url);
      if (data && data.Poster && data.Poster !== 'N/A') {
        console.log('[Poster] Found via IMDb ID: ' + data.Poster);
        return data.Poster;
      }
      return null;
    } catch (e) {
      return null;
    }
  }
  
  // Source 4: Wikipedia (some shows have posters there)
  async function fromWikipedia() {
    try {
      const cleanTitle = title.replace(/\([^)]*\)/g, '').trim();
      const searchTitle = encodeURIComponent(cleanTitle);
      const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&titles=${searchTitle}&format=json&pithumbsize=500&origin=*`;
      const data = await fetchJson(url);
      if (data && data.query && data.query.pages) {
        const pages = Object.values(data.query.pages);
        for (const page of pages) {
          if (page.thumbnail && page.thumbnail.source) {
            console.log('[Poster] Found on Wikipedia: ' + page.thumbnail.source);
            return page.thumbnail.source;
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }
  
  // Try each source in order
  const sources = [
    fromOMDbWithId,
    fromOMDbByTitle,
    fromImdbDirect,
    fromWikipedia
  ];
  
  for (const source of sources) {
    try {
      const result = await source();
      if (result) {
        posterUrl = result;
        break;
      }
    } catch (e) {
      // Continue to next source
    }
  }
  
  return posterUrl;
}

// ── BUILD META ─────────────────────────────────────────────────────────────────
function buildMeta({ imdbId, type, title, platform, releaseDate, overview,
                     rating, posterPath, backdropPath, genres, posterUrl, backdropUrl }) {
  let desc = '';
  if (overview)    desc += overview + '\n\n';
  if (platform)    desc += '📺 Streaming on: ' + platform;
  if (releaseDate) desc += '\n📅 Release: ' + releaseDate;
  if (rating)      desc += '\n⭐ Rating: ' + Number(rating).toFixed(1) + '/10';

  let poster = null;
  if (posterUrl) {
    poster = posterUrl;
  } else if (posterPath) {
    poster = IMG + 'w500' + posterPath;
  } else {
    poster = 'https://via.placeholder.com/500x750/1a1a2e/ffffff?text=' + encodeURIComponent(title);
  }

  let backdrop = null;
  if (backdropUrl) {
    backdrop = backdropUrl;
  } else if (backdropPath) {
    backdrop = IMG + 'w1280' + backdropPath;
  }

  const meta = {
    id:          imdbId,
    type,
    name:        title,
    releaseInfo: releaseDate || '',
    description: desc.trim(),
    poster:      poster || undefined,
    background:  backdrop || undefined,
    genres:      genres && genres.length ? genres : undefined,
  };
  Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);
  return meta;
}

// ── MOVIES ─────────────────────────────────────────────────────────────────────
async function discoverMovies(lang, lookbackDays) {
  const dateFrom = daysAgo(lookbackDays);
  const results  = [];

  for (let page = 1; page <= 5; page++) {
    try {
      const data = await tmdb(
        '/discover/movie'
        + '?with_original_language=' + lang
        + '&watch_region=IN'
        + '&with_watch_monetization_types=flatrate|free|ads'
        + '&sort_by=primary_release_date.desc'
        + '&primary_release_date.gte=' + dateFrom
        + '&primary_release_date.lte=' + today()
        + '&page=' + page
      );
      if (!data.results || !data.results.length) break;

      // Use lang-prefixed key to prevent Malayalam/Tamil cache mixing
      const langPrefix = lang + '_';
      const newItems = data.results
        .filter(r => {
          // Accept correct language (ml/ta)
          if (r.original_language === lang) return true;
          // Also accept English-titled Indian content — many Malayalam/Tamil
          // documentaries and shows are classified as 'en' on TMDB even though
          // they are produced in India and stream in regional languages
          // e.g. "Land of Football" (Malayalam doc, TMDB tags as 'en')
          if (r.original_language === 'en' &&
              Array.isArray(r.origin_country) &&
              r.origin_country.includes('IN')) return true;
          return false;
        })
        .filter(r => !movieCache[langPrefix + r.id]);

      results.push(...newItems);
      console.log('[Discover] Page ' + page + ': ' + data.results.length +
        ' found, ' + newItems.length + ' new');

      if (page >= (data.total_pages || 1)) break;
      if (newItems.length === 0) break;
    } catch (e) {
      console.warn('[Discover] Page ' + page + ' failed: ' + e.message);
      break;
    }
  }
  return results;
}

async function processMovie(item, lang) {
  const tmdbId  = String(item.id);
  const cacheKey = (lang || 'ml') + '_' + tmdbId; // lang-prefixed to prevent mixing

  if (movieCache[cacheKey] !== undefined) {
    const cached = movieCache[cacheKey];
    if (cached && typeof cached === 'object' && cached._status) {
      const age = Date.now() - (cached._at || 0);
      const SKIP_TTL  = 14 * 24 * 60 * 60 * 1000; // 14 days — re-check skipped items
      const RETRY_TTL =  3 * 24 * 60 * 60 * 1000; //  3 days — re-check failed items
      if (cached._status === 'skip'  && age < SKIP_TTL)  return null;
      if (cached._status === 'retry' && age < RETRY_TTL) return null;
      // Expired — fall through and retry
      console.log('[Recheck] Re-checking expired ' + cached._status + ': ' + (item.title || item.name));
    } else if (cached === 'skip')  { return null; } // legacy
      else if (cached === 'retry') { /* fall through */ }
      else if (cached) { return cached; } // valid meta
  }

  try {
    const detail = await tmdb('/movie/' + tmdbId + '?language=en-US&append_to_response=watch/providers');
    if (!detail) {
      movieCache[cacheKey] = { _status: 'retry', _at: Date.now() };
      cacheDirty = true;
      return null;
    }

    if (!detail.imdb_id) {
      console.log('[Skip] No IMDb ID: ' + (detail.title || ''));
      movieCache[cacheKey] = { _status: 'skip', _at: Date.now() };
      cacheDirty = true;
      return null;
    }

    const wp = detail['watch/providers'];
    if (!wp || !wp.results || !wp.results.IN) {
      console.log('[Skip] Not on OTT/IN: ' + (detail.title || ''));
      movieCache[cacheKey] = { _status: 'skip', _at: Date.now() };
      cacheDirty = true;
      return null;
    }

    const IN = wp.results.IN;
    const all = [...(IN.flatrate || []), ...(IN.free || []), ...(IN.ads || [])];
    if (!all.length) {
      console.log('[Skip] No OTT provider: ' + (detail.title || ''));
      movieCache[cacheKey] = { _status: 'skip', _at: Date.now() };
      cacheDirty = true;
      return null;
    }

    const seen = new Set();
    const platform = all
      .filter(p => { if (seen.has(p.provider_id)) return false; seen.add(p.provider_id); return true; })
      .map(p => p.provider_name)
      .join(', ');

    const meta = buildMeta({
      imdbId:      detail.imdb_id,
      type:        'movie',
      title:       detail.title || '',
      platform,
      releaseDate: detail.release_date || '',
      overview:    detail.overview || '',
      rating:      detail.vote_average,
      posterPath:  detail.poster_path,
      backdropPath: detail.backdrop_path,
      genres:      (detail.genres || []).map(g => g.name),
    });

    movieCache[cacheKey] = meta;
    cacheDirty = true;
    console.log('[OK] ' + meta.name + ' (' + (lang||'ml') + ') -> ' + detail.imdb_id + ' on ' + platform);
    return meta;
  } catch (e) {
    console.warn('[Process] Movie ' + tmdbId + ' failed: ' + e.message);
    movieCache[cacheKey] = { _status: 'retry', _at: Date.now() };
    cacheDirty = true;
    return null;
  }
}

async function scrapeMovies(lang) {
  try {
    const catalogueKey = lang + '_movie';
    const isFirstRun   = !seen[catalogueKey];
    const lookback     = isFirstRun ? MOVIE_FIRST_RUN : MOVIE_LOOKBACK;

    console.log('[Movies] ' + lang + ' | lookback: ' + lookback + 'd' + (isFirstRun ? ' (first run)' : ''));

    const newItems = await discoverMovies(lang, lookback);
    console.log('[Movies] ' + newItems.length + ' new items to process');

    let processed = 0;
    let failed = 0;
    for (const item of newItems) {
      const result = await processMovie(item, lang);
      if (result) processed++;
      else failed++;
      if ((processed + failed) % 10 === 0) await new Promise(r => setTimeout(r, 300));
    }

    seen[catalogueKey] = true;

    // Only return movies for THIS language using lang-prefixed keys
    const langPrefix = lang + '_';
    const result = Object.entries(movieCache)
      .filter(([k, v]) => {
        if (!k.startsWith(langPrefix) || !v) return false;
        if (typeof v === 'string') return false; // 'skip'/'retry' strings
        if (v._status) return false; // timed skip/retry objects
        return v.type === 'movie';
      })
      .map(([, v]) => v)
      .sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''))
      .slice(0, 50);

    console.log('[Movies] ' + lang + ': ' + result.length + ' in catalogue (' + processed + ' new, ' + failed + ' failed)');
    return result;
  } catch (e) {
    console.error('[Movies] ' + lang + ' error: ' + e.message);
    await sendAlert('❌ Movies scraper failed for ' + lang + ': ' + e.message);
    return [];
  }
}

// ── SERIES ─────────────────────────────────────────────────────────────────────
async function fetchSheetSeries(filterLang) {
  if (!SHEET_URL) {
    console.warn('[Sheet] GOOGLE_SHEET_URL not set — no series data');
    return [];
  }

  try {
    let sheetUrl = SHEET_URL;
    if (sheetUrl.includes('/edit') || sheetUrl.includes('/view')) {
      const id = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (id) sheetUrl = 'https://docs.google.com/spreadsheets/d/' + id[1] + '/export?format=csv&gid=0';
    }
    
    console.log('[Sheet] Fetching: ' + sheetUrl);
    const csv = await fetchUrl(sheetUrl);
    const lines = csv.trim().split('\n');
    const items = [];

    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVRow(lines[i]);
      if (row.length < 5) continue;

      const title    = row[0].trim();
      const lang     = row[1].trim().toLowerCase();
      const platform = row[2].trim();
      const date     = row[3].trim();
      const imdbId   = row[4].trim();

      if (!title) continue;
      if (!isReleased(date)) {
        console.log('[Sheet] Skipping future: ' + title + ' (' + date + ')');
        continue;
      }
      if (!lang.includes(filterLang.toLowerCase())) continue;

      items.push({ title, platform, date, imdbId });
    }

    console.log('[Sheet] ' + items.length + ' released ' + filterLang + ' series found');
    return items;
  } catch (e) {
    console.warn('[Sheet] Failed: ' + e.message);
    await sendAlert('⚠️ Google Sheet fetch failed: ' + e.message);
    return [];
  }
}

function parseCSVRow(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function enrichSeriesFromTMDB(imdbId, title, lang) {
  const cacheKey = (imdbId || title.toLowerCase().replace(/[^a-z0-9]/g, '_'));
  
  if (seriesCache[cacheKey] !== undefined) {
    const cached = seriesCache[cacheKey];
    if (cached && typeof cached === 'object' && cached._status) {
      const age = Date.now() - (cached._at || 0);
      const SKIP_TTL  = 14 * 24 * 60 * 60 * 1000;
      const RETRY_TTL =  3 * 24 * 60 * 60 * 1000;
      if (cached._status === 'skip'  && age < SKIP_TTL)  return null;
      if (cached._status === 'retry' && age < RETRY_TTL) return null;
      console.log('[Recheck] Re-checking expired ' + cached._status + ': ' + title);
    } else if (cached === 'skip')  { return null; }
      else if (cached === 'retry') { /* fall through */ }
      else if (cached) { return cached; }
  }

  try {
    let tvId = null;
    let resolvedImdbId = imdbId || null;

    // If we have an IMDb ID, try TMDB /find first (fastest — 1 request)
    if (imdbId && imdbId.startsWith('tt')) {
      try {
        const data = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
        const tv = (data.tv_results || [])[0];
        if (tv) {
          tvId = tv.id;
          console.log('[Find] Matched by IMDb ID: ' + imdbId + ' -> TMDB ' + tvId);
        } else {
          // /find returned nothing — TMDB hasn't indexed this IMDb ID yet.
          // IMPORTANT: Do NOT fall through to title search when we have an IMDb ID.
          // Title search risks returning a completely wrong show (wrong metadata,
          // wrong poster) — e.g. searching "Land of Football" could match an
          // unrelated show. Better to show the title with no poster/metadata
          // than show completely wrong information.
          console.log('[Find] IMDb ID ' + imdbId + ' not yet on TMDB — will show title only');
          // Return a minimal result with just the IMDb ID so it still appears
          // in the catalogue and stream addons can resolve it
          const minimal = {
            imdbId,
            poster:   null,
            backdrop: null,
            overview: '',
            rating:   null,
            genres:   [],
          };
          seriesCache[cacheKey] = { _status: 'retry', _at: Date.now() }; // retry next run
          cacheDirty = true;
          return minimal; // show in catalogue, retry metadata next run
        }
      } catch(e) {
        console.warn('[Find] /find failed for ' + imdbId + ': ' + e.message);
      }
    }

    // Only do title search if we have NO IMDb ID at all
    // (never title-search when we have an IMDb ID — risks wrong match)
    if (!tvId && (!imdbId || !imdbId.startsWith('tt'))) {
      console.log('[AutoLookup] Searching: ' + title);
      const langCode = lang === 'ml' ? 'ml' : 'ta';
      const variations = getTitleVariations(title);
      
      // Also add common alternate spellings
      const extraVariations = [];
      for (const v of variations) {
        extraVariations.push(v.replace(/^(the|a|an)\s+/i, '').trim());
        extraVariations.push(v.replace(/ai/g, 'ay'));
        extraVariations.push(v.replace(/y/g, 'i'));
        extraVariations.push(v.replace(/u/g, 'oo'));
        extraVariations.push(v.replace(/i/g, 'ee'));
      }
      
      const allVariations = [...variations, ...extraVariations];
      const seenVariations = new Set();
      
      let best = null;
      let bestScore = -1;

      for (const variant of allVariations) {
        if (seenVariations.has(variant) || variant.length < 3) continue;
        seenVariations.add(variant);
        
        try {
          const query = encodeURIComponent(variant);
          const data = await tmdb('/search/tv?query=' + query + '&language=en-US&page=1');
          const results = data.results || [];

          for (const r of results) {
            let score = 0;
            const rt = (r.name || '').toLowerCase();
            const vl = variant.toLowerCase();

            if (rt === vl) score += 100;
            else if (rt.startsWith(vl)) score += 60;
            else if (rt.includes(vl)) score += 30;
            else {
              const words = vl.split(' ');
              const matchedWords = words.filter(w => rt.includes(w) && w.length > 3);
              if (matchedWords.length > 0) score += matchedWords.length * 15;
            }

            if (r.original_language === langCode) score += 40;
            if (r.origin_country && r.origin_country.includes('IN')) score += 25;
            if (r.popularity > 10) score += 10;
            if (r.media_type === 'movie') score -= 20;

            if (score > bestScore && score >= 70) {  // high threshold prevents wrong matches
              bestScore = score;
              best = r;
            }
          }

          if (best && bestScore >= 70) break;
        } catch(e) { /* continue */ }
      }

      if (best) {
        tvId = best.id;
        console.log('[AutoLookup] Found: ' + best.name + ' (score: ' + bestScore + ')');
      } else {
        console.log('[AutoLookup] No match found for: ' + title);
        seriesCache[cacheKey] = 'retry';
        cacheDirty = true;
        return null;
      }
    }

    if (!tvId) {
      seriesCache[cacheKey] = 'retry';
      cacheDirty = true;
      return null;
    }

    // Fetch full TV detail
    const detail = await tmdb('/tv/' + tvId + '?language=en-US');

    if (!resolvedImdbId && detail.external_ids) {
      resolvedImdbId = detail.external_ids.imdb_id || null;
    }
    if (!resolvedImdbId) {
      try {
        const ext = await tmdb('/tv/' + tvId + '/external_ids');
        resolvedImdbId = ext.imdb_id || null;
      } catch(e) {}
    }

    // ── GET POSTER FROM MULTIPLE SOURCES ──
    let posterUrl = detail.poster_path ? IMG + 'w500' + detail.poster_path : null;
    
    // If TMDB doesn't have a poster, try alternate sources
    if (!posterUrl) {
      console.log('[Poster] No TMDB poster for: ' + title + ', trying alternate sources...');
      posterUrl = await fetchPosterFromMultipleSources(title, resolvedImdbId, 'series');
    }

    const result = {
      imdbId:   resolvedImdbId,
      poster:   posterUrl,
      backdrop: detail.backdrop_path ? IMG + 'w1280' + detail.backdrop_path : null,
      overview: detail.overview      || '',
      rating:   detail.vote_average  || null,
      genres:   (detail.genres || []).map(g => g.name),
    };

    seriesCache[cacheKey] = result;
    cacheDirty = true;
    return result;
  } catch (e) {
    console.warn('[Enrich] ' + (imdbId || title) + ': ' + e.message);
    seriesCache[cacheKey] = { _status: 'retry', _at: Date.now() };
    cacheDirty = true;
    return null;
  }
}

async function scrapeSeries(lang) {
  try {
    const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';
    const items     = await fetchSheetSeries(langLabel);
    
    const releasedItems = items.filter(item => isReleased(item.date));
    if (releasedItems.length < items.length) {
      console.log('[Series] Filtered ' + (items.length - releasedItems.length) + ' future releases');
    }

    releasedItems.sort((a, b) => {
      const da = new Date(a.date);
      const db = new Date(b.date);
      if (isNaN(da)) return 1;
      if (isNaN(db)) return -1;
      return db - da;
    });

    console.log('[Series] Processing ' + releasedItems.length + ' released items');

    const metas = [];
    let failed = 0;
    
    for (const item of releasedItems.slice(0, 50)) {
      const tmdbData = await enrichSeriesFromTMDB(item.imdbId, item.title, lang);
      
      const finalImdbId = item.imdbId || (tmdbData && tmdbData.imdbId) || null;
      if (!finalImdbId) {
        console.log('[Series] Skipping (no IMDb ID): ' + item.title);
        failed++;
        continue;
      }

      let formattedDate = item.date;
      if (item.date) {
        try {
          const d = new Date(item.date);
          if (!isNaN(d)) {
            formattedDate = d.toISOString().split('T')[0];
          }
        } catch(e) {}
      }

      const meta = buildMeta({
        imdbId:      finalImdbId,
        type:        'series',
        title:       item.title,
        platform:    item.platform,
        releaseDate: formattedDate || item.date,
        overview:    tmdbData?.overview || '',
        rating:      tmdbData?.rating   || null,
        posterUrl:   tmdbData?.poster   || null,
        backdropUrl: tmdbData?.backdrop || null,
        genres:      tmdbData?.genres   || [],
      });

      metas.push(meta);
      console.log('[Series] ' + item.title + ' -> ' + finalImdbId + ' (' + formattedDate + ')');
      await new Promise(r => setTimeout(r, 100));
    }

    metas.sort((a, b) => {
      if (a.releaseInfo && b.releaseInfo) {
        const da = new Date(a.releaseInfo);
        const db = new Date(b.releaseInfo);
        if (!isNaN(da) && !isNaN(db)) {
          return db - da;
        }
        return (b.releaseInfo || '').localeCompare(a.releaseInfo || '');
      }
      if (a.releaseInfo && !b.releaseInfo) return -1;
      if (!a.releaseInfo && b.releaseInfo) return 1;
      return 0;
    });

    console.log('[Series] ' + lang + ': ' + metas.length + ' series in catalogue (' + failed + ' failed)');
    return metas;
  } catch (e) {
    console.error('[Series] ' + lang + ' error: ' + e.message);
    await sendAlert('❌ Series scraper failed for ' + lang + ': ' + e.message);
    return [];
  }
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  loadCache();
  try {
    let result;
    if (type === 'series') {
      result = await scrapeSeries('ml');
    } else {
      result = await scrapeMovies('ml');
    }
    saveCache();
    
    // Health check after successful run
    getHealthStatus();
    return result;
  } catch (e) {
    console.error('[scrapeMalayalam] ' + e.message);
    await sendAlert('❌ Malayalam ' + type + ' failed: ' + e.message);
    saveCache();
    return [];
  }
}

async function scrapeTamil(type) {
  loadCache();
  try {
    let result;
    if (type === 'series') {
      result = await scrapeSeries('ta');
    } else {
      result = await scrapeMovies('ta');
    }
    saveCache();
    
    // Health check after successful run
    getHealthStatus();
    return result;
  } catch (e) {
    console.error('[scrapeTamil] ' + e.message);
    await sendAlert('❌ Tamil ' + type + ' failed: ' + e.message);
    saveCache();
    return [];
  }
}

module.exports = { scrapeMalayalam, scrapeTamil };
