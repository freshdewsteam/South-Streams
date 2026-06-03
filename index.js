const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { scrapeMalayalam, scrapeTamil } = require('./scraper');

// ─── MANIFEST ────────────────────────────────────────────────────────────────
const manifest = {
  id: 'community.mollywood.ott.catalogue',
  version: '1.0.2',
  name: '🎬 Mollywood & Kollywood OTT',
  description: 'Malayalam & Tamil OTT releases from 91mobiles. Sorted by release date (newest first). Filters out theatre-only.',
  logo: 'https://i.imgur.com/fBESjol.png',
  resources: ['catalog'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'malayalam-movies', name: '🌴 Malayalam OTT Movies' },
    { type: 'series', id: 'malayalam-series', name: '🌴 Malayalam OTT Series' },
    { type: 'movie', id: 'tamil-movies', name: '🎭 Tamil OTT Movies' },
    { type: 'series', id: 'tamil-series', name: '🎭 Tamil OTT Series' },
  ],
  idPrefixes: ['91mob_'],
};

// ─── SIMPLE CACHE (3 hours) ─────────────────────────────────────────────────
const cache = {
  'malayalam-movies': null,
  'malayalam-series': null,
  'tamil-movies': null,
  'tamil-series': null,
  lastFetch: null,
};
const CACHE_MINUTES = 180; // 3 hours

async function getCachedOrFetch(catalogId, fetchFn) {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (cache[catalogId] && cache.lastFetch && (now - cache.lastFetch) < CACHE_MINUTES * 60 * 1000) {
    console.log(`[cache] Using cached ${catalogId} (${cache[catalogId].length} items)`);
    return cache[catalogId];
  }
  
  // Fetch fresh data
  console.log(`[cache] Fetching fresh data for ${catalogId}...`);
  try {
    const data = await fetchFn();
    cache[catalogId] = data;
    cache.lastFetch = now;
    console.log(`[cache] Cached ${data.length} items for ${catalogId}`);
    return data;
  } catch (err) {
    console.error(`[cache] Error fetching ${catalogId}:`, err.message);
    // Return stale cache if available, otherwise empty array
    return cache[catalogId] || [];
  }
}

// ─── ADDON BUILDER ────────────────────────────────────────────────────────────
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id }) => {
  let metas = [];
  
  try {
    if (id === 'malayalam-movies') {
      metas = await getCachedOrFetch(id, () => scrapeMalayalam('movie'));
    } else if (id === 'malayalam-series') {
      metas = await getCachedOrFetch(id, () => scrapeMalayalam('series'));
    } else if (id === 'tamil-movies') {
      metas = await getCachedOrFetch(id, () => scrapeTamil('movie'));
    } else if (id === 'tamil-series') {
      metas = await getCachedOrFetch(id, () => scrapeTamil('series'));
    }
    
    console.log(`[catalog] Returning ${metas.length} items for ${id}`);
  } catch (err) {
    console.error(`[catalog] Error for ${id}:`, err.message);
    metas = [];
  }
  
  // Return up to 100 items (Stremio limit per page)
  return { metas: metas.slice(0, 100) };
});

// ─── START SERVER ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅ Mollywood & Kollywood OTT addon running!`);
console.log(`   Install URL: http://localhost:${PORT}/manifest.json`);
console.log(`   For Render: https://your-app-name.onrender.com/manifest.json\n`);
