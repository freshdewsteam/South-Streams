/**
 * scraper.js - DEBUG VERSION
 * Logs every step so we can see why no data is showing
 */

const fetch = require('node-fetch');

const URLS = {
  'mal-movie': 'https://www.91mobiles.com/entertainment/new-malayalam-movies',
  'mal-series': 'https://www.91mobiles.com/entertainment/new-malayalam-web-series',
  'tam-movie': 'https://www.91mobiles.com/entertainment/new-tamil-movies',
  'tam-series': 'https://www.91mobiles.com/entertainment/best-tamil-web-series',
};

// Minimum viable scraper - just get ANY data
async function scrapePage(url, type) {
  console.log(`[DEBUG] Starting scrape for: ${url}`);
  
  try {
    // Step 1: Fetch the page
    console.log(`[DEBUG] Fetching page...`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 30000
    });
    
    console.log(`[DEBUG] Response status: ${response.status}`);
    
    if (!response.ok) {
      console.log(`[DEBUG] HTTP error: ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    console.log(`[DEBUG] HTML length: ${html.length} characters`);
    
    // Step 2: Look for Next.js data
    console.log(`[DEBUG] Looking for __NEXT_DATA__ script tag...`);
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    
    if (!jsonMatch) {
      console.log(`[DEBUG] ❌ No __NEXT_DATA__ found!`);
      console.log(`[DEBUG] First 500 chars of HTML: ${html.substring(0, 500)}`);
      return [];
    }
    
    console.log(`[DEBUG] ✅ Found __NEXT_DATA__ (${jsonMatch[1].length} chars)`);
    
    // Step 3: Parse JSON
    console.log(`[DEBUG] Parsing JSON...`);
    let jsonData;
    try {
      jsonData = JSON.parse(jsonMatch[1]);
      console.log(`[DEBUG] JSON parsed successfully`);
    } catch (e) {
      console.log(`[DEBUG] JSON parse error: ${e.message}`);
      return [];
    }
    
    // Step 4: Find ANY array that might contain movies
    console.log(`[DEBUG] Searching for movie data in JSON...`);
    
    let allArrays = [];
    
    function findArrays(obj, path = 'root') {
      if (!obj || typeof obj !== 'object') return;
      
      if (Array.isArray(obj)) {
        console.log(`[DEBUG] Found array at ${path} with ${obj.length} items`);
        if (obj.length > 0) {
          allArrays.push({ path, array: obj, length: obj.length });
        }
      }
      
      for (const key in obj) {
        if (typeof obj[key] === 'object') {
          findArrays(obj[key], `${path}.${key}`);
        }
      }
    }
    
    findArrays(jsonData);
    
    if (allArrays.length === 0) {
      console.log(`[DEBUG] ❌ No arrays found in JSON!`);
      return [];
    }
    
    console.log(`[DEBUG] Found ${allArrays.length} total arrays`);
    
    // Step 5: Try each array to find movie titles
    let allTitles = [];
    
    for (const { path, array } of allArrays) {
      for (const item of array) {
        if (item && typeof item === 'object') {
          // Look for title fields
          let title = item.title || item.name || item.heading || item.movieName;
          if (title && typeof title === 'string' && title.length > 2 && title.length < 100) {
            // Skip obvious garbage
            const garbageWords = ['latest', 'trending', 'view all', 'more', 'movies', 'series', 'ott'];
            const isGarbage = garbageWords.some(word => title.toLowerCase() === word || title.toLowerCase().includes(word));
            
            if (!isGarbage) {
              allTitles.push({
                title: title,
                platform: item.platform || item.ott || '',
                date: item.releaseDate || item.date || '',
                path: path
              });
            }
          }
        }
      }
    }
    
    console.log(`[DEBUG] Found ${allTitles.length} potential movie titles`);
    
    if (allTitles.length > 0) {
      console.log(`[DEBUG] Sample titles: ${allTitles.slice(0, 5).map(t => t.title).join(', ')}`);
    }
    
    // Step 6: Convert to Stremio format
    const items = allTitles.slice(0, 20).map((item, idx) => {
      const id = `tt_${item.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      let description = '';
      if (item.platform) description += `📺 ${item.platform}\n`;
      if (item.date) description += `📅 ${item.date}`;
      
      return {
        id: id,
        type: type,
        name: item.title,
        releaseInfo: item.date || undefined,
        description: description || undefined,
      };
    });
    
    console.log(`[DEBUG] ✅ Returning ${items.length} items`);
    return items;
    
  } catch (error) {
    console.error(`[DEBUG] ❌ Error:`, error.message);
    console.error(`[DEBUG] Stack:`, error.stack);
    return [];
  }
}

async function scrapeMalayalam(type) {
  const key = type === 'movie' ? 'mal-movie' : 'mal-series';
  const result = await scrapePage(URLS[key], type);
  console.log(`[DEBUG] scrapeMalayalam(${type}) returning ${result.length} items`);
  return result;
}

async function scrapeTamil(type) {
  const key = type === 'movie' ? 'tam-movie' : 'tam-series';
  const result = await scrapePage(URLS[key], type);
  console.log(`[DEBUG] scrapeTamil(${type}) returning ${result.length} items`);
  return result;
}

module.exports = { scrapeMalayalam, scrapeTamil };
