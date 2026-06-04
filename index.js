const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { scrapeMalayalam, scrapeTamil } = require('./scraper');

const manifest = {
  id: 'community.mollywood.ott.catalogue',
  version: '1.2.0',
  name: 'Mollywood & Kollywood OTT',
  description:
    'Latest Malayalam & Tamil OTT releases — movies and web series. ' +
    'Only shows titles already streaming. Updated every 3 hours.',
  logo: 'https://i.imgur.com/fBESjol.png',
  background: 'https://i.imgur.com/5pEhPuS.jpg',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie',  id: 'malayalam-ott-movies',  name: 'Malayalam OTT Movies',  extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'malayalam-ott-series',  name: 'Malayalam OTT Series',  extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie',  id: 'tamil-ott-movies',      name: 'Tamil OTT Movies',      extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'tamil-ott-series',      name: 'Tamil OTT Series',      extra: [{ name: 'skip', isRequired: false }] },
  ],
  idPrefixes: ['tt'],   // ← real IMDb IDs now, not cinebuds_ prefix
  behaviorHints: { adult: false, p2p: false },
};

const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const cache = {};

const FETCHERS = [
  { key: 'mal-movies',  fn: () => scrapeMalayalam('movie')  },
  { key: 'mal-series',  fn: () => scrapeMalayalam('series') },
  { key: 'tam-movies',  fn: () => scrapeTamil('movie')      },
  { key: 'tam-series',  fn: () => scrapeTamil('series')     },
];

async function refreshCache(key, fetchFn) {
  console.log('[cache] Refreshing: ' + key);
  try {
    const data = await fetchFn();
    cache[key] = { ts: Date.now(), data };
    console.log('[cache] ' + key + ' -> ' + data.length + ' items');
  } catch (err) {
    console.error('[cache] Failed ' + key + ': ' + err.message);
  }
}

async function getCached(key, fetchFn) {
  if (!cache[key] || Date.now() - cache[key].ts > CACHE_TTL_MS) {
    await refreshCache(key, fetchFn);
  }
  return cache[key] ? cache[key].data : [];
}

async function warmUpAll() {
  console.log('[cache] Warming up...');
  for (const { key, fn } of FETCHERS) {
    await refreshCache(key, fn);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('[cache] Done');
}

function startBackgroundRefresh() {
  setInterval(async () => {
    for (const { key, fn } of FETCHERS) {
      await refreshCache(key, fn);
      await new Promise(r => setTimeout(r, 3000));
    }
  }, CACHE_TTL_MS);
}

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

  // Search all caches for this IMDb ID
  for (const { key } of FETCHERS) {
    if (cache[key]) {
      const found = cache[key].data.find(m => m.id === id);
      if (found) return { meta: found };
    }
  }
  return { meta: null };
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log('Addon running on port ' + PORT);

warmUpAll().then(() => startBackgroundRefresh()).catch(console.error);
