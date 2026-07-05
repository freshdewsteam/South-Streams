/**
 * scraper.js
 *
 * Movies  → cinebuds.com (Malayalam & Tamil)
 * Series  → keralatv.in monthly guide (Malayalam & Tamil)
 *
 * Runs on GitHub Actions — GitHub IPs not blocked by either source.
 * Resolves real IMDb IDs via TMDB + OMDb fallback.
 * Excludes anything without a real IMDb ID.
 */

const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const cheerio = require('cheerio');

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const OMDB_KEY = process.env.OMDB_API_KEY || '';

// ── DYNAMIC KERALATV URL (auto-switches each month) ───────────────────────────
function getKeralaTVUrl() {
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
  ];
  const now   = new Date();
  const month = months[now.getMonth()];
  const year  = now.getFullYear();
  return 'https://www.keralatv.in/' + month + '-' + year + '-ott-release-guide/';
}

const URLS = {
  'mal-movie':  'https://cinebuds.com/malayalam-movies-ott-release-dates/',
  'mal-series': getKeralaTVUrl(),
  'tam-movie':  'https://cinebuds.com/tamil-movies-digital-release-dates/',
  'tam-series': getKeralaTVUrl(),
};

const LANG_CODE = {
  'mal-movie': 'ml', 'mal-series': 'ml',
  'tam-movie': 'ta', 'tam-series': 'ta',
};

// ── HTTP FETCH ────────────────────────────────────────────────────────────────
function fetchRaw(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib  = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
    };
    const req = lib.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchRaw(res.headers.location, timeoutMs).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error('HTTP ' + res.statusCode));

      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 30000, function() {
      this.destroy();
      reject(new Error('Timeout after ' + timeoutMs + 'ms'));
    });
  });
}

function fetchJson(url) {
  return fetchRaw(url, 15000).then(t => JSON.parse(t));
}

// ── DATE LOGIC ────────────────────────────────────────────────────────────────
function parseDate(str) {
  if (!str) return null;
  if (/soon|tba|tbd|announced|upcoming|expected|expect|confirm|tentative|coming soon/i.test(str)) return null;
  const d = new Date(str.replace(/\s*\(.*?\)/g, '').trim());
  return isNaN(d.getTime()) ? null : d;
}

function isAlreadyReleased(dateStr) {
  const d = parseDate(dateStr);
  return d ? d <= new Date() : false;
}

// ── TITLE VARIANTS ────────────────────────────────────────────────────────────
function getTitleVariants(raw) {
  const base = raw
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const variants = new Set();
  variants.add(base);
  if (base.includes(':'))   variants.add(base.split(':')[0].trim());
  if (base.includes(' - ')) variants.add(base.split(' - ')[0].trim());
  const noThe = base.replace(/\b(the|a|an)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (noThe !== base)       variants.add(noThe);

  return Array.from(variants).filter(v => v.length >= 2);
}

// ── TMDB SEARCH ───────────────────────────────────────────────────────────────
async function searchTMDB(title, type, langCode) {
  if (!TMDB_KEY) return null;
  const endpoint = type === 'series' ? 'tv' : 'movie';

  for (const variant of getTitleVariants(title)) {
    try {
      const data = await fetchJson(
        'https://api.themoviedb.org/3/search/' + endpoint
        + '?api_key=' + TMDB_KEY
        + '&query=' + encodeURIComponent(variant)
        + '&language=en-US&page=1'
      );
      if (!data.results || data.results.length === 0) continue;

      let best = null, bestScore = -1;
      for (const r of data.results) {
        let score = 0;
        const rTitle = (r.title || r.name || '').toLowerCase();
        const vLow   = variant.toLowerCase();

        if (rTitle === vLow)               score += 60;
        else if (rTitle.startsWith(vLow))  score += 35;
        else if (rTitle.includes(vLow))    score += 20;

        if (r.original_language === langCode)  score += 50;
        else if (r.original_language === 'en') score -= 30;
        else                                   score -= 10;

        if (r.origin_country && r.origin_country.includes('IN')) score += 15;

        if (score > bestScore && score >= 50) { bestScore = score; best = r; }
      }

      if (!best) continue;

      const detail = await fetchJson(
        'https://api.themoviedb.org/3/' + endpoint + '/' + best.id
        + '?api_key=' + TMDB_KEY
      );

      if (!detail.imdb_id) continue;

      return {
        imdbId:   detail.imdb_id,
        poster:   detail.poster_path   ? 'https://image.tmdb.org/t/p/w500'  + detail.poster_path   : null,
        backdrop: detail.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + detail.backdrop_path : null,
        overview: detail.overview      || null,
        rating:   detail.vote_average  ? detail.vote_average.toFixed(1) : null,
        year:     (detail.release_date || detail.first_air_date || '').slice(0, 4) || null,
        genres:   (detail.genres || []).map(g => g.name),
      };
    } catch (e) {
      console.warn('[TMDB] Error for "' + variant + '": ' + e.message);
    }
  }
  return null;
}

// ── OMDB FALLBACK ─────────────────────────────────────────────────────────────
async function searchOMDb(title, type, langCode) {
  if (!OMDB_KEY) return null;
  const omdbType   = type === 'series' ? 'series' : 'movie';
  const targetLang = langCode === 'ml' ? 'malayalam' : 'tamil';

  for (const variant of getTitleVariants(title)) {
    try {
      const data = await fetchJson(
        'https://www.omdbapi.com/?apikey=' + OMDB_KEY
        + '&t=' + encodeURIComponent(variant)
        + '&type=' + omdbType
      );
      if (!data || data.Response !== 'True' || !data.imdbID) continue;

      const lang = (data.Language || '').toLowerCase();
      if (lang && !lang.includes(targetLang) && !lang.includes('hindi')) {
        console.log('[OMDb] Language mismatch for "' + variant + '": ' + data.Language);
        continue;
      }

      return {
        imdbId:   data.imdbID,
        poster:   data.Poster     !== 'N/A' ? data.Poster     : null,
        backdrop: null,
        overview: data.Plot       !== 'N/A' ? data.Plot       : null,
        rating:   data.imdbRating !== 'N/A' ? data.imdbRating : null,
        year:     data.Year       || null,
        genres:   data.Genre && data.Genre !== 'N/A' ? data.Genre.split(', ') : [],
      };
    } catch (e) {
      console.warn('[OMDb] Error for "' + variant + '": ' + e.message);
    }
  }
  return null;
}

// ── RESOLVE IMDB ID ───────────────────────────────────────────────────────────
const resolveCache = new Map();

async function resolveImdbId(title, type, langCode) {
  const key = title + '|' + type + '|' + langCode;
  if (resolveCache.has(key)) return resolveCache.get(key);

  let result = await searchTMDB(title, type, langCode);
  if (!result && OMDB_KEY) {
    console.log('[OMDb] Trying fallback for "' + title + '"...');
    result = await searchOMDb(title, type, langCode);
  }

  if (result) console.log('[resolve] ' + title + ' -> ' + result.imdbId);
  else        console.log('[resolve] No IMDb ID for "' + title + '" — excluding');

  resolveCache.set(key, result);
  return result;
}

// ── PARSE CINEBUDS TABLE (movies) ────────────────────────────────────────────
function parseCinebudsTable(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('thead th, thead td').each((_, th) =>
      headers.push($(th).text().trim().toLowerCase())
    );
    if (headers.length === 0)
      $(table).find('tr').first().find('th, td').each((_, th) =>
        headers.push($(th).text().trim().toLowerCase())
      );

    const titleIdx    = headers.findIndex(h => h.includes('movie') || h.includes('title') || h.includes('series') || h.includes('show') || h.includes('film') || h.includes('name'));
    const platformIdx = headers.findIndex(h => h.includes('platform') || h.includes('ott') || h.includes('streaming') || h.includes('where') || h.includes('service'));
    const dateIdx     = headers.findIndex(h => h.includes('date') || h.includes('release') || h.includes('premiere') || h.includes('stream') || h.includes('digital'));

    if (titleIdx === -1) return;

    $(table).find('tr').each((rowIdx, row) => {
      if (rowIdx === 0 && headers.length > 0) return;
      const cells = $(row).find('td');
      if (cells.length === 0) return;

      const title       = $(cells[titleIdx]).text().replace(/\s+/g, ' ').trim();
      const platform    = platformIdx >= 0 ? $(cells[platformIdx]).text().replace(/\s+/g, ' ').trim() : '';
      const releaseDate = dateIdx >= 0     ? $(cells[dateIdx]).text().replace(/\[.*?\]/g, '').trim()  : '';

      if (!title || title.length < 2 || /^\d+$/.test(title)) return;
      if (!platform) return;
      items.push({ title, platform, releaseDate });
    });
  });

  return items;
}

// ── PARSE KERALATV TABLE (series) ────────────────────────────────────────────
function parseKeralaTVTable(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('thead th, thead td').each((_, th) =>
      headers.push($(th).text().replace(/[^\w\s]/g, '').trim().toLowerCase())
    );
    if (headers.length === 0)
      $(table).find('tr').first().find('th, td').each((_, th) =>
        headers.push($(th).text().replace(/[^\w\s]/g, '').trim().toLowerCase())
      );

    const titleIdx    = headers.findIndex(h => h.includes('title') || h.includes('movie') || h.includes('name'));
    const typeIdx     = headers.findIndex(h => h.includes('type'));
    const platformIdx = headers.findIndex(h => h.includes('ott') || h.includes('platform') || h.includes('streaming'));
    const dateIdx     = headers.findIndex(h => h.includes('date') || h.includes('release'));

    if (titleIdx === -1) return;

    $(table).find('tr').each((rowIdx, row) => {
      if (rowIdx === 0 && headers.length > 0) return;
      const cells = $(row).find('td');
      if (cells.length === 0) return;

      const title       = $(cells[titleIdx]).text().replace(/\s+/g, ' ').trim();
      const typeRaw     = typeIdx >= 0 ? $(cells[typeIdx]).text().toLowerCase() : '';
      const platform    = platformIdx >= 0 ? $(cells[platformIdx]).text().replace(/\s+/g, ' ').trim() : '';
      const releaseDate = dateIdx >= 0     ? $(cells[dateIdx]).text().replace(/\[.*?\]/g, '').trim()  : '';

      if (!title || title.length < 2) return;
      if (!platform) return;

      const isSeries = typeRaw.includes('series') || typeRaw.includes('web') || typeRaw.includes('show');
      if (!isSeries) return;

      items.push({ title, platform, releaseDate });
    });
  });

  return items;
}

// ── DEDUPLICATE ───────────────────────────────────────────────────────────────
function deduplicate(items) {
  const seen = new Map(), result = [];
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) {
      const ex = result[seen.get(key)];
      if (!ex.platform.includes(item.platform)) ex.platform += ', ' + item.platform;
    } else {
      seen.set(key, result.length);
      result.push({ ...item });
    }
  }
  return result;
}

// ── MAIN SCRAPE ───────────────────────────────────────────────────────────────
async function scrapePage(urlKey, type) {
  const url      = URLS[urlKey];
  const langCode = LANG_CODE[urlKey];

  console.log('[scraper] Fetching ' + url);
  const html = await fetchRaw(url, 45000);
  console.log('[scraper] Downloaded ' + html.length + ' bytes');

  const rawItems = (type === 'series')
    ? parseKeralaTVTable(html)
    : parseCinebudsTable(html);

  console.log('[scraper] Parsed ' + rawItems.length + ' rows');

  const released = rawItems.filter(i => isAlreadyReleased(i.releaseDate));
  const unique   = deduplicate(released);

  unique.sort((a, b) => {
    const da = parseDate(a.releaseDate), db = parseDate(b.releaseDate);
    if (da && db) return db - da;
    return 0;
  });

  console.log('[scraper] ' + unique.length + ' unique released items — resolving IMDb IDs...');

  const metas = [];

  for (const item of unique) {
    const imdb = await resolveImdbId(item.title, type, langCode);
    if (!imdb || !imdb.imdbId) continue;

    let desc = '';
    if (imdb.overview) desc += imdb.overview + '\n\n';
    desc += '📺 Streaming on: ' + item.platform + '\n';
    desc += '📅 OTT Release: '  + item.releaseDate;
    if (imdb.rating)   desc += '\n⭐ Rating: ' + imdb.rating + '/10';

    const meta = {
      id:          imdb.imdbId,
      type,
      name:        item.title,
      releaseInfo: imdb.year || item.releaseDate,
      description: desc.trim(),
      poster:      imdb.poster   || undefined,
      background:  imdb.backdrop || undefined,
      genres:      imdb.genres && imdb.genres.length ? imdb.genres : undefined,
    };

    Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);
    metas.push(meta);

    await new Promise(r => setTimeout(r, 250));
  }

  console.log('[scraper] Done: ' + metas.length + ' items with valid IMDb IDs');
  return metas;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  try { return await scrapePage(type === 'movie' ? 'mal-movie' : 'mal-series', type); }
  catch (e) { console.warn('[scraper] Malayalam ' + type + ': ' + e.message); return []; }
}

async function scrapeTamil(type) {
  try { return await scrapePage(type === 'movie' ? 'tam-movie' : 'tam-series', type); }
  catch (e) { console.warn('[scraper] Tamil ' + type + ': ' + e.message); return []; }
}

module.exports = { scrapeMalayalam, scrapeTamil };
