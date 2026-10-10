/**
 * scraper.js — South Streams (v11)
 *
 * Day-0 authority : 91mobiles "filter" XHR (the endpoint the live webpage uses),
 *                   ONE combined ml+ta request per kind; direct-first with a
 *                   freshness gate — escalates to Indian-IP proxy (ZenRows →
 *                   ScraperAPI) ONLY when the direct result is stale
 * Backups         : public webpage + legacy loadmore AJAX (free, direct only)
 * Fallback        : TMDB Discover (recent releases; premieres + airing for series)
 * Enrichment      : Cinemeta first (episodes, cast, runtime, trailers), TMDB + OMDb fallback
 * Manual fixes    : overrides.json (pin IDs, OTT dates, add or hide titles)
 * Reporting       : every dropped title → data/unmatched.json (+ WEBHOOK_URL alert)
 *
 * v12: unmatched report, overrides.json, Cinemeta-first metadata, 91mobiles
 * OTT date authority for movies, age trimming (18 mo movies / 24 mo series).
 * v11: ZenRows support (ZENROWS_API_KEY), combined-language filter request,
 * freshness-gated escalation to proxy, backups demoted to free direct fetches.
 * v10: filter XHR as primary source; v9: cert-suffix stripping, (OTT) tag as
 * platform; v7: ambiguity rejection; v6: all OTT platforms accepted.
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY       = process.env.TMDB_API_KEY     || '';
const OMDB_KEY       = process.env.OMDB_API_KEY     || '';
const ZENROWS_KEY    = process.env.ZENROWS_API_KEY  || '';
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY   || '';
const BASE           = 'https://api.themoviedb.org/3';
const IMG            = 'https://image.tmdb.org/t/p/';

const MOVIE_CACHE_FILE  = path.join(__dirname, 'data', 'movies-cache.json');
const SERIES_CACHE_FILE = path.join(__dirname, 'data', 'series-cache.json');

// Theatrical→OTT windows are 4–8 weeks, so a 30-day window misses most
// theatrical films (e.g. Khalifa: theatres 20 Aug, OTT 9 Oct = 50 days).
const MOVIE_LOOKBACK      = 75;
const MOVIE_DEEP_LOOKBACK = 90;
const MOVIE_FIRST_RUN     = 730;
const SKIP_TTL            = 14 * 24 * 60 * 60 * 1000;
const RETRY_TTL           =  3 * 24 * 60 * 60 * 1000;

// Catalogue trimming — titles older than this (by OTT date) are hidden.
// Series also stay while their latest episode is within the window.
const MOVIE_MAX_AGE_DAYS  = 540;  // ~18 months
const SERIES_MAX_AGE_DAYS = 730;  // ~24 months

// Cinemeta (Stremio's IMDb-based metadata) — preferred source for episode
// lists and extra details (cast, runtime, trailers). TMDB is the fallback.
const CINEMETA_URL         = 'https://v3-cinemeta.strem.io/meta/';
// Movie details (cast, runtime, trailers) barely change; IMDb rating drifts slowly.
const CINEMETA_TTL_MOVIE   = 45 * 86400 * 1000;
// Series Cinemeta data follows the show's episode timer (see episodeTtl).
const CINEMETA_TTL_SERIES  = 4 * 3600 * 1000;
// Not on Cinemeta yet — new titles usually get indexed within a day.
const CINEMETA_TTL_MISSING = 24 * 3600 * 1000;

function cutoffDate(days) {
  const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10);
}

// ── MANUAL OVERRIDES (overrides.json in the repo root) ───────────────────────
// See overrides.json for the format. Loaded once per build.
const OVERRIDES_FILE = path.join(__dirname, 'overrides.json');
let overrides = [];
try {
  if (fs.existsSync(OVERRIDES_FILE)) {
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    overrides = (Array.isArray(raw.titles) ? raw.titles : []).filter(o => o && typeof o === 'object');
    console.log('[Overrides] ' + overrides.length + ' entries loaded');
  }
} catch (e) {
  console.error('[Overrides] ❌ overrides.json is not valid JSON — ignoring it: ' + e.message);
}

function ovrType(kind) { return kind === 'SHOW' || kind === 'series' ? 'series' : 'movie'; }
function ovrTypeOk(o, type) { return !o.type || o.type === type; }
function overrideByTitle(title, type) {
  const n = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return null;
  return overrides.find(o => o.title && ovrTypeOk(o, type) &&
    String(o.title).toLowerCase().replace(/[^a-z0-9]/g, '') === n) || null;
}
function overrideByTmdb(tmdbId, type) {
  return overrides.find(o => o.tmdb && String(o.tmdb) === String(tmdbId) && ovrTypeOk(o, type)) || null;
}
function overrideByImdb(imdbId, type) {
  return overrides.find(o => o.imdb && o.imdb === imdbId && ovrTypeOk(o, type)) || null;
}
function isHidden(meta) {
  const type = meta.type;
  const byId = overrideByImdb(meta.id, type);
  if (byId && byId.hide) return true;
  const byTitle = overrideByTitle(meta.name, type);
  return !!(byTitle && byTitle.hide && !byTitle.imdb);
}

// ── UNMATCHED REPORT (no more silent drops) ──────────────────────────────────
// Every title a source offered that did NOT make it into the catalogue is
// recorded here with the reason; build-cache.js writes it to
// data/unmatched.json and (optionally) alerts the WEBHOOK_URL.
const unmatched = [];
let lastFailReason = '';
function noteUnmatched(lang, type, title, reason, extra) {
  const key = lang + '|' + type + '|' + String(title || '').toLowerCase();
  if (unmatched.some(u => u._key === key)) return;
  unmatched.push(Object.assign({ _key: key, lang, type, title: title || '?', reason }, extra || {}));
}
function getUnmatched() { return unmatched.map(({ _key, ...rest }) => rest); }

if (!TMDB_KEY) console.error('[Config] ❌ TMDB_API_KEY is NOT set — nothing will work');
if (!OMDB_KEY) console.warn('[Config] ⚠️ OMDB_API_KEY not set — some IMDb IDs will be unresolvable');
if (!ZENROWS_KEY && !SCRAPERAPI_KEY) console.warn('[Config] ⚠️ No proxy key set (ZENROWS_API_KEY / SCRAPERAPI_KEY) — if 91mobiles serves stale data to the runner, fresh titles cannot be fetched');

// ── PLATFORMS: accept ALL OTT platforms; reject only ticketing sites ─────────
const THEATRICAL_REGEX = /\b(bookmyshow|paytm|pvr|inox|cin[eé]polis|ticketnew|justickets)\b/i;

function cleanPlatformNames(rawStr) {
  if (!rawStr) return '';
  const parts = String(rawStr).split(/[|,]/).map(s => s.trim()).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const p of parts) {
    if (THEATRICAL_REGEX.test(p)) continue;
    const key = p.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key); out.push(p);
  }
  return out.join(', ');
}

function platformLineOf(description) {
  if (!description) return '';
  const m = String(description).match(/📺\s*Streaming on:\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}

function isUnusableEntry(description) {
  return cleanPlatformNames(platformLineOf(description)).length === 0;
}

// ── CACHE ─────────────────────────────────────────────────────────────────────
let movieCache  = {};
let seriesCache = {};
let cacheDirty  = false;

function loadCache() {
  try {
    if (fs.existsSync(MOVIE_CACHE_FILE)) {
      const raw  = JSON.parse(fs.readFileSync(MOVIE_CACHE_FILE, 'utf8'));
      movieCache = raw._data || {};
      console.log('[Cache] Movies: ' + Object.keys(movieCache).length + ' entries');
    }
    if (fs.existsSync(SERIES_CACHE_FILE)) {
      const raw   = JSON.parse(fs.readFileSync(SERIES_CACHE_FILE, 'utf8'));
      seriesCache = raw._data || {};
      console.log('[Cache] Series: ' + Object.keys(seriesCache).length + ' entries');
    }
  } catch (e) {
    console.warn('[Cache] Load failed: ' + e.message);
    movieCache = {}; seriesCache = {};
  }
}

function saveCache() {
  if (!cacheDirty) return;
  try {
    const dir = path.dirname(MOVIE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MOVIE_CACHE_FILE,  JSON.stringify({ _data: movieCache },  null, 2));
    fs.writeFileSync(SERIES_CACHE_FILE, JSON.stringify({ _data: seriesCache }, null, 2));
    console.log('[Cache] Saved ' + Object.keys(movieCache).length + ' movies, ' + Object.keys(seriesCache).length + ' series');
    cacheDirty = false;
  } catch (e) {
    console.warn('[Cache] Save failed: ' + e.message);
  }
}

function readCacheEntry(entry) {
  if (entry === undefined) return undefined;
  if (entry === 'skip' || entry === 'retry') return entry;
  if (entry && typeof entry === 'object' && entry._status) {
    const age = Date.now() - (entry._at || 0);
    const ttl = entry._status === 'skip' ? SKIP_TTL : RETRY_TTL;
    return age < ttl ? entry._status : undefined;
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

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchUrl(url, extraHeaders, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: Object.assign(
        { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'SouthStreams/2.0' },
        extraHeaders || {}
      ),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrl(next, extraHeaders, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
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
    req.setTimeout(20000, function() { this.destroy(new Error('Timeout')); });
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
        console.log('[Rate] Pausing ' + Math.ceil(wait / 1000) + 's...');
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
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
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

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function today()    { return new Date().toISOString().slice(0, 10); }

function isDeepSweepHour() {
  // The 18:01 UTC cron is often delayed by GitHub (runs seen at 22:33, 23:15),
  // so accept any run from 18:00 UTC to midnight as the deep sweep.
  if (process.env.DEEP_SWEEP === '1') return true; // manual "deep" run
  const h = new Date().getUTCHours();
  return h >= 18;
}
const RUN_IS_DEEP = isDeepSweepHour();

function m91CleanTitle(t) {
  let s = String(t || '').trim();
  const before = s;
  s = s.replace(/\s*\(\s*(?:u\/a|ua|u|a|pg)\s*(?:[-–]?\s*\d+\+?)?\s*\)\s*$/i, '');
  if (s === before) s = s.replace(/\s*\(\s*[^)]*\)\s*$/, '');
  return s.trim() || String(t || '').trim();
}

function getTitleVariations(title) {
  const v = new Set();
  v.add(title);
  v.add(title.replace(/\s*\([^)]*\)\s*$/, '').trim());
  v.add(title.replace(/\b2\b/g, 'II'));
  v.add(title.replace(/\bII\b/g, '2'));
  v.add(title.replace(/[:\-].*$/, '').trim());
  v.add(title.replace(/\band\b/gi, '&'));
  v.add(title.replace(/&/g, ' and '));
  v.add(title.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
  v.add(title.replace(/\s*\(\d{4}\)\s*$/, '').trim());
  v.add(title.replace(/^(the|a|an)\s+/i, '').trim());
  // 91mobiles adds franchise suffixes TMDB doesn't use, e.g. "Khalifa Part 1"
  // (TMDB: "Khalifa"). The year check in fetch91Mobiles still guards the match.
  const noPart = title.replace(/\s*[:\-–]?\s*\b(part|chapter|vol\.?|volume|ch\.?)\s*(\d+|[ivx]+|one|two|three)\b.*$/i, '').trim();
  if (noPart && noPart !== title) v.add(noPart);
  return Array.from(v).filter(x => x && x.length >= 1);
}

function normTitle(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function buildMeta(opts) {
  const imdbId = opts.imdbId, type = opts.type, title = opts.title;
  const releaseDate = opts.releaseDate, releaseLabel = opts.releaseLabel;
  const overview = opts.overview, rating = opts.rating;
  const posterPath = opts.posterPath, backdropPath = opts.backdropPath;
  const genres = opts.genres, posterUrl = opts.posterUrl, backdropUrl = opts.backdropUrl;

  const cleanedPlatform = cleanPlatformNames(opts.platform);
  let desc = '';
  if (overview)        desc += overview.replace(/"/g, "'").trim() + '\n\n';
  if (cleanedPlatform) desc += '📺 Streaming on: ' + cleanedPlatform;
  if (releaseDate)     desc += '\n' + (releaseLabel || '📅 Release:') + ' ' + releaseDate;
  if (rating)          desc += '\n⭐ Rating: ' + Number(rating).toFixed(1) + '/10';

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

// ── 91MOBILES (DAY-0 AUTHORITY) ───────────────────────────────────────────────
const M91_AJAX_URL = 'https://www.91mobiles.com/entertainment/web/list_ajax.php';
const M91_BASE     = 'https://www.91mobiles.com/entertainment/';
const M91_MOVIE_LOOKBACK_DAYS = 30;
const M91_SHOW_LOOKBACK_DAYS  = 60;
const M91_PAGES = {
  ml: { movie: 'new-malayalam-movies', series: 'new-malayalam-web-series' },
  ta: { movie: 'new-tamil-movies',     series: 'new-tamil-web-series' },
};
const M91_GENERIC_WEB_SLUGS = { movie: 'new-movies', series: 'new-web-series' };
const M91_LANG_LABEL  = { ml: 'malayalam', ta: 'tamil' };
const M91_LANG_NATIVE = { ml: 'മലയാളം', ta: 'தமிழ்' };
// combined request covers both languages in ONE call (mirrors the site itself)
const M91_LANG_IDS_COMBINED = '63,28';

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
    'Accept-Language': 'en-IN,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Cache-Control': 'no-cache, max-age=0',
    'Pragma': 'no-cache',
    'Referer': 'https://www.91mobiles.com/entertainment/',
  };
}

function m91PageHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Cache-Control': 'no-cache, max-age=0',
    'Pragma': 'no-cache',
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

function m91BuildFilterUrl(kind, startOffset) {
  const isShow = kind === 'SHOW';
  const genericSlug = isShow ? M91_GENERIC_WEB_SLUGS.series : M91_GENERIC_WEB_SLUGS.movie;
  const available = isShow ? 'Stream,Rent' : 'Stream,Rent,Buy';
  const params = new URLSearchParams({
    qp: 'available:' + available + '~contentTypes:' + (isShow ? 'show' : 'movie') + '~languages:' + M91_LANG_IDS_COMBINED,
    sortOrder: 'desc',
    sortBy: 'ottReleaseDate',
    start: String(startOffset),
    seoSlug: '/entertainment/' + genericSlug,
    pType: genericSlug,
    dubbedVal: 'notDubbed',
    type: 'filter'
  });
  params.set('_', String(Date.now()));
  return M91_AJAX_URL + '?' + params.toString();
}

function m91BuildLegacyAjaxUrl(slug, kind, lang, startOffset) {
  const isShow = kind === 'SHOW';
  const params = new URLSearchParams({
    qp: 'contentTypes:' + (isShow ? 'show' : 'movie') + '~languages:' + { ml: 28, ta: 63 }[lang],
    sortOrder: 'desc',
    sortBy: 'ottReleaseDate',
    start: String(startOffset || '1'),
    seoSlug: '/' + slug,
    pType: slug,
    dubbedVal: 'notDubbed',
    type: 'loadmore'
  });
  params.set('_', String(Date.now()));
  return M91_AJAX_URL + '?' + params.toString();
}

// freshness signature: the US edge cache serves pages ~2 weeks old
function m91NewestDateIn(body) {
  let newest = null;
  const re = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const d = parseAnyDate(m[0]);
    if (d && (!newest || d > newest)) newest = d;
  }
  return newest;
}
function m91Iso(d) { return d ? d.toISOString().slice(0, 10) : 'none'; }

let zenRowsBroken = false;
let scraperApiBroken = false;

// Indian-IP escalation: ZenRows first, ScraperAPI second. Returns '' if both fail.
async function m91FetchViaProxy(target) {
  if (ZENROWS_KEY && !zenRowsBroken) {
    try {
      const wrapped = 'https://api.zenrows.com/v1/?apikey=' + ZENROWS_KEY +
                      '&premium_proxy=true&proxy_country=in&url=' + encodeURIComponent(target);
      const body = m91UnwrapBody(await fetchUrl(wrapped, {}));
      if (/<div\s+class="?pro_item/.test(body)) return body;
      console.warn('[91Mobiles] zenrows: no usable items (len=' + body.length + ')');
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes('403') || msg.includes('429')) {
        zenRowsBroken = true;
        console.warn('[91Mobiles] ❌ ZenRows rejected (' + msg + ') — out of credits or bad key. Falling back.');
      } else {
        console.warn('[91Mobiles] zenrows failed: ' + msg);
      }
    }
  }
  if (SCRAPERAPI_KEY && !scraperApiBroken) {
    try {
      const wrapped = 'https://api.scraperapi.com/?api_key=' + SCRAPERAPI_KEY +
                      '&country_code=in&url=' + encodeURIComponent(target);
      const body = m91UnwrapBody(await fetchUrl(wrapped, m91FetchHeaders()));
      if (/<div\s+class="?pro_item/.test(body)) return body;
    } catch (e) {
      if (String(e.message).includes('403')) {
        scraperApiBroken = true;
        console.warn('[91Mobiles] ❌ ScraperAPI rejected (HTTP 403) — out of credits.');
      }
    }
  }
  return '';
}

// Combined-language filter source — ONE request covers ml+ta for the kind.
// Direct is FREE: accept it only if it looks fresh; otherwise spend proxy credits.
const filterSourceCache = {};

async function getFilterSource(kind) {
  if (filterSourceCache[kind]) return filterSourceCache[kind];
  const isShow = kind === 'SHOW';

  let html = '';
  try {
    const direct = m91UnwrapBody(await fetchUrl(m91BuildFilterUrl(kind, 0), m91FetchHeaders()));
    if (/<div\s+class="?pro_item/.test(direct)) {
      const newest = m91NewestDateIn(direct);
      const ageDays = newest ? (Date.now() - newest.getTime()) / 86400000 : 999;
      console.log('[91Mobiles] filter direct: newest card date ' + m91Iso(newest) + ' (' + Math.round(ageDays) + 'd old)');
      // Movies: escalate if stale (>3d = US-cache signature).
      // Shows: accept any non-empty direct result (their data legitimately ages).
      if (isShow || ageDays <= 3) {
        html = direct;
      } else {
        console.warn('[91Mobiles] filter direct looks STALE — escalating to Indian-IP proxy');
      }
    } else {
      console.warn('[91Mobiles] filter direct: no usable items (len=' + direct.length + ')');
    }
  } catch (e) {
    console.warn('[91Mobiles] filter direct failed: ' + e.message);
  }

  if (!html) {
    const proxied = await m91FetchViaProxy(m91BuildFilterUrl(kind, 0));
    if (proxied) {
      html = proxied;
      console.log('[91Mobiles] filter via Indian-IP proxy: OK ✓ (newest ' + m91Iso(m91NewestDateIn(proxied)) + ')');
    }
  }

  const out = {};
  for (const lang of ['ml', 'ta']) {
    out[lang] = m91ParsePage(html, M91_LANG_LABEL[lang], isShow, lang + ' ' + kind + ' filter');
  }
  filterSourceCache[kind] = out;
  return out;
}

// Free direct webpage fetch (backup only — never spends proxy credits)
async function m91FetchWebpage(slug) {
  const url = M91_BASE + slug;
  const attempts = [
    { label: 'direct', target: url + '?_=' + Date.now(), hdr: m91PageHeaders() },
    { label: 'googlebot', target: url + '?gr=' + Math.floor(Math.random() * 1e9), hdr: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Cache-Control': 'no-cache',
    } },
  ];
  for (const a of attempts) {
    try {
      const body = await fetchUrl(a.target, a.hdr);
      if (/<div\s+class="?pro_item/.test(body)) return body;
    } catch (e) {}
  }
  return '';
}

// Free direct legacy-AJAX fetch (backup only)
async function m91FetchLegacyAjax(slug, kind, lang, startOffset) {
  try {
    const body = m91UnwrapBody(await fetchUrl(m91BuildLegacyAjaxUrl(slug, kind, lang, startOffset), m91FetchHeaders()));
    return body;
  } catch (e) {
    return '';
  }
}

function m91ParsePage(html, langLabel, isShow, label) {
  const items = [];
  const stats = { blocks: 0, noTitle: 0, noMeta: 0, lang: 0, noDate: 0, future: 0, old: 0, noPlatform: 0, kept: 0 };
  const samples = { lang: [], old: [], noPlatform: [] };
  const keptSamples = [];
  const lookback = isShow ? M91_SHOW_LOOKBACK_DAYS : M91_MOVIE_LOOKBACK_DAYS;

  if (!html || !html.trim()) {
    console.log('[91Mobiles] ' + label + ': EMPTY response');
    return items;
  }

  const blocks = html.split(/<div\s+class="?pro_item/).slice(1);
  stats.blocks = blocks.length;

  for (const block of blocks) {
    let tMatch = block.match(/<a[^>]+title="([^"]+)"[^>]*class="txt-white/);
    if (!tMatch) tMatch = block.match(/<a[^>]+title="([^"]{2,150})"/);
    if (!tMatch) { stats.noTitle++; continue; }
    const title = m91CleanTitle(m91StripTags(tMatch[1]));

    let metaMatch = block.match(/<p class="d-in-block f-s-m">([^<]+)<\/p>/);
    if (!metaMatch) metaMatch = block.match(/<p[^>]*>([^<]*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}[^<]*)<\/p>/);
    if (!metaMatch) { stats.noMeta++; continue; }
    const meta = m91StripTags(metaMatch[1]);
    const metaLower = meta.toLowerCase();

    // STRICT language check (pages/combined feeds mix languages)
    if (!metaLower.includes(langLabel) && !meta.includes(M91_LANG_NATIVE[langLabel])) {
      stats.lang++;
      if (samples.lang.length < 2) samples.lang.push(title + ' [' + meta.slice(0, 80) + ']');
      continue;
    }

    const bodyText = m91StripTags(block);
    const isNewSeason = isShow && /\bnew season\b|\bnew episodes?\b|\bpremiere\b/i.test(bodyText);

    const dateMatch = meta.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (!dateMatch) { stats.noDate++; continue; }
    const date = parseAnyDate(dateMatch[0]);
    if (!date) { stats.noDate++; continue; }
    if (!isReleased(date)) { stats.future++; continue; }

    const ageDays = (Date.now() - date.getTime()) / 86400000;
    if (ageDays > lookback && !isNewSeason) {
      stats.old++;
      if (samples.old.length < 2) samples.old.push(title + ' [' + meta.slice(0, 80) + ']');
      continue;
    }

    const rawPlatforms = [];
    const wtsIdx = block.indexOf('Where To Stream');
    if (wtsIdx !== -1) {
      const tail = block.slice(wtsIdx, wtsIdx + 4000);
      let pm;
      const pRe1 = /<div[^>]*class="[^"]*target_link_ext[^"]*"[^>]*>([^<]+)</g;
      while ((pm = pRe1.exec(tail)) !== null) rawPlatforms.push(pm[1].trim());
      const pRe2 = /target_link_ext[^>]*>\s*<img[^>]+alt="([^"]+)"/g;
      while ((pm = pRe2.exec(tail)) !== null) rawPlatforms.push(pm[1].trim());
    }

    let finalPlatform = cleanPlatformNames(rawPlatforms.join(', '));
    if (!finalPlatform && /\(OTT\)/i.test(meta)) finalPlatform = 'OTT / Streaming';

    if (!finalPlatform) {
      stats.noPlatform++;
      if (samples.noPlatform.length < 2) samples.noPlatform.push(title + ' [' + meta.slice(0, 80) + ']');
    }

    stats.kept++;
    if (keptSamples.length < 2) keptSamples.push(title + ' [' + meta.slice(0, 80) + ']');
    items.push({
      title,
      date,
      arrivalDate: (isNewSeason && ageDays > lookback) ? today() : date.toISOString().slice(0, 10),
      year: dateMatch[3],
      platform: finalPlatform,
      isNewSeason,
    });
  }

  console.log('[91Mobiles] ' + label + ' parse: blocks=' + stats.blocks + ' kept=' + stats.kept +
    ' (dropped — lang:' + stats.lang + ' noDate:' + stats.noDate + ' future:' + stats.future +
    ' tooOld:' + stats.old + ' | noPlatform:' + stats.noPlatform + '→TMDB-check' +
    ' noTitle:' + stats.noTitle + ' noMeta:' + stats.noMeta + ')');
  for (const k of ['lang', 'old', 'noPlatform']) {
    if (samples[k].length) console.log('[91Mobiles] ' + label + ' ' + k + ': ' + samples[k].join('  ||  '));
  }
  if (keptSamples.length) console.log('[91Mobiles] ' + label + ' kept samples: ' + keptSamples.join('  ||  '));
  return items;
}

async function fetch91Mobiles(lang, kind) {
  const isShow = kind === 'SHOW';
  const slug = M91_PAGES[lang] && M91_PAGES[lang][isShow ? 'series' : 'movie'];
  if (!slug) return [];

  try {
    const filterItems = (await getFilterSource(kind))[lang] || [];
    const webLang = await m91FetchWebpage(slug);
    const ajaxP1  = await m91FetchLegacyAjax(slug, kind, lang, '1');

    const sources = [
      { label: lang + ' ' + kind + ' webpage', html: webLang },
      { label: lang + ' ' + kind + ' ajax p1', html: ajaxP1 },
    ];

    const items = [];
    const dedup = new Set();
    for (const it of filterItems) {
      const k = normTitle(it.title) + '|' + it.arrivalDate;
      if (dedup.has(k)) continue;
      dedup.add(k);
      items.push(it);
    }
    for (const src of sources) {
      const pageItems = m91ParsePage(src.html, M91_LANG_LABEL[lang], isShow, src.label);
      for (const it of pageItems) {
        const k = normTitle(it.title) + '|' + it.arrivalDate;
        if (dedup.has(k)) continue;
        dedup.add(k);
        items.push(it);
      }
    }

    console.log('[91Mobiles] ' + lang + ' ' + kind + ': ' + items.length + ' live OTT items total (filter+webpage+ajax)');

    const resolved = [];
    const seenIds = new Set();
    let dropped = 0;
    let ambiguous = 0;
    const ambiguousTitles = [];

    for (const item of items) {
      const endpoint = isShow ? '/search/tv?query=' : '/search/movie?query=';
      let r = null;
      let hadCandidates = false;

      // Manual override wins: pin this 91mobiles title to a TMDB/IMDb ID
      const ovr = overrideByTitle(item.title, ovrType(kind));
      if (ovr && ovr.hide) continue;
      if (ovr && ovr.ottDate) item.arrivalDate = ovr.ottDate;
      if (ovr && ovr.platform) item.platform = ovr.platform;
      if (ovr && (ovr.tmdb || ovr.imdb)) {
        let tmdbId = ovr.tmdb || null;
        if (!tmdbId) {
          try {
            const f = await tmdb('/find/' + ovr.imdb + '?external_source=imdb_id');
            const hit = (isShow ? f.tv_results : f.movie_results) || [];
            if (hit[0]) tmdbId = hit[0].id;
          } catch (e) {}
        }
        if (tmdbId && !seenIds.has(tmdbId)) {
          seenIds.add(tmdbId);
          resolved.push({ id: tmdbId, arrivalDate: item.arrivalDate, title: item.title, imdbId: ovr.imdb || null,
            year: item.year, isNewSeason: item.isNewSeason, trustedPlatform: item.platform, fromOverride: true });
          console.log('[Override] 📌 ' + item.title + ' → TMDB ' + tmdbId);
        } else if (!tmdbId) {
          noteUnmatched(lang, ovrType(kind), item.title, 'override IMDb ID not found on TMDB yet', { ottDate: item.arrivalDate, platform: item.platform, source: '91mobiles' });
        }
        continue;
      }

      for (const v of getTitleVariations(item.title)) {
        try {
          const data = await tmdb(endpoint + encodeURIComponent(v) + '&language=en-US&page=1');
          const results = data.results || [];
          if (!results.length) continue;

          let candidates = results.filter(x => x.original_language === lang);
          if (!candidates.length) {
            const exact = results.find(x => normTitle(x.title || x.name) === normTitle(item.title));
            if (exact) candidates = [exact];
          }
          if (!candidates.length) continue;
          hadCandidates = true;

          const exactHit = candidates.find(c => normTitle(c.title || c.name) === normTitle(item.title));
          if (exactHit) { r = exactHit; break; }

          if (item.year) {
            const yearHit = candidates.find(c => String(c.release_date || c.first_air_date || '').slice(0, 4) === item.year);
            if (yearHit) { r = yearHit; break; }
          }
        } catch (e) {}
      }

      if (r && !seenIds.has(r.id)) {
        seenIds.add(r.id);
        resolved.push({
          id: r.id,
          arrivalDate: item.arrivalDate,
          title: item.title,
          imdbId: null,
          year: item.year,
          isNewSeason: item.isNewSeason,
          trustedPlatform: item.platform,
        });
      }
      // Only report titles 91mobiles says are on OTT (cinema-only cards are noise)
      if (!r) {
        if (item.platform) noteUnmatched(lang, ovrType(kind), item.title,
          hadCandidates ? 'ambiguous TMDB match (title/year didn\'t line up)' : 'no TMDB search result',
          { ottDate: item.arrivalDate, year: item.year, platform: item.platform, source: '91mobiles' });
        if (hadCandidates) {
          ambiguous++;
          if (ambiguousTitles.length < 3) ambiguousTitles.push(item.title + ' (year ' + (item.year || '?') + ')');
        } else {
          dropped++;
        }
      }
      await new Promise(res => setTimeout(res, 80));
    }

    if (dropped || ambiguous) {
      console.warn('[91Mobiles] ' + lang + ' ' + kind + ': ' + dropped + ' dropped (no TMDB result), ' +
        ambiguous + ' skipped (ambiguous — wrong-match protection)');
    }
    if (ambiguousTitles.length) {
      console.warn('[91Mobiles] ' + lang + ' ' + kind + ' ambiguous titles: ' + ambiguousTitles.join('  ||  '));
    }
    return resolved;
  } catch (e) {
    console.warn('[91Mobiles] ' + lang + ' ' + kind + ' fetch failed: ' + e.message);
    return [];
  }
}

async function fetchDay0Items(lang, kind) {
  let items = [];
  try { items = await fetch91Mobiles(lang, kind); } catch (e) { items = []; }

  // Manual adds: override entries with a "lang" are injected even when
  // 91mobiles never lists them (replaces the old Google Sheet).
  const type = ovrType(kind);
  for (const o of overrides) {
    if (o.hide || o.lang !== lang || !ovrTypeOk(o, type) || !(o.tmdb || o.imdb)) continue;
    if (!o.type) continue; // manual adds must say movie or series
    let tmdbId = o.tmdb || null;
    if (!tmdbId) {
      try {
        const f = await tmdb('/find/' + o.imdb + '?external_source=imdb_id');
        const hit = (type === 'series' ? f.tv_results : f.movie_results) || [];
        if (hit[0]) tmdbId = hit[0].id;
      } catch (e) {}
    }
    if (!tmdbId) { noteUnmatched(lang, type, o.title || o.imdb, 'override IMDb ID not found on TMDB yet', { source: 'overrides.json' }); continue; }
    if (items.some(i => String(i.id) === String(tmdbId))) continue;
    items.push({ id: tmdbId, arrivalDate: o.ottDate || null, title: o.title || '', imdbId: o.imdb || null,
      year: null, isNewSeason: false, trustedPlatform: o.platform || '', fromOverride: true });
  }
  return items;
}

// ── TMDB DISCOVER (fallback) ──────────────────────────────────────────────────
async function discoverMovies(lang, lookbackDays, maxPages) {
  maxPages = maxPages || 5;
  const results = [];
  const seenIds = new Set();

  const query =
    '/discover/movie?with_original_language=' + lang +
    '&watch_region=IN&with_watch_monetization_types=flatrate|free|ads' +
    '&sort_by=primary_release_date.desc' +
    '&primary_release_date.gte=' + daysAgo(lookbackDays) +
    '&primary_release_date.lte=' + today();

  for (let page = 1; page <= maxPages; page++) {
    try {
      const data = await tmdb(query + '&page=' + page);
      if (!data.results || !data.results.length) break;
      let added = 0;
      for (const r of data.results) {
        if (seenIds.has(r.id)) continue;
        const ok = r.original_language === lang ||
          (r.original_language === 'en' && Array.isArray(r.origin_country) && r.origin_country.includes('IN'));
        if (!ok) continue;
        seenIds.add(r.id);
        results.push(r);
        added++;
      }
      if (page >= (data.total_pages || 1) || added === 0) break;
    } catch (e) { console.warn('[Discover movies] ' + e.message); break; }
  }
  return results;
}

async function discoverSeries(lang, maxPages, lookbackDays) {
  maxPages = maxPages || 5;
  lookbackDays = lookbackDays || 30;
  const results = [];
  const seenIds = new Set();

  const queries = [
    '/discover/tv?with_original_language=' + lang +
      '&sort_by=first_air_date.desc' +
      '&first_air_date.gte=' + daysAgo(lookbackDays) +
      '&first_air_date.lte=' + today(),
    '/discover/tv?with_original_language=' + lang +
      '&sort_by=popularity.desc' +
      '&air_date.gte=' + daysAgo(lookbackDays) +
      '&air_date.lte=' + today()
  ];

  for (let q = 0; q < queries.length; q++) {
    const pages = q === 0 ? maxPages : Math.min(maxPages, 5);
    for (let page = 1; page <= pages; page++) {
      try {
        const data = await tmdb(queries[q] + '&page=' + page);
        if (!data.results || !data.results.length) break;
        if (q === 1 && (data.total_results || 0) > 1500) {
          console.warn('[Discover series q2] filter looks unsupported (total=' + data.total_results + ') — skipping');
          break;
        }
        let added = 0;
        for (const r of data.results) {
          if (seenIds.has(r.id)) continue;
          if (r.original_language !== lang) continue;
          seenIds.add(r.id);
          results.push(Object.assign({}, r, { detectedStreaming: q === 1 }));
          added++;
        }
        if (page >= (data.total_pages || 1) || added === 0) break;
      } catch (e) { console.warn('[Discover series q' + (q + 1) + '] ' + e.message); break; }
    }
  }
  return results;
}

// TMDB release_dates type 4 = Digital (OTT) release, for India
function tmdbDigitalDateIN(detail) {
  const rd = detail && detail.release_dates && detail.release_dates.results;
  if (!Array.isArray(rd)) return '';
  const IN = rd.find(r => r.iso_3166_1 === 'IN');
  const dig = IN && (IN.release_dates || []).filter(d => d.type === 4 && d.release_date)
    .map(d => d.release_date.slice(0, 10)).sort()[0];
  return dig && dig <= today() ? dig : '';
}

// ── PROCESSORS ────────────────────────────────────────────────────────────────
async function processMovie(item, lang, expectedLang) {
  const cacheKey = lang + '_' + item.id;
  const cached   = readCacheEntry(movieCache[cacheKey]);

  const validDay0Platform = item.trustedPlatform ? cleanPlatformNames(item.trustedPlatform) : '';
  const isDay0Confirmed = validDay0Platform.length > 0;

  lastFailReason = '';
  if (cached === 'skip' && !isDay0Confirmed) { lastFailReason = 'rejected earlier (wrong language) — rechecked within 14 days'; return null; }
  if (cached && cached !== 'retry' && cached !== 'skip' && !isDay0Confirmed) {
    if (isUnusableEntry(cached.description)) { setSkip(movieCache, cacheKey); return null; }
    return cached;
  }

  try {
    const detail = await tmdb('/movie/' + item.id + '?language=en-US&append_to_response=watch/providers,external_ids,release_dates');
    const ovr = overrideByTmdb(item.id, 'movie');

    let imdbId = (ovr && ovr.imdb) || item.imdbId || detail.imdb_id;
    if (!imdbId && detail.external_ids && detail.external_ids.imdb_id) imdbId = detail.external_ids.imdb_id;
    if (!imdbId && OMDB_KEY) {
      try {
        const cleanTitle = (detail.title || item.title || '').replace(/[:\-]/g, ' ').replace(/\s+/g, ' ').trim();
        const movieYear = item.year || (detail.release_date ? detail.release_date.slice(0, 4) : '');
        const omdbRes = await fetchJson('https://www.omdbapi.com/?t=' + encodeURIComponent(cleanTitle) + '&type=movie&y=' + movieYear + '&apikey=' + OMDB_KEY);
        if (omdbOk(omdbRes, 'movie', detail.title || item.title)) imdbId = omdbRes.imdbID;
      } catch (e) {}
    }

    if (!imdbId) { lastFailReason = 'no IMDb ID yet (TMDB/OMDb) — add one in overrides.json'; setRetry(movieCache, cacheKey); return null; }

    const isIndianProduction = Array.isArray(detail.origin_country) && detail.origin_country.includes('IN');
    const isLangMatch = detail.original_language === expectedLang || (detail.original_language === 'en' && isIndianProduction);
    if (expectedLang && !isLangMatch && !(ovr || item.fromOverride)) {
      lastFailReason = 'TMDB says language is "' + detail.original_language + '"';
      setSkip(movieCache, cacheKey); return null;
    }

    let platform = (ovr && ovr.platform) || validDay0Platform;
    if (!platform) {
      const wp = (detail['watch/providers'] && detail['watch/providers'].results) || {};
      const IN = wp.IN;
      const all = IN ? [...(IN.flatrate || []), ...(IN.free || []), ...(IN.ads || [])] : [];
      platform = cleanPlatformNames(all.map(p => p.provider_name).join(', '));
    }

    // TMDB provider data lags JustWatch by a day or two — retry, don't skip for 14 days
    if (!platform) { lastFailReason = 'no OTT platform known yet (TMDB providers lag)'; setRetry(movieCache, cacheKey); return null; }

    // OTT date priority: override → 91mobiles → TMDB India digital release → TMDB release
    const digitalIN = tmdbDigitalDateIN(detail);
    const ottDate = (ovr && ovr.ottDate) || item.arrivalDate || digitalIN || detail.release_date || '';
    const label = ((ovr && ovr.ottDate) || item.arrivalDate || digitalIN) ? '📅 OTT Release:' : '📅 Released:';

    const meta = buildMeta({
      imdbId, type: 'movie',
      title: detail.title || '',
      platform,
      releaseDate: ottDate,
      releaseLabel: label,
      overview: detail.overview || '',
      rating: detail.vote_average,
      posterPath: detail.poster_path,
      backdropPath: detail.backdrop_path,
      genres: (detail.genres || []).map(g => g.name),
    });

    movieCache[cacheKey] = meta;
    cacheDirty = true;
    return meta;
  } catch (e) {
    lastFailReason = 'TMDB error: ' + e.message;
    console.warn('[Movie ' + item.id + '] ' + e.message);
    setRetry(movieCache, cacheKey);
    return null;
  }
}

async function processSeriesJW(item, lang) {
  const cacheKey = lang + '_series_' + item.id;
  const cached   = readCacheEntry(seriesCache[cacheKey]);

  const validDay0Platform = item.trustedPlatform ? cleanPlatformNames(item.trustedPlatform) : '';
  const isDay0Confirmed = validDay0Platform.length > 0;

  lastFailReason = '';
  if (cached === 'skip' && !isDay0Confirmed) { lastFailReason = 'rejected earlier (wrong language) — rechecked within 14 days'; return null; }
  if (cached && cached !== 'retry' && cached !== 'skip' && !isDay0Confirmed) return cached;

  try {
    let tmdbId = item.id;
    let detail = null;

    try {
      detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers,external_ids');
    } catch (e) {
      if (!String(e.message).includes('HTTP 404')) throw e;
    }

    if (!detail && item.title) {
      try {
        const data = await tmdb('/search/tv?query=' + encodeURIComponent(item.title) + '&language=en-US&page=1');
        const results = data.results || [];
        const normQ = normTitle(item.title);
        const tv = results.find(x => normTitle(x.name) === normQ && x.original_language === lang) ||
                   results.find(x => normTitle(x.name) === normQ);
        if (tv) {
          tmdbId = tv.id;
          detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers,external_ids');
        }
      } catch (e) {}
    }

    if (!detail) { lastFailReason = 'TMDB entry not found'; setRetry(seriesCache, cacheKey); return null; }
    const ovr = overrideByTmdb(tmdbId, 'series');

    const isIndianProduction = Array.isArray(detail.origin_country) && detail.origin_country.includes('IN');
    const isLangMatch = detail.original_language === lang || (detail.original_language === 'en' && isIndianProduction);
    if (!isLangMatch && !(ovr || item.fromOverride)) {
      lastFailReason = 'TMDB says language is "' + detail.original_language + '"';
      setSkip(seriesCache, cacheKey); return null;
    }

    let imdbId = (ovr && ovr.imdb) || item.imdbId || (detail.external_ids && detail.external_ids.imdb_id) || null;
    if (!imdbId) {
      try { const ext = await tmdb('/tv/' + tmdbId + '/external_ids'); imdbId = ext.imdb_id || null; } catch (e) {}
    }
    if (!imdbId && OMDB_KEY) {
      try {
        const cleanTitle = (detail.name || item.title || '').replace(/[:\-]/g, ' ').replace(/\s+/g, ' ').trim();
        // type=series + year: a bare "?t=Eyes" returned Eyes Wide Shut (tt0120663)
        const firstYear = (detail.first_air_date || '').slice(0, 4);
        const omdbRes = await fetchJson('https://www.omdbapi.com/?t=' + encodeURIComponent(cleanTitle) + '&type=series' + (firstYear ? '&y=' + firstYear : '') + '&apikey=' + OMDB_KEY);
        if (omdbOk(omdbRes, 'series', detail.name || item.title)) imdbId = omdbRes.imdbID;
      } catch (e) {}
    }

    if (!imdbId) { lastFailReason = 'no IMDb ID yet (TMDB/OMDb) — add one in overrides.json'; setRetry(seriesCache, cacheKey); return null; }

    const wp = (detail['watch/providers'] && detail['watch/providers'].results) || {};
    const IN = wp.IN;
    const all = IN ? [...(IN.flatrate || []), ...(IN.free || []), ...(IN.ads || [])] : [];
    const platform = (ovr && ovr.platform) || validDay0Platform || cleanPlatformNames(all.map(p => p.provider_name).join(', ')) || 'OTT / Streaming';

    const latestAirDate = (ovr && ovr.ottDate) || item.arrivalDate || detail.last_air_date || detail.first_air_date || today();
    const label = item.arrivalDate ? '📅 OTT Release:' : '📅 Latest Episode:';

    const meta = buildMeta({
      imdbId, type: 'series',
      title: detail.name || '',
      platform,
      releaseDate: latestAirDate,
      releaseLabel: label,
      overview: detail.overview || '',
      rating: detail.vote_average,
      posterPath: detail.poster_path,
      backdropPath: detail.backdrop_path,
      genres: (detail.genres || []).map(g => g.name),
    });

    seriesCache[cacheKey] = meta;
    cacheDirty = true;
    return meta;
  } catch (e) {
    lastFailReason = 'TMDB error: ' + e.message;
    console.warn('[Series ' + (item.id || '') + '] ' + e.message);
    setRetry(seriesCache, cacheKey);
    return null;
  }
}

// ── OMDb GUARD ────────────────────────────────────────────────────────────────
// Accept an OMDb title match only if the type is right and the title really
// matches — otherwise short titles grab famous unrelated IMDb IDs.
function omdbOk(res, type, title) {
  if (!res || res.Response === 'False' || !res.imdbID || !res.imdbID.startsWith('tt')) return false;
  if (res.Type && res.Type !== type) return false;
  const a = normTitle(res.Title), b = normTitle(title);
  return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
}

// ── CINEMETA (preferred metadata source; TMDB is the fallback) ───────────────
// Cinemeta is Stremio's own IMDb-based catalogue. Its episode numbering is
// what stream addons (Torrentio etc.) search by, so its episode list is used
// first. It often lags on brand-new Indian OTT titles — then TMDB fills in.
const CM_EXTRA_FIELDS = ['runtime', 'links', 'imdbRating', 'trailers', 'trailerStreams', 'cast', 'director', 'writer', 'logo'];

function slimCinemeta(m, type) {
  const out = {};
  for (const f of CM_EXTRA_FIELDS.concat(['poster', 'background'])) if (m[f] != null && m[f] !== '') out[f] = m[f];
  if (Array.isArray(out.links)) {
    out.links = out.links.filter(l => l && /^(Cast|Directors|Writers|imdb)$/i.test(l.category || '')).slice(0, 15);
  }
  if (type === 'series' && Array.isArray(m.videos)) {
    out.videos = m.videos
      .filter(v => v && Number(v.season) > 0 && Number(v.episode || v.number) > 0)
      .map(v => ({
        season: Number(v.season),
        episode: Number(v.episode || v.number),
        title: v.name || v.title || ('Episode ' + (v.episode || v.number)),
        released: v.released || v.firstAired || undefined,
        overview: v.overview || v.description || undefined,
        thumbnail: v.thumbnail || undefined,
      }));
  }
  return out;
}

async function cinemeta(type, imdbId, ttlOverride) {
  if (!imdbId || !String(imdbId).startsWith('tt')) return null;
  const store = type === 'series' ? seriesCache : movieCache;
  const key = 'cm_' + imdbId;
  const c = store[key];
  if (c && c._at) {
    const ttl = c.meta
      ? (ttlOverride != null ? ttlOverride : (type === 'series' ? CINEMETA_TTL_SERIES : CINEMETA_TTL_MOVIE))
      : CINEMETA_TTL_MISSING;
    if (Date.now() - c._at < ttl) return c.meta || null;
  }
  try {
    const data = await fetchJson(CINEMETA_URL + type + '/' + imdbId + '.json');
    const m = data && data.meta && data.meta.id ? slimCinemeta(data.meta, type) : null;
    store[key] = { _at: Date.now(), meta: m };
    cacheDirty = true;
    return m;
  } catch (e) {
    return (c && c.meta) || null; // network blip — use stale data
  }
}

// Add Cinemeta's extra details (cast, runtime, trailers, IMDb rating) without
// touching our own name / description / OTT date / genres.
function applyCinemetaExtras(meta, cm) {
  if (!cm) return meta;
  for (const f of CM_EXTRA_FIELDS) if (cm[f] != null && meta[f] == null) meta[f] = cm[f];
  if (!meta.poster && cm.poster) meta.poster = cm.poster;
  if (!meta.background && cm.background) meta.background = cm.background;
  return meta;
}

// Cinemeta first; TMDB only adds episodes Cinemeta hasn't indexed yet, and
// only when both number the show the same way (avoids soap-opera mix-ups).
function mergeEpisodes(cmVideos, tmdbVideos) {
  if (!cmVideos.length) return { videos: tmdbVideos, source: tmdbVideos.length ? 'tmdb' : 'none' };
  const count = (list) => list.reduce((m, v) => { m[v.season] = (m[v.season] || 0) + 1; return m; }, {});
  const cmCount = count(cmVideos), tmCount = count(tmdbVideos);
  const cmSeasons = Object.keys(cmCount).map(Number);
  const cmMaxSeason = Math.max.apply(null, cmSeasons);
  const tmMaxSeason = tmdbVideos.length ? Math.max.apply(null, tmdbVideos.map(v => v.season)) : 0;
  const aligned = tmdbVideos.length > 0 &&
    cmSeasons.every(s => (tmCount[s] || 0) >= cmCount[s]) &&
    tmMaxSeason <= cmMaxSeason + 1;
  const cmMaxEp = {};
  for (const v of cmVideos) cmMaxEp[v.season] = Math.max(cmMaxEp[v.season] || 0, v.episode);
  const extras = aligned ? tmdbVideos.filter(v =>
    (v.season === cmMaxSeason + 1) || (cmMaxEp[v.season] !== undefined && v.episode > cmMaxEp[v.season])) : [];
  const videos = cmVideos.concat(extras).sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { videos, source: extras.length ? 'cinemeta+tmdb' : 'cinemeta' };
}

// ── EPISODES (series meta needs `videos`, or Stremio shows no episodes) ──────
// Cached per TMDB id under 'eps_<id>' in series-cache.json. Also self-heals
// bad IMDb IDs: TMDB's own imdb_id wins; an OMDb-sourced ID that OMDb says is
// not a series (e.g. a movie) is dropped. An overrides.json IMDb ID is locked.
// How often a series' episode list is re-checked, by how active the show is:
const EPS_TTL_RECENT = 4 * 3600 * 1000;    // episode in the last 14 days (or brand new)
const EPS_TTL_QUIET  = 24 * 3600 * 1000;   // no episode for 2+ weeks
const EPS_TTL_STALE  = 14 * 86400 * 1000;  // no episode within the catalogue age window
const EPS_TTL_ENDED  = 30 * 86400 * 1000;  // TMDB says Ended/Canceled
const EPS_RECENT_DAYS = 14;

function episodeTtl(entry) {
  if (!entry) return EPS_TTL_RECENT;
  if (entry.status === 'Ended' || entry.status === 'Canceled') return EPS_TTL_ENDED;
  if (!entry.lastEp) return EPS_TTL_RECENT;
  if (entry.lastEp < cutoffDate(SERIES_MAX_AGE_DAYS)) return EPS_TTL_STALE;
  if (entry.lastEp < cutoffDate(EPS_RECENT_DAYS)) return EPS_TTL_QUIET;
  return EPS_TTL_RECENT;
}

async function loadEpisodes(meta, tmdbId, locked) {
  const key = 'eps_' + (tmdbId || meta.id);
  const c = seriesCache[key];
  if (c && c._at && c.forId === meta.id && c.source) {
    if (Date.now() - c._at < episodeTtl(c)) return c;
  }

  try {
    const todayStr = today();
    const fallbackDate = (meta.releaseInfo || todayStr) + 'T00:00:00.000Z';
    let imdbId = meta.id;
    let status = '';
    const tmdbVideos = [];

    if (tmdbId) {
      const detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=external_ids');
      status = detail.status || '';
      const tmdbImdb = (detail.external_ids && detail.external_ids.imdb_id) || null;

      if (!locked && tmdbImdb && tmdbImdb !== meta.id) {
        console.log('[Episodes] 🔧 ' + meta.name + ': IMDb ' + meta.id + ' → ' + tmdbImdb + ' (TMDB)');
        imdbId = tmdbImdb;
      } else if (!locked && !tmdbImdb && OMDB_KEY) {
        try {
          const o = await fetchJson('https://www.omdbapi.com/?i=' + meta.id + '&apikey=' + OMDB_KEY);
          // Only drop on a definite verdict. "Request limit reached!" / "Invalid API key!"
          // also come back as Response:False and must NOT drop a good series.
          const badId = o && o.Response === 'False' && /incorrect imdb id/i.test(o.Error || '');
          const wrongType = o && o.Response === 'True' && o.Type && o.Type !== 'series';
          if (badId || wrongType) {
            console.log('[Episodes] ❌ ' + meta.name + ': ' + meta.id + ' is "' + (o.Title || '?') + '" (' + (o.Type || 'invalid') + ') — dropping');
            imdbId = null;
          }
        } catch (e) { /* network blip — keep current ID */ }
      }

      if (imdbId) {
        for (const s of (detail.seasons || [])) {
          if (!s || !s.season_number) continue; // skip specials (season 0)
          let eps = [];
          try {
            const sd = await tmdb('/tv/' + tmdbId + '/season/' + s.season_number + '?language=en-US');
            eps = sd.episodes || [];
          } catch (e) {}
          if (eps.length) {
            for (const ep of eps) {
              if (ep.air_date && ep.air_date > todayStr) continue; // not out yet
              tmdbVideos.push({
                season: s.season_number, episode: ep.episode_number,
                title: ep.name || ('Episode ' + ep.episode_number),
                released: ep.air_date ? ep.air_date + 'T00:00:00.000Z' : fallbackDate,
                overview: ep.overview || undefined,
                thumbnail: ep.still_path ? IMG + 'w300' + ep.still_path : undefined,
              });
            }
          } else if (s.episode_count > 0 && (!s.air_date || s.air_date <= todayStr)) {
            // Brand-new OTT drops: TMDB often has the count but no episode rows yet
            for (let n = 1; n <= s.episode_count; n++) {
              tmdbVideos.push({ season: s.season_number, episode: n, title: 'Episode ' + n,
                released: s.air_date ? s.air_date + 'T00:00:00.000Z' : fallbackDate });
            }
          }
        }
      }
    }

    let videos = [], source = 'none';
    if (imdbId) {
      const cm = await cinemeta('series', imdbId, 3600 * 1000);
      const nowIso = new Date().toISOString();
      const cmVideos = ((cm && cm.videos) || [])
        .filter(v => !v.released || v.released <= nowIso)
        .map(v => Object.assign({}, v, { released: v.released || fallbackDate }));
      ({ videos, source } = mergeEpisodes(cmVideos, tmdbVideos));
    }

    const lastEp = videos.reduce((m, v) => (v.released && v.released.slice(0, 10) > m ? v.released.slice(0, 10) : m), '');
    const entry = { _at: Date.now(), forId: meta.id, status, imdbId, source, lastEp, videos };
    seriesCache[key] = entry;
    cacheDirty = true;
    return entry;
  } catch (e) {
    console.warn('[Episodes] ' + meta.name + ': ' + e.message);
    return c || null; // use stale data rather than nothing
  }
}

// Returns a COPY of meta with videos + Cinemeta extras (cache entries stay
// lean), or null if the IMDb ID turned out to be wrong.
async function withEpisodes(meta, tmdbId, cacheKey, lang) {
  const locked = !!(overrideByImdb(meta.id, 'series') || (tmdbId && overrideByTmdb(tmdbId, 'series')));
  const eps = await loadEpisodes(meta, tmdbId, locked);
  if (!eps) return Object.assign({}, meta);
  if (!eps.imdbId) {
    noteUnmatched(lang, 'series', meta.name, 'IMDb ID ' + meta.id + ' belongs to a different title — add the right one in overrides.json', { tmdb: tmdbId || undefined });
    if (cacheKey) setRetry(seriesCache, cacheKey);
    return null;
  }
  if (eps.imdbId !== meta.id) {
    meta.id = eps.imdbId; // fix the cached entry too
    if (cacheKey) seriesCache[cacheKey] = meta;
    cacheDirty = true;
  }
  const out = applyCinemetaExtras(Object.assign({}, meta), await cinemeta('series', meta.id, episodeTtl(eps)));
  out.videos = (eps.videos || []).map(v => {
    const o = Object.assign({ id: out.id + ':' + v.season + ':' + v.episode }, v);
    Object.keys(o).forEach(k => o[k] === undefined && delete o[k]);
    return o;
  });
  out._lastEp = eps.lastEp || '';
  return out;
}

// ── ORCHESTRATORS ─────────────────────────────────────────────────────────────
function setOttDateLine(meta, date) {
  const line = '📅 OTT Release: ' + date;
  const d = meta.description || '';
  meta.description = /📅[^\n]*/.test(d) ? d.replace(/📅[^\n]*/, line) : (d + '\n' + line).trim();
}

function applyDay0Update(existingMeta, day0Item, arrivalDate, cacheObj, cacheKey) {
  const freshPlatform = cleanPlatformNames(day0Item.trustedPlatform);
  let changed = false;

  // Movies: 91mobiles' OTT date is authoritative whenever it names an OTT
  // platform (or the entry was pinned in overrides.json) — it replaces a
  // theatrical/TMDB date in either direction. Series: newer date wins, so a
  // returning show with fresh episodes isn't pushed back to its premiere date.
  const isMovie = existingMeta.type === 'movie';
  const authoritative = isMovie && (freshPlatform || day0Item.fromOverride);
  if (arrivalDate && arrivalDate !== existingMeta.releaseInfo &&
      (authoritative || arrivalDate > (existingMeta.releaseInfo || ''))) {
    existingMeta.releaseInfo = arrivalDate;
    setOttDateLine(existingMeta, arrivalDate);
    changed = true;
  }
  if (freshPlatform) {
    const base = (existingMeta.description || '').replace(/📺\s*Streaming on:[^\n]*/g, '').trim();
    const newDesc = (base + '\n\n📺 Streaming on: ' + freshPlatform).trim();
    if (newDesc !== existingMeta.description) { existingMeta.description = newDesc; changed = true; }
  }
  if (changed) {
    cacheObj[cacheKey] = existingMeta;
    cacheDirty = true;
    console.log('[Day-0 Update] 🔄 ' + existingMeta.name + ' → ' + existingMeta.releaseInfo + (freshPlatform ? ' on ' + freshPlatform : ''));
  }
}

// Shared last step for both catalogues: overrides (hide / OTT date / platform),
// age trimming, enrichment (Cinemeta extras, episodes) and the size cap.
// Works on copies, so the cache files stay lean.
async function finalizeList(metas, lang, type, limit, maxAgeDays, enrich) {
  const cutoff = cutoffDate(maxAgeDays);
  const out = [];
  const seen = new Set();
  let trimmed = 0, hidden = 0;

  const prepared = metas.map(m => {
    const o = overrideByImdb(m.id, type);
    if (!o || !(o.ottDate || o.platform)) {
      // Keep the description's date line in step with the sort date
      const dm = (m.description || '').match(/📅[^:]*:\s*(\d{4}-\d{2}-\d{2})/);
      if (type === 'movie' && m.releaseInfo && dm && dm[1] !== m.releaseInfo) {
        const c = Object.assign({}, m); setOttDateLine(c, m.releaseInfo); return c;
      }
      return m;
    }
    const c = Object.assign({}, m);
    if (o.ottDate) { c.releaseInfo = o.ottDate; setOttDateLine(c, o.ottDate); }
    if (o.platform) {
      const base = (c.description || '').replace(/📺\s*Streaming on:[^\n]*/g, '').trim();
      c.description = (base + '\n\n📺 Streaming on: ' + o.platform).trim();
    }
    return c;
  });
  prepared.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));

  for (const m of prepared) {
    if (out.length >= limit) break;
    if (isHidden(m)) { hidden++; continue; }
    // Quick pre-check: skip enrichment work for obviously stale movies
    if (type === 'movie' && (m.releaseInfo || '') < cutoff) { trimmed++; continue; }
    const full = await enrich(Object.assign({}, m));
    if (!full || seen.has(full.id)) continue;
    // Series survive while their latest episode is recent, even if first
    // added long ago (sorting still uses the OTT/arrival date).
    const lastEp = full._lastEp || '';
    delete full._lastEp;
    if ((full.releaseInfo || '') < cutoff && lastEp < cutoff) { trimmed++; continue; }
    seen.add(full.id);
    out.push(full);
  }
  if (trimmed || hidden) console.log('[Finalize] ' + lang + ' ' + type + ': ' + trimmed + ' trimmed (older than ' + cutoff + '), ' + hidden + ' hidden by overrides');
  return out;
}

async function scrapeMovies(lang) {
  const metas = [];
  const processedImdbIds = new Set();

  for (const [cacheKey, val] of Object.entries(movieCache)) {
    if (!cacheKey.startsWith(lang + '_')) continue;
    const entry = readCacheEntry(val);
    if (entry && typeof entry === 'object' && entry.id && entry.id.startsWith('tt') &&
        entry.type === 'movie' && !processedImdbIds.has(entry.id)) {
      if (isUnusableEntry(entry.description)) { setSkip(movieCache, cacheKey); continue; }
      metas.push(entry);
      processedImdbIds.add(entry.id);
    }
  }

  const day0Items = await fetchDay0Items(lang, 'MOVIE');
  for (const day0Item of day0Items) {
    const cacheKey = lang + '_' + day0Item.id;
    const arrivalDate = day0Item.arrivalDate || (day0Item.fromOverride ? null : today());

    const existingIndex = metas.findIndex(m => {
      if (movieCache[cacheKey] && movieCache[cacheKey].id === m.id) return true;
      if (day0Item.imdbId && m.id === day0Item.imdbId) return true;
      if (m.name && day0Item.title && normTitle(m.name) === normTitle(day0Item.title)) return true;
      return false;
    });

    if (existingIndex !== -1) {
      applyDay0Update(metas[existingIndex], day0Item, arrivalDate, movieCache, cacheKey);
      continue;
    }

    const meta = await processMovie(day0Item, lang, lang);
    const onOtt = cleanPlatformNames(day0Item.trustedPlatform) || day0Item.fromOverride;
    if (!meta && onOtt) {
      noteUnmatched(lang, 'movie', day0Item.title, lastFailReason || 'rejected by TMDB checks',
        { tmdb: day0Item.id, ottDate: day0Item.arrivalDate, platform: day0Item.trustedPlatform, source: day0Item.fromOverride ? 'overrides.json' : '91mobiles' });
    }
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      if (arrivalDate) { meta.releaseInfo = arrivalDate; setOttDateLine(meta, arrivalDate); }
      movieCache[cacheKey] = meta;
      cacheDirty = true;
      metas.push(meta);
      processedImdbIds.add(meta.id);
      console.log('[Day-0 Add] 🎬 ' + meta.name + ' added on ' + meta.releaseInfo + ' (' + meta.id + ')');
    }
  }

  const isLeanCache = metas.length < 100;
  const lookback = isLeanCache ? MOVIE_FIRST_RUN : (RUN_IS_DEEP ? MOVIE_DEEP_LOOKBACK : MOVIE_LOOKBACK);
  const discoverPages = isLeanCache ? 25 : (RUN_IS_DEEP ? 12 : 5);

  const tmdbItems = await discoverMovies(lang, lookback, discoverPages);
  let discoverAdds = 0;
  for (const item of tmdbItems) {
    const meta = await processMovie(item, lang, lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      metas.push(meta);
      processedImdbIds.add(meta.id);
      discoverAdds++;
    }
  }
  if (discoverAdds) console.log('[Discover] ' + lang + ' movies: ' + discoverAdds + ' new additions');

  const finalResult = await finalizeList(metas, lang, 'movie', 120, MOVIE_MAX_AGE_DAYS,
    async (m) => applyCinemetaExtras(m, await cinemeta('movie', m.id)));
  console.log('[Movies] ' + lang + ': ' + finalResult.length + ' in catalogue');
  return finalResult;
}

async function scrapeSeries(lang) {
  const metas = [];
  const processedImdbIds = new Set();
  const keyOf = new Map(); // meta.id → series cache key (holds the TMDB id)

  for (const [cacheKey, val] of Object.entries(seriesCache)) {
    if (!cacheKey.startsWith(lang + '_series_')) continue;
    const entry = readCacheEntry(val);
    if (entry && typeof entry === 'object' && entry.id && entry.id.startsWith('tt') &&
        entry.type === 'series' && !processedImdbIds.has(entry.id)) {
      metas.push(entry);
      processedImdbIds.add(entry.id);
      keyOf.set(entry.id, cacheKey);
    }
  }

  const day0Items = await fetchDay0Items(lang, 'SHOW');
  for (const day0Item of day0Items) {
    const cacheKey = lang + '_series_' + day0Item.id;
    const arrivalDate = day0Item.arrivalDate || (day0Item.fromOverride ? null : today());

    const existingIndex = metas.findIndex(m => {
      if (seriesCache[cacheKey] && seriesCache[cacheKey].id === m.id) return true;
      if (day0Item.imdbId && m.id === day0Item.imdbId) return true;
      if (m.name && day0Item.title && normTitle(m.name) === normTitle(day0Item.title)) return true;
      return false;
    });

    if (existingIndex !== -1) {
      applyDay0Update(metas[existingIndex], day0Item, arrivalDate, seriesCache, cacheKey);
      continue;
    }

    const meta = await processSeriesJW(day0Item, lang);
    if (!meta) {
      noteUnmatched(lang, 'series', day0Item.title, lastFailReason || 'rejected by TMDB checks',
        { tmdb: day0Item.id, ottDate: day0Item.arrivalDate, platform: day0Item.trustedPlatform, source: day0Item.fromOverride ? 'overrides.json' : '91mobiles' });
    }
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      if (arrivalDate) { meta.releaseInfo = arrivalDate; setOttDateLine(meta, arrivalDate); }
      seriesCache[cacheKey] = meta;
      cacheDirty = true;
      metas.push(meta);
      processedImdbIds.add(meta.id);
      keyOf.set(meta.id, cacheKey);
      console.log('[Day-0 Add] 📺 ' + meta.name + ' added on ' + meta.releaseInfo + ' (' + meta.id + ')');
    }
  }

  const isLeanSeries = metas.length < 20;
  const seriesPages = isLeanSeries ? 10 : 4;
  const seriesWindow = isLeanSeries ? 180 : (RUN_IS_DEEP ? 60 : 30);
  const tmdbSeries = await discoverSeries(lang, seriesPages, seriesWindow);
  console.log('[Discover] ' + lang + ' series candidates: ' + tmdbSeries.length + ' (window ' + seriesWindow + 'd)');

  let discoverAdds = 0;
  for (const item of tmdbSeries) {
    const meta = await processSeriesJW(item, lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      metas.push(meta);
      processedImdbIds.add(meta.id);
      keyOf.set(meta.id, lang + '_series_' + item.id);
      discoverAdds++;
      console.log('[Discover Add] 📺 ' + meta.name + ' (' + meta.releaseInfo + ')');
    }
  }
  if (discoverAdds) console.log('[Discover] ' + lang + ' series: ' + discoverAdds + ' new additions');

  metas.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));
  const finalResult = await finalizeList(metas, lang, 'series', 80, SERIES_MAX_AGE_DAYS, async (m) => {
    const cacheKey = keyOf.get(m.id);
    const tmdbId = cacheKey ? cacheKey.slice((lang + '_series_').length) : null;
    return withEpisodes(m, tmdbId, cacheKey, lang);
  });
  console.log('[Series] ' + lang + ': ' + finalResult.length + ' in catalogue');
  return finalResult;
}

// ── PUBLIC API (unchanged interface — build-cache.js needs no edits) ──────────
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

module.exports = { scrapeMalayalam, scrapeTamil, getHealthStatus, getUnmatched };

// ── END OF FILE — South Streams scraper v11 ──
