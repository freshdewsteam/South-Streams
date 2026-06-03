/**
 * scraper.js - FIXED: Handles missing IMDb IDs and posters gracefully
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

const tmdbCache = new Map();

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
  if (/soon|tba|tbd|announced|upcoming|expected|confirm|tentative|coming soon/i.test(str)) return null;
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
  let cleaned = title.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/\s*\([^)]*\)/g, (match) => {
    if (match.match(/\d{4}/)) return match;
    return '';
  });
  cleaned = cleaned.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
  return cleaned;
}

// Try multiple search strategies for IMDb ID
async function getImdbId(title, type, langCode, year = null) {
  const cacheKey = `${title}_${type}`;
  if (tmdbCache.has(cacheKey)) {
    return tmdbCache.get(cacheKey);
  }
  
  if (!TMDB_KEY) return { imdbId: null, poster: null, backdrop: null, overview: null, rating: null };
  
  try {
    const endpoint = type === 'series' ? 'tv' : 'movie';
    const cleanTitle = title.split('(')[0].split('-')[0].split(':')[0].trim();
    const query = encodeURIComponent(cleanTitle);
    
    // Strategy 1: Search with original language filter
    let searchUrl = 'https://api.themoviedb.org/3/search/' + endpoint +
      '?api_key=' + TMDB_KEY +
      '&query=' + query +
      '&language=en-US&page=1';
    
    if (langCode) {
      searchUrl += '&with_original_language=' + langCode;
    }
    
    let searchData = await fetchJson(searchUrl);
    
    // Strategy 2: If no results, try without language filter
    if (!searchData.results || searchData.results.length === 0) {
      const fallbackUrl = 'https://api.themoviedb.org/3/search/' + endpoint +
        '?api_key=' + TMDB_KEY +
        '&query=' + query +
        '&language=en-US&page=1';
      searchData = await fetchJson(fallbackUrl);
    }
    
    if (!searchData.results || searchData.results.length === 0) {
      tmdbCache.set(cacheKey, { imdbId: null, poster: null, backdrop: null, overview: null, rating: null });
      return { imdbId: null, poster: null, backdrop: null, overview: null, rating: null };
    }
    
    // Find best match
    let bestMatch = null;
    let bestScore = 0;
    
    for (const result of searchData.results) {
      let score = 0;
      const resultTitle = (result.title || result.name || '').toLowerCase();
      const searchTitle = cleanTitle.toLowerCase();
      
      if (resultTitle === searchTitle) score += 50;
      else if (resultTitle.includes(searchTitle)) score += 30;
      else if (searchTitle.includes(resultTitle)) score += 20;
      
      if (result.original_language === langCode) score += 40;
      if (result.origin_country && result.origin_country.includes('IN')) score += 20;
      if (result.popularity) score += Math.min(result.popularity / 10, 10);
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }
    
    if (!bestMatch || bestScore < 15) {
      tmdbCache.set(cacheKey, { imdbId: null, poster: null, backdrop: null, overview: null, rating: null });
      return { imdbId: null, poster: null, backdrop: null, overview: null, rating: null };
    }
    
    // Get details for IMDb ID
    const detailsUrl = 'https://api.themoviedb.org/3/' + endpoint + '/' + bestMatch.id +
      '?api_key=' + TMDB_KEY;
    const details = await fetchJson(detailsUrl);
    
    const result = {
      imdbId: details.imdb_id || null,
      poster: details.poster_path ? 'https://image.tmdb.org/t/p/w500' + details.poster_path : null,
      backdrop: details.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + details.backdrop_path : null,
      overview: details.overview || null,
      rating: details.vote_average ? details.vote_average.toFixed(1) : null,
      releaseYear: details.release_date ? details.release_date.split('-')[0] : (details.first_air_date ? details.first_air_date.split('-')[0] : null),
    };
    
    tmdbCache.set(cacheKey, result);
    console.log(`[TMDB] ${result.imdbId ? '✅ Found: ' + result.imdbId : '❌ No IMDb ID for'} "${title}"`);
    return result;
    
  } catch (e) {
    console.warn('[TMDB] Failed for ' + title + ': ' + e.message);
    tmdbCache.set(cacheKey, { imdbId: null, poster: null, backdrop: null, overview: null, rating: null });
    return { imdbId: null, poster: null, backdrop: null, overview: null, rating: null };
  }
}

// Fallback poster from placeholder service
function getFallbackPoster(title) {
  return `https://via.placeholder.com/500x750/1a1a2e/ffffff?text=${encodeURIComponent(title)}`;
}

function parseCinebudsTable(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('script, style, iframe, nav, header, footer, aside, .sidebar, .comments, .advertisement, .widget').remove();

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
      if (rowIdx === 0 && headers.length > 0) return;
      
      const cells = $(row).find('td');
      if (cells.length === 0) return;

      let title = titleIdx < cells.length ? $(cells[titleIdx]).text().trim() : '';
      let platform = platformIdx >= 0 && platformIdx < cells.length ? $(cells[platformIdx]).text().trim() : '';
      let releaseDate = dateIdx >= 0 && dateIdx < cells.length ? $(cells[dateIdx]).text().trim() : '';

      title = cleanTitle(title);
      if (!title || title.length < 2) return;
      if (/^\d+$/.test(title)) return;
      
      platform = platform.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
      if (!platform) return;
      
      releaseDate = releaseDate.replace(/\[.*?\]/g, '').trim();

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

  unique.sort((a, b) => {
    const da = parseDate(a.releaseDate);
    const db = parseDate(b.releaseDate);
    if (da && db) return db - da;
    return 0;
  });

  // Process items
  const metas = [];
  const itemsToProcess = unique.slice(0, 25);
  
  console.log('[TMDB] Fetching data for ' + itemsToProcess.length + ' items...');
  
  for (let idx = 0; idx < itemsToProcess.length; idx++) {
    const item = itemsToProcess[idx];
    console.log(`[TMDB] ${idx + 1}/${itemsToProcess.length}: ${item.title}`);
    
    const tmdbData = await getImdbId(item.title, type, langCode);
    
    // Use IMDb ID if found, otherwise use title-based ID (Torrentio can still search by title)
    const imdbId = tmdbData?.imdbId;
    let finalId;
    
    if (imdbId) {
      finalId = imdbId;  // Real IMDb ID - best for Torrentio
    } else {
      // Fallback: Create a searchable ID with the title
      const titleSlug = item.title.toLowerCase().replace(/[^a-z0-9]/g, '_');
      finalId = `tt_search_${titleSlug}`;
      console.log(`[TMDB] ⚠️ No IMDb ID for "${item.title}", using searchable fallback`);
    }
    
    // Build description - include helpful info even without IMDb ID
    let description = '';
    if (tmdbData?.overview) {
      description += tmdbData.overview + '\n\n';
    } else {
      description += `🎬 **${item.title}**\n\n`;
    }
    
    description += `📺 **Streaming on:** ${item.platform}\n`;
    description += `📅 **OTT Release:** ${item.releaseDate}\n`;
    
    if (tmdbData?.rating) {
      description += `⭐ **TMDB Rating:** ${tmdbData.rating}/10\n`;
    }
    
    if (imdbId) {
      description += `\n🔗 **IMDb:** https://www.imdb.com/title/${imdbId}/`;
    } else {
      description += `\n🔍 **Tip:** If no streams appear, search "${item.title}" in Stremio search bar`;
    }
    
    const meta = {
      id: finalId,
      type: type,
      name: item.title,
      releaseInfo: tmdbData?.releaseYear || item.releaseDate,
      description: description,
    };
    
    // Use TMDB poster if available, otherwise fallback
    if (tmdbData?.poster) {
      meta.poster = tmdbData.poster;
    } else {
      // Try to construct a poster URL from IMDb ID or use placeholder
      if (imdbId) {
        meta.poster = `https://img.omdbapi.com/?i=${imdbId}&apikey=YOUR_OMDB_KEY`; // Optional
      } else {
        meta.poster = getFallbackPoster(item.title);
      }
    }
    
    if (tmdbData?.backdrop) meta.background = tmdbData.backdrop;
    
    metas.push(meta);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  const foundCount = metas.filter(m => m.id && m.id.startsWith('tt') && !m.id.includes('search')).length;
  console.log(`[scraper] ✅ ${metas.length} items (${foundCount} with real IMDb IDs, ${metas.length - foundCount} with searchable fallbacks)`);
  
  metas.forEach(m => {
    Object.keys(m).forEach(k => m[k] === undefined && delete m[k]);
  });
  
  return metas;
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
