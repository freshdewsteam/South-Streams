// server.js — South Streams
// Serves the landing page, manifest, and catalog/meta endpoints from in-memory cache synced with GitHub Raw

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;
const RAW_CACHE_URL = 'https://raw.githubusercontent.com/freshdewsteam/South-Streams/main/data/cache.json';

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

async function syncCacheFromGitHub() {
  try {
    const freshData = await fetchRemoteJson(RAW_CACHE_URL + '?t=' + Date.now());
    if (freshData && freshData['malayalam-movies']) {
      memoryCache = freshData;
      console.log('[Cache Sync] ✅ In-memory cache updated from GitHub Raw (' + (freshData.builtAt || 'latest') + ')');
    }
  } catch (e) {
    console.warn('[Cache Sync] ⚠️ GitHub Raw sync failed (' + e.message + ') — serving current memory cache');
  }
}

// Initial sync on boot, then repeat every 30 minutes
syncCacheFromGitHub();
setInterval(syncCacheFromGitHub, 30 * 60 * 1000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // ── Root Landing Page ──
  if (url === '/') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      res.writeHead(404);
      res.end('Manifest not found');
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const counts = {
      mm: (memoryCache['malayalam-movies'] || []).length,
      ms: (memoryCache['malayalam-series'] || []).length,
      tm: (memoryCache['tamil-movies'] || []).length,
      ts: (memoryCache['tamil-series'] || []).length,
    };
    const total = counts.mm + counts.ms + counts.tm + counts.ts;
    const host = req.headers.host || 'localhost:' + PORT;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${manifest.name} — New Malayalam & Tamil OTT releases, daily</title>
  <meta name="description" content="${manifest.description}">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background:#0a0e14; color:#e6edf3; line-height:1.6; }
    .wrap { max-width: 880px; margin: 0 auto; padding: 0 20px; }
    a { color:#4fd1c5; }
    .hero { text-align:center; padding: 70px 0 40px; background: radial-gradient(ellipse at top, #0f2733 0%, #0a0e14 70%); }
    .badge { display:inline-block; background:#132a33; color:#4fd1c5; border:1px solid #1e4a52; padding:5px 14px; border-radius:20px; font-size:.8rem; font-weight:600; margin-bottom:18px; }
    h1 { font-size: clamp(2.2rem, 5vw, 3.4rem); background: linear-gradient(90deg,#4fd1c5,#63b3ed); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .tagline { font-size:1.1rem; color:#9fb3c8; max-width:540px; margin:12px auto 6px; }
    .cta-row { margin-top:28px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
    .btn { display:inline-block; padding:12px 28px; border-radius:10px; font-size:1rem; font-weight:700; text-decoration:none; }
    .btn-primary { background: linear-gradient(90deg,#14b8a6,#3b82f6); color:#fff; }
    .btn-ghost { background:#16202b; color:#c9d6e2; border:1px solid #263444; }
    .stats { display:flex; gap:24px; justify-content:center; margin-top:32px; flex-wrap:wrap; }
    .stat b { display:block; font-size:1.4rem; color:#4fd1c5; }
    .stat span { font-size:.75rem; color:#7a8ea3; text-transform:uppercase; letter-spacing:1px; }
    section { padding: 36px 0; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; }
    .card { background:#111926; border:1px solid #1e2c3d; border-radius:12px; padding:18px; }
    .card .ico { font-size:1.5rem; }
    .card h3 { font-size:1rem; margin:6px 0 2px; }
    .card .num { font-size:1.2rem; font-weight:800; color:#4fd1c5; }
    footer { border-top:1px solid #1a2433; margin-top:40px; padding:28px 0; text-align:center; color:#7a8ea3; font-size:.85rem; }
  </style>
</head>
<body>
  <div class="hero">
    <div class="wrap">
      <span class="badge">⚡ AUTO-SYNCED STREAMING CATALOG</span>
      <h1>🌊 ${manifest.name}</h1>
      <p class="tagline">New Malayalam & Tamil OTT films and series detected the day they drop.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="stremio://${host}/manifest.json">📦 Install in Stremio</a>
        <a class="btn btn-ghost" href="https://${host}/manifest.json">🔧 Manual / Nuvio install</a>
      </div>
      <div class="stats">
        <div class="stat"><b>${total}</b><span>Titles tracked</span></div>
        <div class="stat"><b>${counts.mm + counts.tm}</b><span>Movies</span></div>
        <div class="stat"><b>${counts.ms + counts.ts}</b><span>Series</span></div>
      </div>
    </div>
  </div>
  <section>
    <div class="wrap">
      <div class="grid">
        <div class="card"><div class="ico">🎬</div><h3>Malayalam Movies</h3><p class="num">${counts.mm}</p></div>
        <div class="card"><div class="ico">📺</div><h3>Malayalam Series</h3><p class="num">${counts.ms}</p></div>
        <div class="card"><div class="ico">🎬</div><h3>Tamil Movies</h3><p class="num">${counts.tm}</p></div>
        <div class="card"><div class="ico">📺</div><h3>Tamil Series</h3><p class="num">${counts.ts}</p></div>
      </div>
    </div>
  </section>
  <footer>
    <div class="wrap"><p>South Streams • Metadata discovery addon for Stremio</p></div>
  </footer>
</body>
</html>`);
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      fs.createReadStream(manifestPath).pipe(res);
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

    if (!found) {
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
  if (url.startsWith('/catalog/')) {
    const parts = url.split('/');
    const catalogId = parts[3] ? parts[3].replace('.json', '') : '';

    if (!memoryCache[catalogId]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ metas: [] }));
      return;
    }

    let items = memoryCache[catalogId];

    // Check for genre parameter either in path or query string
    let requestedGenre = null;
    const genreMatch = req.url.match(/genre=([^&/.]+)/);
    if (genreMatch) {
      requestedGenre = decodeURIComponent(genreMatch[1]).trim();
    }

    if (requestedGenre) {
      items = items.filter(item => Array.isArray(item.genres) && item.genres.includes(requestedGenre));
    }

    // Pagination check
    let skip = 0;
    const skipMatch = req.url.match(/skip=([0-9]+)/);
    if (skipMatch) {
      skip = parseInt(skipMatch[1], 10) || 0;
    }

    const catalogData = items.slice(skip, skip + 100);

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
