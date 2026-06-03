/**
 * scraper.js - Uses OMDb API for IMDb IDs (100% reliable)
 * Get free API key: https://www.omdbapi.com/apikey.aspx
 */

const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const OMDB_KEY = process.env.OMDB_API_KEY || '';  // ← YOU NEED THIS

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

// Get IMDb ID from OMDb API (free, reliable)
async function getImdbFromOMDb(title, year = null) {
  if (!OMDB_KEY) return null;
  
  try {
    const searchTitle = encodeURIComponent(title);
    let url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${searchTitle}&type=movie`;
    if (year) url += `&y=${year}`;
    
    const data = await fetchJson(url);
    
    if (data && data.Response === 'True' && data.imdbID) {
      console.log(`[OMDb] Found: ${title} -> ${data.imdbID}`);
      return {
        imdbId: data.imdbID,
        poster: data.Poster !== 'N/A' ? data.Poster : null,
        backdrop: null,
        overview: data.Plot !== 'N/A' ? data.Plot : null,
        rating: data.imdbRating !== 'N/A' ? data.imdbRating : null,
        releaseYear: data.Year,
      };
    }
    return null;
  } catch (e) {
    console.warn('[OMDb] Error: ' + e.message);
    return null;
  }
}

// Try TMDB first, then OMDb
async function getImdbId(title, type, langCode, year = null) {
  const cacheKey = `${title}_${type}_${year || ''}`;
  if (tmdbCache.has(cacheKey)) {
    return tmdbCache.get(cacheKey);
  }
  
  let result = { imdbId: null, poster: null, backdrop: null, overview: null, rating: null, releaseYear: null };
  
  // Try TMDB first (gets better posters)
  if (TMDB_KEY) {
    try {
      const endpoint = type === 'series' ? 'tv' : 'movie';
      const cleanTitle = title.split('(')[0].split('-')[0].split(':')[0].trim();
      const query = encodeURIComponent(cleanTitle);
      
      let searchUrl = 'https://api.themoviedb.org/3/search/' + endpoint +
        '?api_key=' + TMDB_KEY +
        '&query=' + query +
        '&language=en-US&page=1';
      
      if (langCode) {
        searchUrl += '&with_original_language=' + langCode;
      }
      
      let searchData = await fetchJson(searchUrl);
      
      if (!searchData.results || searchData.results.length === 0) {
        const fallbackUrl = 'https://api.themoviedb.org/3/search/' + endpoint +
          '?api_key=' + TMDB_KEY +
          '&query=' + query +
          '&language=en-US&page=1';
        searchData = await fetchJson(fallbackUrl);
      }
      
      if (searchData.results && searchData.results.length > 0) {
        let bestMatch = null;
        let bestScore = 0;
        
        for (const res of searchData.results) {
          let score = 0;
          const resultTitle = (res.title || res.name || '').toLowerCase();
          const searchTitle = cleanTitle.toLowerCase();
          
          if (resultTitle === searchTitle) score += 50;
          else if (resultTitle.includes(searchTitle)) score += 30;
          else if (searchTitle.includes(resultTitle)) score += 20;
          
          if (res.original_language === langCode) score += 40;
          if (res.origin_country && res.origin_country.includes('IN')) score += 20;
          if (res.popularity) score += Math.min(res.popularity / 10, 10);
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = res;
          }
        }
        
        if (bestMatch && bestScore >= 15) {
          const detailsUrl = 'https://api.themoviedb.org/3/' + endpoint + '/' + bestMatch.id +
            '?api_key=' + TMDB_KEY;
          const details = await fetchJson(detailsUrl);
          
          if (details.imdb_id) {
            result = {
              imdbId: details.imdb_id,
              poster: details.poster_path ? 'https://image.tmdb.org/t/p/w500' + details.poster_path : null,
              backdrop: details.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + details.backdrop_path : null,
              overview: details.overview || null,
              rating: details.vote_average ? details.vote_average.toFixed(1) : null,
              releaseYear: details.release_date ? details.release_date.split('-')[0] : (details.first_air_date ? details.first_air_date.split('-')[0] : null),
            };
            console.log(`[TMDB] Found: ${result.imdbId} for "${title}"`);
          }
        }
      }
    } catch (e) {
      console.warn('[TMDB] Error: ' + e.message);
    }
  }
  
  // If TMDB didn't find IMDb ID, try OMDb
  if (!result.imdbId && OMDB_KEY) {
    console.log(`[OMDb] Trying fallback for "${title}"...`);
    const omdbResult = await getImdbFromOMDb(title, year);
    if (omdbResult && omdbResult.imdbId) {
      result = omdbResult;
      console.log(`[OMDb] Found: ${result.imdbId} for "${title}"`);
    }
  }
  
  tmdbCache.set(cacheKey, result);
  return result;
}

function getFallbackPoster(title) {
  return `https://via.placeholder.com/500x750/1a1a2e/ffffff?text=${encodeURIComponent(title.substring(0, 30))}`;
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

  const metas = [];
  const itemsToProcess = unique.slice(0, 30);
  
  console.log('[API] Fetching IMDb IDs...');
  
  for (let idx = 0; idx < itemsToProcess.length; idx++) {
    const item = itemsToProcess[idx];
    console.log(`[${idx + 1}/${itemsToProcess.length}] ${item.title}`);
    
    const yearMatch = item.releaseDate?.match(/\d{4}/);
    const year = yearMatch ? yearMatch[0] : null;
    
    const imdbData = await getImdbId(item.title, type, langCode, year);
    
    let description = '';
    if (imdbData?.overview) {
      description += imdbData.overview + '\n\n';
    }
    
    description += `📺 **Streaming on:** ${item.platform}\n`;
    description += `📅 **OTT Release:** ${item.releaseDate}`;
    
    if (imdbData?.rating && imdbData.rating !== 'N/A') {
      description += `\n⭐ **Rating:** ${imdbData.rating}/10`;
    }
    
    // Use IMDb ID if found
    let finalId;
    if (imdbData?.imdbId) {
      finalId = imdbData.imdbId;
      console.log(`✅ IMDb ID: ${finalId}`);
    } else {
      const titleSlug = item.title.toLowerCase().replace(/[^a-z0-9]/g, '_');
      finalId = `search_${titleSlug}`;
      console.log(`⚠️ No IMDb ID for: ${item.title}`);
    }
    
    const meta = {
      id: finalId,
      type: type,
      name: item.title,
      releaseInfo: imdbData?.releaseYear || item.releaseDate,
      description: description,
    };
    
    if (imdbData?.poster && imdbData.poster !== 'N/A') {
      meta.poster = imdbData.poster;
    } else {
      meta.poster = getFallbackPoster(item.title);
    }
    
    if (imdbData?.backdrop) meta.background = imdbData.backdrop;
    
    metas.push(meta);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  const foundCount = metas.filter(m => m.id && m.id.startsWith('tt') && m.id.length === 9).length;
  console.log(`[scraper] ✅ ${metas.length} items (${foundCount} with IMDb IDs)`);
  
  metas.forEach(m => {
    Object.keys(m).forEach(k => m[k] === undefined && delete m[k]);
  });
  
  return metas;
}

async function scrapeMalayalam(type) {
  const key = type === 'movie' ? 'mal-movie' : 'mal-series';
  try { return await scrapePage(key, type); }
  catch (e) { console.warn('[scraper] Malayalam failed: ' + e.message); return []; }
}

async function scrapeTamil(type) {
  const key = type === 'movie' ? 'tam-movie' : 'tam-series';
  try { return await scrapePage(key, type); }
  catch (e) { console.warn('[scraper] Tamil failed: ' + e.message); return []; }
}

module.exports = { scrapeMalayalam, scrapeTamil };
