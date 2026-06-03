/**
 * scraper.js
 *
 * Fetches Malayalam & Tamil OTT releases from:
 *   - cinebuds.com  (Malayalam movies & Tamil movies)
 *
 * These are WordPress sites — plain HTML, no JS rendering needed.
 * Uses cheerio to parse tables.
 * Sorted newest-first by OTT release date.
 */

const https  = require('https');
const zlib   = require('zlib');
const cheerio = require('cheerio');

// ─── SOURCE URLS ──────────────────────────────────────────────────────────────
const URLS = {
  'mal-movie':  'https://cinebuds.com/malayalam-movies-ott-release-dates/',
  'mal-series': 'https://cinebuds.com/malayalam-web-series-ott-release-dates/',
  'tam-movie':  'https://cinebuds.com/tamil-movies-digital-release-dates/',
  'tam-series': 'https://cinebuds.com/tamil-web-series-ott-release-dates/',
};

// ─── HTTP FETCH ───────────────────────────────────────────────────────────────
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
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

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

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
function parseDate(str) {
  if (!str) return null;
  if (/soon|tba|tbd|announced|upcoming/i.test(str)) return null;
  const d = new Date(str.trim());
  return isNaN(d.getTime()) ? null : d;
}

// ─── PARSE CINEBUDS TABLE ─────────────────────────────────────────────────────
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

// ─── MAIN SCRAPE ──────────────────────────────────────────────────────────────
async function scrapePage(url, type) {
  console.log(`[scraper] Fetching: ${url}`);
  const html = await fetchUrl(url);
  console.log(`[scraper] Downloaded ${html.length} bytes`);

  const rawItems = parseCinebudsTable(html);
  console.log(`[scraper] Parsed ${rawItems.length} rows from tables`);

  rawItems.sort((a, b) => {
    const da = parseDate(a.releaseDate);
    const db = parseDate(b.releaseDate);
    if (da && db) return db - da;
    if (da) return -1;
    if (db) return 1;
    return 0;
  });

  return rawItems.map((item, idx) => {
    const slug = item.title.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60);
    const id   = `91mob_${slug}_${idx}`;

    const desc = [
      item.platform    ? `📺 ${item.platform}`              : null,
      item.releaseDate ? `📅 OTT Release: ${item.releaseDate}` : null,
    ].filter(Boolean).join('\n');

    return {
      id,
      type,
      name: item.title,
      releaseInfo: item.releaseDate || 'Upcoming',
      description: desc || undefined,
    };
  }).filter(m => m.name);
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  const url = URLS[type === 'movie' ? 'mal-movie' : 'mal-series'];
  try {
    return await scrapePage(url, type);
  } catch (e) {
    console.warn(`[scraper] Malayalam ${type} failed: ${e.message}`);
    return [];
  }
}

async function scrapeTamil(type) {
  const url = URLS[type === 'movie' ? 'tam-movie' : 'tam-series'];
  try {
    return await scrapePage(url, type);
  } catch (e) {
    console.warn(`[scraper] Tamil ${type} failed: ${e.message}`);
    return [];
  }
}

module.exports = { scrapeMalayalam, scrapeTamil };
