/**
 * scraper.js - LIGHTWEIGHT VERSION with DATE SORTING
 * Fetches Malayalam & Tamil OTT releases from 91mobiles.com/entertainment
 * Sorts by release date (newest first, "Coming soon" at the end)
 * Filters out BookMyShow/theatre-only listings
 * Works perfectly on Render free tier
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

// Keywords that indicate theatre-only (will be filtered out)
const THEATRE_KEYWORDS = [
  'bookmyshow', 'book my show', 'theatre', 'theater', 
  'cinema', 'pvr', 'inox', 'cinepolis', 'inox'
];

// Month mapping for date parsing
const MONTHS = {
  'jan': 0, 'january': 0,
  'feb': 1, 'february': 1,
  'mar': 2, 'march': 2,
  'apr': 3, 'april': 3,
  'may': 4,
  'jun': 5, 'june': 5,
  'jul': 6, 'july': 6,
  'aug': 7, 'august': 7,
  'sep': 8, 'september': 8,
  'oct': 9, 'october': 9,
  'nov': 10, 'november': 10,
  'dec': 11, 'december': 11
};

function parseDate(dateStr) {
  if (!dateStr) return null;
  
  const str = dateStr.toLowerCase().trim();
  
  // Check for "coming soon" / "announced" / "tba"
  if (/coming|soon|tba|announced|upcoming|expected/i.test(str)) {
    return '9999-12-31'; // Push to end
  }
  
  // Try format: "Dec 15, 2024" or "December 15, 2024"
  let match = str.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (match) {
    const month = MONTHS[match[1].toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      const date = new Date(parseInt(match[3]), month, parseInt(match[2]));
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
  }
  
  // Try format: "15 Dec 2024" or "15 December 2024"
  match = str.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
  if (match) {
    const month = MONTHS[match[2].toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      const date = new Date(parseInt(match[3]), month, parseInt(match[1]));
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
  }
  
  // Try format: "2024-12-15"
  match = str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const date = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }
  
  // Try format: "15/12/2024" or "12/15/2024"
  match = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    // Try DD/MM/YYYY first (Indian format)
    let date = new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
    // Try MM/DD/YYYY
    date = new Date(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2]));
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }
  
  // If we can't parse, return null (will be sorted to end)
  return null;
}

function isTheatreOnly(platformText) {
  if (!platformText) return true;
  const lower = platformText.toLowerCase();
  const platforms = lower.split(/[,/|&+]/).map(p => p.trim());
  // If ALL platforms are theatre keywords, filter it out
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 30000
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const items = [];
    
    // Look for movie/show cards - try multiple possible selectors
    const cardSelectors = [
      '.movie-card',
      '.content-card',
      'article',
      '[class*="movie"]',
      '[class*="card"]',
      'li'
    ];
    
    let cards = [];
    for (const selector of cardSelectors) {
      cards = $(selector).toArray();
      if (cards.length > 2) break;
    }
    
    console.log(`[scraper] Found ${cards.length} potential cards on ${url}`);
    
    for (const card of cards) {
      const $card = $(card);
      
      // Skip if too small (probably not a movie card)
      if ($card.text().length < 20) continue;
      
      // Extract title
      let title = $card.find('h2, h3, h4, [class*="title"], [class*="name"]').first().text().trim();
      if (!title) {
        // Try getting from any heading
        title = $card.find('h1,h2,h3,h4,h5,h6').first().text().trim();
      }
      if (!title || title.length < 2) continue;
      
      // Extract OTT platform text
      let platformText = $card.find('[class*="platform"], [class*="ott"], [class*="streaming"], [class*="provider"]').first().text().trim();
      if (!platformText) {
        // Look for any text containing OTT platform names
        const cardText = $card.text();
        const ottMatches = cardText.match(/(Netflix|Amazon|Prime|Hotstar|Disney|ZEE5|SonyLIV|JioCinema|MX Player|Aha|Sun NXT|ManoramaMAX|Koode|SimplySouth)/i);
        if (ottMatches) platformText = ottMatches[0];
      }
      
      // Filter out theatre-only
      if (isTheatreOnly(platformText)) continue;
      
      // Extract poster image
      let poster = $card.find('img').first().attr('data-src') || 
                   $card.find('img').first().attr('src') || 
                   null;
      if (poster && !poster.startsWith('http')) {
        poster = 'https://www.91mobiles.com' + poster;
      }
      
      // Extract release date
      let releaseDate = $card.find('[class*="date"], [class*="release"], time').first().text().trim();
      if (!releaseDate) {
        const dateMatch = $card.text().match(/(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i);
        if (dateMatch) releaseDate = dateMatch[0];
      }
      
      // Parse date for sorting
      let sortDate = parseDate(releaseDate);
      
      // Extract description/genre
      let description = $card.find('[class*="desc"], [class*="synopsis"], p').first().text().trim();
      if (!description || description.length < 10) {
        description = $card.text().slice(0, 200).replace(/\s+/g, ' ').trim();
      }
      
      // Build unique ID
      const slug = title.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const id = `91mob_${slug}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      
      // Build description with OTT info
      let fullDesc = '';
      if (platformText) fullDesc += `📺 Available on: ${platformText}\n`;
      if (releaseDate) fullDesc += `📅 Release: ${releaseDate}\n`;
      if (description && !description.includes(platformText)) fullDesc += `\n${description.slice(0, 300)}`;
      
      items.push({
        id,
        type,
        name: title,
        poster: poster || undefined,
        releaseInfo: releaseDate || undefined,
        description: fullDesc.trim() || undefined,
        sortDate: sortDate // Hidden field for sorting
      });
    }
    
    // Remove duplicates (by name)
    const unique = [];
    const seen = new Set();
    for (const item of items) {
      if (!seen.has(item.name.toLowerCase())) {
        seen.add(item.name.toLowerCase());
        unique.push(item);
      }
    }
    
    // ⭐ SORT BY DATE (newest first, coming soon last) ⭐
    unique.sort((a, b) => {
      // Both have no date → keep original order
      if (!a.sortDate && !b.sortDate) return 0;
      // a has no date → put after b
      if (!a.sortDate) return 1;
      // b has no date → put after a
      if (!b.sortDate) return -1;
      // Both have dates → newest first (descending)
      return b.sortDate.localeCompare(a.sortDate);
    });
    
    // Remove sortDate from final output (Stremio doesn't need it)
    unique.forEach(item => delete item.sortDate);
    
    console.log(`[scraper] ✅ Found ${unique.length} OTT items (sorted by date) on ${url}`);
    
    // Log first 3 release dates for debugging
    if (unique.length > 0) {
      console.log(`[scraper] 📅 First 3 releases: ${unique.slice(0, 3).map(i => `${i.name} (${i.releaseInfo || 'No date'})`).join(', ')}`);
    }
    
    return unique;
    
  } catch (error) {
    console.error(`[scraper] ❌ Error scraping ${url}:`, error.message);
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
