/**
 * scraper.js — South Streams (v4)
 *
 * Day-0 authority : 91mobiles editorial AJAX
 * Fallback        : TMDB Discover (theatrical-recent + streaming-availability + recent-episode queries)
 * Enrichment      : TMDB + OMDb
 *
 * v4: language check only rejects explicit other-languages (script-tolerant);
 * new-season items bypass the 30-day rule; "(OTT)" tag optional — logos are the
 * signal; TMDB queries catch new OTT arrivals & new episodes; drop-sample logging.
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY       = process.env.TMDB_API_KEY  || '';
const OMDB_KEY       = process.env.OMDB_API_KEY  || '';
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || '';
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

// ── PLATFORM HANDLING: accept ALL OTT platforms; reject only ticketing sites ──
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

function getTitleVariations(title) {
  const v = new Set();
  v.add(title);
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

function buildMeta({ imdbId, type, title, platform, releaseDate, releaseLabel,
                     overview, rating, posterPath, backdropPath, genres,
                     posterUrl, backdropUrl }) {
  const cleanedPlatform = cleanPlatformNames(platform);
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
const M91_LANG_ID  = { ml: 28, ta: 63 };
const M91_MOVIE_LOOKBACK_DAYS = 30;
const M91_SHOW_LOOKBACK_DAYS  = 60;
const M91_PAGES = {
  ml: { movie: 'new-malayalam-movies', series: 'new-malayalam-web-series' },
  ta: { movie: 'new-tamil-movies',     series: 'new-tamil-web-series' },
};
const M91_LANG_LABEL = { ml: 'malayalam', ta: 'tamil' };
const M91_LANG_NATIVE = { ml: 'മലയാളം', ta: 'தமிழ்' };
const KNOWN_LANGS = ['malayalam','tamil','telugu','hindi','kannada','english','bengali','marathi','punjabi'];

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

let scraperApiBroken = false;

async function m91FetchItems(slug, kind, lang, startOffset) {
  const isShow = kind === 'SHOW';
  const params = new URLSearchParams({
    qp: 'contentTypes:' + (isShow ? 'show' : 'movie') + '~languages:' + M91_LANG_ID[lang],
    sortOrder: 'desc',
    sortBy: 'ottReleaseDate',
    start: String(startOffset || '1'),
    seoSlug: '/' + slug,
    pType: slug,
    dubbedVal: 'notDubbed',
    type: 'loadmore'
  });
  const target = M91_AJAX_URL + '?' + params.toString();

  if (SCRAPERAPI_KEY && !scraperApiBroken) {
    try {
      const wrapped = 'https://api.scraperapi.com/?api_key=' + SCRAPERAPI_KEY +
                      '&country_code=in&url=' + encodeURIComponent(target);
      const body = m91UnwrapBody(await fetchUrl(wrapped, m91FetchHeaders()));
      if (/<div\s+class="?pro_item/.test(body)) return body;
      console.warn('[91Mobiles] scraperapi: no items in response (' + slug + ' start=' + startOffset + ', len=' + body.length + ')');
    } catch (e) {
      if (String(e.message).includes('403')) {
        scraperApiBroken = true;
        console.warn('[91Mobiles] ❌ ScraperAPI key REJECTED (HTTP 403) — invalid or out of credits. Continuing with direct fetch. Check your ScraperAPI account.');
      } else {
        console.warn('[91Mobiles] scraperapi failed (' + slug + '): ' + e.message);
      }
    }
  }

  try {
    const body = m91UnwrapBody(await fetchUrl(target, m91FetchHeaders()));
    if (/<div\s+class="?pro_item/.test(body)) return body;
    if (startOffset === '1') console.warn('[91Mobiles] direct fetch: no items (' + slug + ', len=' + body.length + ')');
    return body; // return anyway — parser logs will diagnose
  } catch (e) {
    console.warn('[91Mobiles] direct fetch failed (' + slug + ' start=' + startOffset + '): ' + e.message);
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
    console.log('[91Mobiles] ' + label + ': EMPTY response — fetch failed (normal for some show offsets)');
    return items;
  }

  const blocks = html.split(/<div\s+class="?pro_item/).slice(1);
  stats.blocks = blocks.length;

  for (const block of blocks) {
    let tMatch = block.match(/<a[^>]+title="([^"]+)"[^>]*class="txt-white/);
    if (!tMatch) tMatch = block.match(/<a[^>]+title="([^"]{2,150})"/);
    if (!tMatch) { stats.noTitle++; continue; }
    const title = m91StripTags(tMatch[1]);

    let metaMatch = block.match(/<p class="d-in-block f-s-m">([^<]+)<\/p>/);
    if (!metaMatch) metaMatch = block.match(/<p[^>]*>([^<]*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}[^<]*)<\/p>/);
    if (!metaMatch) { stats.noMeta++; continue; }
    const meta = m91StripTags(metaMatch[1]);
    const metaLower = meta.toLowerCase();

    // Language: reject ONLY when a different language is explicitly named.
    // Cards that omit/state-in-script the language are trusted (page slug is
    // language-specific). TMDB re-verifies language later regardless.
    if (!metaLower.includes(langLabel) && metaLower.includes(M91_LANG_NATIVE[langLabel ? langLabel : '']) === false) {
      const hasNative = meta.includes(M91_LANG_NATIVE[langLabel]);
      const other = KNOWN_LANGS.find(l => l !== langLabel && metaLower.includes(l));
      if (!hasNative && other) {
        stats.lang++;
        if (samples.lang.length < 2) samples.lang.push(title + ' [' + meta.slice(0, 80) + ']');
        continue;
      }
    }

    const bodyText = m91StripTags(block);
    const isNewSeason = isShow && /\bnew season\b|\bnew episodes?\b|\bpremiere\b/i.test(bodyText);

    const dateMatch = meta.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (!dateMatch) { stats.noDate++; continue; }
    const date = parseAnyDate(dateMatch[0]);
    if (!date) { stats.noDate++; continue; }
    if (!isReleased(date)) { stats.future++; continue; }

    const ageDays = (Date.now() - date.getTime()) / 86400000;
    // Shows often
