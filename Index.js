const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fs   = require('fs');
const path = require('path');

const manifest = {
  id: 'community.mollywood.ott.catalogue',
  version: '1.6.0',
  name: 'Mollywood & Kollywood OTT',
  description:
    'Latest Malayalam & Tamil OTT releases — movies and web series. ' +
    'Only shows titles already streaming. Updated every 6 hours via GitHub Actions.',
  logo: 'https://i.imgur.com/fBESjol.png',
  background: 'https://i.imgur.com/5pEhPuS.jpg',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie',  id: 'malayalam-ott-movies', name: 'Malayalam OTT Movies', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'malayalam-ott-series', name: 'Malayalam OTT Series', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie',  id: 'tamil-ott-movies',     name: 'Tamil OTT Movies',     extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'tamil-ott-series',     name: 'Tamil OTT Series',     extra: [{ name: 'skip', isRequired: false }] },
  ],
  idPrefixes: ['tt'],
  behaviorHints: { adult: false, p2p: false },
};

// ── CACHE FILE ────────────────────────────────────────────────────────────────
// Written by GitHub Actions, committed to repo, served by Render
// Render does zero scraping — just reads this file instantly
const CACHE_PATH = path.join(__dirname, 'data', 'cache.json');

let cache = {
  'mal-movies': [],
  'mal-series': [],
  'tam-movies': [],
  'tam-series': [],
  builtAt: null,
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      cache = data;
      console.log('[cache] Loaded data/cache.json built at: ' + data.builtAt);
      console.log('[cache] mal-movies: ' + (data['mal-movies'] || []).length);
      console.log('[cache] mal-series: ' + (data['mal-series'] || []).length);
      console.log('[cache] tam-movies: ' + (data['tam-movies'] || []).length);
      console.log('[cache] tam-series: ' + (data['tam-series'] || []).length);
    } else {
      console.warn('[cache] data/cache.json not found — catalogues will be empty');
      console.warn('[cache] Go to GitHub Actions and run "Scrape & Update Cache" manually');
    }
  } catch (e) {
    console.error('[cache] Failed to load: ' + e.message);
  }
}

// Check every 10 min if GitHub Actions committed a newer cache.json
function startCacheWatcher() {
  setInterval(() => {
    try {
      if (fs.existsSync(CACHE_PATH)) {
        const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        if (data.builtAt !== cache.builtAt) {
          cache = data;
          console.log('[cache] Reloaded — new build at: ' + data.builtAt);
        }
      }
    } catch (e) {
      console.warn('[cache] Reload check failed: ' + e.message);
    }
  }, 10 * 60 * 1000);
}

// ── ADDON ─────────────────────────────────────────────────────────────────────
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const skip = parseInt((extra && extra.skip) || 0);
  let metas  = [];

  if      (id === 'malayalam-ott-movies') metas = cache['mal-movies'] || [];
  else if (id === 'malayalam-ott-series') metas = cache['mal-series'] || [];
  else if (id === 'tamil-ott-movies')     metas = cache['tam-movies'] || [];
  else if (id === 'tamil-ott-series')     metas = cache['tam-series'] || [];

  return {
    metas: metas.slice(skip, skip + 50),
    cacheMaxAge:     3600,
    staleRevalidate: 86400,
    staleError:      86400,
  };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('tt')) return { meta: null };

  const allMetas = [
    ...(cache['mal-movies'] || []),
    ...(cache['mal-series'] || []),
    ...(cache['tam-movies'] || []),
    ...(cache['tam-series'] || []),
  ];

  const found = allMetas.find(m => m.id === id);
  return { meta: found || null };
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log('[server] Addon running on port ' + PORT);

loadCache();
startCacheWatcher();
