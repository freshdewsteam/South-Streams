// server.js — South Streams
// Serves the landing page, manifest, and catalog/meta endpoints from in-memory cache synced with GitHub Raw

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { renderLanding } = require('./landing');

const PORT = process.env.PORT || 3000;

// Short codes used in configured install links
const CATALOG_CODES = {
  mm: 'malayalam-movies',
  ms: 'malayalam-series',
  tm: 'tamil-movies',
  ts: 'tamil-series',
};
const CATALOG_LABELS = {
  mm: '🎬 Malayalam Movies',
  ms: '📺 Malayalam Series',
  tm: '🎬 Tamil Movies',
  ts: '📺 Tamil Series',
};
// Generated data lives on the `cache` branch (rewritten each build, no history).
// The old main-branch path is kept as a fallback during the switch-over.
const RAW_CACHE_URLS = [
  'https://raw.githubusercontent.com/freshdewsteam/South-Streams/cache/data/cache.json',
  'https://raw.githubusercontent.com/freshdewsteam/South-Streams/main/data/cache.json',
];

// Helper to read local JSON file
function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (e) {
    console.error('Error reading local JSON:', e.message);
    return null;
  }
}

// ── IN-MEMORY CACHE & GITHUB RAW SYNC ──
let memoryCache = readJsonFile(path.join(__dirname, 'data', 'cache.json')) || {
  'malayalam-movies': [],
  'malayalam-series': [],
  'tamil-movies': [],
  'tamil-series': []
};

function fetchRemoteJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SouthStreamsServer/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRemoteJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

let hasSynced = false;

async function syncCacheFromGitHub() {
  for (const url of RAW_CACHE_URLS) {
    try {
      const freshData = await fetchRemoteJson(url + '?t=' + Date.now());
      if (freshData && freshData['malayalam-movies']) {
        // Never replace newer data with older (e.g. the stale fallback path)
        const cur = memoryCache && memoryCache.builtAt;
        if (cur && freshData.builtAt && freshData.builtAt < cur) continue;
        memoryCache = freshData;
        hasSynced = true;
        console.log('[Cache Sync] ✅ In-memory cache updated (' + (freshData.builtAt || 'latest') + ')');
        return;
      }
    } catch (e) {
      console.warn('[Cache Sync] ⚠️ ' + url.split('/').slice(-3, -2)[0] + ' branch: ' + e.message);
    }
  }
  console.warn('[Cache Sync] ⚠️ All sources failed — serving current memory cache');
}

// Sync on boot; retry every minute until the first success (a fresh server has
// no local data), then every 10 minutes.
syncCacheFromGitHub();
const bootRetry = setInterval(() => {
  if (hasSynced) return clearInterval(bootRetry);
  syncCacheFromGitHub();
}, 60 * 1000);
setInterval(syncCacheFromGitHub, 10 * 60 * 1000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // ── Per-user catalogue choice, carried in the install link ──
  // e.g. /mm,ts/manifest.json → Malayalam Movies + Tamil Series only.
  // Plain links (no code) keep all four catalogues, so old installs still work.
  let url = req.url.split('?')[0];
  let selected = null; // null = all catalogues
  const cfgMatch = url.match(/^\/([a-z]{2}(?:,[a-z]{2})*)(\/.*)?$/);
  if (cfgMatch) {
    const codes = cfgMatch[1].split(',');
    if (codes.every(c => CATALOG_CODES[c])) {
      selected = [...new Set(codes)];
      url = cfgMatch[2] || '/';
    }
  }

  // ── Root Landing Page ──
  if (url === '/' || url === '/configure') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      res.writeHead(404);
      res.end('Manifest not found');
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const host = req.headers.host || 'localhost:' + PORT;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(renderLanding({ manifest, cache: memoryCache, host, selected }));
    return;
  }

  // ── Static Files from /public ──
  if (url.startsWith('/public/')) {
    const filePath = path.join(__dirname, url);
    if (filePath.startsWith(path.join(__dirname, 'public')) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const mime = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // ── Serve manifest.json ──
  if (url === '/manifest.json') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (selected) {
        const ids = selected.map(c => CATALOG_CODES[c]);
        manifest.catalogs = manifest.catalogs.filter(c => ids.includes(c.id));
      }
      // Shows a "Configure" button in Stremio that opens /configure
      manifest.behaviorHints = Object.assign({}, manifest.behaviorHints, { configurable: true, configurationRequired: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest));
    } else {
      res.writeHead(404);
      res.end('Manifest not found');
    }
    return;
  }

  // ── Meta Endpoint (/meta/{type}/{id}.json) ──
  if (url.startsWith('/meta/')) {
    const match = url.match(/^\/meta\/[^/]+\/([^/.]+)(?:\.json)?$/);
    const id = match ? match[1] : url.split('/').pop().replace('.json', '');

    const allItems = [
      ...(memoryCache['malayalam-movies'] || []),
      ...(memoryCache['malayalam-series'] || []),
      ...(memoryCache['tamil-movies'] || []),
      ...(memoryCache['tamil-series'] || []),
    ];
    const found = allItems.find(item => item.id === id) || null;

    // A series meta with no episode list shows an empty page in Stremio —
    // treat it as not found so other meta addons (Cinemeta) can answer.
    const noEpisodes = found && found.type === 'series' && !(Array.isArray(found.videos) && found.videos.length);
    if (!found || noEpisodes) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meta: null }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: found,
      cacheMaxAge: 3600,
      staleRevalidate: 86400,
      staleError: 86400,
    }));
    return;
  }

  // ── Catalog Endpoint with Genre Filtering & Pagination ──
  // Stremio patterns:
  // - /catalog/{type}/{catalogId}.json
  // - /catalog/{type}/{catalogId}/genre={genreName}.json
  // - /catalog/{type}/{catalogId}/skip={skipCount}.json
  // - /catalog/{type}/{catalogId}/genre={genreName}&skip={skipCount}.json
  // - /catalog/{type}/{catalogId}/search={query}.json
  if (url.startsWith('/catalog/')) {
    const parts = url.split('/');
    const catalogId = parts[3] ? parts[3].replace('.json', '') : '';

    if (!memoryCache[catalogId] || (selected && !selected.some(c => CATALOG_CODES[c] === catalogId))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ metas: [] }));
      return;
    }

    let items = memoryCache[catalogId];

    // Stremio "extra" filters: /catalog/{type}/{id}/genre=X&search=Y&skip=N.json
    // (values are URL-encoded; may contain dots, e.g. "S.W.A.T.")
    const extras = {};
    if (parts[4]) {
      const raw = parts.slice(4).join('/').replace(/\.json$/, '');
      for (const pair of raw.split('&')) {
        const eq = pair.indexOf('=');
        if (eq < 1) continue;
        try { extras[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1)).trim(); }
        catch (e) { extras[pair.slice(0, eq)] = pair.slice(eq + 1).trim(); }
      }
    }

    if (extras.genre) {
      items = items.filter(item => Array.isArray(item.genres) && item.genres.includes(extras.genre));
    }

    // Search: every word of the query must appear in the title (case, accents
    // and punctuation ignored); best matches first.
    if (extras.search) {
      const norm = (t) => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9\u0d00-\u0d7f\u0b80-\u0bff]+/g, ' ').trim();
      const q = norm(extras.search);
      const qWords = q.split(' ').filter(Boolean);
      const qJoined = q.replace(/ /g, '');
      const scored = [];
      for (const item of items) {
        const n = norm(item.name);
        const joined = n.replace(/ /g, '');
        const hit = qWords.length && (qWords.every(w => n.includes(w)) || (qJoined.length >= 3 && joined.includes(qJoined)));
        if (!hit) continue;
        const score = n === q ? 0 : (n.startsWith(q) || joined.startsWith(qJoined)) ? 1 : 2;
        scored.push({ item, score });
      }
      scored.sort((a, b) => a.score - b.score);
      items = scored.map(x => x.item);
    }

    const skip = parseInt(extras.skip, 10) || 0;

    // Episodes, cast, trailers etc. are only needed on the meta page — catalog
    // responses carry just the preview fields Stremio shows on the home row
    const PREVIEW = ['id', 'type', 'name', 'poster', 'posterShape', 'background', 'logo', 'genres', 'releaseInfo', 'description', 'imdbRating', 'runtime'];
    const catalogData = items.slice(skip, skip + 100).map(m => {
      const o = {};
      for (const k of PREVIEW) if (m[k] !== undefined) o[k] = m[k];
      return o;
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      metas: catalogData,
      cacheMaxAge: 3600,
      staleRevalidate: 86400,
      staleError: 86400
    }));
    return;
  }

  // ── Serve raw in-memory cache for debugging ──
  if (url === '/data/cache.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(memoryCache));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('🌊 South Streams server running on port ' + PORT);
});
