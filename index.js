const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { scrapeMalayalam, scrapeTamil } = require('./scraper');
const fs   = require('fs');
const path = require('path');

const manifest = {
  id: 'community.mollywood.ott.catalogue',
  version: '1.5.0',
  name: 'Mollywood & Kollywood OTT',
  description:
    'Latest Malayalam & Tamil OTT releases — movies and web series. ' +
    'Only shows titles already streaming. Updated at 12:30 AM, 7 AM, 12:30 PM and 6 PM IST daily.',
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

// ── PERSISTENT DISK CACHE ─────────────────────────────────────────────────────
const CACHE_FILE = path.join('/tmp', 'mollywood_cache.json');

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log('[cache] Loaded from disk: ' + Object.keys(data).join(', '));
      return data;
    }
  } catch (e) {
    console.warn('[cache] Could not load from disk: ' + e.message);
  }
  return {};
}

function saveCacheToDisk(cacheObj) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj), 'utf8');
  } catch (e) {
    console.warn('[cache] Could not save to disk: ' + e.message);
  }
}

// ── IN-MEMORY CACHE ───────────────────────────────────────────────────────────
const CACHE_TTL_MS = 1  * 60 * 60 * 1000; // 1 hour
const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const cache      = loadCacheFromDisk();
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
    saveCacheToDisk(cache);
    console.log('[cache] ' + key + ' -> ' + data.length + ' items (saved to disk)');
  } catch (err) {
    console.error('[cache] Failed ' + key + ': ' + err.message);
  } finally {
    refreshing.delete(key);
  }
}

async function getCached(key, fetchFn) {
  const entry = cache[key];
  if (entry) {
    const age = Date.now() - entry.ts;
    if (age < CACHE_TTL_MS) return entry.data;
    if (age < STALE_TTL_MS) {
      refreshCache(key, fetchFn);
      return entry.data;
    }
  }
  await refreshCache(key, fetchFn);
  return cache[key] ? cache[key].data : [];
}

// ── WARM UP ───────────────────────────────────────────────────────────────────
async function warmUpAll() {
  const now          = Date.now();
  const needsRefresh = FETCHERS.filter(({ key }) => {
    const entry = cache[key];
    return !entry || (now - entry.ts) > CACHE_TTL_MS;
  });

  if (needsRefresh.length === 0) {
    console.log('[cache] Disk cache is fresh — skipping warm-up');
    return;
  }

  console.log('[cache] Warming up ' + needsRefresh.length + ' catalogues (staggered)...');

  for (const { key, fn } of needsRefresh) {
    await refreshCache(key, fn);
    await new Promise(r => setTimeout(r, 4000));
  }

  console.log('[cache] Warm-up complete');
}

// ── IST-AWARE SCHEDULER ───────────────────────────────────────────────────────
const IST_OFFSET_MS     = 5.5 * 60 * 60 * 1000;
const IST_REFRESH_TIMES = [
  { hour: 0,  minute: 30 }, // 12:30 AM IST
  { hour: 7,  minute: 0  }, //  7:00 AM IST
  { hour: 12, minute: 30 }, // 12:30 PM IST
  { hour: 18, minute: 0  }, //  6:00 PM IST
];

function msUntilNextISTRefresh() {
  const nowIST              = new Date(Date.now() + IST_OFFSET_MS);
  const currentHour         = nowIST.getUTCHours();
  const currentMinute       = nowIST.getUTCMinutes();
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  const scheduledMinutes = IST_REFRESH_TIMES.map(t => t.hour * 60 + t.minute);
  const next             = scheduledMinutes.find(m => m > currentTotalMinutes);

  const minutesUntilNext = next !== undefined
    ? next - currentTotalMinutes
    : (24 * 60 - currentTotalMinutes) + scheduledMinutes[0];

  return minutesUntilNext * 60 * 1000;
}

function getNextISTRefreshLabel() {
  const nowIST        = new Date(Date.now() + IST_OFFSET_MS);
  const currentHour   = nowIST.getUTCHours();
  const currentMinute = nowIST.getUTCMinutes();
  const currentTotal  = currentHour * 60 + currentMinute;
  const next          = IST_REFRESH_TIMES.find(t => (t.hour * 60 + t.minute) > currentTotal)
                        ?? IST_REFRESH_TIMES[0];
  return next.hour.toString().padStart(2, '0') + ':' +
         next.minute.toString().padStart(2, '0') + ' IST';
}

function scheduleISTRefresh() {
  const delay = msUntilNextISTRefresh();
  const label = getNextISTRefreshLabel();
  console.log('[scheduler] Next IST refresh at ' + label +
              ' (in ' + Math.round(delay / 60000) + ' minutes)');

  setTimeout(async () => {
    console.log('[scheduler] IST-timed refresh firing...');
    for (const { key, fn } of FETCHERS) {
      await refreshCache(key, fn);
      await new Promise(r => setTimeout(r, 4000));
    }
    console.log('[scheduler] Refresh complete — scheduling next...');
    scheduleISTRefresh();
  }, delay);
}

// ── ADDON ─────────────────────────────────────────────────────────────────────
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const skip = parseInt((extra && extra.skip) || 0);
  let metas  = [];

  if      (id === 'malayalam-ott-movies') metas = await getCached('mal-movies', () => scrapeMalayalam('movie'));
  else if (id === 'malayalam-ott-series') metas = await getCached('mal-series', () => scrapeMalayalam('series'));
  else if (id === 'tamil-ott-movies')     metas = await getCached('tam-movies', () => scrapeTamil('movie'));
  else if (id === 'tamil-ott-series')     metas = await getCached('tam-series', () => scrapeTamil('series'));

  return {
    metas: metas.slice(skip, skip + 50),
    cacheMaxAge:     3600,
    staleRevalidate: 86400,
    staleError:      86400,
  };
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
console.log('[server] Addon running on port ' + PORT);

warmUpAll()
  .then(() => scheduleISTRefresh())
  .catch(console.error);
