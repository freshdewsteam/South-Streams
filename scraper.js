/**
 * scraper.js — South Streams
 *
 * Movies  → Movie of the Night changes API (official day-0, primary)
 *           → JustWatch GraphQL newTitles (ALWAYS-ON safety net, 7 days)
 *           → 91mobiles editorial AJAX (7-day sweep, deep sweep only)
 *           → TMDB Auto-Discover (/discover/movie, foundation)
 * Series  → Movie of the Night changes API → JustWatch safety net
 *           → 91mobiles editorial AJAX (7-day sweep, deep sweep only)
 *           → TMDB Auto-Discover (/discover/tv, foundation)
 * Enrichment → TMDB / OMDb API (posters, descriptions, IMDb IDs)
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY       = process.env.TMDB_API_KEY       || '';
const OMDB_KEY       = process.env.OMDB_API_KEY       || '';
const WEBHOOK_URL    = process.env.WEBHOOK_URL         || '';
const MON_API_KEY    = process.env.MON_API_KEY         || '';
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY    || '';
const BASE           = 'https://api.themoviedb.org/3';
const IMG            = 'https://image.tmdb.org/t/p/';

const JW_GRAPHQL_URL = 'https://apis.justwatch.com/graphql';
const JW_DAYS_TO_SCAN = 7;

const MON_CHANGES_URL = 'https://api.movieofthenight.com/v4/changes';

const MOVIE_CACHE_FILE  = path.join(__dirname, 'data', 'movies-cache.json');
const SERIES_CACHE_FILE = path.join(__dirname, 'data', 'series-cache.json');

const MOVIE_LOOKBACK      = 30;
const MOVIE_DEEP_LOOKBACK = 90;
const MOVIE_FIRST_RUN     = 730;
const SKIP_TTL            = 14 * 24 * 60 * 60 * 1000;
const RETRY_TTL           =  3 * 24 * 60 * 60 * 1000;

const RERELEASE_MAX_AGE_DAYS = 90;

// ── PLATFORM NORMALIZATION HELPER ──
function cleanPlatformNames(platformStr) {
  if (!platformStr) return '';
  const map = {
    'amazon prime video': 'Prime Video',
    'amazon prime video with ads': 'Prime Video',
    'prime video': 'Prime Video',
    'manoramamax amazon channel': 'ManoramaMAX',
    'manoramamax': 'ManoramaMAX',
    'lionsgate play amazon channel': 'Lionsgate Play',
    'lionsgate play apple tv channel': 'Lionsgate Play',
    'lionsgate play': 'Lionsgate Play',
    'ap international south cinema amazon channel': 'AP International',
    'ultraplaybox amazon channel': 'Ultraplaybox',
    'chaupal amazon channel': 'Chaupal',
    'sun nxt': 'SunNXT',
    'sunnxt': 'SunNXT',
    'sony liv': 'Sony LIV',
    'sony liv ': 'Sony LIV',
    'sonyliv': 'Sony LIV',
    'jiohotstar': 'JioHotstar',
    'hotstar': 'JioHotstar',
    'zee5': 'Zee5',
    'netflix': 'Netflix',
    'aha': 'Aha'
  };

  const platforms = String(platformStr).split(',').map(p => p.trim()).filter(Boolean);
  const normalized = new Set();

  for (const p of platforms) {
    const key = p.toLowerCase();
    normalized.add(map[key] || p);
  }
  return Array.from(normalized).join(', ');
}

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

function readCacheEntry(entry) {
  if (entry === undefined) return undefined;
  if (entry === 'skip')  return 'skip';
  if (entry === 'retry') return 'retry';
  if (entry && typeof entry === 'object' && entry._status) {
    const age = Date.now() - (entry._at || 0);
    const ttl = entry._status === 'skip' ? SKIP_TTL : RETRY_TTL;
    if (age < ttl) return entry._status;
    return undefined;
  }
  if (entry && typeof entry === 'object' && entry.id) return entry;
  return undefined;
}

function setSkip(cacheObj, key)  { cacheObj[key] = { _status: 'skip',  _at: Date.now() }; cacheDirty = true; }
function setRetry(cacheObj, key) { cacheObj[key] = { _status: 'retry', _at: Date.now() }; cacheDirty = true; }

function getHealthStatus() {
  const mc = Object.values(movieCache).filter(v => v && typeof v === 'object' && v.id && !v._status).length;
  const sc = Object.values(seriesCache).filter(v => v && typeof v === 'object' && v.id && !v._status).length;
  console.log('[Health] ' + mc + ' movies, ' + sc + ' series');
  return { movies: mc, series: sc, total: mc + sc };
}

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
function fetchUrl(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign(
        { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'SouthStreams/2.0' },
        extraHeaders || {}
      ),
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

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = (typeof payload === 'string') ? payload : JSON.stringify(payload);
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (compatible; SouthStreamsAddon/2.0)',
        'App-Version': '3.8.0-web-web'
      }
    }, (res) => {
      let s = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      if (enc === 'br')   s = res.pipe(zlib.createBrotliDecompress());
      const c = [];
      s.on('data', d => c.push(d));
      s.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ': ' + text.slice(0, 300)));
        }
        resolve(text);
      });
      s.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { this.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
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
      if (String(e.message).includes('HTTP 404')) throw e;
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

function isDeepSweepHour() {
  const h = new Date().getUTCHours();
  return h >= 18 && h < 20;
}
const RUN_IS_DEEP = isDeepSweepHour();

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

function buildMeta({ imdbId, type, title, platform, releaseDate, overview,
                     rating, posterPath, backdropPath, genres, posterUrl, backdropUrl }) {
  let desc = '';
  if (overview)    desc += overview + '\n\n';
  if (platform)    desc += '📺 Streaming on: ' + cleanPlatformNames(platform);
  if (releaseDate) desc += '\n📅 Release: ' + releaseDate;
  if (rating)      desc += '\n⭐ Rating: ' + Number(rating).toFixed(1) + '/10';

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

// ── MOVIE OF THE NIGHT ────────────────────────────────────────────────────────
const monRawCache = { MOVIE: null, SHOW: null };

function monWindowStart(kind) {
  const now = Date.now();
  if (RUN_IS_DEEP) return now - 3 * 86400 * 1000;
  const last = seen['mon_' + kind];
  if (!last || isNaN(last)) return now - 3 * 86400 * 1000;
  return Math.max(last - 3600 * 1000, now - 12 * 3600 * 1000);
}

async function fetchMonRaw(kind) {
  if (!MON_API_KEY) return null;
  if (monRawCache[kind]) return monRawCache[kind];

  const showType = kind === 'SHOW' ? 'series' : 'movie';
  const fromUnix = Math.floor(monWindowStart(kind) / 1000);
  const maxPages = RUN_IS_DEEP ? 8 : 2;
  const changes   = [];
  const showsById = {};
  let cursor  = null;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      country: 'in',
      change_type: 'new',
      item_type: 'show',
      show_type: showType,
      from: String(fromUnix),
      order_direction: 'desc'
    });
    if (cursor) params.set('cursor', cursor);

    try {
      const text = await fetchUrl(MON_CHANGES_URL + '?' + params.toString(), { 'X-API-Key': MON_API_KEY });
      const data = JSON.parse(text);

      let showsList = [];
      if (Array.isArray(data.shows)) {
        showsList = data.shows;
      } else if (data.shows && typeof data.shows === 'object') {
        showsList = Object.entries(data.shows).map(([key, val]) => {
          if (val && typeof val === 'object') {
            if (val.id === undefined || val.id === null) val.id = key;
            return val;
          }
          return { id: key };
        });
      }

      for (const ch of (Array.isArray(data.changes) ? data.changes : [])) changes.push(ch);
      for (const sh of showsList) if (sh && sh.id !== undefined) showsById[String(sh.id)] = sh;

      if (!data.hasMore || !data.nextCursor) break;
      cursor = data.nextCursor;
    } catch (e) { break; }
  }

  if (!changes.length || !Object.keys(showsById).length) return null;

  seen['mon_' + kind] = Date.now();
  cacheDirty = true;
  monRawCache[kind] = { changes, showsById };
  return monRawCache[kind];
}

async function resolveMonForLang(raw, lang, kind) {
  const items     = [];
  const seenIds   = new Set();
  const latestByShow = new Map();

  for (const ch of raw.changes) {
    if (!ch || ch.showId === undefined) continue;
    const opt = ch.streamingOptionType;
    if (opt && opt !== 'subscription' && opt !== 'free' && opt !== 'ads' && opt !== 'addon') continue;
    const sid = String(ch.showId);
    if (!latestByShow.has(sid)) latestByShow.set(sid, ch);
  }

  for (const [sid, ch] of latestByShow) {
    const sh = raw.showsById[sid];
    if (!sh) continue;

    const title = (sh.originalTitle || sh.title || '').trim();
    if (!title) continue;
    if (sh.originalLanguage && String(sh.originalLanguage).toLowerCase() !== lang) continue;

    const arrivalDate = ch.timestamp
      ? new Date(ch.timestamp * 1000).toISOString().slice(0, 10)
      : today();

    const isNewSeason = ch.itemType === 'season' && (ch.season || 0) >= 2;
    const tmdbId = (sh.tmdbId !== undefined && sh.tmdbId !== null) ? parseInt(sh.tmdbId, 10) : NaN;
    const imdbId = sh.imdbId || null;
    const year   = sh.releaseYear || null;

    if (!isNaN(tmdbId) && tmdbId > 0) {
      if (!seenIds.has(tmdbId)) { seenIds.add(tmdbId); items.push({ id: tmdbId, arrivalDate, title, imdbId, year, isNewSeason }); }
      continue;
    }

    if (imdbId) {
      try {
        const data = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
        const hit  = kind === 'SHOW' ? (data.tv_results || [])[0] : (data.movie_results || [])[0];
        if (hit && !seenIds.has(hit.id)) { seenIds.add(hit.id); items.push({ id: hit.id, arrivalDate, title, imdbId, year, isNewSeason }); }
        continue;
      } catch (e) {}
    }

    const retryStore = kind === 'SHOW' ? seriesCache : movieCache;
    const retryKey = 'mon_' + kind.toLowerCase() + '_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
    if (readCacheEntry(retryStore[retryKey]) === 'retry') continue;

    try {
      let r = null;
      if (kind === 'SHOW') {
        const yearParam = year ? '&first_air_date_year=' + year : '';
        const data = await tmdb('/search/tv?query=' + encodeURIComponent(title) + '&language=en-US&page=1' + yearParam);
        r = (data.results || [])[0];
      } else {
        const yearParam = year ? '&primary_release_year=' + year : '';
        const data = await tmdb('/search/movie?query=' + encodeURIComponent(title) + '&language=en-US&page=1' + yearParam);
        r = (data.results || [])[0];
      }
      if (r && !seenIds.has(r.id)) { seenIds.add(r.id); items.push({ id: r.id, arrivalDate, title, imdbId, year, isNewSeason }); }
      else { setRetry(retryStore, retryKey); }
    } catch (e) {}
  }

  return items;
}

// ── JUSTWATCH SAFETY NET ──────────────────────────────────────────────────────
const JW_NEW_QUERY_MOVIE_RICH = `
query JwNew($country: Country!, $date: Date!, $language: Language!, $filter: TitleFilter, $first: Int!, $after: String) {
  newTitles(country: $country, date: $date, filter: $filter, after: $after, first: $first, priceDrops: false, pageType: NEW) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        __typename
        ... on MovieOrSeason {
          objectType
          content(country: $country, language: $language) {
            title
            shortDescription
            fullPath
            originalReleaseYear
            externalIds { imdbId tmdbId }
            isReleased
          }
        }
      }
    }
  }
}`;

const JW_NEW_QUERY_SHOW_RICH = `
query JwNew($country: Country!, $date: Date!, $language: Language!, $filter: TitleFilter, $first: Int!, $after: String) {
  newTitles(country: $country, date: $date, filter: $filter, after: $after, first: $first, priceDrops: false, pageType: NEW) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        __typename
        ... on MovieOrSeason {
          objectType
          content(country: $country, language: $language) {
            title
            shortDescription
            fullPath
            originalReleaseYear
            externalIds { imdbId tmdbId }
            isReleased
          }
          ... on Season {
            show {
              objectId
              content(country: $country, language: $language) {
                title
                fullPath
                originalReleaseYear
                externalIds { imdbId tmdbId }
              }
            }
          }
        }
      }
    }
  }
}`;

function extractJwIdentifiers(node, kind) {
  if (!node) return null;
  if (kind === 'SHOW' && node.show && node.show.content) {
    const sc = node.show.content;
    return {
      title: (sc.title || '').trim(),
      tmdbId: sc.externalIds && sc.externalIds.tmdbId ? parseInt(sc.externalIds.tmdbId, 10) : NaN,
      imdbId: sc.externalIds && sc.externalIds.imdbId ? sc.externalIds.imdbId : null,
      year: sc.originalReleaseYear || null,
      isReleased: node.content ? node.content.isReleased !== false : true,
    };
  }
  const c = node.content;
  if (!c) return null;
  return {
    title: (c.title || '').trim(),
    tmdbId: c.externalIds && c.externalIds.tmdbId ? parseInt(c.externalIds.tmdbId, 10) : NaN,
    imdbId: c.externalIds && c.externalIds.imdbId ? c.externalIds.imdbId : null,
    year: c.originalReleaseYear || null,
    isReleased: c.isReleased !== false,
  };
}

async function jwNewTitlesForDate(dateStr, filter, kind) {
  const collected = [];
  let after = null;

  for (let page = 0; page < 3; page++) {
    const query = (kind === 'SHOW' ? JW_NEW_QUERY_SHOW_RICH : JW_NEW_QUERY_MOVIE_RICH);
    const payload = JSON.stringify({
      operationName: 'JwNew',
      query: query,
      variables: { country: 'IN', date: dateStr, language: 'en', first: 50, after: after, filter }
    });
    const text = await postJson(JW_GRAPHQL_URL, payload);
    const data = JSON.parse(text);
    const conn = data.data && data.data.newTitles;
    if (!conn) break;
    for (const e of (conn.edges || [])) {
      if (e && e.node) collected.push(e.node);
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return collected;
}

async function fetchJustWatch(lang, kind) {
  const contents = [];
  const seenKeys = new Set();

  for (let d = 0; d < JW_DAYS_TO_SCAN; d++) {
    const dateStr = daysAgo(d);
    try {
      const nodes = await jwNewTitlesForDate(dateStr, { objectTypes: [kind] }, kind);
      for (const node of nodes) {
        if (kind === 'SHOW' && node.objectType === 'MOVIE') continue;
        if (kind === 'MOVIE' && node.objectType && node.objectType !== 'MOVIE') continue;

        const ids = extractJwIdentifiers(node, kind);
        if (!ids || !ids.title || !ids.isReleased) continue;

        const key = (node.content && node.content.fullPath) || (ids.title + '|' + (isNaN(ids.tmdbId) ? '' : ids.tmdbId));
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        ids._arrivalDate = dateStr;
        contents.push(ids);
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }

  const resolved = [];
  const seenIds  = new Set();

  for (const c of contents) {
    if (!isNaN(c.tmdbId) && c.tmdbId > 0) {
      if (!seenIds.has(c.tmdbId)) { seenIds.add(c.tmdbId); resolved.push({ id: c.tmdbId, arrivalDate: c._arrivalDate, title: c.title, imdbId: c.imdbId, year: c.year }); }
      continue;
    }
    if (c.imdbId) {
      try {
        const data = await tmdb('/find/' + c.imdbId + '?external_source=imdb_id');
        const hit  = kind === 'SHOW' ? (data.tv_results || [])[0] : (data.movie_results || [])[0];
        if (hit && !seenIds.has(hit.id)) { seenIds.add(hit.id); resolved.push({ id: hit.id, arrivalDate: c._arrivalDate, title: c.title, imdbId: c.imdbId, year: c.year }); }
        continue;
      } catch (e) {}
    }
  }

  return resolved;
}

// ── 91MOBILES (7-DAY REGULAR SWEEP) ───────────────────────────────────────────
const M91_AJAX_URL = 'https://www.91mobiles.com/entertainment/web/list_ajax.php';
const M91_LANG_ID  = { ml: 28, ta: 63 };
const M91_LOOKBACK_DAYS = 7;
const M91_PAGES = {
  ml: { movie: 'new-malayalam-movies', series: 'new-malayalam-web-series' },
  ta: { movie: 'new-tamil-movies',     series: 'new-tamil-web-series' },
};
const M91_LANG_LABEL = { ml: 'malayalam', ta: 'tamil' };

function m91StripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function m91FetchHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36',
    'Accept': 'text/html, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://www.91mobiles.com/entertainment/',
  };
}

function m91UnwrapBody(raw) {
  let body = raw;
  if (body.trim().startsWith('{')) {
    try {
      const j = JSON.parse(body);
      if (j.response) body = j.response;
    } catch (e) {}
  }
  return body.replace(/\\"/g, '"').replace(/\\\//g, '/')
             .replace(/\\u003C/gi, '<').replace(/\\u003E/gi, '>').replace(/\\n/g, '\n');
}

async function m91FetchItems(slug, kind, lang) {
  const isShow = kind === 'SHOW';
  const params = new URLSearchParams({
    qp: 'contentTypes:' + (isShow ? 'show' : 'movie') + '~languages:' + M91_LANG_ID[lang],
    sortOrder: 'desc',
    sortBy: 'ottReleaseDate',
    start: '1',
    seoSlug: '/' + slug,
    pType: slug,
    dubbedVal: 'notDubbed',
    type: 'loadmore'
  });
  const target = M91_AJAX_URL + '?' + params.toString();

  if (SCRAPERAPI_KEY) {
    try {
      const wrapped = 'https://api.scraperapi.com/?api_key=' + SCRAPERAPI_KEY +
                      '&country_code=in&url=' + encodeURIComponent(target);
      const body = m91UnwrapBody(await fetchUrl(wrapped, m91FetchHeaders()));
      if (/<div\s+class="?pro_item/.test(body)) return body;
    } catch (e) {}
  }

  try {
    const body = m91UnwrapBody(await fetchUrl(target, m91FetchHeaders()));
    if (/<div\s+class="?pro_item/.test(body)) return body;
  } catch (e) {}

  return '';
}

function m91ParsePage(html, langLabel, requireOttMarker) {
  const items = [];
  const blocks = html.split(/<div\s+class="?pro_item/).slice(1);

  for (const block of blocks) {
    const tMatch = block.match(/<a[^>]+title="([^"]+)"[^>]*class="txt-white/);
    if (!tMatch) continue;
    const title = tMatch[1].trim();

    const metaMatch = block.match(/<p class="d-in-block f-s-m">([^<]+)<\/p>/);
    if (!metaMatch) continue;
    const meta = m91StripTags(metaMatch[1]);

    const parts = meta.split('|').map(p => p.trim());
    if ((parts[0] || '').toLowerCase() !== langLabel) continue;

    const dateMatch = meta.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (!dateMatch) continue;
    const date = parseAnyDate(dateMatch[0]);
    if (!date || !isReleased(date)) continue;

    const ageDays = (Date.now() - date.getTime()) / 86400000;
    if (ageDays > M91_LOOKBACK_DAYS) continue;

    if (requireOttMarker && !/\(OTT\)/i.test(meta)) continue;

    const platforms = [];
    const wtsIdx = block.indexOf('Where To Stream');
    if (wtsIdx !== -1) {
      const tail = block.slice(wtsIdx, wtsIdx + 2000);
      const pRe = /<div[^>]*class="[^"]*target_link_ext[^"]*"[^>]*>([^<]+)</g;
      let pm;
      while ((pm = pRe.exec(tail)) !== null) {
        const name = pm[1].trim();
        if (name && !platforms.includes(name)) platforms.push(name);
      }
    }

    const bodyText = m91StripTags(block);
    const isNewSeason = /\bnew season\b|\bnew episode\b/i.test(bodyText);

    items.push({ title, date, year: dateMatch[3], platform: platforms.join(', '), isNewSeason });
  }

  return items;
}

async function fetch91Mobiles(lang, kind) {
  const isShow = kind === 'SHOW';
  const slug = M91_PAGES[lang] && M91_PAGES[lang][isShow ? 'series' : 'movie'];
  if (!slug) return [];

  try {
    const body = await m91FetchItems(slug, kind, lang);
    const items = m91ParsePage(body, M91_LANG_LABEL[lang], !isShow);

    const resolved = [];
    const seenIds = new Set();

    for (const item of items) {
      const endpoint = isShow ? '/search/tv?query=' : '/search/movie?query=';
      let r = null;
      for (const v of getTitleVariations(item.title)) {
        try {
          const data = await tmdb(endpoint + encodeURIComponent(v) + '&language=en-US&page=1');
          const candidates = (data.results || []).filter(x =>
            x.original_language === lang || (Array.isArray(x.origin_country) && x.origin_country.includes('IN'))
          );
          if (candidates.length) { r = candidates[0]; break; }
        } catch (e) {}
      }

      if (r && !seenIds.has(r.id)) {
        seenIds.add(r.id);
        resolved.push({
          id: r.id,
          arrivalDate: item.date.toISOString().slice(0, 10),
          title: item.title,
          imdbId: null,
          year: item.year,
          isNewSeason: item.isNewSeason,
          trustedPlatform: cleanPlatformNames(item.platform) || undefined,
        });
      }
      await new Promise(res => setTimeout(res, 80));
    }

    return resolved;
  } catch (e) {
    return [];
  }
}

async function fetchDay0Items(lang, kind) {
  const byId = new Map();

  const monRaw = await fetchMonRaw(kind);
  if (monRaw) {
    for (const it of await resolveMonForLang(monRaw, lang, kind)) {
      if (!byId.has(it.id)) byId.set(it.id, it);
    }
  }

  try {
    for (const it of await fetchJustWatch(lang, kind)) {
      if (!byId.has(it.id)) byId.set(it.id, it);
    }
  } catch (e) {}

  if (RUN_IS_DEEP) {
    try {
      for (const it of await fetch91Mobiles(lang, kind)) {
        if (!byId.has(it.id)) byId.set(it.id, it);
      }
    } catch (e) {}
  }

  return Array.from(byId.values());
}

// ── TMDB DISCOVER ─────────────────────────────────────────────────────────────
async function discoverMovies(lang, lookbackDays, maxPages) {
  maxPages = maxPages || 5;
  const dateFrom = daysAgo(lookbackDays);
  const results  = [];

  for (let page = 1; page <= maxPages; page++) {
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

      const newItems = data.results.filter(r => {
        if (r.original_language === lang) return true;
        if (r.original_language === 'en' && Array.isArray(r.origin_country) && r.origin_country.includes('IN')) return true;
        return false;
      });

      results.push(...newItems);
      if (page >= (data.total_pages || 1) || newItems.length === 0) break;
    } catch (e) { break; }
  }
  return results;
}

async function discoverSeries(lang, maxPages) {
  maxPages = maxPages || 5;
  const results = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const data = await tmdb(
        '/discover/tv?with_original_language=' + lang +
        '&watch_region=IN&with_watch_monetization_types=flatrate|free|ads' +
        '&sort_by=first_air_date.desc' +
        '&page=' + page
      );
      if (!data.results || !data.results.length) break;

      const newItems = data.results.filter(r => r.original_language === lang);
      results.push(...newItems);
      if (page >= (data.total_pages || 1) || newItems.length === 0) break;
    } catch (e) { break; }
  }
  return results;
}

async function processMovie(item, lang, expectedLang, strictLang) {
  const langPfx  = lang + '_';
  const cacheKey = langPfx + item.id;
  const cached   = readCacheEntry(movieCache[cacheKey]);

  if (cached === 'skip') return null;
  if (cached && cached !== 'retry') return cached;

  try {
    const detail = await tmdb('/movie/' + item.id + '?language=en-US&append_to_response=watch/providers');
    if (!detail.imdb_id) { setRetry(movieCache, cacheKey); return null; }

    if (expectedLang && detail.original_language &&
        detail.original_language !== expectedLang &&
        (strictLang || detail.original_language !== 'en')) {
      setSkip(movieCache, cacheKey);
      return null;
    }

    const IN  = detail['watch/providers'] && detail['watch/providers'].results && detail['watch/providers'].results.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];

    let platform;
    if (all.length) {
      const seenP = new Set();
      platform = cleanPlatformNames(
        all.filter(p => { if (seenP.has(p.provider_id)) return false; seenP.add(p.provider_id); return true; })
           .map(p => p.provider_name).join(', ')
      );
    } else if (item.trustedPlatform) {
      platform = cleanPlatformNames(item.trustedPlatform);
    } else {
      setRetry(movieCache, cacheKey);
      return null;
    }

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
    return meta;
  } catch (e) {
    setRetry(movieCache, cacheKey);
    return null;
  }
}

async function processSeriesJW(item, lang) {
  const cacheKey = lang + '_series_' + item.id;
  const cached   = readCacheEntry(seriesCache[cacheKey]);

  if (cached === 'skip') return null;
  if (cached && cached !== 'retry') return cached;

  try {
    let tmdbId = item.id;
    let detail = null;

    try {
      detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers');
    } catch (e) {
      if (!String(e.message).includes('HTTP 404')) throw e;
    }

    if (!detail && item.imdbId) {
      try {
        const data = await tmdb('/find/' + item.imdbId + '?external_source=imdb_id');
        const tv   = (data.tv_results || [])[0];
        if (tv) {
          tmdbId = tv.id;
          detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers');
        }
      } catch (e) {}
    }

    if (!detail && item.title) {
      try {
        const yearParam = item.year ? '&first_air_date_year=' + item.year : '';
        const data = await tmdb('/search/tv?query=' + encodeURIComponent(item.title) + '&language=en-US&page=1' + yearParam);
        const tv   = (data.results || [])[0];
        if (tv) {
          tmdbId = tv.id;
          detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers');
        }
      } catch (e) {}
    }

    if (!detail) { setRetry(seriesCache, cacheKey); return null; }

    if (!detail.original_language || detail.original_language !== lang) {
      setSkip(seriesCache, cacheKey);
      return null;
    }

    let imdbId = null;
    try {
      const ext = await tmdb('/tv/' + tmdbId + '/external_ids');
      imdbId = ext.imdb_id || null;
    } catch(e) {}
    if (!imdbId) { setRetry(seriesCache, cacheKey); return null; }

    const IN  = detail['watch/providers'] && detail['watch/providers'].results && detail['watch/providers'].results.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];
    const platform = cleanPlatformNames(
      all.length
        ? all.filter((p, i, arr) => arr.findIndex(x => x.provider_id === p.provider_id) === i).map(p => p.provider_name).join(', ')
        : (item.trustedPlatform || '')
    );

    // Prefer last_air_date so newly airing seasons/episodes sort to the current year
    const latestAirDate = detail.last_air_date || detail.first_air_date || item.arrivalDate || today();

    const meta = buildMeta({
      imdbId:      imdbId,
      type:        'series',
      title:       detail.name || '',
      platform,
      releaseDate: latestAirDate,
      overview:    detail.overview || '',
      rating:      detail.vote_average,
      posterPath:  detail.poster_path,
      backdropPath: detail.backdrop_path,
      genres:      (detail.genres || []).map(g => g.name),
    });

    seriesCache[cacheKey] = meta;
    cacheDirty = true;
    return meta;
  } catch (e) {
    setRetry(seriesCache, cacheKey);
    return null;
  }
}

// ── ORCHESTRATORS ─────────────────────────────────────────────────────────────
async function scrapeMovies(lang) {
  const metas = [];
  const processedImdbIds = new Set();

  for (const [cacheKey, val] of Object.entries(movieCache)) {
    if (!cacheKey.startsWith(lang + '_')) continue;
    const entry = readCacheEntry(val);
    if (entry && typeof entry === 'object' && entry.id && entry.id.startsWith('tt') &&
        entry.type === 'movie' && !processedImdbIds.has(entry.id)) {
      metas.push(entry);
      processedImdbIds.add(entry.id);
    }
  }

  const day0Items = await fetchDay0Items(lang, 'MOVIE');
  for (const day0Item of day0Items) {
    const cacheKey = lang + '_' + day0Item.id;
    const cachedEntry    = readCacheEntry(movieCache[cacheKey]);
    const isNewDiscovery = cachedEntry === undefined || cachedEntry === 'retry';

    const meta = await processMovie(day0Item, lang, lang, true);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      if (isNewDiscovery) {
        const arrivalDate = day0Item.arrivalDate || today();
        const tmdbDate    = meta.releaseInfo || arrivalDate;
        const ageMs       = Date.now() - new Date(tmdbDate).getTime();
        const isRerelease = !isNaN(ageMs) && ageMs > RERELEASE_MAX_AGE_DAYS * 24 * 3600 * 1000;

        if (isRerelease) {
          meta.description = ((meta.description || '') + '\n\n♻️ Re-release: back on OTT on ' + arrivalDate).trim();
        } else {
          meta.releaseInfo = arrivalDate;
        }

        movieCache[cacheKey] = meta;
        cacheDirty = true;
      }
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
  }

  const lookback = RUN_IS_DEEP ? MOVIE_DEEP_LOOKBACK : MOVIE_LOOKBACK;
  const discoverPages = RUN_IS_DEEP ? 12 : 5;
  const tmdbItems = await discoverMovies(lang, lookback, discoverPages);
  for (const item of tmdbItems) {
    const meta = await processMovie(item, lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
  }

  metas.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));
  const finalResult = metas.slice(0, 120);
  console.log('[Movies] ' + lang + ': ' + finalResult.length + ' in catalogue');
  return finalResult;
}

async function scrapeSeries(lang) {
  const metas = [];
  const processedImdbIds = new Set();

  for (const [cacheKey, val] of Object.entries(seriesCache)) {
    if (!cacheKey.startsWith(lang + '_series_')) continue;
    const entry = readCacheEntry(val);
    if (entry && typeof entry === 'object' && entry.id && entry.id.startsWith('tt') &&
        entry.type === 'series' && !processedImdbIds.has(entry.id)) {
      metas.push(entry);
      processedImdbIds.add(entry.id);
    }
  }

  const day0Items = await fetchDay0Items(lang, 'SHOW');
  for (const day0Item of day0Items) {
    const cacheKey = lang + '_series_' + day0Item.id;
    const cachedEntry    = readCacheEntry(seriesCache[cacheKey]);
    const isNewDiscovery = cachedEntry === undefined || cachedEntry === 'retry';

    const meta = await processSeriesJW(day0Item, lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      if (isNewDiscovery) {
        const arrivalDate = day0Item.arrivalDate || today();
        const firstAir    = meta.releaseInfo || arrivalDate;
        const ageMs       = Date.now() - new Date(firstAir).getTime();
        const isNewSeason = day0Item.isNewSeason === true;
        const isRerelease = !isNewSeason && !isNaN(ageMs) && ageMs > RERELEASE_MAX_AGE_DAYS * 24 * 3600 * 1000;

        if (isRerelease) {
          meta.description = ((meta.description || '') + '\n\n♻️ Re-release: back on OTT on ' + arrivalDate).trim();
        } else {
          meta.releaseInfo = arrivalDate;
        }

        seriesCache[cacheKey] = meta;
        cacheDirty = true;
      }
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
  }

  const tmdbSeries = await discoverSeries(lang, 5);
  for (const item of tmdbSeries) {
    const meta = await processSeriesJW(item, lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
  }

  metas.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));
  const finalResult = metas.slice(0, 80);
  console.log('[Series] ' + lang + ': ' + finalResult.length + ' in catalogue');
  return finalResult;
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
    saveCache(); return [];
  }
}

module.exports = { scrapeMalayalam, scrapeTamil, getHealthStatus };
