/**
 * scraper.js — South Streams
 *
 * Movies  → TMDB Discover API (automatic)
 * Series  → Google Sheet CSV (manually maintained)
 *
 * Key principles:
 * - If a series has an IMDb ID → use it directly, never title-search-fallback
 *   (title search risks matching a completely wrong show)
 * - If no poster found → omit it entirely so Cinemeta/AIO Metadata can fill it
 * - Movie cache is language-prefixed to prevent Malayalam/Tamil mixing
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY    = process.env.TMDB_API_KEY    || '';
const OMDB_KEY    = process.env.OMDB_API_KEY    || '';
const SHEET_URL   = process.env.GOOGLE_SHEET_URL || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL      || '';
const BASE        = 'https://api.themoviedb.org/3';
const IMG         = 'https://image.tmdb.org/t/p/';

const MOVIE_CACHE_FILE  = path.join(__dirname, '..', 'data', 'movies-cache.json');
const SERIES_CACHE_FILE = path.join(__dirname, '..', 'data', 'series-cache.json');

const MOVIE_LOOKBACK  = 30;
const MOVIE_FIRST_RUN = 730;
const SKIP_TTL        = 14 * 24 * 60 * 60 * 1000; // 14 days
const RETRY_TTL       =  3 * 24 * 60 * 60 * 1000; //  3 days

// ── CACHE ─────────────────────────────────────────────────────────────────────
let movieCache  = {};
let seriesCache = {};
let seen        = {};
let cacheDirty  = false;

function loadCache() {
  try {
    if (fs.existsSync(MOVIE_CACHE_FILE)) {
      const raw   = JSON.parse(fs.readFileSync(MOVIE_CACHE_FILE, 'utf8'));
      movieCache  = raw._data || {};
      seen        = raw._seen || {};
      console.log('[Cache] Movies: ' + Object.keys(movieCache).length + ' entries');
    }
    if (fs.existsSync(SERIES_CACHE_FILE)) {
      const raw   = JSON.parse(fs.readFileSync(SERIES_CACHE_FILE, 'utf8'));
      seriesCache = raw._data || {};
      console.log('[Cache] Series: ' + Object.keys(seriesCache).length + ' entries');
    }
  } catch (e) {
    console.warn('[Cache] Load failed: ' + e.message);
    movieCache = {}; seriesCache = {}; seen = {};
  }
}

function saveCache() {
  if (!cacheDirty) return;
  try {
    const dir = path.dirname(MOVIE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MOVIE_CACHE_FILE,  JSON.stringify({ _data: movieCache,  _seen: seen }, null, 2));
    fs.writeFileSync(SERIES_CACHE_FILE, JSON.stringify({ _data: seriesCache }, null, 2));
    console.log('[Cache] Saved ' + Object.keys(movieCache).length + ' movies, ' + Object.keys(seriesCache).length + ' series');
    cacheDirty = false;
  } catch (e) {
    console.warn('[Cache] Save failed: ' + e.message);
  }
}

// Read a cache entry — handles both old string format and new timed object format
function readCacheEntry(entry) {
  if (entry === undefined) return undefined;
  // Legacy string format
  if (entry === 'skip')  return 'skip';
  if (entry === 'retry') return 'retry';
  // New timed object format
  if (entry && typeof entry === 'object' && entry._status) {
    const age = Date.now() - (entry._at || 0);
    const ttl = entry._status === 'skip' ? SKIP_TTL : RETRY_TTL;
    if (age < ttl) return entry._status; // still within TTL
    return undefined; // expired — treat as not cached, retry
  }
  // Valid meta object
  if (entry && typeof entry === 'object' && entry.id) return entry;
  return undefined;
}

function setSkip(cacheObj, key)  { cacheObj[key] = { _status: 'skip',  _at: Date.now() }; cacheDirty = true; }
function setRetry(cacheObj, key) { cacheObj[key] = { _status: 'retry', _at: Date.now() }; cacheDirty = true; }

// ── HEALTH ────────────────────────────────────────────────────────────────────
function getHealthStatus() {
  const mc = Object.values(movieCache).filter(v => v && typeof v === 'object' && v.id && !v._status).length;
  const sc = Object.values(seriesCache).filter(v => v && typeof v === 'object' && v.id && !v._status).length;
  console.log('[Health] ' + mc + ' movies, ' + sc + ' series');
  return { movies: mc, series: sc, total: mc + sc };
}

// ── ALERTS ────────────────────────────────────────────────────────────────────
async function sendAlert(message) {
  console.log('[Alert] ' + message);
  if (!WEBHOOK_URL) return;
  try {
    const body = JSON.stringify({ content: '🎬 South Streams: ' + message, username: 'South Streams' });
    await new Promise((resolve, reject) => {
      const u   = new URL(WEBHOOK_URL);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body); req.end();
    });
  } catch (e) { console.warn('[Alert] Failed: ' + e.message); }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'SouthStreams/2.0' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
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

function fetchJson(url) { return fetchUrl(url).then(t => JSON.parse(t)); }

let reqCount = 0, reqReset = Date.now();
async function tmdb(endpoint, retries) {
  retries = retries || 3;
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const now = Date.now();
      if (now - reqReset > 10000) { reqCount = 0; reqReset = now; }
      if (reqCount >= 35) {
        const wait = 15100 - (now - reqReset);
        console.log('[Rate] Pausing ' + Math.ceil(wait/1000) + 's...');
        await new Promise(r => setTimeout(r, wait));
        reqCount = 0; reqReset = Date.now();
      }
      reqCount++;
      const sep = endpoint.includes('?') ? '&' : '?';
      return await fetchJson(BASE + endpoint + sep + 'api_key=' + TMDB_KEY);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}

// ── DATES ─────────────────────────────────────────────────────────────────────
const _M = {
  jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
  january:0,february:1,march:2,april:3,june:5,july:6,august:7,
  september:8,october:9,november:10,december:11
};

function parseAnyDate(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/soon|tba|tbd|upcoming|expected|coming/i.test(s)) return null;
  let m;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) { const mo = _M[m[2].toLowerCase()]; if (mo !== undefined) return new Date(+m[3], mo, +m[1]); }
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) { const mo = _M[m[1].toLowerCase()]; if (mo !== undefined) return new Date(+m[3], mo, +m[2]); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isReleased(dateStr) {
  const d = parseAnyDate(dateStr);
  if (!d) return false;
  const now = new Date(); now.setHours(23, 59, 59, 999);
  return d <= now;
}

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function today()    { return new Date().toISOString().slice(0,10); }

// ── TITLE VARIATIONS ──────────────────────────────────────────────────────────
function getTitleVariations(title) {
  const v = new Set([title]);
  v.add(title.replace(/\band\b/gi, '&'));
  v.add(title.replace(/&/g, ' and '));
  v.add(title.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
  v.add(title.replace(/\s*\(\d{4}\)\s*$/, '').trim());
  v.add(title.replace(/\s*[-–]\s*season\s*\d+/i, '').trim());
  v.add(title.replace(/^(the|a|an)\s+/i, '').trim());
  v.add(title.replace(/\s+(series|show|tv|web series)$/i, '').trim());
  return Array.from(v).filter(x => x.length >= 2);
}

// ── POSTER FETCHER ────────────────────────────────────────────────────────────
// Only reliable sources: OMDb by ID, OMDb by title
// Wikipedia removed — returns wrong images (people photos, logos etc.)
async function fetchPosterFallback(title, imdbId, type) {
  if (!OMDB_KEY) return null;
  const mediaType = type === 'series' ? 'series' : 'movie';

  // Source 1: OMDb by IMDb ID (most reliable)
  if (imdbId) {
    try {
      const data = await fetchJson('https://www.omdbapi.com/?apikey=' + OMDB_KEY + '&i=' + imdbId);
      if (data && data.Response === 'True' && data.Poster && data.Poster !== 'N/A') {
        console.log('[Poster] OMDb by ID: ' + imdbId);
        return data.Poster;
      }
    } catch(e) {}
  }

  // Source 2: OMDb by title (3 variations max)
  const variations = getTitleVariations(title).slice(0, 3);
  for (const v of variations) {
    try {
      const data = await fetchJson(
        'https://www.omdbapi.com/?apikey=' + OMDB_KEY +
        '&t=' + encodeURIComponent(v) + '&type=' + mediaType
      );
      if (data && data.Response === 'True' && data.Poster && data.Poster !== 'N/A') {
        console.log('[Poster] OMDb by title: ' + v);
        return data.Poster;
      }
    } catch(e) {}
  }

  return null; // No poster found — return null, NOT a placeholder
}

// ── BUILD META ────────────────────────────────────────────────────────────────
function buildMeta({ imdbId, type, title, platform, releaseDate, overview,
                     rating, posterPath, backdropPath, genres, posterUrl, backdropUrl }) {
  let desc = '';
  if (overview)    desc += overview + '\n\n';
  if (platform)    desc += '📺 Streaming on: ' + platform;
  if (releaseDate) desc += '\n📅 Release: ' + releaseDate;
  if (rating)      desc += '\n⭐ Rating: ' + Number(rating).toFixed(1) + '/10';

  // ── KEY FIX: No placeholder posters ─────────────────────────────────────
  // If we don't have a poster, omit it entirely.
  // Stremio's metadata addons (Cinemeta, AIO Metadata) will provide the
  // correct poster when the user clicks the title.
  // A placeholder grey box is worse than no poster at all.
  let poster   = posterUrl || (posterPath   ? IMG + 'w500'  + posterPath   : undefined);
  let backdrop = backdropUrl || (backdropPath ? IMG + 'w1280' + backdropPath : undefined);

  const meta = {
    id:          imdbId,
    type,
    name:        title,
    releaseInfo: releaseDate || '',
    description: desc.trim(),
    poster,
    background:  backdrop,
    genres:      genres && genres.length ? genres : undefined,
  };
  Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);
  return meta;
}

// ── MOVIES ────────────────────────────────────────────────────────────────────
async function discoverMovies(lang, lookbackDays) {
  const dateFrom = daysAgo(lookbackDays);
  const results  = [];
  const langPfx  = lang + '_';

  for (let page = 1; page <= 5; page++) {
    try {
      const data = await tmdb(
        '/discover/movie?with_original_language=' + lang +
        '&watch_region=IN&with_watch_monetization_types=flatrate|free|ads' +
        '&sort_by=primary_release_date.desc' +
        '&primary_release_date.gte=' + dateFrom +
        '&primary_release_date.lte=' + today() +
        '&page=' + page
      );
      if (!data.results || !data.results.length) break;

      const newItems = data.results
        .filter(r => {
          // Accept correct language
          if (r.original_language === lang) return true;
          // Accept English-titled Indian content (Malayalam/Tamil docs often tagged 'en')
          if (r.original_language === 'en' && Array.isArray(r.origin_country) && r.origin_country.includes('IN')) return true;
          return false;
        })
        .filter(r => {
          const cached = readCacheEntry(movieCache[langPfx + r.id]);
          return cached === undefined; // only process uncached items
        });

      results.push(...newItems);
      console.log('[Discover] ' + lang + ' page ' + page + ': ' + data.results.length + ' found, ' + newItems.length + ' new');
      if (page >= (data.total_pages || 1) || newItems.length === 0) break;
    } catch (e) { console.warn('[Discover] Page ' + page + ': ' + e.message); break; }
  }
  return results;
}

async function processMovie(item, lang) {
  const langPfx  = lang + '_';
  const cacheKey = langPfx + item.id;
  const cached   = readCacheEntry(movieCache[cacheKey]);

  if (cached === 'skip')  return null;
  if (cached === 'retry') { /* fall through to retry */ }
  else if (cached)        return cached; // valid meta

  try {
    const detail = await tmdb('/movie/' + item.id + '?language=en-US&append_to_response=watch/providers');

    if (!detail.imdb_id) {
      setSkip(movieCache, cacheKey);
      console.log('[Skip] No IMDb ID: ' + (detail.title || ''));
      return null;
    }

    const IN  = detail['watch/providers'] && detail['watch/providers'].results && detail['watch/providers'].results.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];
    if (!all.length) {
      setSkip(movieCache, cacheKey);
      console.log('[Skip] Not on OTT/IN: ' + (detail.title || ''));
      return null;
    }

    const seenP    = new Set();
    const platform = all
      .filter(p => { if (seenP.has(p.provider_id)) return false; seenP.add(p.provider_id); return true; })
      .map(p => p.provider_name).join(', ');

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
    console.log('[Movie OK] ' + meta.name + ' (' + lang + ') -> ' + detail.imdb_id + ' on ' + platform);
    return meta;
  } catch (e) {
    setRetry(movieCache, cacheKey);
    console.warn('[Movie] Failed: ' + e.message);
    return null;
  }
}

async function scrapeMovies(lang) {
  const key      = lang + '_movie';
  const isFirst  = !seen[key];
  const lookback = isFirst ? MOVIE_FIRST_RUN : MOVIE_LOOKBACK;
  console.log('\n[Movies] ' + lang + ' | lookback: ' + lookback + 'd' + (isFirst ? ' (first run)' : ''));

  const newItems = await discoverMovies(lang, lookback);
  console.log('[Movies] ' + newItems.length + ' new to process');

  for (let i = 0; i < newItems.length; i++) {
    await processMovie(newItems[i], lang);
    if ((i+1) % 10 === 0) await new Promise(r => setTimeout(r, 300));
  }
  seen[key] = true;

  const langPfx = lang + '_';
  const result  = Object.entries(movieCache)
    .filter(([k, v]) => {
      if (!k.startsWith(langPfx)) return false;
      const c = readCacheEntry(v);
      return c && typeof c === 'object' && c.id && c.type === 'movie';
    })
    .map(([, v]) => {
      // Strip internal cache fields before returning
      const { _status, _at, _savedAt, ...clean } = (typeof v === 'object' ? v : {});
      return clean;
    })
    .filter(m => m.id)
    .sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''))
    .slice(0, 50);

  console.log('[Movies] ' + lang + ': ' + result.length + ' in catalogue');
  return result;
}

// ── SERIES ────────────────────────────────────────────────────────────────────
function parseCSVRow(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

async function fetchSheetSeries(filterLang) {
  if (!SHEET_URL) { console.warn('[Sheet] GOOGLE_SHEET_URL not set'); return []; }
  try {
    let url = SHEET_URL;
    if (url.includes('docs.google.com/spreadsheets')) {
      const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (id) url = 'https://docs.google.com/spreadsheets/d/' + id[1] + '/export?format=csv&gid=0';
    }
    console.log('[Sheet] Fetching...');
    const csv   = await fetchUrl(url);
    const lines = csv.trim().split('\n');
    const items = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const row      = parseCSVRow(lines[i]);
      const title    = (row[0] || '').trim();
      const lang     = (row[1] || '').toLowerCase();
      const platform = (row[2] || '').trim();
      const dateRaw  = (row[3] || '').trim();
      const imdbId   = (row[4] || '').trim();

      if (!title) continue;
      if (!lang.includes(filterLang.toLowerCase())) continue;
      if (!isReleased(dateRaw)) continue;

      // Normalise date to YYYY-MM-DD
      const d = parseAnyDate(dateRaw);
      const dateISO = d ? d.toISOString().slice(0, 10) : dateRaw;

      items.push({ title, platform, date: dateISO, imdbId });
    }

    console.log('[Sheet] ' + items.length + ' released ' + filterLang + ' series');
    return items;
  } catch (e) {
    console.warn('[Sheet] Failed: ' + e.message);
    await sendAlert('Google Sheet fetch failed: ' + e.message);
    return [];
  }
}

// ── SERIES ENRICHMENT ─────────────────────────────────────────────────────────
// DESIGN DECISION — why we never do title-search when we have an IMDb ID:
//
// "Land of Football" has IMDb ID tt37541677. TMDB /find returns nothing
// because TMDB hasn't indexed this new title yet. If we then search by
// title "Land of Football", TMDB matches a completely unrelated show and
// we get Mohiniyattam/SpongeBob metadata — worse than having no metadata.
//
// The correct approach:
// - Have IMDb ID + TMDB finds it → use TMDB metadata ✅
// - Have IMDb ID + TMDB doesn't find it → return just the IMDb ID,
//   let Cinemeta/AIO Metadata provide the real metadata ✅
// - No IMDb ID → search by title strictly (score >= 70 to prevent wrong matches) ✅
async function enrichSeries(imdbId, title, lang) {
  const cacheKey = imdbId && imdbId.startsWith('tt') ? imdbId : 'title_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
  const cached   = readCacheEntry(seriesCache[cacheKey]);

  if (cached === 'skip')  return null;
  if (cached === 'retry') { /* fall through */ }
  else if (cached)        return cached;

  try {
    let tvId = null;
    let resolvedImdbId = imdbId || null;
    let usedTitleSearch = false;

    // Step 1: If we have an IMDb ID, try TMDB /find (fast, 1 request)
    if (imdbId && imdbId.startsWith('tt')) {
      try {
        const data = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
        const tv   = (data.tv_results || [])[0];
        if (tv) {
          tvId = tv.id;
          console.log('[Find] ' + imdbId + ' -> TMDB ' + tvId);
        } else {
          // ── CRITICAL: TMDB doesn't have this IMDb ID yet ─────────────────
          // DO NOT fall through to title search.
          // Return a minimal result — the IMDb ID is enough for Stremio
          // to show the title. Cinemeta/AIO will provide poster + metadata.
          console.log('[Find] ' + imdbId + ' not yet indexed on TMDB — using IMDb ID only');
          setRetry(seriesCache, cacheKey); // retry next run in case TMDB indexes it
          return { imdbId, poster: null, backdrop: null, overview: '', rating: null, genres: [] };
        }
      } catch(e) {
        console.warn('[Find] ' + imdbId + ': ' + e.message);
        setRetry(seriesCache, cacheKey);
        return { imdbId, poster: null, backdrop: null, overview: '', rating: null, genres: [] };
      }
    }

    // Step 2: No IMDb ID — title search (strict threshold)
    if (!tvId) {
      usedTitleSearch = true;
      console.log('[Search] Looking up: ' + title);
      let best = null, bestScore = -1;

      for (const v of getTitleVariations(title)) {
        try {
          const data = await tmdb('/search/tv?query=' + encodeURIComponent(v) + '&language=en-US&page=1');
          for (const r of (data.results || [])) {
            let sc = 0;
            const rt = (r.name || '').toLowerCase(), vl = v.toLowerCase();
            if (rt === vl)              sc += 100;
            else if (rt.includes(vl))  sc += 40;
            else if (vl.includes(rt))  sc += 40;
            if (r.original_language === lang)                                   sc += 50;
            if (r.origin_country && r.origin_country.includes('IN'))            sc += 30;
            if (r.original_language !== lang && r.original_language !== 'en')   sc -= 50;
            // High threshold (70) to prevent wrong matches
            if (sc > bestScore && sc >= 70) { bestScore = sc; best = r; }
          }
          if (best && bestScore >= 100) break;
        } catch(e) {}
      }

      if (best) {
        tvId = best.id;
        console.log('[Search] Matched: ' + best.name + ' (score: ' + bestScore + ')');
      } else {
        console.log('[Search] No confident match for: ' + title);
        setSkip(seriesCache, cacheKey);
        return null;
      }
    }

    // Step 3: Fetch full TV details
    const detail = await tmdb('/tv/' + tvId + '?language=en-US');

    // Step 4: Get IMDb ID if we don't have it
    if (!resolvedImdbId) {
      try {
        const ext  = await tmdb('/tv/' + tvId + '/external_ids');
        resolvedImdbId = ext.imdb_id || null;
      } catch(e) {}
    }

    // Step 5: Get poster — TMDB first, then OMDb fallback
    let posterUrl  = detail.poster_path   ? IMG + 'w500'  + detail.poster_path   : null;
    let backdropUrl = detail.backdrop_path ? IMG + 'w1280' + detail.backdrop_path : null;

    if (!posterUrl) {
      console.log('[Poster] No TMDB poster for: ' + title + ' — trying OMDb');
      posterUrl = await fetchPosterFallback(title, resolvedImdbId, 'series');
    }

    const result = {
      imdbId:   resolvedImdbId,
      poster:   posterUrl   || null,
      backdrop: backdropUrl || null,
      overview: detail.overview || '',
      rating:   detail.vote_average || null,
      genres:   (detail.genres || []).map(g => g.name),
    };

    seriesCache[cacheKey] = result;
    cacheDirty = true;
    console.log('[Series OK] ' + title + ' -> ' + (resolvedImdbId || 'no IMDb') +
      (posterUrl ? ' (has poster)' : ' (no poster)'));
    return result;
  } catch (e) {
    console.warn('[Enrich] ' + (imdbId || title) + ': ' + e.message);
    setRetry(seriesCache, cacheKey);
    return null;
  }
}

async function scrapeSeries(lang) {
  const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';
  const items     = await fetchSheetSeries(langLabel);
  const skipped   = [];

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const metas = [];
  for (const item of items.slice(0, 50)) {
    const tmdbData    = await enrichSeries(item.imdbId, item.title, lang);
    const finalImdbId = item.imdbId || (tmdbData && tmdbData.imdbId) || null;

    if (!finalImdbId) {
      skipped.push(item.title);
      console.log('[Series] ⚠️  No IMDb ID: ' + item.title);
      continue;
    }

    const meta = buildMeta({
      imdbId:      finalImdbId,
      type:        'series',
      title:       item.title,
      platform:    item.platform,
      releaseDate: item.date,
      overview:    tmdbData && tmdbData.overview || '',
      rating:      tmdbData && tmdbData.rating   || null,
      posterUrl:   tmdbData && tmdbData.poster   || undefined,
      backdropUrl: tmdbData && tmdbData.backdrop || undefined,
      genres:      tmdbData && tmdbData.genres   || [],
    });

    metas.push(meta);
    console.log('[Series] ' + item.title + ' -> ' + finalImdbId +
      (meta.poster ? ' ✅ poster' : ' (no poster yet — metadata addon will fill)'));
    await new Promise(r => setTimeout(r, 100));
  }

  if (skipped.length > 0) {
    console.log('\n[Series] ⚠️  ' + skipped.length + ' skipped (no IMDb ID found):');
    skipped.forEach(t => console.log('   • ' + t));
    await sendAlert('Series skipped (no IMDb ID): ' + skipped.join(', '));
  }

  console.log('[Series] ' + lang + ': ' + metas.length + ' in catalogue');
  return metas;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  loadCache();
  try {
    const result = type === 'series' ? await scrapeSeries('ml') : await scrapeMovies('ml');
    saveCache();
    return result;
  } catch (e) {
    console.error('[scrapeMalayalam] ' + e.message);
    await sendAlert('Malayalam ' + type + ' failed: ' + e.message);
    saveCache(); return [];
  }
}

async function scrapeTamil(type) {
  loadCache();
  try {
    const result = type === 'series' ? await scrapeSeries('ta') : await scrapeMovies('ta');
    saveCache();
    return result;
  } catch (e) {
    console.error('[scrapeTamil] ' + e.message);
    await sendAlert('Tamil ' + type + ' failed: ' + e.message);
    saveCache(); return [];
  }
}

module.exports = { scrapeMalayalam, scrapeTamil, getHealthStatus };
