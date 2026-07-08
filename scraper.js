/**
 * scraper.js - TMDB Discover API
 */

const https = require('https');
const zlib = require('zlib');   // ← Fixed
const fs = require('fs');        // ← Make sure this is here
const path = require('path');

const TMDB_KEY   = process.env.TMDB_API_KEY || '';
const BASE       = 'https://api.themoviedb.org/3';
const IMG        = 'https://image.tmdb.org/t/p/';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'resolve-cache.json');

// Look back 30 days for new releases on each run
// First run ever uses 180 days to backfill
const LOOKBACK_DAYS     = 30;
const FIRST_RUN_LOOKBACK = 180;

// ── PERSISTENT CACHE ──────────────────────────────────────────────────────────
// Stores processed TMDB IDs so we don't re-fetch them on every run
// Format: { "tmdbId": { ...meta } | "skip" }
let cache = {};
const MAX_CACHE_SIZE = 1500;  // Only keep 1500 items in cache
let cacheLoaded = false;
function trimCache() {
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_SIZE) {
    // Remove oldest entries (they're at the end)
    const toRemove = keys.length - MAX_CACHE_SIZE;
    const sortedKeys = keys.sort((a, b) => {
      const aVal = cache[a];
      const bVal = cache[b];
      // Skip entries are less important
      if (aVal === 'skip' && bVal !== 'skip') return 1;
      if (bVal === 'skip' && aVal !== 'skip') return -1;
      return 0;
    });
    for (let i = 0; i < Math.min(toRemove, sortedKeys.length); i++) {
      delete cache[sortedKeys[i]];
    }
    console.log('[Cache] Trimmed ' + toRemove + ' old entries');
  }
}

function loadCache() {
  if (cacheLoaded) return;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const count = Object.keys(cache).length;
      console.log('[Cache] Loaded ' + count + ' entries from resolve-cache.json');
    } else {
      console.log('[Cache] No resolve-cache.json yet — will create on first run');
    }
  } catch (e) {
    console.warn('[Cache] Load failed: ' + e.message + ' — starting fresh');
    cache = {};
  }
  cacheLoaded = true;
}
function saveCache() {
  trimCache();
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log('[Cache] Saved ' + Object.keys(cache).length + ' entries');
  } catch (e) {
    console.warn('[Cache] Save failed: ' + e.message);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'MollywoodAddon/1.0' },
    }, (res) => {
      if (res.statusCode !== 200)
        return reject(new Error('HTTP ' + res.statusCode));
      let s = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    s = res.pipe(zlib.createGunzip());
      if (enc === 'br')      s = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      const c = [];
      s.on('data', d => c.push(d));
      s.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(c).toString())); }
        catch (e) { reject(e); }
      });
      s.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { this.destroy(); reject(new Error('Timeout after 20s')); });
  });
}

// Rate limiter — stay well under TMDB's 40 req/10s limit
let reqCount = 0, reqReset = Date.now();
async function tmdb(path) {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');
  const now = Date.now();
  if (now - reqReset > 10000) { reqCount = 0; reqReset = now; }
  if (reqCount >= 35) {
    const wait = 10100 - (now - reqReset);
    console.log('[Rate] Pausing ' + Math.ceil(wait / 1000) + 's...');
    await new Promise(r => setTimeout(r, wait));
    reqCount = 0; reqReset = Date.now();
  }
  reqCount++;
  const sep = path.includes('?') ? '&' : '?';
  return fetchJson(BASE + path + sep + 'api_key=' + TMDB_KEY);
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

// ── DISCOVER NEW RELEASES ─────────────────────────────────────────────────────
async function discoverNew(mediaType, lang) {
  const isFirstRun = Object.keys(cache).length === 0;
  const lookback   = isFirstRun ? FIRST_RUN_LOOKBACK : LOOKBACK_DAYS;
  const dateFrom   = daysAgo(lookback);
  const dateTo     = today();

  console.log('[Discover] ' + lang + ' ' + mediaType +
    ' from ' + dateFrom + (isFirstRun ? ' (first run — backfilling ' + lookback + ' days)' : ''));

  const results = [];

  // Try multiple methods to catch more content
  const methods = [
    // Method 1: Discover with language only (no OTT filter)
    async () => {
      const dateParam = mediaType === 'movie'
        ? 'primary_release_date.gte=' + dateFrom + '&primary_release_date.lte=' + dateTo
        : 'first_air_date.gte=' + dateFrom + '&first_air_date.lte=' + dateTo;

      const data = await tmdb(
        '/discover/' + mediaType
        + '?with_original_language=' + lang
        + '&sort_by=primary_release_date.desc'
        + '&' + dateParam
        + '&page=1'
      );
      return data.results || [];
    },
    // Method 2: Trending (catches popular new content)
    async () => {
      const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
      const data = await tmdb('/trending/' + endpoint + '/week');
      return (data.results || []).filter(r => r.original_language === lang);
    },
    // Method 3: Popular (catches evergreen content)
    async () => {
      const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
      const data = await tmdb('/' + endpoint + '/popular');
      return (data.results || []).filter(r => r.original_language === lang);
    }
  ];

  for (const method of methods) {
    try {
      const items = await method();
      const newItems = items.filter(r => !cache[String(r.id)]);
      results.push(...newItems);
      console.log('[Discover] Found ' + newItems.length + ' new items');
      if (results.length >= 100) break;
    } catch (e) {
      console.warn('[Discover] Method failed: ' + e.message);
    }
  }

  console.log('[Discover] Total ' + results.length + ' new items to process');
  return results;
}
// Use TMDB ID as fallback if IMDb ID is missing
const imdbId = detail.imdb_id || ('tmdb' + tmdbId);
if (!detail.imdb_id) {
  console.log('[Notice] No IMDb ID for: ' + (detail.title || detail.name) + ' - using TMDB ID instead');
  // Still process it - we'll use TMDB ID as identifier
}
// ── FETCH DETAILS + PROVIDERS IN ONE REQUEST ──────────────────────────────────
// append_to_response saves 1 API call per item compared to separate requests
async function fetchDetailAndProviders(tmdbId, mediaType) {
  const ep = mediaType === 'movie' ? 'movie' : 'tv';
  try {
    const data = await tmdb(
      '/' + ep + '/' + tmdbId
      + '?language=en-US'
      + '&append_to_response=watch/providers'
    );
    return data;
  } catch (e) {
    console.warn('[Detail] ' + tmdbId + ': ' + e.message);
    return null;
  }
}

// ── EXTRACT PROVIDERS FROM RESPONSE ──────────────────────────────────────────
function extractProviders(data) {
  const watchProviders = data['watch/providers'];
  if (!watchProviders) return null;

  const IN = watchProviders.results && watchProviders.results.IN;
  if (!IN) return null;

  const all = [
    ...(IN.flatrate || []),
    ...(IN.free     || []),
    ...(IN.ads      || []),
  ];
  if (!all.length) return null;

  const seen = new Set();
  const names = [];
  for (const p of all) {
    if (!seen.has(p.provider_id)) {
      seen.add(p.provider_id);
      names.push(p.provider_name);
    }
  }
  return names.join(', ') || null;
}

// ── PROCESS ONE ITEM ──────────────────────────────────────────────────────────
async function processItem(item, mediaType) {
  const tmdbId = String(item.id);

  // Already cached — return cached result or skip
  if (cache[tmdbId] !== undefined) {
    return cache[tmdbId] === 'skip' ? null : cache[tmdbId];
  }

  const detail = await fetchDetailAndProviders(tmdbId, mediaType);
  if (!detail) {
    cache[tmdbId] = 'skip';
    return null;
  }

  // Must have an IMDb ID for Stremio stream addons to work
  const imdbId = detail.imdb_id || null;
  if (!imdbId) {
    console.log('[Skip] No IMDb ID: ' + (detail.title || detail.name));
    cache[tmdbId] = 'skip';
    return null;
  }

  // Must be on OTT in India
  const platform = extractProviders(detail);
  if (!platform) {
    console.log('[Skip] Not on OTT in India: ' + (detail.title || detail.name));
    cache[tmdbId] = 'skip';
    return null;
  }

  const title       = detail.title || detail.name || '';
  const releaseDate = detail.release_date || detail.first_air_date || '';
  const year        = releaseDate.slice(0, 4);
  const genres      = (detail.genres || []).map(g => g.name);

  let desc = '';
  if (detail.overview)      desc += detail.overview + '\n\n';
  desc += '📺 Streaming on: ' + platform;
  if (releaseDate)          desc += '\n📅 Release: ' + releaseDate;
  if (detail.vote_average)  desc += '\n⭐ Rating: ' + detail.vote_average.toFixed(1) + '/10';

  const meta = {
    id:          imdbId,
    type:        mediaType === 'movie' ? 'movie' : 'series',
    name:        title,
    releaseInfo: year || releaseDate,
    description: desc.trim(),
    poster:      detail.poster_path   ? IMG + 'w500'  + detail.poster_path   : undefined,
    background:  detail.backdrop_path ? IMG + 'w1280' + detail.backdrop_path : undefined,
    genres:      genres.length ? genres : undefined,
  };

  Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);

  // Cache the result so future runs skip this item
  cache[tmdbId] = meta;

  console.log('[OK] ' + title + ' -> ' + imdbId + ' on ' + platform);
  return meta;
}

// ── MAIN SCRAPE ───────────────────────────────────────────────────────────────
async function scrapeLanguage(lang, mediaType) {
  loadCache();

  const newItems = await discoverNew(mediaType, lang);

  // Process new items sequentially (safe, predictable, avoids burst)
  let processed = 0;
  for (const item of newItems) {
    await processItem(item, mediaType);
    processed++;
    // Small pause every 10 items just to be safe
    if (processed % 10 === 0) await new Promise(r => setTimeout(r, 500));
  }

  // Build final list from cache — all items for this language/type
  // sorted newest first, capped at 50
  const allMetas = Object.values(cache)
    .filter(v => v !== 'skip' && v && v.type === (mediaType === 'movie' ? 'movie' : 'series'))
    // Only return items from this language (inferred from genres/name is unreliable,
    // but since we scrape by language the cache is naturally partitioned by run)
    .sort((a, b) => {
      // Sort by releaseInfo year desc, then name
      const ya = parseInt(a.releaseInfo) || 0;
      const yb = parseInt(b.releaseInfo) || 0;
      return yb - ya;
    })
    .slice(0, 50);

  console.log('[Done] ' + lang + ' ' + mediaType + ': ' +
  processed + ' new processed, ' + allMetas.length + ' total in catalogue' +
  (processed === 0 ? ' (all cached, skipping)' : ''));
  saveCache();
  return allMetas;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  try { return await scrapeLanguage('ml', type === 'series' ? 'tv' : 'movie'); }
  catch (e) { console.error('[scrapeMalayalam] ' + e.message); saveCache(); return []; }
}

async function scrapeTamil(type) {
  try { return await scrapeLanguage('ta', type === 'series' ? 'tv' : 'movie'); }
  catch (e) { console.error('[scrapeTamil] ' + e.message); saveCache(); return []; }
}

module.exports = { scrapeMalayalam, scrapeTamil };
