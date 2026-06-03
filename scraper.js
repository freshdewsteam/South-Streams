/**
 * scraper.js
 *
 * Fetches Malayalam & Tamil OTT releases from 91mobiles.com/entertainment.
 * Uses Puppeteer (headless Chrome) to bypass bot detection.
 *
 * Filters OUT:
 *   - BookMyShow / theatre-only listings
 *   - Items with no recognised OTT platform
 *
 * Results are sorted newest-first by OTT release date.
 *
 * Returns Stremio-compatible "meta preview" objects.
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// ─── URLS ─────────────────────────────────────────────────────────────────────
const URLS = {
  'mal-movie':  'https://www.91mobiles.com/entertainment/new-malayalam-movies',
  'mal-series': 'https://www.91mobiles.com/entertainment/new-malayalam-web-series',
  'tam-movie':  'https://www.91mobiles.com/entertainment/new-tamil-movies',
  'tam-series': 'https://www.91mobiles.com/entertainment/best-tamil-web-series',
};

// ─── FILTER LISTS ─────────────────────────────────────────────────────────────

// Any card whose platform text contains ONLY these → skip (cinema-only)
const CINEMA_KEYWORDS = [
  'bookmyshow', 'book my show',
  'theatre', 'theater',
  'cinema halls', 'cinemas',
  'pvr', 'inox', 'cinepolis', 'miraj', 'carnival cinemas',
  'in cinemas', 'now showing',
];

// Known OTT / streaming platforms — if at least one is found → keep the card
const OTT_KEYWORDS = [
  'netflix', 'prime video', 'amazon prime', 'hotstar', 'disney+', 'disney plus',
  'zee5', 'sony liv', 'sonyliv', 'jiocinema', 'jiocinemax', 'manorama max',
  'sun nxt', 'sunnxt', 'aha', 'neestream', 'saina play', 'stage',
  'apple tv', 'mubi', 'discovery+', 'voot', 'mx player', 'hoichoi',
  'erosnow', 'shemaroo', 'hungama', 'alt balaji', 'ullu',
];

/**
 * Decide whether a card should be kept.
 * Strategy (in order):
 *   1. If platformText contains a known OTT keyword → KEEP ✅
 *   2. If platformText contains only cinema keywords → SKIP ❌
 *   3. If platformText is empty but card is in an OTT section → KEEP ✅
 *   4. Otherwise → SKIP ❌ (safer than showing wrong data)
 */
function shouldKeep(platformText, isOttSection) {
  const lower = (platformText || '').toLowerCase();

  // Rule 1: explicit OTT platform found → definitely keep
  if (OTT_KEYWORDS.some((kw) => lower.includes(kw))) return true;

  // Rule 2: only cinema keywords → skip
  if (lower) {
    const parts = lower.split(/[,/|&\s]+/).filter(Boolean);
    const allCinema = parts.every((p) =>
      CINEMA_KEYWORDS.some((kw) => p.includes(kw))
    );
    if (allCinema) return false;
  }

  // Rule 3: no platform text but page section is OTT → keep
  if (!lower && isOttSection) return true;

  // Rule 4: ambiguous — skip to avoid clutter
  return false;
}

// ─── DATE PARSING ─────────────────────────────────────────────────────────────
/**
 * Parse a variety of date strings 91mobiles might use:
 *   "15 May 2025", "May 15, 2025", "2025-05-15", "15/05/2025"
 * Returns a JS Date or null.
 */
function parseDate(str) {
  if (!str) return null;
  // Clean up extra whitespace / label prefixes like "OTT: 15 May 2025"
  const cleaned = str.replace(/^[^0-9a-z]*/i, '').trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

// ─── LAUNCH BROWSER ───────────────────────────────────────────────────────────
async function launchBrowser() {
  const isLocal = !process.env.VERCEL && !process.env.RENDER;

  if (isLocal) {
    // Local dev: use system Chrome / Chromium
    const localChromePaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    const fs = require('fs');
    const execPath = localChromePaths.find((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });

    return puppeteer.launch({
      executablePath: execPath || undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }

  // Hosted (Vercel/Render): use @sparticuz/chromium
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

// ─── SCRAPE ONE PAGE ──────────────────────────────────────────────────────────
async function scrapePage(url, type) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Mimic a real browser
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    console.log(`[scraper] Fetching: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for movie cards to appear
    await page.waitForSelector(
      '.movie-card, .content-card, [class*="MovieCard"], [class*="movie-item"]',
      { timeout: 15000 }
    ).catch(() => console.warn('[scraper] Card selector timeout — trying anyway'));

    // Scroll to load all lazy-loaded content
    await autoScroll(page);

    // Extract raw data from the page DOM
    const rawItems = await page.evaluate(() => {
      const results = [];

      // Try multiple card selectors — 91mobiles may use different class names
      const cardSelectors = [
        '.movie-card',
        '.content-card',
        '[class*="movie-card"]',
        '[class*="MovieCard"]',
        '[class*="content-card"]',
        'article',
      ];

      let cards = [];
      for (const sel of cardSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 2) { cards = Array.from(found); break; }
      }

      // Also detect if the card is inside an "OTT" labelled section
      // (vs a "In Theatres" section) — helps when platform text is missing
      function isInsideOttSection(el) {
        let parent = el.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!parent) break;
          const text = (parent.getAttribute('class') || '') +
                       (parent.getAttribute('id') || '') +
                       (parent.querySelector('h2,h3,h4')?.textContent || '');
          const lower = text.toLowerCase();
          if (lower.includes('ott') || lower.includes('streaming') || lower.includes('digital')) return true;
          if (lower.includes('theatre') || lower.includes('cinema') || lower.includes('now showing')) return false;
          parent = parent.parentElement;
        }
        return false; // unknown
      }

      cards.forEach((card) => {
        try {
          // Title
          const titleEl = card.querySelector('h2, h3, [class*="title"], [class*="name"]');
          const title = titleEl ? titleEl.textContent.trim() : null;
          if (!title || title.length < 2) return;

          // Poster image
          const imgEl = card.querySelector('img');
          const poster =
            imgEl?.getAttribute('data-src') ||
            imgEl?.getAttribute('data-lazy-src') ||
            imgEl?.getAttribute('src') ||
            null;

          // OTT platform text — try several selectors
          const platformEl = card.querySelector(
            '[class*="platform"], [class*="ott"], [class*="streaming"], ' +
            '[class*="provider"], [class*="where-to-watch"], [class*="available"]'
          );
          const platformText = platformEl ? platformEl.textContent.trim() : '';

          // Release date — prefer OTT date over theatre date
          // Look for labels like "OTT Release:", "Digital:", "Streaming:"
          let releaseDate = '';
          const allText = card.innerText || card.textContent || '';
          const ottDateMatch = allText.match(
            /(?:ott|digital|streaming|available)[^:]*:\s*([^\n|•,]+)/i
          );
          if (ottDateMatch) {
            releaseDate = ottDateMatch[1].trim();
          } else {
            const dateEl = card.querySelector('[class*="date"], [class*="release"], time');
            releaseDate = dateEl ? dateEl.textContent.trim() : '';
          }

          // Genre
          const genreEl = card.querySelector('[class*="genre"], [class*="category"]');
          const genre = genreEl ? genreEl.textContent.trim() : '';

          // Description
          const descEl = card.querySelector('[class*="desc"], [class*="synopsis"], [class*="plot"], p');
          const description = descEl ? descEl.textContent.trim() : '';

          // Page link (used to build a stable ID)
          const linkEl = card.querySelector('a[href]');
          const href = linkEl ? linkEl.getAttribute('href') : '';

          const ottSection = isInsideOttSection(card);

          results.push({ title, poster, platformText, releaseDate, genre, description, href, ottSection });
        } catch (e) {
          // Skip malformed cards silently
        }
      });

      return results;
    });

    console.log(`[scraper] Raw cards found: ${rawItems.length} on ${url}`);

    // ── Apply OTT filter ──────────────────────────────────────────────────────
    const ottItems = rawItems.filter((item) =>
      shouldKeep(item.platformText, item.ottSection)
    );

    console.log(`[scraper] After OTT filter: ${ottItems.length} items`);

    // ── Sort by OTT release date, newest first ────────────────────────────────
    ottItems.sort((a, b) => {
      const da = parseDate(a.releaseDate);
      const db = parseDate(b.releaseDate);
      if (da && db) return db - da;          // both have dates → sort descending
      if (da && !db) return -1;              // a has date, b doesn't → a first
      if (!da && db) return 1;              // b has date, a doesn't → b first
      return 0;                              // neither has date → preserve order
    });

    // ── Convert to Stremio meta preview objects ───────────────────────────────
    return ottItems.map((item, idx) => {
      const slug = item.href
        ? item.href.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60)
        : item.title.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60);
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
  } finally {
    if (browser) await browser.close();
  }
}

function buildDescription(item) {
  let desc = '';
  if (item.platformText) desc += `📺 Available on: ${item.platformText}\n`;
  if (item.releaseDate)  desc += `📅 Release: ${item.releaseDate}\n`;
  if (item.description)  desc += `\n${item.description}`;
  return desc.trim() || undefined;
}

// Scroll page to trigger lazy loading
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= Math.min(document.body.scrollHeight, 15000)) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────
async function scrapeMalayalam(type /* 'movie' | 'series' */) {
  const key = type === 'movie' ? 'mal-movie' : 'mal-series';
  return scrapePage(URLS[key], type);
}

async function scrapeTamil(type /* 'movie' | 'series' */) {
  const key = type === 'movie' ? 'tam-movie' : 'tam-series';
  return scrapePage(URLS[key], type);
}

module.exports = { scrapeMalayalam, scrapeTamil };
