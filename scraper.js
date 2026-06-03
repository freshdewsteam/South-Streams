/**
 * scraper.js - UPDATED SELECTORS for current 91mobiles layout
 * Fetches Malayalam & Tamil OTT releases from 91mobiles.com/entertainment
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

// URLs to scrape
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

async function searchIMDb(title, type, year) {
  const cacheKey = `${title.toLowerCase()}_${type}_${year || ''}`;
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
  
  const str = dateStr.toLowerCase().trim();
  
  if (/coming|soon|tba|announced|upcoming|expected/i.test(str)) {
    return '9999-12-31';
  }
  
  // Format: "29 May 2026" or "29 May 2026 (OTT)"
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
  
  // Format: "May 29, 2026"
  match = str.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (match) {
    const month = MONTHS[match[1].toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      const date = new Date(parseInt(match[3]), month, parseInt(match[2]));
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
    const $ = cheerio.load(html);
    
    const items = [];
    
    // UPDATED SELECTORS for current 91mobiles layout
    // Looking at your screenshot, movies are in divs with movie/show information
    
    // Try multiple selectors to find movie cards
    let cards = [];
    
    // Selector 1: Look for article or div that contains movie details
    cards = $('article, .movie-item, .content-item, [class*="movie-card"], [class*="content-card"]').toArray();
    
    // Selector 2: Look for divs that have both title and OTT platform info
    if (cards.length < 2) {
      cards = $('div').filter((i, el) => {
        const $el = $(el);
        const hasTitle = $el.find('h1, h2, h3, [class*="title"]').length > 0;
        const hasPlatform = $el.text().match(/(Prime Video|Netflix|Hotstar|SunNxt|ZEE5|SonyLIV|JioCinema|Aha|ManoramaMAX)/i);
        return hasTitle && hasPlatform && $el.text().length > 50;
      }).toArray();
    }
    
    // Selector 3: Look for list items in the main content
    if (cards.length < 2) {
      cards = $('.main-content li, .content-wrapper li, .listing li').toArray();
    }
    
    console.log(`[scraper] Found ${cards.length} potential cards`);
    
    for (const card of cards) {
      const $card = $(card);
      
      // Extract title - look for heading elements
      let title = $card.find('h1, h2, h3, [class*="title"], [class*="name"]').first().text().trim();
      if (!title) {
        // Try getting text from a link
        title = $card.find('a[href*="/entertainment/"]').first().text().trim();
      }
      if (!title || title.length < 2) continue;
      
      // Clean title (remove extra spaces and special chars)
      title = title.replace(/\s+/g, ' ').trim();
      
      // Extract OTT platform - look for platform name or button/link
      let platformText = '';
      
      // Look for "Where To Stream" section or platform buttons
      const platformEl = $card.find('[class*="platform"], [class*="ott"], [class*="stream"], button a, .streaming-service');
      if (platformEl.length > 0) {
        platformText = platformEl.first().text().trim();
      }
      
      if (!platformText) {
        // Look for known platform names in the card text
        const cardHtml = $card.html();
        const platformMatch = cardHtml.match(/(Prime Video|Netflix|Amazon|Hotstar|Disney\+|ZEE5|SonyLIV|JioCinema|MX Player|Aha|Sun Nxt|SunNxt|ManoramaMAX|Koode)/i);
        if (platformMatch) platformText = platformMatch[0];
      }
      
      // Filter out theatre-only
      if (isTheatreOnly(platformText)) continue;
      
      // Extract poster - look for image
      let poster = $card.find('img').first().attr('data-src') || 
                   $card.find('img').first().attr('src') || 
                   $card.find('picture img').attr('src') || 
                   null;
      if (poster && !poster.startsWith('http')) {
        if (poster.startsWith('/')) {
          poster = 'https://www.91mobiles.com' + poster;
        }
      }
      
      // Extract release date - look for date pattern
      let releaseDate = '';
      const cardText = $card.text();
      const dateMatch = cardText.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
      if (dateMatch) {
        releaseDate = dateMatch[0];
      }
      
      if (!releaseDate) {
        const altDateMatch = cardText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i);
        if (altDateMatch) releaseDate = altDateMatch[0];
      }
      
      // Extract year for IMDb
      let year = null;
      if (releaseDate) {
        const yearMatch = releaseDate.match(/\d{4}/);
        if (yearMatch) year = parseInt(yearMatch[0]);
      }
      
      // Extract description/synopsis
      let description = '';
      const descEl = $card.find('[class*="desc"], [class*="synopsis"], [class*="plot"], p').first();
      if (descEl.length > 0) {
        description = descEl.text().trim();
      }
      if (!description || description.length < 10) {
        // Try getting from a longer text block
        const textBlocks = $card.find('p, div').filter((i, el) => $(el).text().length > 50).first();
        if (textBlocks.length > 0) {
          description = textBlocks.text().trim();
        }
      }
      
      // Parse sort date
      const sortDate = parseDate(releaseDate);
      
      // Search IMDb
      let imdbId = await searchIMDb(title, type, year);
      const finalId = imdbId || `tt_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      // Build description
      let fullDesc = '';
      if (platformText) fullDesc += `📺 Available on: ${platformText}\n`;
      if (releaseDate) fullDesc += `📅 Release: ${releaseDate}\n`;
      if (imdbId) fullDesc += `🎬 IMDb: https://www.imdb.com/title/${imdbId}/\n`;
      if (description && description.length > 10) fullDesc += `\n${description.slice(0, 400)}`;
      
      items.push({
        id: finalId,
        type: type,
        name: title,
        poster: poster || undefined,
        releaseInfo: releaseDate || undefined,
        description: fullDesc.trim() || undefined,
        sortDate: sortDate,
        _platform: platformText
      });
    }
    
    // Remove duplicates by title
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
    
    // Clean up
    unique.forEach(item => {
      delete item.sortDate;
      delete item._platform;
    });
    
    const withImdb = items.filter(i => i._imdbId).length;
    console.log(`[scraper] ✅ ${unique.length} unique items (${unique.slice(0, 3).map(i => i.name).join(', ')})`);
    
    return unique;
    
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
