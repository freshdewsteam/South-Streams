// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Helper to read JSON file
function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (e) {
    console.error('Error reading JSON:', e.message);
    return null;
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url.split('?')[0]; // Remove query params

  // ── Serve HTML page for root ──
  if (url === '/') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${manifest.name}</title>
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 60px auto; padding: 0 20px; text-align: center; background: #0d1117; color: #e6edf3; }
              .container { background: #161b22; padding: 40px; border-radius: 16px; border: 1px solid #30363d; }
              h1 { font-size: 2.5rem; margin: 0; color: #58a6ff; }
              .subtitle { font-size: 1.1rem; color: #8b949e; margin: 10px 0 30px; }
              .install-btn { display: inline-block; background: #238636; color: #fff; padding: 16px 40px; border-radius: 8px; font-size: 1.2rem; font-weight: 600; text-decoration: none; border: none; cursor: pointer; transition: background 0.2s; }
              .install-btn:hover { background: #2ea043; }
              .install-btn:active { transform: scale(0.98); }
              .info { margin-top: 30px; color: #8b949e; font-size: 0.9rem; }
              .info a { color: #58a6ff; text-decoration: none; }
              .info a:hover { text-decoration: underline; }
              .catalogs { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 20px 0; }
              .catalog-tag { background: #21262d; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; color: #8b949e; border: 1px solid #30363d; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>🌊 ${manifest.name}</h1>
              <p class="subtitle">${manifest.description}</p>
              <a href="stremio://${req.headers.host}/manifest.json" class="install-btn">📦 Install in Stremio</a>
              <div class="catalogs">
                ${manifest.catalogs.map(c => `<span class="catalog-tag">${c.name}</span>`).join('')}
              </div>
              <div class="info">
                <p>📱 Compatible with Stremio, Nuvio and other Stremio-compatible apps</p>
                <p>🔗 Manual install: <a href="/manifest.json">manifest.json</a></p>
                <p>⚡ Updated automatically 4 times daily</p>
                <p>❤️ Built for the South Indian OTT community</p>
              </div>
            </div>
          </body>
        </html>
      `);
    } else {
      res.writeHead(404);
      res.end('Manifest not found');
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

  // ── SERVE META ENDPOINT ──
  // Stremio/Nuvio calls this when user clicks a title from our catalogue
  // /meta/{type}/{id}.json
  if (url.startsWith('/meta/')) {
    const parts = url.split('/');
    const type  = parts[2]; // 'movie' or 'series'
    const id    = parts[3] ? parts[3].replace('.json', '') : '';

    console.log('[Meta] Request: ' + type + ' / ' + id);

    // Read the cache data
    const cache = readJsonFile(path.join(__dirname, 'data', 'cache.json'));
    let found   = null;

    if (cache) {
      // Search ALL catalogs
      const allItems = [
        ...(cache['malayalam-movies'] || []),
        ...(cache['malayalam-series'] || []),
        ...(cache['tamil-movies']     || []),
        ...(cache['tamil-series']     || []),
      ];
      found = allItems.find(item => item.id === id) || null;
      
      if (found) {
        console.log('[Meta] ✅ Found: ' + found.name + ' (' + found.type + ')');
      } else {
        console.log('[Meta] ❌ Not found in cache: ' + id);
      }
    }

    // Return the meta data (or null if not found)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: found || null,
      cacheMaxAge: 3600,
      staleRevalidate: 86400,
      staleError: 86400,
    }));
    return;
  }

  // ── SERVE CATALOG ENDPOINTS ──
  // Stremio expects: /catalog/{type}/{catalogId}.json
  if (url.startsWith('/catalog/')) {
    const parts = url.split('/');
    const type = parts[2];
    const catalogId = parts[3] ? parts[3].replace('.json', '') : '';

    console.log('[Catalog] Request: ' + type + ' / ' + catalogId);

    const cache = readJsonFile(path.join(__dirname, 'data', 'cache.json'));
    if (!cache) {
      res.writeHead(500);
      res.end('Cache not found');
      return;
    }

    let catalogData = cache[catalogId] || [];

    if (catalogData.length === 0) {
      const keys = Object.keys(cache);
      for (const key of keys) {
        if (key.toLowerCase().includes(type) || type.includes(key.toLowerCase())) {
          catalogData = cache[key] || [];
          break;
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      metas: catalogData,
      cacheMaxAge: 3600,
      staleRevalidate: 86400,
      staleError: 86400
    }));
    return;
  }

  // ── Serve raw cache.json (for debugging) ──
  if (url === '/data/cache.json') {
    const cache = readJsonFile(path.join(__dirname, 'data', 'cache.json'));
    if (cache) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cache));
    } else {
      res.writeHead(404);
      res.end('Cache not found');
    }
    return;
  }

  // ── Default: return 404 ──
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('🌊 South Streams server running on port ' + PORT);
});
