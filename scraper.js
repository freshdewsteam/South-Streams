/**
 * scraper.js
 *
 * 1. Scrapes OTT release tables from cinebuds.com
 * 2. Filters to ONLY already-released titles (past/today dates)
 *    - "Soon", "TBA", future dates, blank dates are all excluded
 * 3. Deduplicates by title (merges platforms)
 * 4. Enriches first 10 with TMDB posters
 * 5. Sorts newest-first by OTT release date
 */

const https   = require('https');
const zlib    = require('zlib');
const cheerio = require('cheerio');

const TMDB_KEY = process.env.TMDB_API_KEY || '';

const URLS = {
  'mal-movie':  'https://cinebuds.com/malayalam-movies-ott-release-dates/',
  'mal-series': 'https://cinebuds.com/malayalam-web-series-ott-release-dates/',
  'tam-movie':  'https://cinebuds.com/tamil-movies-digital-release-dates/',
  'tam-series': 'https://cinebuds.com/tamil-web-series-ott-release-dates/',
};

const LANG_CODE = {
  'mal-movie': 'ml', 'mal-series': 'ml',
  'tam-movie': 'ta', 'tam-series': 'ta',
};

// ---- HTTP FETCH -------------------------------------------------------------
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
    };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));

      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }).on('error', reject)
      .setTimeout(30000, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJson(url) {
  return fetchUrl(url).then(text => JSON.parse(text));
}

// ---- DATE LOGIC -------------------------------------------------------------
function parseDate(str) {
  if (!str) return null;
  if (/soon|tba|tbd|announced|upcoming|expected|expect|confirm|tentative/i.test(str)) return null;
  const cleaned = str.replace(/\s*\(.*?\)/g, '').trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

// TRUE only if OTT date is a real date that is today or already past
function isAlreadyReleased(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;     // "Soon", "TBA", blank, future-flagged -> skip
  return d <= new Date();   // past or today -> include
}

// ---- TMDB ENRICHMENT -------------------------------------------------------
async function tmdbSearch(title, type, langCode) {
  if (!TMDB_KEY) return null;
  try {
    const endpoint = type === 'series' ? 'tv' : 'movie';
    const query    = encodeURIComponent(title);
    const url      = 'https://api.themoviedb.org/3/search/' + endpoint +
                     '?api_key=' + TMDB_KEY +
                     '&query=' + query +
                     '&with_original_language=' + langCode +
                     '&language=en-US&page=1';
    const data   = await fetchJson(url);
    const result = data.results && data.results[0];
    if (!result) return null;
    return {
      poster:      result.poster_path   ? 'https://image.tmdb.org/t/p/w500'  + result.poster_path   : null,
      background:  result.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + result.backdrop_path : null,
      description: result.overview      || null,
      imdbRating:  result.vote_average  ? String(result.vote_average.toFixed(1)) : null,
    };
  } catch (e) {
    console.warn('[tmdb] Search failed for "' + title + '": ' + e.message);
    return null;
  }
}

// ---- PARSE CINEBUDS TABLE --------------------------------------------------
function parseCinebudsTable(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('thead th, thead td').each((_, th) => {
      headers.push($(th).text().trim().toLowerCase());
    });
    if (headers.length === 0) {
      $(table).find('tr').first().find('th, td').each((_, th) => {
        headers.push($(th).text().trim().toLowerCase());
      });
    }

    const titleIdx    = headers.findIndex(h => h.includes('movie') || h.includes('title') || h.includes('series') || h.includes('show'));
    const platformIdx = headers.findIndex(h => h.includes('platform') || h.includes('ott') || h.includes('streaming') || h.includes('where'));
    const dateIdx     = headers.findIndex(h => h.includes('date') || h.includes('release') || h.includes('premiere'));

    if (titleIdx === -1) return;

    $(table).find('tr').each((rowIdx, row) => {
      if (rowIdx === 0 && headers.length > 0) return;
      const cells = $(row).find('td');
      if (cells.length === 0) return;

      const title       = $(cells[titleIdx]).text().trim();
      const platform    = platformIdx >= 0 ? $(cells[platformIdx]).text().trim() : '';
      const releaseDate = dateIdx >= 0     ? $(cells[dateIdx]).text().trim()     : '';

      if (!title || title.length < 2) return;
      if (!platform) return;

      items.push({ title, platform, releaseDate });
    });
  });

  return items;
}

// ---- DEDUPLICATE -----------------------------------------------------------
function deduplicate(items) {
  const seen   = new Map();
  const result = [];

  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) {
      const existing = result[seen.get(key)];
      if (!existing.platform.includes(item.platform)) {
        existing.platform += ' & ' + item.platform;
      }
    } else {
      seen.set(key, result.length);
      result.push(Object.assign({}, item));
    }
  }

  return result;
}

// ---- MAIN SCRAPE -----------------------------------------------------------
async function scrapePage(urlKey, type) {
  const url      = URLS[urlKey];
  const langCode = LANG_CODE[urlKey];

  console.log('[scraper] Fetching: ' + url);
  const html = await fetchUrl(url);
  console.log('[scraper] Downloaded ' + html.length + ' bytes');

  const rawItems = parseCinebudsTable(html);
  console.log('[scraper] Parsed ' + rawItems.length + ' rows');

  // STEP 1: Keep ONLY movies already released on OTT (past or today)
  const released = rawItems.filter(item => isAlreadyReleased(item.releaseDate));
  console.log('[scraper] Already on OTT: ' + released.length + ' items');

  // STEP 2: Deduplicate
  const unique = deduplicate(released);
  console.log('[scraper] After dedup: ' + unique.length + ' items');

  // STEP 3: Sort newest-first
  unique.sort((a, b) => {
    const da = parseDate(a.releaseDate);
    const db = parseDate(b.releaseDate);
    if (da && db) return db - da;
    return 0;
  });

  // STEP 4: Build Stremio meta objects
  const metas = unique.map((item, idx) => {
    const slug = item.title.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60);
    const id   = 'cinebuds_' + slug + '_' + idx;
    const desc = [
      item.platform    ? ('📺 ' + item.platform)                 : null,
      item.releaseDate ? ('📅 OTT Release: ' + item.releaseDate) : null,
    ].filter(Boolean).join('\n');

    return {
      id,
      type,
      name:        item.title,
      releaseInfo: item.releaseDate,
      description: desc || undefined,
      poster:      undefined,
      background:  undefined,
    };
  }).filter(m => m.name);

  // STEP 5: Enrich first 10 with TMDB posters (all 10 run in parallel)
  if (TMDB_KEY) {
    console.log('[tmdb] Enriching first 10 items...');
    const enriched = await Promise.all(
      metas.slice(0, 10).map(meta => tmdbSearch(meta.name, type, langCode))
    );
    enriched.forEach((tmdb, i) => {
      if (!tmdb) return;
      if (tmdb.poster)      metas[i].poster      = tmdb.poster;
      if (tmdb.background)  metas[i].background  = tmdb.background;
      if (tmdb.description) metas[i].description = tmdb.description + '\n\n' + (metas[i].description || '');
      if (tmdb.imdbRating)  metas[i].imdbRating  = tmdb.imdbRating;
    });
    console.log('[tmdb] Done');
  } else {
    console.log('[tmdb] No TMDB_API_KEY — skipping posters');
  }

  metas.forEach(m => Object.keys(m).forEach(k => m[k] === undefined && delete m[k]));
  return metas;
}

// ---- PUBLIC API ------------------------------------------------------------
async function scrapeMalayalam(type) {
  const key = type === 'movie' ? 'mal-movie' : 'mal-series';
  try { return await scrapePage(key, type); }
  catch (e) { console.warn('[scraper] Malayalam ' + type + ' failed: ' + e.message); return []; }
}

async function scrapeTamil(type) {
  const key = type === 'movie' ? 'tam-movie' : 'tam-series';
  try { return await scrapePage(key, type); }
  catch (e) { console.warn('[scraper] Tamil ' + type + ' failed: ' + e.message); return []; }
}

module.exports = { scrapeMalayalam, scrapeTamil };
