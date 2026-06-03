const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { scrapeMalayalam, scrapeTamil } = require('./scraper');

const manifest = {
  id: 'community.mollywood.ott.catalogue',
  version: '2.0.1',
  name: '🎬 Mollywood & Kollywood OTT',
  description: 'Malayalam & Tamil OTT releases from cinebuds.com. Shows only released content, sorted newest first.',
  logo: 'https://i.imgur.com/fBESjol.png',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'malayalam-movies', name: '🌴 Malayalam OTT Movies' },
    { type: 'series', id: 'malayalam-series', name: '🌴 Malayalam OTT Series' },
    { type: 'movie', id: 'tamil-movies', name: '🎭 Tamil OTT Movies' },
    { type: 'series', id: 'tamil-series', name: '🎭 Tamil OTT Series' },
  ],
  idPrefixes: ['cinebuds_'],
};

// Cache storage
const cache = {
  'malayalam-movies': null,
  'malayalam-series': null,
  'tamil-movies': null,
  'tamil-series': null,
  'meta': new Map(),
  lastFetch: null,
};
const CACHE_MINUTES = 180;

async function getCachedOrFetch(catalogId, fetchFn) {
  const now = Date.now();
  
  if (cache[catalogId] && cache.lastFetch && (now - cache.lastFetch) < CACHE_MINUTES * 60 * 1000) {
    console.log(`[cache] Using cached ${catalogId} (${cache[catalogId].length} items)`);
    return cache[catalogId];
  }
  
  console.log(`[cache] Fetching fresh data for ${catalogId}...`);
  try {
    const data = await fetchFn();
    console.log(`[cache] Got ${data.length} items for ${catalogId}`);
    cache[catalogId] = data;
    cache.lastFetch = now;
    
    // Also cache individual meta items
    for (const item of data) {
      cache.meta.set(item.id, item);
    }
    
    return data;
  } catch (err) {
    console.error(`[cache] Error fetching ${catalogId}:`, err.message);
    return cache[catalogId] || [];
  }
}

const builder = new addonBuilder(manifest);

// Catalog handler
builder.defineCatalogHandler(async ({ type, id }) => {
  console.log(`[catalog] Request for: ${id}`);
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
    console.error(`[catalog] Error:`, err.message);
    metas = [];
  }
  
  return { metas };
});

// Meta handler - THIS FIXES "No data loaded from addon" error
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[meta] Request for: ${id}`);
  
  // Check cache first
  if (cache.meta.has(id)) {
    console.log(`[meta] Found in cache: ${id}`);
    return { meta: cache.meta.get(id) };
  }
  
  // If not in cache, search through all catalogs
  const allCatalogs = [
    ...(cache['malayalam-movies'] || []),
    ...(cache['malayalam-series'] || []),
    ...(cache['tamil-movies'] || []),
    ...(cache['tamil-series'] || []),
  ];
  
  const found = allCatalogs.find(item => item.id === id);
  
  if (found) {
    console.log(`[meta] Found item: ${found.name}`);
    cache.meta.set(id, found);
    return { meta: found };
  }
  
  console.log(`[meta] Not found: ${id}`);
  return { meta: null };
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅ Mollywood OTT addon running on port ${PORT}`);
console.log(`   URL: http://localhost:${PORT}/manifest.json\n`);
