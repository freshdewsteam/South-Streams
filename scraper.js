/**
 * scraper.js
 *
 * Movies  → cinebuds.com (primary) + filmibeat.com (backup)
 * Series  → filmibeat.com (primary) + keralatv.in (backup)
 *
 * If one source fails the other covers it automatically.
 * Runs on GitHub Actions — no proxies needed.
 */

const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  TMDB_KEY:        process.env.TMDB_API_KEY || '',
  OMDB_KEY:        process.env.OMDB_API_KEY || '',
  MAX_ITEMS:       50,
  REQUEST_TIMEOUT: 45000,
  CONCURRENCY:     5,
  ENABLE_OMDB:     true,
  CACHE_FILE:      './data/resolve-cache.json', // separate from OTT catalogue cache
  CACHE_TTL:       30 * 24 * 60 * 60 * 1000,   // 30 days
  MAX_RETRIES:     3,
};

// ── RESOLVE CACHE ─────────────────────────────────────────────────────────────
let memoryCache = new Map();
let cacheLoaded = false;
let cacheDirty  = false;

function loadCache() {
  if (cacheLoaded) return;
  try {
    const dir = path.dirname(CONFIG.CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, 'utf8'));
      memoryCache = new Map(Array.isArray(parsed) ? parsed : Object.entries(parsed));
      console.log('[Cache] Loaded ' + memoryCache.size + ' entries');
    }
  } catch (e) { console.warn('[Cache] Load failed:', e.message); }
  cacheLoaded = true;
}

function saveCache() {
  if (!cacheLoaded || !cacheDirty) return;
  try {
    const tmp = CONFIG.CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Array.from(memoryCache.entries()), null, 2));
    fs.renameSync(tmp, CONFIG.CACHE_FILE);
    cacheDirty = false;
  } catch (e) { console.warn('[Cache] Save failed:', e.message); }
}

function cacheGet(key) {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CONFIG.CACHE_TTL) { memoryCache.delete(key); return undefined; }
  return entry.data;
}

function cacheSet(key, data) {
  memoryCache.set(key, { ts: Date.now(), data });
  cacheDirty = true;
}

// ── SOURCES ───────────────────────────────────────────────────────────────────
function keralaTVUrl() {
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  const d = new Date();
  return 'https://www.keralatv.in/' + months[d.getMonth()] + '-' + d.getFullYear() + '-ott-release-guide/';
}

const SRC = {
  CINEBUDS_MAL:  'https://cinebuds.com/malayalam-movies-ott-release-dates/',
  CINEBUDS_TAM:  'https://cinebuds.com/tamil-movies-digital-release-dates/',
  FILMIBEAT_MAL: 'https://www.filmibeat.com/top-listing/new-ott-release-movies-in-malayalam-this-week-4-1087.html',
  FILMIBEAT_TAM: 'https://www.filmibeat.com/top-listing/new-ott-releases-this-week-in-tamil-2026-netflix-aha-prime-video-sunnxt-zee5-jiohotstar-and-sonyliv-5-1080.html',
  KERALATV:      keralaTVUrl(),
};

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchRaw(url, ms) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchRaw(res.headers.location, ms).then(resolve).catch(reject);
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
    req.setTimeout(ms || CONFIG.REQUEST_TIMEOUT, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchWithRetry(url) {
  let err;
  for (let i = 1; i <= CONFIG.MAX_RETRIES; i++) {
    try {
      console.log('[Fetch] ' + url.slice(0, 70));
      const html = await fetchRaw(url);
      if (html.length < 500) throw new Error('Too short');
      return html;
    } catch (e) {
      err = e;
      console.warn('[Fetch] Attempt ' + i + ' failed: ' + e.message);
      if (i < CONFIG.MAX_RETRIES) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw err;
}

async function tryFetch(name, url) {
  try { return await fetchWithRetry(url); }
  catch (e) { console.warn('[' + name + '] Failed — skipping: ' + e.message); return null; }
}

function fetchJson(url) { return fetchRaw(url, 15000).then(t => JSON.parse(t)); }

// ── RATE LIMITER (TMDB 40 req/10s) ───────────────────────────────────────────
let tmdbCount = 0, tmdbReset = Date.now();
async function tmdbFetch(url) {
  const now = Date.now();
  if (now - tmdbReset > 10000) { tmdbCount = 0; tmdbReset = now; }
  if (tmdbCount >= 38) { await new Promise(r => setTimeout(r, 10100 - (now - tmdbReset))); tmdbCount = 0; tmdbReset = Date.now(); }
  tmdbCount++;
  return fetchJson(url);
}

// ── DATE ──────────────────────────────────────────────────────────────────────
const MON = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseDate(s) {
  if (!s) return null;
  if (/soon|tba|tbd|upcoming|expected|coming soon|awaiting/i.test(s)) return null;
  s = s.replace(/\s*\(.*?\)/g, '').trim();
  // "15 Jun 2026" or "June 15, 2026"
  const m1 = s.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*[\s,]+(\d{4})/i);
  if (m1) return new Date(+m1[3], MON[m1[2].slice(0,3).toLowerCase()], +m1[1]);
  const m2 = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2}),?\s*(\d{4})/i);
  if (m2) return new Date(+m2[3], MON[m2[1].slice(0,3).toLowerCase()], +m2[2]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function released(dateStr) { const d = parseDate(dateStr); return d ? d <= new Date() : false; }

// ── TITLE VARIANTS ────────────────────────────────────────────────────────────
function variants(raw) {
  const base = raw.replace(/\s*\([^)]*\)/g,'').replace(/\s*\[[^\]]*\]/g,'')
                  .replace(/\s*[Ss]eason\s*\d+/,'').replace(/\s+/g,' ').trim();
  const v = new Set([base]);
  if (base.includes(':'))   v.add(base.split(':')[0].trim());
  if (base.includes(' - ')) v.add(base.split(' - ')[0].trim());
  return Array.from(v).filter(x => x.length >= 2);
}

// ── TMDB ──────────────────────────────────────────────────────────────────────
async function searchTMDB(title, type, lang) {
  if (!CONFIG.TMDB_KEY) return null;
  const ep = type === 'series' ? 'tv' : 'movie';
  for (const v of variants(title)) {
    try {
      const data = await tmdbFetch(
        'https://api.themoviedb.org/3/search/' + ep
        + '?api_key=' + CONFIG.TMDB_KEY + '&query=' + encodeURIComponent(v) + '&language=en-US&page=1'
      );
      if (!data.results?.length) continue;
      let best = null, top = -1;
      for (const r of data.results) {
        let sc = 0;
        const rt = (r.title || r.name || '').toLowerCase(), vl = v.toLowerCase();
        if (rt === vl) sc += 60; else if (rt.startsWith(vl)) sc += 35; else if (rt.includes(vl)) sc += 20;
        if (r.original_language === lang) sc += 50; else if (r.original_language === 'en') sc -= 30; else sc -= 10;
        if (r.origin_country?.includes('IN')) sc += 15;
        if (sc > top && sc >= 50) { top = sc; best = r; }
      }
      if (!best) continue;
      const det = await tmdbFetch('https://api.themoviedb.org/3/' + ep + '/' + best.id + '?api_key=' + CONFIG.TMDB_KEY);
      if (!det.imdb_id) continue;
      return makeTMDB(det);
    } catch (e) { console.warn('[TMDB] "' + v + '": ' + e.message); }
  }
  return null;
}

async function findByImdb(imdbId, type) {
  if (!CONFIG.TMDB_KEY || !imdbId) return null;
  try {
    const data = await tmdbFetch('https://api.themoviedb.org/3/find/' + imdbId + '?api_key=' + CONFIG.TMDB_KEY + '&external_source=imdb_id');
    const res  = (type === 'series' ? data.tv_results : data.movie_results) || [];
    if (!res.length) return null;
    const ep  = type === 'series' ? 'tv' : 'movie';
    const det = await tmdbFetch('https://api.themoviedb.org/3/' + ep + '/' + res[0].id + '?api_key=' + CONFIG.TMDB_KEY);
    return makeTMDB(det, imdbId);
  } catch (e) { console.warn('[TMDB/find] ' + imdbId + ': ' + e.message); return null; }
}

function makeTMDB(d, fallback) {
  return {
    imdbId:   d.imdb_id || fallback || null,
    poster:   d.poster_path   ? 'https://image.tmdb.org/t/p/w500'  + d.poster_path   : null,
    backdrop: d.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + d.backdrop_path : null,
    overview: d.overview      || null,
    rating:   d.vote_average  ? d.vote_average.toFixed(1) : null,
    year:     (d.release_date || d.first_air_date || '').slice(0, 4) || null,
    genres:   (d.genres || []).map(g => g.name),
  };
}

// ── OMDB ──────────────────────────────────────────────────────────────────────
async function searchOMDb(title, type, lang) {
  if (!CONFIG.OMDB_KEY || !CONFIG.ENABLE_OMDB) return null;
  const ot = type === 'series' ? 'series' : 'movie';
  const tl = lang === 'ml' ? 'malayalam' : 'tamil';
  for (const v of variants(title)) {
    try {
      const d = await fetchJson('https://www.omdbapi.com/?apikey=' + CONFIG.OMDB_KEY + '&t=' + encodeURIComponent(v) + '&type=' + ot);
      if (!d || d.Response !== 'True' || !d.imdbID) continue;
      const l = (d.Language || '').toLowerCase();
      if (l && !l.includes(tl) && !l.includes('hindi')) continue;
      return {
        imdbId:   d.imdbID,
        poster:   d.Poster     !== 'N/A' ? d.Poster     : null,
        backdrop: null,
        overview: d.Plot       !== 'N/A' ? d.Plot       : null,
        rating:   d.imdbRating !== 'N/A' ? d.imdbRating : null,
        year:     d.Year       || null,
        genres:   d.Genre && d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
      };
    } catch (e) { console.warn('[OMDb] "' + v + '": ' + e.message); }
  }
  return null;
}

// ── RESOLVE ───────────────────────────────────────────────────────────────────
async function resolve(title, type, lang) {
  const key = (title + '|' + type + '|' + lang).toLowerCase().replace(/[^a-z0-9|]/g, '');
  const hit = cacheGet(key);
  if (hit !== undefined) { if (hit === 'nf') return null; console.log('[Hit] ' + title); return hit; }

  let r = await searchTMDB(title, type, lang);
  if (!r && CONFIG.ENABLE_OMDB) r = await searchOMDb(title, type, lang);

  // If found via OMDb but no poster — try TMDB /find for poster
  if (r?.imdbId && !r.poster && CONFIG.TMDB_KEY) {
    const t = await findByImdb(r.imdbId, type);
    if (t?.poster) { r.poster = t.poster; r.backdrop = t.backdrop; r.overview = r.overview || t.overview; }
  }

  if (r) { console.log('[Resolve] ' + title + ' -> ' + r.imdbId); cacheSet(key, r); }
  else   { console.log('[Resolve] Not found: ' + title);            cacheSet(key, 'nf'); }
  return r;
}

// ── PARSE: CINEBUDS (table) ───────────────────────────────────────────────────
function parseCinebuds(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('table').each((_, t) => {
    const h = [];
    $(t).find('thead th,thead td').each((_, x) => h.push($(x).text().trim().toLowerCase()));
    if (!h.length) $(t).find('tr').first().find('th,td').each((_, x) => h.push($(x).text().trim().toLowerCase()));
    const ti = h.findIndex(x => x.includes('movie') || x.includes('title') || x.includes('name'));
    const pi = h.findIndex(x => x.includes('platform') || x.includes('ott') || x.includes('streaming'));
    const di = h.findIndex(x => x.includes('date') || x.includes('release') || x.includes('stream') || x.includes('digital'));
    if (ti === -1) return;
    $(t).find('tr').each((ri, r) => {
      if (ri === 0 && h.length) return;
      const c = $(r).find('td');
      if (!c.length) return;
      const title = $(c[ti]).text().replace(/\s+/g,' ').trim();
      const plat  = pi >= 0 ? $(c[pi]).text().replace(/\s+/g,' ').trim() : '';
      const date  = di >= 0 ? $(c[di]).text().replace(/\[.*?\]/g,'').trim() : '';
      if (!title || title.length < 2 || /^\d+$/.test(title) || !plat) return;
      out.push({ title, platform: plat, releaseDate: date });
    });
  });
  console.log('[Cinebuds] ' + out.length + ' rows');
  return out;
}

// ── PARSE: KERALATV (table with Type column) ──────────────────────────────────
function parseKeralaTV(html, want) {
  const $ = cheerio.load(html);
  const out = [];
  $('table').each((_, t) => {
    const h = [];
    $(t).find('thead th,thead td').each((_, x) => h.push($(x).text().replace(/[^\w\s]/g,'').trim().toLowerCase()));
    if (!h.length) $(t).find('tr').first().find('th,td').each((_, x) => h.push($(x).text().replace(/[^\w\s]/g,'').trim().toLowerCase()));
    const ti = h.findIndex(x => x.includes('title') || x.includes('movie') || x.includes('name'));
    const xi = h.findIndex(x => x.includes('type'));
    const pi = h.findIndex(x => x.includes('ott') || x.includes('platform') || x.includes('streaming'));
    const di = h.findIndex(x => x.includes('date') || x.includes('release'));
    if (ti === -1) return;
    $(t).find('tr').each((ri, r) => {
      if (ri === 0 && h.length) return;
      const c = $(r).find('td');
      if (!c.length) return;
      const title = $(c[ti]).text().replace(/\s+/g,' ').trim();
      const xraw  = xi >= 0 ? $(c[xi]).text().toLowerCase() : '';
      const plat  = pi >= 0 ? $(c[pi]).text().replace(/\s+/g,' ').trim() : '';
      const date  = di >= 0 ? $(c[di]).text().replace(/\[.*?\]/g,'').trim() : '';
      if (!title || title.length < 2 || !plat || /^tba$/i.test(plat)) return;
      const isSeries = /series|web|show/i.test(xraw);
      if (xi === -1) { if (want !== 'series') out.push({ title, platform: plat, releaseDate: date }); return; }
      if (want === 'series' && !isSeries) return;
      if (want === 'movie'  &&  isSeries) return;
      out.push({ title, platform: plat, releaseDate: date });
    });
  });
  console.log('[KeralaTV/' + want + '] ' + out.length + ' rows');
  return out;
}

// ── PARSE: FILMIBEAT (article-style h2 + paragraphs) ─────────────────────────
// Each entry is an h2 heading followed by paragraph(s).
// Platform and date are extracted from the text pattern:
//   "streaming on [Platform] from [Date]"
// Series detection: paragraph contains "series", "season N", or "episodes"
function parseFilmibeat(html, want) {
  const $ = cheerio.load(html);
  const out = [];
  const SKIP = /disclaimer|top listing|stay connected|read more|latest releases|upcoming/i;

  $('h2').each((_, el) => {
    const title = $(el).text().replace(/\s+/g,' ').trim();
    if (!title || title.length < 2 || SKIP.test(title)) return;

    // Gather all paragraph text after this h2 until the next h2
    const parts = [];
    $(el).nextUntil('h2', 'p').each((_, p) => parts.push($(p).text()));
    const desc = parts.join(' ').replace(/\s+/g,' ').trim();
    if (!desc || desc.length < 15) return;

    // Series detection
    const isSeries = /\b(series|web series|season \d+|episodes?)\b/i.test(desc);
    if (want === 'series' && !isSeries) return;
    if (want === 'movie'  &&  isSeries) return;

    // Extract platform + date
    // Common patterns on Filmibeat:
    //   "...streaming on Sun NXT from June 26, 2026..."
    //   "...now streaming on ZEE5 from July 3, 2026..."
    //   "...premieres on JioHotstar from May 29, 2026..."
    //   "...available on Amazon Prime Video from June 18, 2026..."
    let platform = '', releaseDate = '';

    const match = desc.match(
      /(?:streaming on|available on|premiere[sd]? on|debuts? on|start(?:s|ing)(?: streaming)? on|now (?:streaming|available) on)\s+([A-Za-z0-9 +]+?)\s+from\s+([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2} [A-Za-z]+ \d{4})/i
    );
    if (match) {
      platform    = match[1].trim();
      releaseDate = match[2].trim();
    } else {
      // Fallback: look for bold/strong tags which Filmibeat uses for platform+date
      const bolds = [];
      $(el).nextUntil('h2','p').find('strong,b').each((_, b) => {
        const t = $(b).text().trim();
        if (t) bolds.push(t);
      });
      // Typical: bold[0] = "Sun NXT", bold[1] = "June 26, 2026"
      if (bolds.length >= 2) {
        platform    = bolds[0];
        releaseDate = bolds[1];
      } else if (bolds.length === 1) {
        // Sometimes one bold has both: "Sun NXT from June 26, 2026"
        const sp = bolds[0].match(/^(.+?)\s+from\s+(.+)$/i);
        if (sp) { platform = sp[1].trim(); releaseDate = sp[2].trim(); }
        else platform = bolds[0];
      }
    }

    // Also try "OTT Release: Platform – Date" pattern
    if (!platform) {
      const ott = desc.match(/OTT Release:\s*([A-Za-z0-9 +]+?)\s*[–-]\s*([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2} [A-Za-z]+ \d{4})/i);
      if (ott) { platform = ott[1].trim(); releaseDate = ott[2].trim(); }
    }

    if (!platform || platform.length < 2) return;
    out.push({ title, platform, releaseDate });
  });

  console.log('[Filmibeat/' + want + '] ' + out.length + ' items');
  return out;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function dedup(items) {
  const seen = new Map(), r = [];
  for (const i of items) {
    const k = i.title.toLowerCase().replace(/[^a-z0-9]/g,'');
    if (seen.has(k)) { const e = r[seen.get(k)]; if (!e.platform.includes(i.platform)) e.platform += ', ' + i.platform; }
    else { seen.set(k, r.length); r.push({...i}); }
  }
  return r;
}

function sortDesc(items) {
  return items.sort((a,b) => { const da=parseDate(a.releaseDate),db=parseDate(b.releaseDate); if(da&&db)return db-da; if(da)return -1; if(db)return 1; return 0; });
}

async function buildMetas(items, type, lang) {
  const results = [], queue = [...items];
  await new Promise(done => {
    let active = 0;
    const next = async () => {
      if (!queue.length) { if (!active) done(); return; }
      const item = queue.shift(); active++;
      try {
        const imdb = await resolve(item.title, type, lang);
        if (imdb?.imdbId) {
          let desc = '';
          if (imdb.overview) desc += imdb.overview + '\n\n';
          desc += '📺 Streaming on: ' + item.platform + '\n📅 OTT Release: ' + item.releaseDate;
          if (imdb.rating) desc += '\n⭐ Rating: ' + imdb.rating + '/10';
          const meta = { id: imdb.imdbId, type, name: item.title, releaseInfo: imdb.year || item.releaseDate, description: desc.trim(), poster: imdb.poster||undefined, background: imdb.backdrop||undefined, genres: imdb.genres?.length ? imdb.genres : undefined };
          Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);
          results.push(meta);
        }
      } catch(e) { console.error('[Build] ' + e.message); }
      finally { active--; next(); }
    };
    for (let i = 0; i < Math.min(CONFIG.CONCURRENCY, items.length); i++) next();
  });
  console.log('[Build] ' + results.length + '/' + items.length + ' resolved');
  return results;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  loadCache();
  try {
    let items = [];
    if (type === 'movie') {
      console.log('[scraper] Malayalam movies: 2 sources...');
      const [h1, h2] = await Promise.all([
        tryFetch('Cinebuds-MAL',  SRC.CINEBUDS_MAL),
        tryFetch('Filmibeat-MAL', SRC.FILMIBEAT_MAL),
      ]);
      const a = h1 ? parseCinebuds(h1) : [];
      const b = h2 ? parseFilmibeat(h2, 'movie') : [];
      console.log('[scraper] cinebuds=' + a.length + ' filmibeat=' + b.length);
      items = sortDesc(dedup([...a,...b].filter(i => released(i.releaseDate))));
    } else {
      console.log('[scraper] Malayalam series: 2 sources...');
      const [h1, h2] = await Promise.all([
        tryFetch('Filmibeat-MAL', SRC.FILMIBEAT_MAL),
        tryFetch('KeralaTV',      SRC.KERALATV),
      ]);
      const a = h1 ? parseFilmibeat(h1, 'series') : [];
      const b = h2 ? parseKeralaTV(h2, 'series')  : [];
      console.log('[scraper] filmibeat=' + a.length + ' keralatv=' + b.length);
      items = sortDesc(dedup([...a,...b].filter(i => released(i.releaseDate))));
    }
    console.log('[scraper] Malayalam ' + type + ': ' + items.length + ' released -> top ' + CONFIG.MAX_ITEMS);
    const result = await buildMetas(items.slice(0, CONFIG.MAX_ITEMS), type, 'ml');
    saveCache(); return result;
  } catch(e) { console.error('[scraper] Malayalam ' + type + ':', e.message); saveCache(); return []; }
}

async function scrapeTamil(type) {
  loadCache();
  try {
    let items = [];
    if (type === 'movie') {
      console.log('[scraper] Tamil movies: 2 sources...');
      const [h1, h2] = await Promise.all([
        tryFetch('Cinebuds-TAM',  SRC.CINEBUDS_TAM),
        tryFetch('Filmibeat-TAM', SRC.FILMIBEAT_TAM),
      ]);
      const a = h1 ? parseCinebuds(h1) : [];
      const b = h2 ? parseFilmibeat(h2, 'movie') : [];
      console.log('[scraper] cinebuds=' + a.length + ' filmibeat=' + b.length);
      items = sortDesc(dedup([...a,...b].filter(i => released(i.releaseDate))));
    } else {
      console.log('[scraper] Tamil series: 2 sources...');
      const [h1, h2] = await Promise.all([
        tryFetch('Filmibeat-TAM', SRC.FILMIBEAT_TAM),
        tryFetch('KeralaTV',      SRC.KERALATV),
      ]);
      // FIX: was incorrectly passing h2 to both — now correctly uses h1 for Filmibeat
      const a = h1 ? parseFilmibeat(h1, 'series') : [];
      const b = h2 ? parseKeralaTV(h2, 'series')  : [];
      console.log('[scraper] filmibeat=' + a.length + ' keralatv=' + b.length);
      items = sortDesc(dedup([...a,...b].filter(i => released(i.releaseDate))));
    }
    console.log('[scraper] Tamil ' + type + ': ' + items.length + ' released -> top ' + CONFIG.MAX_ITEMS);
    const result = await buildMetas(items.slice(0, CONFIG.MAX_ITEMS), type, 'ta');
    saveCache(); return result;
  } catch(e) { console.error('[scraper] Tamil ' + type + ':', e.message); saveCache(); return []; }
}

module.exports = { scrapeMalayalam, scrapeTamil };
