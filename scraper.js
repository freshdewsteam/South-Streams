/**
 * scraper.js — South Streams
 *
 * Movies  → 91mobiles editorial AJAX (Sole Day-0 OTT authority, strict whitelist)
 *           → TMDB Auto-Discover (/discover/movie with watch_region=IN)
 * Series  → 91mobiles editorial AJAX (Sole Day-0 OTT authority)
 *           → TMDB Auto-Discover (/discover/tv)
 * Enrichment → TMDB API (posters, descriptions, IMDb IDs)
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY       = process.env.TMDB_API_KEY       || '';
const OMDB_KEY       = process.env.OMDB_API_KEY       || '';
const WEBHOOK_URL    = process.env.WEBHOOK_URL         || '';
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY    || '';
const BASE           = 'https://api.themoviedb.org/3';
const IMG            = 'https://image.tmdb.org/t/p/';

const MOVIE_CACHE_FILE  = path.join(__dirname, 'data', 'movies-cache.json');
const SERIES_CACHE_FILE = path.join(__dirname, 'data', 'series-cache.json');

const MOVIE_LOOKBACK      = 30;
const MOVIE_DEEP_LOOKBACK = 90;
const MOVIE_FIRST_RUN     = 730;
const SKIP_TTL            = 14 * 24 * 60 * 60 * 1000;
const RETRY_TTL           =  3 * 24 * 60 * 60 * 1000;

const RERELEASE_MAX_AGE_DAYS = 90;

// ── THEATRICAL DETECTION REGEX ──
const THEATRICAL_REGEX = /\b(bookmyshow|paytm|ticket|pvr|inox|cinepolis|theatre|theater|cinema)\b/i;

// ── STRICT OTT PLATFORM WHITELIST & NORMALIZER ──
const VALID_OTT_PLATFORMS = [
  { match: /prime video|amazon/i,              name: 'Prime Video' },
  { match: /netflix/i,                         name: 'Netflix' },
  { match: /hotstar|jiohotstar/i,              name: 'JioHotstar' },
  { match: /sony\s*liv/i,                      name: 'Sony LIV' },
  { match: /zee5/i,                            name: 'Zee5' },
  { match: /sun\s*nxt/i,                       name: 'SunNXT' },
  { match: /manorama/i,                        name: 'ManoramaMAX' },
  { match: /aha/i,                             name: 'Aha' },
  { match: /saina\s*play/i,                    name: 'Saina Play' },
  { match: /simply\s*south/i,                  name: 'Simply South' },
  { match: /lionsgate/i,                       name: 'Lionsgate Play' },
  { match: /jiocinema/i,                       name: 'JioCinema' },
  { match: /chaupal/i,                         name: 'Chaupal' }
];

function extractValidOttPlatforms(rawStr) {
  if (!rawStr) return '';
  const str = String(rawStr);
  const found = new Set();

  for (const p of VALID_OTT_PLATFORMS) {
    if (p.match.test(str)) {
      found.add(p.name);
    }
  }
  return Array.from(found).join(', ');
}

function isPureTheatrical(str) {
  if (!str) return false;
  const hasTheatrical = THEATRICAL_REGEX.test(str);
  const hasValidOtt   = extractValidOttPlatforms(str).length > 0;
  return hasTheatrical && !hasValidOtt;
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
  const cleanedPlatform = extractValidOttPlatforms(platform);
  let desc = '';
  if (overview)        desc += overview + '\n\n';
  if (cleanedPlatform) desc += '📺 Streaming on: ' + cleanedPlatform;
  if (releaseDate)     desc += '\n📅 OTT Release: ' + releaseDate;
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

// ── 91MOBILES (SOLE DAY-0 OTT DISCOVERY AUTHORITY) ────────────────────────────
const M91_AJAX_URL = 'https://www.91mobiles.com/entertainment/web/list_ajax.php';
const M91_LANG_ID  = { ml: 28, ta: 63 };
const M91_LOOKBACK_DAYS = 14; // Clean 2-week rolling window
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

    if (THEATRICAL_REGEX.test(block) && !VALID_OTT_PLATFORMS.some(p => p.match.test(block))) {
      continue;
    }

    const platforms = [];
    const wtsIdx = block.indexOf('Where To Stream');
    if (wtsIdx !== -1) {
      const tail = block.slice(wtsIdx, wtsIdx + 2000);
      const pRe = /<div[^>]*class="[^"]*target_link_ext[^"]*"[^>]*>([^<]+)</g;
      let pm;
      while ((pm = pRe.exec(tail)) !== null) {
        const rawName = pm[1].trim();
        const validOtt = extractValidOttPlatforms(rawName);
        if (validOtt && !platforms.includes(validOtt)) {
          platforms.push(validOtt);
        }
      }
    }

    const finalPlatform = extractValidOttPlatforms(platforms.join(', '));
    if (!finalPlatform) continue;

    const bodyText = m91StripTags(block);
    const isNewSeason = /\bnew season\b|\bnew episode\b/i.test(bodyText);

    items.push({ title, date, year: dateMatch[3], platform: finalPlatform, isNewSeason });
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
          trustedPlatform: item.platform,
        });
      }
      await new Promise(res => setTimeout(res, 80));
    }

    return resolved;
  } catch (e) {
    return [];
  }
}

// Day-0 is now strictly powered by 91mobiles
async function fetchDay0Items(lang, kind) {
  try {
    return await fetch91Mobiles(lang, kind);
  } catch (e) {
    return [];
  }
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
  if (cached && cached !== 'retry') {
    if (isPureTheatrical(cached.description) || !extractValidOttPlatforms(cached.description)) {
      setSkip(movieCache, cacheKey);
      return null;
    }
    return cached;
  }

  try {
    const detail = await tmdb('/movie/' + item.id + '?language=en-US&append_to_response=watch/providers,external_ids');

    let imdbId = detail.imdb_id;
    if (!imdbId && detail.external_ids && detail.external_ids.imdb_id) {
      imdbId = detail.external_ids.imdb_id;
    }

    if (!imdbId) {
      setRetry(movieCache, cacheKey);
      return null;
    }

    if (expectedLang && detail.original_language &&
        detail.original_language !== expectedLang &&
        (strictLang || detail.original_language !== 'en')) {
      setSkip(movieCache, cacheKey);
      return null;
    }

    const wp = (detail['watch/providers'] && detail['watch/providers'].results) || {};
    const IN = wp.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];

    let platform = '';
    if (all.length) {
      platform = extractValidOttPlatforms(all.map(p => p.provider_name).join(', '));
    } else if (item.trustedPlatform && !isPureTheatrical(item.trustedPlatform)) {
      platform = extractValidOttPlatforms(item.trustedPlatform);
    }

    if (!platform || isPureTheatrical(platform)) {
      setSkip(movieCache, cacheKey);
      return null;
    }

    const ottDate = item.arrivalDate || detail.release_date || '';

    const meta = buildMeta({
      imdbId:      imdbId,
      type:        'movie',
      title:       detail.title || '',
      platform,
      releaseDate: ottDate,
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
      detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers,external_ids');
    } catch (e) {
      if (!String(e.message).includes('HTTP 404')) throw e;
    }

    if (!detail && item.imdbId) {
      try {
        const data = await tmdb('/find/' + item.imdbId + '?external_source=imdb_id');
        const tv   = (data.tv_results || [])[0];
        if (tv) {
          tmdbId = tv.id;
          detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers,external_ids');
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
          detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers,external_ids');
        }
      } catch (e) {}
    }

    if (!detail) { setRetry(seriesCache, cacheKey); return null; }

    if (!detail.original_language || detail.original_language !== lang) {
      setSkip(seriesCache, cacheKey);
      return null;
    }

    let imdbId = null;
    if (detail.external_ids && detail.external_ids.imdb_id) {
      imdbId = detail.external_ids.imdb_id;
    }
    if (!imdbId) {
      try {
        const ext = await tmdb('/tv/' + tmdbId + '/external_ids');
        imdbId = ext.imdb_id || null;
      } catch(e) {}
    }
    if (!imdbId) { setRetry(seriesCache, cacheKey); return null; }

    const wp = (detail['watch/providers'] && detail['watch/providers'].results) || {};
    const IN = wp.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];
    let platform = '';
    if (all.length) {
      platform = extractValidOttPlatforms(all.map(p => p.provider_name).join(', '));
    } else if (item.trustedPlatform) {
      platform = extractValidOttPlatforms(item.trustedPlatform);
    } else {
      platform = 'OTT / Streaming';
    }

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

      if (isPureTheatrical(entry.description) || !extractValidOttPlatforms(entry.description)) {
        setSkip(movieCache, cacheKey);
        continue;
      }

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
      if (m.name && day0Item.title && m.name.toLowerCase() === day0Item.title.toLowerCase()) return true;
      return false;
    });

    if (existingIndex !== -1) {
      const existingMeta = metas[existingIndex];
      if (arrivalDate && (!existingMeta.releaseInfo || existingMeta.releaseInfo < arrivalDate)) {
        existingMeta.releaseInfo = arrivalDate;
        const validOtt = extractValidOttPlatforms(day0Item.trustedPlatform);
        if (validOtt && (!existingMeta.description || !existingMeta.description.includes('📺 Streaming on:'))) {
          existingMeta.description = ((existingMeta.description || '') + '\n\n📺 Streaming on: ' + validOtt).trim();
        }
        movieCache[cacheKey] = existingMeta;
        cacheDirty = true;
        console.log('[Date Update] 🔄 ' + existingMeta.name + ' OTT date set to ' + arrivalDate);
      }
      continue;
    }

    const cachedEntry    = readCacheEntry(movieCache[cacheKey]);
    const isNewDiscovery = cachedEntry === undefined || cachedEntry === 'retry';

    const meta = await processMovie(day0Item, lang, lang, true);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      const tmdbTheatrical = meta.releaseInfo || arrivalDate;
      const ageMs = Date.now() - new Date(tmdbTheatrical).getTime();
      const isRerelease = !isNaN(ageMs) && ageMs > RERELEASE_MAX_AGE_DAYS * 24 * 3600 * 1000;

      if (isRerelease) {
        meta.description = ((meta.description || '') + '\n\n♻️ Re-release: back on OTT on ' + arrivalDate).trim();
      } else {
        meta.releaseInfo = arrivalDate;
      }

      movieCache[cacheKey] = meta;
      cacheDirty = true;
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
  }

  const isLeanCache = metas.length < 100;
  const lookback = isLeanCache ? MOVIE_FIRST_RUN : (RUN_IS_DEEP ? MOVIE_DEEP_LOOKBACK : MOVIE_LOOKBACK);
  const discoverPages = isLeanCache ? 25 : (RUN_IS_DEEP ? 12 : 5);

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
    const arrivalDate = day0Item.arrivalDate || today();

    const existingIndex = metas.findIndex(m => {
      if (seriesCache[cacheKey] && seriesCache[cacheKey].id === m.id) return true;
      if (day0Item.imdbId && m.id === day0Item.imdbId) return true;
      if (m.name && day0Item.title && m.name.toLowerCase() === day0Item.title.toLowerCase()) return true;
      return false;
    });

    if (existingIndex !== -1) {
      const existingMeta = metas[existingIndex];
      if (arrivalDate && (!existingMeta.releaseInfo || existingMeta.releaseInfo < arrivalDate)) {
        existingMeta.releaseInfo = arrivalDate;
        seriesCache[cacheKey] = existingMeta;
        cacheDirty = true;
        console.log('[Date Update] 🔄 Updated series ' + existingMeta.name + ' date to ' + arrivalDate);
      }
      continue;
    }

    const cachedEntry    = readCacheEntry(seriesCache[cacheKey]);
    const isNewDiscovery = cachedEntry === undefined || cachedEntry === 'retry';

    const meta = await processSeriesJW(day0Item, lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      const firstAir = meta.releaseInfo || arrivalDate;
      const ageMs = Date.now() - new Date(firstAir).getTime();
      const isNewSeason = day0Item.isNewSeason === true;
      const isRerelease = !isNewSeason && !isNaN(ageMs) && ageMs > RERELEASE_MAX_AGE_DAYS * 24 * 3600 * 1000;

      if (isRerelease) {
        meta.description = ((meta.description || '') + '\n\n♻️ Re-release: back on OTT on ' + arrivalDate).trim();
      } else {
        meta.releaseInfo = arrivalDate;
      }

      seriesCache[cacheKey] = meta;
      cacheDirty = true;
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
  }

  const isLeanSeries = metas.length < 20;
  const seriesPages = isLeanSeries ? 10 : 4;
  const tmdbSeries = await discoverSeries(lang, seriesPages);
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
