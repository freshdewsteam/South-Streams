const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { scrapeMalayalam, scrapeTamil } = require('./scraper');

const manifest = {
  id: 'community.mollywood.ott.catalogue',
  version: '1.3.0',
  name: 'Mollywood & Kollywood OTT',
  description:
    'Latest Malayalam & Tamil OTT releases — movies and web series. ' +
    'Only shows titles already streaming. Updated every 3 hours.',
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

// ── CACHE ─────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;  // 3 hours — refresh after this
const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — max age before we must wait
const cache = {};
const refreshing = new Set();

const FETCHERS = [
  { key: 'mal-movies', fn: () => scrapeMalayalam('movie')  },
  { key: 'mal-series', fn: () => scrapeMalayalam('series') },
  { key: 'tam-movies', fn: () => scrapeTamil('movie')      },
  { key: 'tam-series', fn: () => scrapeTamil('series')     },
];

async function refreshCache(key, fetchFn) {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  console.log('[cache] Refreshing: ' + key);
  try {
    const data = await fetchFn();
    cache[key] = { ts: Date.now(), data };
    console.log('[cache] ' + key + ' -> ' + data.length + ' items');
  } catch (err) {
    console.error('[cache] Failed ' + key + ': ' + err.message);
  } finally {
    refreshing.delete(key);
  }
}

// Stale-while-revalidate:
// Fresh (<3h)     → return immediately ✅
// Stale (3-24h)   → return old data NOW, refresh in background ✅
// Empty or ancient → wait for fresh data (only on cold start) ⏳
async function getCached(key, fetchFn) {
  const now   = Date.now();
  const entry = cache[key];

  if (entry) {
    const age = now - entry.ts;
    if (age < CACHE_TTL_MS) {
      return entry.data; // fresh, return immediately
    }
    if (age < STALE_TTL_MS) {
      refreshCache(key, fetchFn); // background refresh, don't await
      return entry.data;          // return stale data instantly
    }
  }

  // No cache or very stale — must wait (first ever startup only)
  await refreshCache(key, fetchFn);
  return cache[key] ? cache[key].data : [];
}

async function warmUpAll() {
  console.log('[cache] Warming up all catalogues in parallel...');
  await Promise.allSettled(
    FETCHERS.map(({ key, fn }) => refreshCache(key, fn))
  );
  console.log('[cache] Warm-up complete');
}

function startBackgroundRefresh() {
  setInterval(() => {
    console.log('[cache] Scheduled background refresh...');
    Promise.allSettled(
      FETCHERS.map(({ key, fn }) => refreshCache(key, fn))
    );
  }, CACHE_TTL_MS);
}

// ── ADDON ─────────────────────────────────────────────────────────────────────
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const skip = parseInt((extra && extra.skip) || 0);
  let metas = [];

  if      (id === 'malayalam-ott-movies') metas = await getCached('mal-movies', () => scrapeMalayalam('movie'));
  else if (id === 'malayalam-ott-series') metas = await getCached('mal-series', () => scrapeMalayalam('series'));
  else if (id === 'tamil-ott-movies')     metas = await getCached('tam-movies', () => scrapeTamil('movie'));
  else if (id === 'tamil-ott-series')     metas = await getCached('tam-series', () => scrapeTamil('series'));

  return { metas: metas.slice(skip, skip + 50) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('tt')) return { meta: null };
  for (const { key } of FETCHERS) {
    if (cache[key]) {
      const found = cache[key].data.find(m => m.id === id);
      if (found) return { meta: found };
    }
  }
  return { meta: null };
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log('Addon running on port ' + PORT);

warmUpAll().then(() => startBackgroundRefresh()).catch(console.error);
