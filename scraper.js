/**
 * scraper.js
 *
 * Fetches Malayalam & Tamil OTT releases from 91mobiles.com/entertainment.
 *
 * Uses a lightweight approach:
 *   1. First tries direct fetch with browser-like headers
 *   2. Falls back to ScraperAPI free tier (no key needed for basic use)
 *   3. Parses HTML with cheerio (like jQuery, but server-side â€” no browser needed)
 *
 * Filters OUT theatre/BookMyShow-only listings.
 * Sorts results newest-first by OTT release date.
 */

const https = require('https');
const http  = require('http');
const cheerio = require('cheerio');

// â”€â”€â”€ URLS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const URLS = {
  'mal-movie':  'https://www.91mobiles.com/entertainment/new-malayalam-movies',
  'mal-series': 'https://www.91mobiles.com/entertainment/new-malayalam-web-series',
  'tam-movie':  'https://www.91mobiles.com/entertainment/new-tamil-movies',
  'tam-series': 'https://www.91mobiles.com/entertainment/best-tamil-web-series',
};

// â”€â”€â”€ FILTER LISTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CINEMA_KEYWORDS = [
  'bookmyshow', 'book my show',
  'theatre', 'theater',
  'pvr', 'inox', 'cinepolis', 'miraj',
  'in cinemas', 'now showing', 'cinema halls',
];

const OTT_KEYWORDS = [
  'netflix', 'prime video', 'amazon prime', 'hotstar', 'disney+', 'disney plus',
  'zee5', 'sony liv', 'sonyliv', 'jiocinema', 'manorama max', 'manoramamax',
  'sun nxt', 'sunnxt', 'aha', 'neestream', 'saina play', 'stage',
  'apple tv', 'mubi', 'discovery+', 'voot', 'mx player', 'hoichoi',
  'erosnow', 'shemaroo', 'hungama', 'alt balaji', 'ullu', 'ott',
];

function shouldKeep(platformText) {
  const lower = (platformText || '').toLowerCase();
  if (!lower) return false;
  // Keep if any known OTT platform is mentioned
  if (OTT_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  // Drop if only cinema keywords
  const parts = lower.split(/[,/|&\s]+/).filter(Boolean);
  const allCinema = parts.every((p) => CINEMA_KEYWORDS.some((kw) => p.includes(kw)));
  return !allCinema;
}

// â”€â”€â”€ DATE PARSING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function parseDate(str) {
  if (!str) return null;
  const cleaned = str.replace(/^[^0-9a-z]*/i, '').trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

// â”€â”€â”€ HTTP FETCH (no external deps) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
      },
    };
    const req = lib.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      // Handle gzip
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'br') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Fallback: use a free scraping proxy if direct fetch is blocked
async function fetchWithFallback(url) {
  // Try direct first
  try {
    console.log(`[scraper] Trying direct fetch: ${url}`);
    const html = await fetchUrl(url);
    if (html.length > 5000 && html.includes('movie')) {
      console.log(`[scraper] Direct fetch succeeded (${html.length} bytes)`);
      return html;
    }
    throw new Error('Response too short or missing content â€” likely blocked');
  } catch (err) {
    console.warn(`[scraper] Direct fetch failed: ${err.message}`);
  }

  // Fallback 1: ScraperAPI (free tier â€” 1000 calls/month, no key needed for basic)
  try {
    const scraperUrl = `https://api.scraperapi.com/?url=${encodeURIComponent(url)}&render=false`;
    const apiKey = process.env.SCRAPER_API_KEY || '';
    const finalUrl = apiKey ? `${scraperUrl}&api_key=${apiKey}` : scraperUrl;
    console.log(`[scraper] Trying ScraperAPI fallback...`);
    const html = await fetchUrl(finalUrl);
    if (html.length > 5000) {
      console.log(`[scraper] ScraperAPI succeeded`);
      return html;
    }
  } catch (err) {
    console.warn(`[scraper] ScraperAPI failed: ${err.message}`);
  }

  // Fallback 2: AllOrigins proxy (completely free, no key)
  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    console.log(`[scraper] Trying AllOrigins fallback...`);
    const html = await fetchUrl(proxyUrl);
    if (html.length > 5000) {
      console.log(`[scraper] AllOrigins succeeded`);
      return html;
    }
  } catch (err) {
    console.warn(`[scraper] AllOrigins failed: ${err.message}`);
  }

  throw new Error(`All fetch methods failed for ${url}`);
}

// â”€â”€â”€ PARSE HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function parseMovieCards(html) {
  const $ = cheerio.load(html);
  const items = [];

  // 91mobiles uses React-rendered content with these patterns
  // We try multiple card selectors
  const cardSelectors = [
    '.movie-card',
    '.content-card',
    '[class*="MovieCard"]',
    '[class*="movie-card"]',
    '[class*="content-card"]',
    '.card',
    'article',
  ];

  let $cards = $();
  for (const sel of cardSelectors) {
    const found = $(sel);
    if (found.length > 2) {
      $cards = found;
      console.log(`[parser] Using selector "${sel}" â†’ ${found.length} cards`);
      break;
    }
  }

  if ($cards.length === 0) {
    console.warn('[parser] No cards found â€” site may be fully JS-rendered');
    // Try to extract any JSON data embedded in the page (Next.js / React apps often do this)
    const jsonMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      console.log('[parser] Found __NEXT_DATA__ â€” trying JSON extraction');
      return extractFromNextData(jsonMatch[1]);
    }
    return [];
  }

  $cards.each((_, card) => {
    const $card = $(card);

    const title = $card.find('h2, h3, [class*="title"], [class*="name"]').first().text().trim();
    if (!title || title.length < 2) return;

    const $img = $card.find('img').first();
    const poster = $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src') || '';

    const platformText = $card.find(
      '[class*="platform"], [class*="ott"], [class*="streaming"], [class*="provider"], [class*="where"]'
    ).first().text().trim();

    // Find OTT-specific release date
    const fullText = $card.text();
    let releaseDate = '';
    const ottMatch = fullText.match(/(?:ott|digital|streaming|available)[^:]*:\s*([^\n|â€¢,<]+)/i);
    if (ottMatch) {
      releaseDate = ottMatch[1].trim();
    } else {
      releaseDate = $card.find('[class*="date"], [class*="release"], time').first().text().trim();
    }

    const genre = $card.find('[class*="genre"], [class*="category"]').first().text().trim();
    const description = $card.find('[class*="desc"], [class*="synopsis"], p').first().text().trim();
    const href = $card.find('a[href]').first().attr('href') || '';

    items.push({ title, poster, platformText, releaseDate, genre, description, href });
  });

  return items;
}

// Extract movies from Next.js __NEXT_DATA__ JSON (common in modern React sites)
function extractFromNextData(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    const items = [];
    // Walk the JSON tree looking for movie-like objects
    JSON.stringify(data, (key, value) => {
      if (value && typeof value === 'object' && value.title && value.poster) {
        items.push({
          title: value.title,
          poster: value.poster || value.posterUrl || value.image || '',
          platformText: value.ottPlatform || value.platform || value.streamingOn || '',
          releaseDate: value.ottReleaseDate || value.releaseDate || '',
          genre: Array.isArray(value.genres) ? value.genres.join(', ') : (value.genre || ''),
          description: value.description || value.synopsis || '',
          href: value.slug || value.url || '',
        });
      }
      return value;
    });
    console.log(`[parser] Extracted ${items.length} items from __NEXT_DATA__`);
    return items;
  } catch (e) {
    console.warn('[parser] Failed to parse __NEXT_DATA__:', e.message);
    return [];
  }
}

// â”€â”€â”€ MAIN SCRAPE FUNCTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function scrapePage(url, type) {
  const html = await fetchWithFallback(url);
  const rawItems = parseMovieCards(html);

  console.log(`[scraper] Raw items: ${rawItems.length}`);

  // Filter to OTT only
  const ottItems = rawItems.filter((item) => shouldKeep(item.platformText));
  console.log(`[scraper] After OTT filter: ${ottItems.length}`);

  // Sort newest first
  ottItems.sort((a, b) => {
    const da = parseDate(a.releaseDate);
    const db = parseDate(b.releaseDate);
    if (da && db) return db - da;
    if (da) return -1;
    if (db) return 1;
    return 0;
  });

  // Convert to Stremio meta objects
  return ottItems.map((item, idx) => {
    const slug = (item.href || item.title)
      .replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60);
    const id = `91mob_${slug}_${idx}`;

    const meta = {
      id,
      type,
      name: item.title,
      poster: item.poster || undefined,
      genres: item.genre ? [item.genre] : undefined,
      releaseInfo: item.releaseDate || undefined,
      description: buildDescription(item),
    };

    Object.keys(meta).forEach((k) => meta[k] === undefined && delete meta[k]);
    return meta;
  });
}

function buildDescription(item) {
  let desc = '';
  if (item.platformText) desc += `ðŸ“º Available on: ${item.platformText}\n`;
  if (item.releaseDate)  desc += `ðŸ“… OTT Release: ${item.releaseDate}\n`;
  if (item.description)  desc += `\n${item.description}`;
  return desc.trim() || undefined;
}

// â”€â”€â”€ PUBLIC API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function scrapeMalayalam(type) {
  return scrapePage(URLS[type === 'movie' ? 'mal-movie' : 'mal-series'], type);
}

async function scrapeTamil(type) {
  return scrapePage(URLS[type === 'movie' ? 'tam-movie' : 'tam-series'], type);
}

module.exports = { scrapeMalayalam, scrapeTamil };
