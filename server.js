// server.js — South Streams
// Serves the landing page, manifest, and catalog/meta endpoints from in-memory cache synced with GitHub Raw

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;
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
// no local data), then every 30 minutes.
syncCacheFromGitHub();
const bootRetry = setInterval(() => {
  if (hasSynced) return clearInterval(bootRetry);
  syncCacheFromGitHub();
}, 60 * 1000);
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

    if (!memoryCache[catalogId]) {
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
