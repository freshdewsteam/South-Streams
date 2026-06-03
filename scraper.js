/**
 * scraper.js - FIXED VERSION
 * Better TMDB matching, cleaner text filtering, proper deduplication
 */

const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');

const TMDB_KEY = process.env.TMDB_API_KEY || '';

const URLS = {
  'mal-movie': 'https://cinebuds.com/malayalam-movies-ott-release-dates/',
  'mal-series': 'https://cinebuds.com/malayalam-web-series-ott-release-dates/',
  'tam-movie': 'https://cinebuds.com/tamil-movies-digital-release-dates/',
  'tam-series': 'https://cinebuds.com/tamil-web-series-ott-release-dates/',
};

const LANG_CODE = {
  'mal-movie': 'ml', 'mal-series': 'ml',
  'tam-movie': 'ta', 'tam-series': 'ta',
};

// Common garbage words to filter out
const GARBAGE_WORDS = [
  'view all', 'read more', 'share', 'tweet', 'facebook', 'whatsapp',
  'telegram', 'click here', 'subscribe', 'newsletter', 'advertisement',
  'trending', 'popular', 'recommended', 'related', 'comments'
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));

      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }).on('error', reject)
      .setTimeout(30000, function () { this.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJson(url) {
  return fetchUrl(url).then(text => JSON.parse(text));
}

function parseDate(str) {
  if (!str) return null;
  // Filter out non-date strings
  if (/soon|tba|tbd|announced|upcoming|expected|confirm|tentative|coming soon|not announced/i.test(str)) return null;
  
  const cleaned = str.replace(/\s*\(.*?\)/g, '').trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function isAlreadyReleased(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;
  return d <= new Date();
}

function cleanTitle(title) {
  if (!title) return '';
  // Remove extra spaces, newlines, and common garbage
  let cleaned = title.replace(/\s+/g, ' ').trim();
  // Remove parenthetical content that's not year (like (2024) is ok)
  cleaned = cleaned.replace(/\s*\([^)]*\)/g, (match) => {
    if (match.match(/\d{4}/)) return match; // Keep years
    return ''; // Remove other parenthetical content
  });
  // Remove words that indicate garbage
  for (const word of GARBAGE_WORDS) {
    cleaned = cleaned.replace(new RegExp(word, 'gi'), '');
  }
  return cleaned.trim();
}

async function tmdbSearch(title, type, langCode) {
  if (!TMDB_KEY) return null;
  
  try {
    const endpoint = type === 'series' ? 'tv' : 'movie';
    // Clean title for better matching
    const cleanTitle = title.split('(')[0].split('-')[0].trim();
    const query = encodeURIComponent(cleanTitle);
    
    // Search with language filter
    const url = 'https://api.themoviedb.org/3/search/' + endpoint +
      '?api_key=' + TMDB_KEY +
      '&query=' + query +
      '&language=en-US&page=1';
    
    const data = await fetchJson(url);
    
    if (!data.results || data.results.length === 0) return null;
    
    // Find best match - prioritize exact title match and correct language
    let bestMatch = null;
    let bestScore = 0;
    
    for (const result of data.results) {
      let score = 0;
      const resultTitle = (result.title || result.name || '').toLowerCase();
      const searchTitle = cleanTitle.toLowerCase();
      
      // Exact match
      if (resultTitle === searchTitle) score += 50;
      // Title contains search term
      else if (resultTitle.includes(searchTitle)) score += 30;
      // Search term contains result title
      else if (searchTitle.includes(resultTitle)) score += 20;
      
      // Check original language
      if (result.original_language === langCode) score += 40;
      // Check for India region
      if (result.origin_country && result.origin_country.includes('IN')) score += 20;
      
      // Popularity boost
      if (result.popularity) score += Math.min(result.popularity / 10, 10);
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }
    
    // Only use match if score is decent
    if (bestScore < 20) return null;
    
    return {
      id: bestMatch.id,
      poster: bestMatch.poster_path ? 'https://image.tmdb.org/t/p/w500' + bestMatch.poster_path : null,
      background: bestMatch.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + bestMatch.backdrop_path : null,
      description: bestMatch.overview || null,
      imdbRating: bestMatch.vote_average ? bestMatch.vote_average.toFixed(1) : null,
      year: bestMatch.release_date ? bestMatch.release_date.split('-')[0] : (bestMatch.first_air_date ? bestMatch.first_air_date.split('-')[0] : null),
    };
  } catch (e) {
    console.warn('[tmdb] Search failed for "' + title + '": ' + e.message);
    return null;
  }
}

function parseCinebudsTable(html) {
  const $ = cheerio.load(html);
  const items = [];

  // Remove unwanted elements first
  $('script, style, iframe, nav, header, footer, aside, .sidebar, .comments, .advertisement').remove();

  // Find all tables
  $('table').each((_, table) => {
    const headers = [];
    
    // Get headers from thead
    $(table).find('thead th, thead td').each((_, th) => {
      headers.push($(th).text().trim().toLowerCase());
    });
    
    // If no thead, try first row
    if (headers.length === 0) {
      $(table).find('tr').first().find('th, td').each((_, th) => {
        headers.push($(th).text().trim().toLowerCase());
      });
    }

    const titleIdx = headers.findIndex(h => 
      h.includes('movie') || h.includes('title') || h.includes('series') || 
      h.includes('show') || h.includes('film') || h.includes('name')
    );
    const platformIdx = headers.findIndex(h => 
      h.includes('platform') || h.includes('ott') || h.includes('streaming') || 
      h.includes('where') || h.includes('service') || h.includes('channel')
    );
    const dateIdx = headers.findIndex(h => 
      h.includes('date') || h.includes('release') || h.includes('premiere')
    );

    if (titleIdx === -1) return;

    $(table).find('tr').each((rowIdx, row) => {
      // Skip header row
      if (rowIdx === 0 && headers.length > 0) return;
      
      const cells = $(row).find('td');
      if (cells.length === 0) return;

      let title = titleIdx < cells.length ? $(cells[titleIdx]).text().trim() : '';
      let platform = platformIdx >= 0 && platformIdx < cells.length ? $(cells[platformIdx]).text().trim() : '';
      let releaseDate = dateIdx >= 0 && dateIdx < cells.length ? $(cells[dateIdx]).text().trim() : '';

      // Clean up title
      title = cleanTitle(title);
      if (!title || title.length < 2) return;
      
      // Skip if title looks like garbage
      if (title.length > 0 && title[0] === title[0].toLowerCase() && title.length < 10) return;
      if (/^\d+$/.test(title)) return;
      
      // Clean platform
      platform = platform.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
      if (!platform) return;
      
      // Clean release date
      releaseDate = releaseDate.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();

      items.push({ title, platform, releaseDate });
    });
  });

  return items;
}

function deduplicate(items) {
  const seen = new Map();
  const result = [];

  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) {
      const existing = result[seen.get(key)];
      if (!existing.platform.includes(item.platform)) {
        existing.platform += ', ' + item.platform;
      }
    } else {
      seen.set(key, result.length);
      result.push({ ...item });
    }
  }

  return result;
}

async function scrapePage(urlKey, type) {
  const url = URLS[urlKey];
  const langCode = LANG_CODE[urlKey];

  console.log('[scraper] Fetching: ' + url);
  const html = await fetchUrl(url);
  console.log('[scraper] Downloaded ' + html.length + ' bytes');

  const rawItems = parseCinebudsTable(html);
  console.log('[scraper] Parsed ' + rawItems.length + ' rows');

  const released = rawItems.filter(item => isAlreadyReleased(item.releaseDate));
  console.log('[scraper] Already on OTT: ' + released.length + ' items');

  const unique = deduplicate(released);
  console.log('[scraper] After dedup: ' + unique.length + ' items');

  // Sort newest first
  unique.sort((a, b) => {
    const da = parseDate(a.releaseDate);
    const db = parseDate(b.releaseDate);
    if (da && db) return db - da;
    return 0;
  });

  // Build Stremio meta objects
  const metas = [];
  
  for (let idx = 0; idx < unique.length; idx++) {
    const item = unique[idx];
    const slug = item.title.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 50);
    const id = 'cinebuds_' + slug + '_' + idx;
    
    const description = [
      item.platform ? '🎬 **Streaming on:** ' + item.platform : null,
      item.releaseDate ? '📅 **OTT Release:** ' + item.releaseDate : null,
    ].filter(Boolean).join('\n\n');
    
    metas.push({
      id,
      type,
      name: item.title,
      releaseInfo: item.releaseDate,
      description: description || 'Malayalam OTT release',
    });
  }

  // Enrich first 15 with TMDB
  if (TMDB_KEY) {
    console.log('[tmdb] Enriching first 15 items...');
    const enriched = await Promise.all(
      metas.slice(0, 15).map(meta => tmdbSearch(meta.name, type, langCode))
    );
    enriched.forEach((tmdb, i) => {
      if (!tmdb) return;
      if (tmdb.poster) metas[i].poster = tmdb.poster;
      if (tmdb.background) metas[i].background = tmdb.background;
      if (tmdb.year) metas[i].releaseInfo = tmdb.year + (metas[i].releaseInfo ? ' | ' + metas[i].releaseInfo : '');
      
      // Build better description
      let newDesc = '';
      if (tmdb.description) newDesc += tmdb.description + '\n\n';
      if (metas[i].description) newDesc += metas[i].description;
      if (tmdb.imdbRating) newDesc += '\n\n⭐ **IMDb Rating:** ' + tmdb.imdbRating + '/10';
      metas[i].description = newDesc;
    });
    console.log('[tmdb] Done');
  } else {
    console.log('[tmdb] No TMDB_API_KEY — skipping posters');
  }

  metas.forEach(m => {
    Object.keys(m).forEach(k => m[k] === undefined && delete m[k]);
  });
  
  return metas.slice(0, 30); // Limit to 30 per catalog
}

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
