/**
 * scraper.js - Uses Next.js JSON API directly
 * No HTML parsing needed - gets clean data from 91mobiles' internal API
 */

const fetch = require('node-fetch');

// URLs to scrape (the actual page URLs)
const URLS = {
  'mal-movie': 'https://www.91mobiles.com/entertainment/new-malayalam-movies',
  'mal-series': 'https://www.91mobiles.com/entertainment/new-malayalam-web-series',
  'tam-movie': 'https://www.91mobiles.com/entertainment/new-tamil-movies',
  'tam-series': 'https://www.91mobiles.com/entertainment/best-tamil-web-series',
};

// Theatre keywords to filter out
const THEATRE_KEYWORDS = [
  'bookmyshow', 'book my show', 'theatre', 'theater', 
  'cinema', 'pvr', 'inox', 'cinepolis'
];

// Month mapping for date parsing
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
          console.log(`[IMDb] Found: ${title} -> ${imdbId}`);
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

/**
 * Extract the Next.js JSON data from the page HTML
 * Next.js embeds data in a script tag with id="__NEXT_DATA__"
 */
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
    
    // Extract Next.js JSON data from script tag
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    
    if (!jsonMatch) {
      console.log(`[scraper] No Next.js data found, trying fallback method...`);
      return await scrapePageFallback(html, url, type);
    }
    
    const jsonData = JSON.parse(jsonMatch[1]);
    
    // Navigate through Next.js props to find movie data
    // The structure varies, so we need to search recursively
    let movieData = null;
    
    function findMovieData(obj, depth = 0) {
      if (depth > 10) return null;
      if (!obj || typeof obj !== 'object') return null;
      
      // Look for arrays that contain movie-like objects
      if (Array.isArray(obj) && obj.length > 0) {
        // Check if this array has movie items
        const firstItem = obj[0];
        if (firstItem && typeof firstItem === 'object') {
          if (firstItem.title || firstItem.name || firstItem.heading || 
              (firstItem.url && firstItem.url.includes('/entertainment/'))) {
            return obj;
          }
        }
      }
      
      // Search recursively
      for (const key in obj) {
        if (key === 'props' || key === 'pageProps' || key === 'initialState' || 
            key === 'movies' || key === 'contents' || key === 'items' || key === 'data') {
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
      console.log(`[scraper] Could not extract movie data from JSON`);
      return [];
    }
    
    console.log(`[scraper] Found ${movieData.length} items in JSON data`);
    
    const items = [];
    
    for (const item of movieData) {
      // Extract title - try different possible field names
      let title = item.title || item.name || item.heading || item.movieName || item.contentName;
      if (!title && item.url) {
        // Extract from URL slug
        const urlMatch = item.url.match(/\/entertainment\/([^\/?#]+)/);
        if (urlMatch) {
          title = urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        }
      }
      if (!title) continue;
      
      title = title.replace(/\s+/g, ' ').trim();
      if (title.length < 2) continue;
      
      // Extract OTT platform
      let platformText = item.platform || item.ott || item.streamingOn || item.provider;
      if (!platformText && item.tags && Array.isArray(item.tags)) {
        const ottTag = item.tags.find(t => 
          ['Netflix', 'Prime', 'Hotstar', 'SunNxt', 'ZEE5', 'SonyLIV', 'JioCinema', 'Aha', 'ManoramaMAX'].some(p => 
            typeof t === 'string' && t.includes(p)
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
      let releaseDate = item.releaseDate || item.date || item.publishDate;
      if (releaseDate && typeof releaseDate === 'string') {
        // Clean up date string
        releaseDate = releaseDate.replace(/\s*\([^)]*\)/, '').trim();
      }
      
      // Parse year
      let year = null;
      if (releaseDate) {
        const yearMatch = releaseDate.match(/\d{4}/);
        if (yearMatch) year = parseInt(yearMatch[0]);
      }
      
      // Extract description
      let description = item.description || item.synopsis || item.excerpt || item.summary;
      if (description && typeof description === 'string') {
        description = description.trim();
      }
      
      // Parse sort date
      const sortDate = parseDate(releaseDate);
      
      // Search for IMDb ID
      let imdbId = await searchIMDb(title, type, year);
      const finalId = imdbId || `tt_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      // Build description
      let fullDesc = '';
      if (platformText) fullDesc += `📺 Available on: ${platformText}\n`;
      if (releaseDate) fullDesc += `📅 Release: ${releaseDate}\n`;
      if (imdbId) fullDesc += `🎬 IMDb: https://www.imdb.com/title/${imdbId}/\n`;
      if (description && typeof description === 'string' && description.length > 10) {
        fullDesc += `\n${description.slice(0, 400)}`;
      }
      
      items.push({
        id: finalId,
        type: type,
        name: title,
        poster: poster || undefined,
        releaseInfo: releaseDate || undefined,
        description: fullDesc.trim() || undefined,
        sortDate: sortDate
      });
    }
    
    // Remove duplicates
    const unique = [];
    const seen = new Set();
    for (const item of items) {
      const key = item.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }
    
    // Sort by date
    unique.sort((a, b) => {
      if (!a.sortDate && !b.sortDate) return 0;
      if (!a.sortDate) return 1;
      if (!b.sortDate) return -1;
      return b.sortDate.localeCompare(a.sortDate);
    });
    
    // Clean up
    unique.forEach(item => delete item.sortDate);
    
    console.log(`[scraper] ✅ ${unique.length} unique items found`);
    if (unique.length > 0) {
      console.log(`[scraper] 📅 First 3: ${unique.slice(0, 3).map(i => `${i.name} (${i.releaseInfo || 'No date'})`).join(', ')}`);
    }
    
    return unique;
    
  } catch (error) {
    console.error(`[scraper] ❌ Error:`, error.message);
    return [];
  }
}

/**
 * Fallback scraper that tries to extract data from HTML structure
 */
async function scrapePageFallback(html, url, type) {
  console.log(`[scraper] Using fallback HTML parsing for ${url}`);
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  
  const items = [];
  
  // Look for any links to entertainment content
  $('a[href*="/entertainment/"]').each((i, el) => {
    const $el = $(el);
    let title = $el.text().trim();
    const href = $el.attr('href');
    
    if (!title || title.length < 2) {
      // Try to get title from parent
      title = $el.parent().find('h1, h2, h3, h4').first().text().trim();
    }
    
    if (title && title.length > 2 && title.length < 100) {
      // Avoid duplicate entries
      const existing = items.find(i => i.name === title);
      if (!existing) {
        items.push({
          id: `tt_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          type: type,
          name: title,
          description: `Found on 91mobiles\nURL: ${href || url}`,
        });
      }
    }
  });
  
  console.log(`[scraper] Fallback found ${items.length} items`);
  return items;
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
