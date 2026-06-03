/**
 * scraper.js - HTML PARSER VERSION
 * Extracts movie data directly from HTML structure
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const URLS = {
  'mal-movie': 'https://www.91mobiles.com/entertainment/new-malayalam-movies',
  'mal-series': 'https://www.91mobiles.com/entertainment/new-malayalam-web-series',
  'tam-movie': 'https://www.91mobiles.com/entertainment/new-tamil-movies',
  'tam-series': 'https://www.91mobiles.com/entertainment/best-tamil-web-series',
};

// Keywords to filter out (garbage UI text)
const GARBAGE_TITLES = [
  'latest and trending', 'view all', 'more', 'movies', 'web series', 
  'ott this week', 'trending', 'popular', 'recommended', 'iohotsta',
  'streaming pr', 'new malaysia', 'new tamil', 'kerala', 'malayalam'
];

async function scrapePage(url, type) {
  console.log(`[scraper] Fetching: ${url}`);
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      },
      timeout: 20000
    });
    
    if (!response.ok) {
      console.log(`[scraper] HTTP error: ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const items = [];
    
    // Look for movie cards - based on your screenshot structure
    // They appear to be in divs with certain classes
    
    // Method 1: Look for links that go to movie pages
    $('a[href*="/entertainment/"]').each((i, el) => {
      const $el = $(el);
      let title = $el.text().trim();
      const href = $el.attr('href');
      
      // Skip if no title or too short
      if (!title || title.length < 2) return;
      if (title.length > 100) return;
      
      // Skip if href is for category pages
      if (href && (href.includes('/new-') || href.includes('/best-') || href === '/entertainment')) {
        return;
      }
      
      // Skip garbage titles
      const lowerTitle = title.toLowerCase();
      if (GARBAGE_TITLES.some(garbage => lowerTitle === garbage || lowerTitle.includes(garbage))) {
        return;
      }
      
      // Skip if title is just a number or single character
      if (/^\d+$/.test(title)) return;
      if (title.length < 3) return;
      
      // Try to find parent container for additional info
      const $parent = $el.closest('div');
      
      // Look for date
      let releaseDate = '';
      const dateText = $parent.find('[class*="date"], [class*="release"], time').first().text().trim();
      if (dateText) {
        const dateMatch = dateText.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i);
        if (dateMatch) releaseDate = dateMatch[0];
      }
      
      // Look for platform
      let platform = '';
      const platformText = $parent.text().match(/(Netflix|Prime Video|Amazon|Hotstar|Disney|ZEE5|SonyLIV|JioCinema|Aha|SunNxt|ManoramaMAX)/i);
      if (platformText) platform = platformText[0];
      
      // Create ID
      const id = `tt_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      items.push({
        id: id,
        type: type,
        name: title,
        releaseInfo: releaseDate || undefined,
        description: platform ? `📺 Available on: ${platform}` : undefined,
      });
    });
    
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
    
    // Limit to 20 items
    const finalItems = unique.slice(0, 20);
    
    console.log(`[scraper] Found ${finalItems.length} movies (from ${items.length} raw links)`);
    
    if (finalItems.length > 0) {
      console.log(`[scraper] Sample: ${finalItems.slice(0, 3).map(i => i.name).join(', ')}`);
    }
    
    return finalItems;
    
  } catch (error) {
    console.error(`[scraper] Error:`, error.message);
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
