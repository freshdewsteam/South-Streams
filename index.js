const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { scrapeMalayalam, scrapeTamil } = require('./scraper');

// â”€â”€â”€ MANIFEST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const manifest = {
  id: 'community.mollywood.ott.catalogue',
  version: '1.0.0',
  name: 'ðŸŽ¬ Mollywood & Kollywood OTT',
  description:
    'Malayalam & Tamil OTT releases sourced from 91mobiles.com/entertainment. ' +
    'Filters out theatre-only listings. Two separate catalogues â€” one for each language. ' +
    'Built for the Kerala community ðŸŒ´',
  logo: 'https://i.imgur.com/fBESjol.png',
  background: 'https://i.imgur.com/5pEhPuS.jpg',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'malayalam-ott-movies',
      name: 'ðŸŒ´ Malayalam OTT Movies',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'series',
      id: 'malayalam-ott-series',
      name: 'ðŸŒ´ Malayalam OTT Series',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'tamil-ott-movies',
      name: 'ðŸŽ­ Tamil OTT Movies',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'series',
      id: 'tamil-ott-series',
      name: 'ðŸŽ­ Tamil OTT Series',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ],
  idPrefixes: ['91mob_'],
  behaviorHints: { adult: false, p2p: false },
};

// â”€â”€â”€ CACHE (refreshes every 3 hours, even without visitors) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const cache = {};

// All catalogue keys and their fetch functions
const CATALOGUE_FETCHERS = [
  { key: 'mal-movies',  fn: () => scrapeMalayalam('movie')  },
  { key: 'mal-series',  fn: () => scrapeMalayalam('series') },
  { key: 'tam-movies',  fn: () => scrapeTamil('movie')      },
  { key: 'tam-series',  fn: () => scrapeTamil('series')     },
];

async function refreshCache(key, fetchFn) {
  console.log(`[cache] Refreshing "${key}"...`);
  try {
    const data = await fetchFn();
    cache[key] = { ts: Date.now(), data };
    console.log(`[cache] "${key}" updated â€” ${data.length} items`);
  } catch (err) {
    console.error(`[cache] Failed to refresh "${key}":`, err.message);
    // Keep stale data if we have it
  }
}

async function getCached(key, fetchFn) {
  const now = Date.now();
  if (!cache[key] || now - cache[key].ts > CACHE_TTL_MS) {
    await refreshCache(key, fetchFn);
  }
  return cache[key] ? cache[key].data : [];
}

// â”€â”€ Background refresh: warm up all caches on startup, then every 3 hours â”€â”€â”€â”€
async function warmUpAll() {
  console.log('[cache] Warming up all catalogues on startup...');
  for (const { key, fn } of CATALOGUE_FETCHERS) {
    await refreshCache(key, fn);
    // Small delay between scrapes to be polite to 91mobiles
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('[cache] All catalogues warmed up âœ…');
}

// Refresh all caches every 3 hours in the background
function startBackgroundRefresh() {
  setInterval(async () => {
    console.log('[cache] Background refresh triggered...');
    for (const { key, fn } of CATALOGUE_FETCHERS) {
      await refreshCache(key, fn);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }, CACHE_TTL_MS);
}

// â”€â”€â”€ ADDON BUILDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const skip = parseInt(extra && extra.skip) || 0;
  let metas = [];

  if (id === 'malayalam-ott-movies') {
    const all = await getCached('mal-movies', () => scrapeMalayalam('movie'));
    metas = all.slice(skip, skip + 50);
  } else if (id === 'malayalam-ott-series') {
    const all = await getCached('mal-series', () => scrapeMalayalam('series'));
    metas = all.slice(skip, skip + 50);
  } else if (id === 'tamil-ott-movies') {
    const all = await getCached('tam-movies', () => scrapeTamil('movie'));
    metas = all.slice(skip, skip + 50);
  } else if (id === 'tamil-ott-series') {
    const all = await getCached('tam-series', () => scrapeTamil('series'));
    metas = all.slice(skip, skip + 50);
  }

  return { metas };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('91mob_')) return { meta: null };

  const allKeys = ['mal-movies', 'mal-series', 'tam-movies', 'tam-series'];
  for (const key of allKeys) {
    if (cache[key]) {
      const found = cache[key].data.find((m) => m.id === id);
      if (found) return { meta: found };
    }
  }
  return { meta: null };
});

// â”€â”€â”€ START â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\nâœ… Mollywood & Kollywood OTT addon running!`);
console.log(`   Install URL: http://localhost:${PORT}/manifest.json\n`);

// Warm up cache on startup (non-blocking) then start background refresh
warmUpAll().then(() => startBackgroundRefresh()).catch(console.error);
