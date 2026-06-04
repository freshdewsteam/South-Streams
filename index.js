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
// Survives Render restarts so first user after a restart gets instant response
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
const CACHE_TTL_MS  = 1  * 60 * 60 * 1000; // 1 hour  — reduced from 3h
const STALE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours — max before must wait

const cache      = loadCacheFromDisk(); // instantly populated from disk on startup
const refreshing = new Set();

const FETCHERS = [
  { key: 'mal-movies', fn: () => scrapeMalayalam('movie')  },
  { key: 'mal-series', fn: () => scrapeMalayalam('series') },
  { key: 'tam-movies', fn: () => scrapeTamil('movie')      },
  { key: 'tam-series', fn: () => scrapeTamil('series')     },
];

async function refreshCache(key, fetchFn) {
  if (refreshing.has(key)) return; // already running — don't double-fire
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

// Stale-while-revalidate:
// Fresh (<1h)   → return immediately, no network call
// Stale (1-24h) → return old data instantly, refresh silently in background
// Empty/ancient → must wait (only on very first ever boot)
async function getCached(key, fetchFn) {
  const entry = cache[key];
  if (entry) {
    const age = Date.now() - entry.ts;
    if (age < CACHE_TTL_MS)  return entry.data;
    if (age < STALE_TTL_MS) {
      refreshCache(key, fetchFn); // intentionally not awaited — runs in background
      return entry.data;          // user gets response immediately
    }
  }
  // No cache at all — must wait (first ever boot with empty disk)
  await refreshCache(key, fetchFn);
  return cache[key] ? cache[key].data : [];
}

// ── WARM UP ───────────────────────────────────────────────────────────────────
// Runs on server start — skips network calls if disk cache is still fresh
async function warmUpAll() {
  const now          = Date.now();
  const needsRefresh = FETCHERS.filter(({ key }) => {
    const entry = cache[key];
    return !entry || (now - entry.ts) > CACHE_TTL_MS;
  });

  if (needsRefresh.length === 0) {
    console.log('[cache] Disk cache is fresh — skipping warm-up network calls');
    return;
  }

  console.log('[cache] Warming up ' + needsRefresh.length + ' stale catalogues in parallel...');
  await Promise.allSettled(needsRefresh.map(({ key, fn }) => refreshCache(key, fn)));
  console.log('[cache] Warm-up complete');
}

// ── IST-AWARE SCHEDULER ───────────────────────────────────────────────────────
// OLD: refreshed every 3 hours from whenever server happened to start
//      e.g. server starts 2 PM → refreshes 2PM, 5PM, 8PM, 11PM, 2AM...
//      A midnight OTT drop might not show until 2AM worst case
//
// NEW: refreshes at fixed IST times chosen around real OTT drop patterns:
//   12:30 AM IST — catches midnight drops (Prime, Netflix, Hotstar drop at 12AM IST)
//    7:00 AM IST — catches dawn drops + early morning cinebuds updates
//   12:30 PM IST — catches afternoon drops + midday cinebuds edits
//    6:00 PM IST — catches evening drops + any missed updates
//
// Result: Patriot dropping June 5 at 12AM IST → in addon by 12:31 AM IST ✅

const IST_OFFSET_MS    = 5.5 * 60 * 60 * 1000; // IST = UTC + 5:30
const IST_REFRESH_TIMES = [
  { hour: 0,  minute: 30 }, // 12:30 AM IST
  { hour: 7,  minute: 0  }, //  7:00 AM IST
  { hour: 12, minute: 30 }, // 12:30 PM IST
  { hour: 18, minute: 0  }, //  6:00 PM IST
];

function msUntilNextISTRefresh() {
  const nowIST        = new Date(Date.now() + IST_OFFSET_MS);
  const currentHour   = nowIST.getUTCHours();
  const currentMinute = nowIST.getUTCMinutes();
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  // Find the next scheduled time (in minutes from midnight IST)
  const scheduledMinutes = IST_REFRESH_TIMES.map(t => t.hour * 60 + t.minute);
  const next = scheduledMinutes.find(m => m > currentTotalMinutes);

  // If no time today is left, wrap to first slot tomorrow
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
  const next = IST_REFRESH_TIMES.find(t => (t.hour * 60 + t.minute) > currentTotal)
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
    await Promise.allSettled(FETCHERS.map(({ key, fn }) => refreshCache(key, fn)));
    console.log('[scheduler] Refresh complete — scheduling next...');
    scheduleISTRefresh(); // schedule the next one after this completes
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
    cacheMaxAge:     3600,  // 1 hour — reduced from 6h so Stremio client refreshes faster
    staleRevalidate: 86400, // 24 hours — serve stale while refreshing in background
    staleError:      86400, // 24 hours — keep showing data even if server errors
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

// 1. Load disk cache instantly (already done above at const cache = loadCacheFromDisk())
// 2. Warm up any stale/missing catalogues
// 3. Schedule IST-aware refreshes going forward
warmUpAll()
  .then(() => scheduleISTRefresh())
  .catch(console.error);
