/**
 * scraper.js — South Streams (v11)
 *
 * Day-0 authority : 91mobiles "filter" XHR (the endpoint the live webpage uses),
 *                   ONE combined ml+ta request per kind; direct-first with a
 *                   freshness gate — escalates to Indian-IP proxy (ZenRows →
 *                   ScraperAPI) ONLY when the direct result is stale
 * Backups         : public webpage + legacy loadmore AJAX (free, direct only)
 * Fallback        : TMDB Discover (recent releases; premieres + airing for series)
 * Enrichment      : TMDB + OMDb
 *
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

const MOVIE_LOOKBACK      = 30;
const MOVIE_DEEP_LOOKBACK = 90;
const MOVIE_FIRST_RUN     = 730;
const SKIP_TTL            = 14 * 24 * 60 * 60 * 1000;
const RETRY_TTL           =  3 * 24 * 60 * 60 * 1000;

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
  const h = new Date().getUTCHours();
  return h >= 18 && h < 20;
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
      if (!r) {
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
  try { return await fetch91Mobiles(lang, kind); }
  catch (e) { return []; }
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

// ── PROCESSORS ────────────────────────────────────────────────────────────────
async function processMovie(item, lang, expectedLang) {
  const cacheKey = lang + '_' + item.id;
  const cached   = readCacheEntry(movieCache[cacheKey]);

  const validDay0Platform = item.trustedPlatform ? cleanPlatformNames(item.trustedPlatform) : '';
  const isDay0Confirmed = validDay0Platform.length > 0;

  if (cached === 'skip' && !isDay0Confirmed) return null;
  if (cached && cached !== 'retry' && cached !== 'skip' && !isDay0Confirmed) {
    if (isUnusableEntry(cached.description)) { setSkip(movieCache, cacheKey); return null; }
    return cached;
  }

  try {
    const detail = await tmdb('/movie/' + item.id + '?language=en-US&append_to_response=watch/providers,external_ids');

    let imdbId = detail.imdb_id;
    if (!imdbId && detail.external_ids && detail.external_ids.imdb_id) imdbId = detail.external_ids.imdb_id;
    if (!imdbId && OMDB_KEY) {
      try {
        const cleanTitle = (detail.title || item.title || '').replace(/[:\-]/g, ' ').replace(/\s+/g, ' ').trim();
        const movieYear = item.year || (detail.release_date ? detail.release_date.slice(0, 4) : '');
        const omdbRes = await fetchJson('https://www.omdbapi.com/?t=' + encodeURIComponent(cleanTitle) + '&y=' + movieYear + '&apikey=' + OMDB_KEY);
        if (omdbRes && omdbRes.imdbID && omdbRes.imdbID.startsWith('tt')) imdbId = omdbRes.imdbID;
      } catch (e) {}
    }

    if (!imdbId) { setRetry(movieCache, cacheKey); return null; }

    const isIndianProduction = Array.isArray(detail.origin_country) && detail.origin_country.includes('IN');
    const isLangMatch = detail.original_language === expectedLang || (detail.original_language === 'en' && isIndianProduction);
    if (expectedLang && !isLangMatch) { setSkip(movieCache, cacheKey); return null; }

    let platform = validDay0Platform;
    if (!platform) {
      const wp = (detail['watch/providers'] && detail['watch/providers'].results) || {};
      const IN = wp.IN;
      const all = IN ? [...(IN.flatrate || []), ...(IN.free || []), ...(IN.ads || [])] : [];
      platform = cleanPlatformNames(all.map(p => p.provider_name).join(', '));
    }

    if (!platform) { setSkip(movieCache, cacheKey); return null; }

    const ottDate = item.arrivalDate || detail.release_date || '';
    const label = item.arrivalDate ? '📅 OTT Release:' : '📅 Released:';

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

  if (cached === 'skip' && !isDay0Confirmed) return null;
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

    if (!detail) { setRetry(seriesCache, cacheKey); return null; }

    const isIndianProduction = Array.isArray(detail.origin_country) && detail.origin_country.includes('IN');
    const isLangMatch = detail.original_language === lang || (detail.original_language === 'en' && isIndianProduction);
    if (!isLangMatch) { setSkip(seriesCache, cacheKey); return null; }

    let imdbId = (detail.external_ids && detail.external_ids.imdb_id) || null;
    if (!imdbId) {
      try { const ext = await tmdb('/tv/' + tmdbId + '/external_ids'); imdbId = ext.imdb_id || null; } catch (e) {}
    }
    if (!imdbId && OMDB_KEY) {
      try {
        const cleanTitle = (detail.name || item.title || '').replace(/[:\-]/g, ' ').replace(/\s+/g, ' ').trim();
        const omdbRes = await fetchJson('https://www.omdbapi.com/?t=' + encodeURIComponent(cleanTitle) + '&apikey=' + OMDB_KEY);
        if (omdbRes && omdbRes.imdbID && omdbRes.imdbID.startsWith('tt')) imdbId = omdbRes.imdbID;
      } catch (e) {}
    }

    if (!imdbId) { setRetry(seriesCache, cacheKey); return null; }

    const wp = (detail['watch/providers'] && detail['watch/providers'].results) || {};
    const IN = wp.IN;
    const all = IN ? [...(IN.flatrate || []), ...(IN.free || []), ...(IN.ads || [])] : [];
    const platform = validDay0Platform || cleanPlatformNames(all.map(p => p.provider_name).join(', ')) || 'OTT / Streaming';

    const latestAirDate = item.arrivalDate || detail.last_air_date || detail.first_air_date || today();
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
    console.warn('[Series ' + (item.id || '') + '] ' + e.message);
    setRetry(seriesCache, cacheKey);
    return null;
  }
}

// ── ORCHESTRATORS ─────────────────────────────────────────────────────────────
function applyDay0Update(existingMeta, day0Item, arrivalDate, cacheObj, cacheKey) {
  const freshPlatform = cleanPlatformNames(day0Item.trustedPlatform);
  let changed = false;

  if (arrivalDate && arrivalDate > (existingMeta.releaseInfo || '')) {
    existingMeta.releaseInfo = arrivalDate;
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
    const arrivalDate = day0Item.arrivalDate || today();

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
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      meta.releaseInfo = arrivalDate;
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
    const arrivalDate = day0Item.arrivalDate || today();

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
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      meta.releaseInfo = arrivalDate;
      seriesCache[cacheKey] = meta;
      cacheDirty = true;
      metas.push(meta);
      processedImdbIds.add(meta.id);
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
      discoverAdds++;
      console.log('[Discover Add] 📺 ' + meta.name + ' (' + meta.releaseInfo + ')');
    }
  }
  if (discoverAdds) console.log('[Discover] ' + lang + ' series: ' + discoverAdds + ' new additions');

  metas.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));
  const finalResult = metas.slice(0, 80);
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

module.exports = { scrapeMalayalam, scrapeTamil, getHealthStatus };

// ── END OF FILE — South Streams scraper v11 ──
