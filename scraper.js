/**
 * scraper.js - Option B: IMDb lookup ONLY for recent movies (last 30 days)
 * Filters out UI garbage text properly
 * Sorted by release date (newest first)
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const URLS = {
  'mal-movie': 'https://www.91mobiles.com/entertainment/new-malayalam-movies',
  'mal-series': 'https://www.91mobiles.com/entertainment/new-malayalam-web-series',
  'tam-movie': 'https://www.91mobiles.com/entertainment/new-tamil-movies',
  'tam-series': 'https://www.91mobiles.com/entertainment/best-tamil-web-series',
};

// Keywords to FILTER OUT (garbage UI text)
const GARBAGE_KEYWORDS = [
  'latest and trending', 'movies', 'web series', 'ott this week', 'view all',
  'more', 'trending', 'popular', 'recommended', 'you may also like',
  'iohotsta', 'streaming pr', 'new malaysia', 'new tamil'
];

// Theatre keywords to filter out
const THEATRE_KEYWORDS = [
  'bookmyshow', 'theatre', 'theater', 'cinema', 'pvr', 'inox', 'cinepolis'
];

// Month mapping
const MONTHS = {
  'jan': 0, 'january': 0, 'feb': 1, 'february': 1,
  'mar': 2, 'march': 2, 'apr': 3, 'april': 3,
  'may': 4, 'jun': 5, 'june': 5, 'jul': 6, 'july': 6,
  'aug': 7, 'august': 7, 'sep': 8, 'september': 8,
  'oct': 9, 'october': 9, 'nov': 10, 'november': 10,
  'dec': 11, 'december': 11
};

// IMDb cache
const imdbCache = new Map();

// Calculate date 30 days ago
const THIRTY_DAYS_AGO = new Date();
THIRTY_DAYS_AGO.setDate(THIRTY_DAYS_AGO.getDate() - 30);

async function searchIMDb(title, type, year) {
  const cacheKey = `${title.toLowerCase()}_${year || ''}`;
  if (imdbCache.has(cacheKey)) {
    return imdbCache.get(cacheKey);
  }
  
  try {
    const searchTitle = encodeURIComponent(title.toLowerCase());
    const firstLetter = searchTitle[0];
    const imdbUrl = `https://v2.sg.media-imdb.com/suggestion/${firstLetter}/${searchTitle}.json`;
    
    const response = await fetch(imdbUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.d && data.d.length > 0) {
        let bestMatch = data.d[0];
        if (year) {
          const yearMatch = data.d.find(item => item.y && item.y.toString() === year.toString());
          if (yearMatch) bestMatch = yearMatch;
        }
        if (bestMatch && bestMatch.id) {
          let imdbId = bestMatch.id;
          if (!imdbId.startsWith('tt')) imdbId = `tt${imdbId}`;
          imdbCache.set(cacheKey, imdbId);
          console.log(`[IMDb] ✅ Found: ${title} -> ${imdbId}`);
          return imdbId;
        }
      }
    }
    imdbCache.set(cacheKey, null);
    return null;
  } catch (error) {
    return null;
  }
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  
  const str = dateStr.toString().toLowerCase().trim();
  
  if (/coming|soon|tba|announced|upcoming|expected/i.test(str)) {
    return '9999-12-31';
  }
  
  // Format: "29 May 2026"
  let match = str.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
  if (match) {
    const month = MONTHS[match[2].toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      const date = new Date(parseInt(match[3]), month, parseInt(match[1]));
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
  }
  
  return null;
}

function isTheatreOnly(platformText) {
  if (!platformText) return true;
  const lower = platformText.toLowerCase();
  const platforms = lower.split(/[,/|&+]/).map(p => p.trim());
  const allAreTheatre = platforms.every(p => 
    THEATRE_KEYWORDS.some(kw => p.includes(kw))
  );
  return allAreTheatre;
}

function isGarbageText(title) {
  if (!title) return true;
  const lower = title.toLowerCase();
  return GARBAGE_KEYWORDS.some(keyword => lower === keyword || lower.includes(keyword));
}

async function scrapePage(url, type) {
  try {
    console.log(`[scraper] Fetching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      },
      timeout: 30000
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const html = await response.text();
    
    // Extract Next.js JSON data
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    
    if (!jsonMatch) {
      console.log(`[scraper] No Next.js data found`);
      return [];
    }
    
    const jsonData = JSON.parse(jsonMatch[1]);
    
    // Find movie data recursively
    let movieData = null;
    
    function findMovieData(obj, depth = 0) {
      if (depth > 15) return null;
      if (!obj || typeof obj !== 'object') return null;
      
      if (Array.isArray(obj) && obj.length > 0) {
        const firstItem = obj[0];
        if (firstItem && typeof firstItem === 'object') {
          // Look for actual movie data (has title and not garbage)
          if ((firstItem.title || firstItem.name) && 
              !isGarbageText(firstItem.title || firstItem.name)) {
            return obj;
          }
        }
      }
      
      for (const key in obj) {
        if (key === 'props' || key === 'pageProps' || key === 'initialProps' ||
            key === 'movies' || key === 'items' || key === 'data' || key === 'contents') {
          const result = findMovieData(obj[key], depth + 1);
          if (result) return result;
        } else if (typeof obj[key] === 'object') {
          const result = findMovieData(obj[key], depth + 1);
          if (result) return result;
        }
      }
      return null;
    }
    
    movieData = findMovieData(jsonData);
    
    if (!movieData || !Array.isArray(movieData)) {
      console.log(`[scraper] Could not extract movie data`);
      return [];
    }
    
    console.log(`[scraper] Found ${movieData.length} raw items in JSON`);
    
    const items = [];
    
    for (const item of movieData) {
      // Extract title
      let title = item.title || item.name || item.heading || item.movieName || item.contentName;
      if (!title || typeof title !== 'string') continue;
      
      title = title.replace(/\s+/g, ' ').trim();
      
      // Filter out garbage titles
      if (isGarbageText(title)) continue;
      if (title.length < 2) continue;
      
      // Extract OTT platform
      let platformText = item.platform || item.ott || item.streamingOn || item.provider || '';
      if (!platformText && item.tags && Array.isArray(item.tags)) {
        const ottTag = item.tags.find(t => 
          typeof t === 'string' && 
          ['Netflix', 'Prime', 'Hotstar', 'SunNxt', 'ZEE5', 'SonyLIV', 'JioCinema', 'Aha', 'ManoramaMAX'].some(p => 
            t.toLowerCase().includes(p.toLowerCase())
          )
        );
        if (ottTag) platformText = ottTag;
      }
      
      // Filter out theatre-only
      if (isTheatreOnly(platformText)) continue;
      
      // Extract poster
      let poster = item.image || item.poster || item.thumbnail || item.img;
      if (poster && typeof poster === 'string' && !poster.startsWith('http')) {
        if (poster.startsWith('/')) {
          poster = 'https://www.91mobiles.com' + poster;
        }
      }
      
      // Extract release date
      let releaseDate = item.releaseDate || item.date || item.publishDate || '';
      if (releaseDate && typeof releaseDate === 'string') {
        releaseDate = releaseDate.replace(/\s*\([^)]*\)/, '').trim();
      }
      
      // Parse year and sort date
      let year = null;
      let sortDate = null;
      if (releaseDate) {
        const yearMatch = releaseDate.match(/\d{4}/);
        if (yearMatch) year = parseInt(yearMatch[0]);
        sortDate = parseDate(releaseDate);
      }
      
      // Extract description
      let description = item.description || item.synopsis || item.excerpt || '';
      if (description && typeof description === 'string') {
        description = description.trim();
      }
      
      // 🔍 IMDb lookup ONLY for recent movies (last 30 days)
      let imdbId = null;
      let isRecent = false;
      
      if (sortDate && sortDate !== '9999-12-31') {
        const movieDate = new Date(sortDate);
        if (!isNaN(movieDate.getTime()) && movieDate >= THIRTY_DAYS_AGO) {
          isRecent = true;
          console.log(`[IMDb] Recent movie (${sortDate}): ${title}`);
          imdbId = await searchIMDb(title, type, year);
          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      const finalId = imdbId || `tt_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      // Build description
      let fullDesc = '';
      if (platformText) fullDesc += `📺 Available on: ${platformText}\n`;
      if (releaseDate) fullDesc += `📅 Release: ${releaseDate}\n`;
      if (imdbId) fullDesc += `🎬 IMDb: https://www.imdb.com/title/${imdbId}/\n`;
      if (!imdbId && isRecent) fullDesc += `🔍 Try searching "${title}" in Stremio\n`;
      if (description && typeof description === 'string' && description.length > 10) {
        fullDesc += `\n${description.slice(0, 300)}`;
      }
      
      items.push({
        id: finalId,
        type: type,
        name: title,
        poster: poster || undefined,
        releaseInfo: releaseDate || undefined,
        description: fullDesc.trim() || undefined,
        sortDate: sortDate,
        isRecent: isRecent
      });
    }
    
    // Remove duplicates by name
    const unique = [];
    const seen = new Set();
    for (const item of items) {
      const key = item.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }
    
    // Sort by date (newest first)
    unique.sort((a, b) => {
      if (!a.sortDate && !b.sortDate) return 0;
      if (!a.sortDate) return 1;
      if (!b.sortDate) return -1;
      return b.sortDate.localeCompare(a.sortDate);
    });
    
    // Clean up and limit to 20 items per category
    const finalItems = unique.slice(0, 20);
    finalItems.forEach(item => {
      delete item.sortDate;
      delete item.isRecent;
    });
    
    const imdbCount = finalItems.filter(i => i.id.startsWith('tt') && !i.id.startsWith('tt_')).length;
    console.log(`[scraper] ✅ ${finalItems.length} items (${imdbCount} with real IMDb IDs)`);
    
    if (finalItems.length > 0) {
      console.log(`[scraper] 📅 Newest: ${finalItems[0].name} (${finalItems[0].releaseInfo || 'No date'})`);
    }
    
    return finalItems;
    
  } catch (error) {
    console.error(`[scraper] ❌ Error:`, error.message);
    return [];
  }
}

async function scrapeMalayalam(type) {
  const key = type === 'movie' ? 'mal-movie' : 'mal-series';
  return scrapePage(URLS[key], type);
}

async function scrapeTamil(type) {
  const key = type === 'movie' ? 'tam-movie' : 'tam-series';
  return scrapePage(URLS[key], type);
}

module.exports = { scrapeMalayalam, scrapeTamil };
