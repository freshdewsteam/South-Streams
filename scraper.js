/**
 * scraper.js
 *
 * Movies  → TMDB Discover API (automatic, no maintenance)
 * Series  → Google Sheet CSV (you maintain manually)
 *
 * Series sheet format (5 columns):
 *   Title | Language | Platform | OTT Release Date | IMDb ID
 *
 * How to get your sheet CSV URL:
 *   1. Create Google Sheet, make it public (Anyone with link → Viewer)
 *   2. File → Share → Publish to web → CSV → Copy link
 *   OR use: https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY   = process.env.TMDB_API_KEY || '';
const SHEET_URL  = process.env.GOOGLE_SHEET_URL || ''; // Set in GitHub Secrets
const BASE       = 'https://api.themoviedb.org/3';
const IMG        = 'https://image.tmdb.org/t/p/';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'resolve-cache.json');

// Lookback windows for TMDB Discover
const MOVIE_LOOKBACK  = 30;  // days — check last 30 days each run
const MOVIE_FIRST_RUN = 730; // days — backfill on very first run

// ── PERSISTENT CACHE ──────────────────────────────────────────────────────────
let cache = {};
let seen  = {}; // tracks which catalogues have run before
let cacheLoaded = false;
let cacheDirty  = false;

function loadCache() {
  if (cacheLoaded) return;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      seen  = raw._seen  || {};
      cache = Object.fromEntries(
        Object.entries(raw).filter(([k]) => k !== '_seen')
      );
      console.log('[Cache] Loaded ' + Object.keys(cache).length + ' entries');
    } else {
      console.log('[Cache] Fresh start');
    }
  } catch (e) {
    console.warn('[Cache] Load failed: ' + e.message);
    cache = {}; seen = {};
  }
  cacheLoaded = true;
}

function saveCache() {
  if (!cacheDirty) return;
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...cache, _seen: seen }, null, 2));
    console.log('[Cache] Saved ' + Object.keys(cache).length + ' entries');
    cacheDirty = false;
  } catch (e) {
    console.warn('[Cache] Save failed: ' + e.message);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'MollywoodAddon/1.0',
      },
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error('HTTP ' + res.statusCode));
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

// Rate limiter — stay under TMDB's 40 req/10s
let reqCount = 0, reqReset = Date.now();
async function tmdb(endpoint) {
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
  const sep = endpoint.includes('?') ? '&' : '?';
  return fetchJson(BASE + endpoint + sep + 'api_key=' + TMDB_KEY);
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

function isReleased(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr) <= new Date();
}

// ── TMDB: DISCOVER MOVIES ─────────────────────────────────────────────────────
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

      const newItems = data.results.filter(r => !cache[String(r.id)]);
      results.push(...newItems);
      console.log('[Discover] Page ' + page + ': ' + data.results.length +
        ' found, ' + newItems.length + ' new');

      if (page >= (data.total_pages || 1)) break;
      if (newItems.length === 0) break; // all cached, stop paging
    } catch (e) {
      console.warn('[Discover] Page ' + page + ' failed: ' + e.message);
      break;
    }
  }
  return results;
}

// ── TMDB: FETCH DETAIL + PROVIDERS (1 request) ────────────────────────────────
async function fetchMovieDetail(tmdbId) {
  try {
    return await tmdb(
      '/movie/' + tmdbId
      + '?language=en-US'
      + '&append_to_response=watch/providers'
    );
  } catch (e) {
    console.warn('[Detail] ' + tmdbId + ': ' + e.message);
    return null;
  }
}

function getIndiaProviders(data) {
  const wp = data['watch/providers'];
  if (!wp || !wp.results || !wp.results.IN) return null;
  const IN  = wp.results.IN;
  const all = [...(IN.flatrate || []), ...(IN.free || []), ...(IN.ads || [])];
  if (!all.length) return null;
  const seen = new Set();
  return all
    .filter(p => { if (seen.has(p.provider_id)) return false; seen.add(p.provider_id); return true; })
    .map(p => p.provider_name)
    .join(', ');
}

// ── TMDB: PROCESS ONE MOVIE ───────────────────────────────────────────────────
async function processMovie(item) {
  const tmdbId = String(item.id);
  if (cache[tmdbId] !== undefined) {
    return cache[tmdbId] === 'skip' ? null : cache[tmdbId];
  }

  const detail = await fetchMovieDetail(tmdbId);
  if (!detail) { cache[tmdbId] = 'skip'; cacheDirty = true; return null; }

  if (!detail.imdb_id) {
    console.log('[Skip] No IMDb ID: ' + (detail.title || ''));
    cache[tmdbId] = 'skip'; cacheDirty = true; return null;
  }

  const platform = getIndiaProviders(detail);
  if (!platform) {
    console.log('[Skip] Not on OTT/IN: ' + (detail.title || ''));
    cache[tmdbId] = 'skip'; cacheDirty = true; return null;
  }

  const releaseDate = detail.release_date || '';
  const meta = buildMeta({
    imdbId:      detail.imdb_id,
    type:        'movie',
    title:       detail.title || '',
    platform,
    releaseDate,
    overview:    detail.overview || '',
    rating:      detail.vote_average,
    posterPath:  detail.poster_path,
    backdropPath: detail.backdrop_path,
    genres:      (detail.genres || []).map(g => g.name),
  });

  cache[tmdbId] = meta; cacheDirty = true;
  console.log('[OK] ' + meta.name + ' -> ' + detail.imdb_id + ' on ' + platform);
  return meta;
}

// ── GOOGLE SHEET: FETCH AND PARSE SERIES ──────────────────────────────────────
// Sheet columns: Title | Language | Platform | OTT Release Date | IMDb ID
// Language column: "Malayalam" or "Tamil"
async function fetchSheetSeries(filterLang) {
  if (!SHEET_URL) {
    console.warn('[Sheet] GOOGLE_SHEET_URL not set — no series data');
    return [];
  }

  try {
    // Auto-convert edit/view URL to CSV export URL
    let sheetUrl = SHEET_URL;
    if (sheetUrl.includes('/edit') || sheetUrl.includes('/view')) {
      const id = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (id) sheetUrl = 'https://docs.google.com/spreadsheets/d/' + id[1] + '/export?format=csv&gid=0';
    }
    console.log('[Sheet] Fetching: ' + sheetUrl);
    const csv = await fetchUrl(sheetUrl);
    const lines = csv.trim().split('\n');
    const items = [];

    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVRow(lines[i]);
      if (row.length < 5) continue;

      const title    = row[0].trim();
      const lang     = row[1].trim().toLowerCase();
      const platform = row[2].trim();
      const date     = row[3].trim();
      const imdbId   = row[4].trim();

      if (!title) continue;
      // IMDb ID is optional — if missing, TMDB auto-lookup will find it
      if (!isReleased(date)) continue; // skip future releases
      if (!lang.includes(filterLang.toLowerCase())) continue;

      items.push({ title, platform, date, imdbId });
    }

    console.log('[Sheet] ' + items.length + ' released ' + filterLang + ' series found');
    return items;
  } catch (e) {
    console.warn('[Sheet] Failed: ' + e.message);
    return [];
  }
}

// Simple CSV row parser (handles quoted fields)
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

// ── SHEET SERIES → TMDB META ──────────────────────────────────────────────────
// If IMDb ID is provided: use TMDB /find (1 request)
// If IMDb ID is missing:  search TMDB by title to find it automatically
async function enrichSeriesFromTMDB(imdbId, title, lang) {
  const cacheKey = 'series_' + (imdbId || title.toLowerCase().replace(/[^a-z0-9]/g, '_'));
  if (cache[cacheKey] && cache[cacheKey] !== 'skip') return cache[cacheKey];

  try {
    let tvId = null;
    let resolvedImdbId = imdbId || null;

    if (imdbId && imdbId.startsWith('tt')) {
      // We have an IMDb ID — use TMDB /find (fast, 1 request)
      const data = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
      const tv   = (data.tv_results || [])[0];
      if (tv) tvId = tv.id;
    } else {
      // No IMDb ID — search TMDB by title
      console.log('[AutoLookup] Searching for: ' + title);
      const langCode = lang === 'ml' ? 'ml' : 'ta';
      const query    = encodeURIComponent(title);
      const data     = await tmdb('/search/tv?query=' + query + '&language=en-US&page=1');
      const results  = data.results || [];

      // Score results — prefer correct language
      let best = null, bestScore = -1;
      for (const r of results) {
        let score = 0;
        const rt = (r.name || '').toLowerCase();
        const vl = title.toLowerCase();
        if (rt === vl)              score += 60;
        else if (rt.includes(vl))   score += 30;
        if (r.original_language === langCode) score += 50;
        else if (r.original_language === 'en') score -= 20;
        if (r.origin_country && r.origin_country.includes('IN')) score += 15;
        if (score > bestScore && score >= 40) { bestScore = score; best = r; }
      }

      if (best) {
        tvId = best.id;
        console.log('[AutoLookup] Found: ' + best.name + ' (score: ' + bestScore + ')');
      } else {
        console.log('[AutoLookup] No match for: ' + title);
        cache[cacheKey] = 'skip'; cacheDirty = true; return null;
      }
    }

    if (!tvId) {
      cache[cacheKey] = 'skip'; cacheDirty = true; return null;
    }

    // Fetch full TV detail
    const detail = await tmdb('/tv/' + tvId + '?language=en-US');

    // Get IMDb ID from detail if we didn't have it
    if (!resolvedImdbId && detail.external_ids) {
      resolvedImdbId = detail.external_ids.imdb_id || null;
    }
    // Fetch external IDs if still missing
    if (!resolvedImdbId) {
      try {
        const ext = await tmdb('/tv/' + tvId + '/external_ids');
        resolvedImdbId = ext.imdb_id || null;
      } catch(e) {}
    }

    const result = {
      imdbId:   resolvedImdbId,
      poster:   detail.poster_path   ? IMG + 'w500'  + detail.poster_path   : null,
      backdrop: detail.backdrop_path ? IMG + 'w1280' + detail.backdrop_path : null,
      overview: detail.overview      || '',
      rating:   detail.vote_average  || null,
      genres:   (detail.genres || []).map(g => g.name),
    };

    cache[cacheKey] = result; cacheDirty = true;
    return result;
  } catch (e) {
    console.warn('[Enrich] ' + (imdbId || title) + ': ' + e.message);
    return null;
  }
}

// ── BUILD STREMIO META OBJECT ─────────────────────────────────────────────────
function buildMeta({ imdbId, type, title, platform, releaseDate, overview,
                     rating, posterPath, backdropPath, genres, posterUrl, backdropUrl }) {
  let desc = '';
  if (overview)    desc += overview + '\n\n';
  if (platform)    desc += '📺 Streaming on: ' + platform;
  if (releaseDate) desc += '\n📅 Release: ' + releaseDate;
  if (rating)      desc += '\n⭐ Rating: ' + Number(rating).toFixed(1) + '/10';

  // Use posterUrl or posterPath (whichever is provided)
  let poster = null;
  if (posterUrl) {
    poster = posterUrl;
  } else if (posterPath) {
    poster = IMG + 'w500' + posterPath;
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

// ── SCRAPE MOVIES (TMDB Discover) ────────────────────────────────────────────
async function scrapeMovies(lang) {
  loadCache();

  const catalogueKey = lang + '_movie';
  const isFirstRun   = !seen[catalogueKey];
  const lookback     = isFirstRun ? MOVIE_FIRST_RUN : MOVIE_LOOKBACK;

  console.log('[Movies] ' + lang + ' | lookback: ' + lookback + 'd' +
    (isFirstRun ? ' (first run)' : ''));

  const newItems = await discoverMovies(lang, lookback);
  console.log('[Movies] ' + newItems.length + ' new items to process');

  for (let i = 0; i < newItems.length; i++) {
    await processMovie(newItems[i]);
    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 300));
  }

  seen[catalogueKey] = true;

  const result = Object.values(cache)
    .filter(v => v && v !== 'skip' && v.type === 'movie')
    .sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''))
    .slice(0, 50);

  console.log('[Movies] ' + lang + ': ' + result.length + ' in catalogue');
  saveCache();
  return result;
}

// ── SCRAPE SERIES (Google Sheet) ─────────────────────────────────────────────
async function scrapeSeries(lang) {
  loadCache();

  const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';
  const items     = await fetchSheetSeries(langLabel);

  // Sort newest first
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const metas = [];
  for (const item of items.slice(0, 50)) {
    // Try to enrich with TMDB data (poster etc)
    const cacheKey = 'series_' + (item.imdbId || item.title.toLowerCase().replace(/[^a-z0-9]/g, '_'));
    let tmdbData   = cache[cacheKey] && cache[cacheKey] !== 'skip'
      ? cache[cacheKey]
      : null;

    if (!tmdbData) {
      tmdbData = await enrichSeriesFromTMDB(item.imdbId, item.title, lang);
    }

    // If sheet had no IMDb ID, use the one resolved from TMDB
    const finalImdbId = item.imdbId || (tmdbData && tmdbData.imdbId) || null;
    if (!finalImdbId) {
      console.log('[Series] Skipping (no IMDb ID found): ' + item.title);
      continue;
    }

    const meta = buildMeta({
      imdbId:      finalImdbId,
      type:        'series',
      title:       item.title,
      platform:    item.platform,
      releaseDate: item.date,
      overview:    tmdbData?.overview || '',
      rating:      tmdbData?.rating   || null,
      posterUrl:   tmdbData?.poster   || null,
      backdropUrl: tmdbData?.backdrop || null,
      genres:      tmdbData?.genres   || [],
    });

    metas.push(meta);
    console.log('[Series] ' + item.title + ' -> ' + finalImdbId);
    await new Promise(r => setTimeout(r, 100));
  }

  // Sort metas by release date (newest first)
  metas.sort((a, b) => {
    const da = a.releaseInfo || '';
    const db = b.releaseInfo || '';
    return db.localeCompare(da);
  });

  console.log('[Series] ' + lang + ': ' + metas.length + ' in catalogue');
  saveCache();
  return metas;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  try {
    return type === 'series'
      ? await scrapeSeries('ml')
      : await scrapeMovies('ml');
  } catch (e) {
    console.error('[scrapeMalayalam] ' + e.message);
    saveCache(); return [];
  }
}

async function scrapeTamil(type) {
  try {
    return type === 'series'
      ? await scrapeSeries('ta')
      : await scrapeMovies('ta');
  } catch (e) {
    console.error('[scrapeTamil] ' + e.message);
    saveCache(); return [];
  }
}

module.exports = { scrapeMalayalam, scrapeTamil };
