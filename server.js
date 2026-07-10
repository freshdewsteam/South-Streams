// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Helper function to send JSON response
function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// Helper function to read JSON file safely
function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (e) {
    console.error('Error reading JSON file:', e.message);
    return null;
  }
}

const server = http.createServer((req, res) => {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Serve manifest.json
  if (req.url === '/' || req.url === '/manifest.json') {
    const manifest = readJsonFile(path.join(__dirname, 'manifest.json'));
    if (manifest) {
      sendJson(res, manifest);
    } else {
      res.writeHead(500);
      res.end('Server error: manifest.json not found or invalid');
    }
    return;
  }

  // Serve cache.json
  if (req.url === '/data/cache.json') {
    const cache = readJsonFile(path.join(__dirname, 'data', 'cache.json'));
    if (cache) {
      sendJson(res, cache);
    } else {
      // If cache doesn't exist, return an empty cache structure
      console.log('📭 Cache file not found, returning empty cache');
      sendJson(res, {
        'malayalam-movies': [],
        'malayalam-series': [],
        'tamil-movies': [],
        'tamil-series': [],
        'builtAt': new Date().toISOString()
      });
    }
    return;
  }

  // Serve the HTML page for root
  const manifest = readJsonFile(path.join(__dirname, 'manifest.json'));
  if (manifest) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${manifest.name}</title>
          <style>
            body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
            h1 { color: #1a1a2e; }
            .badge { display: inline-block; background: #1a1a2e; color: white; padding: 4px 12px; border-radius: 20px; font-size: 14px; }
            .catalogs { display: flex; gap: 10px; flex-wrap: wrap; margin: 20px 0; }
            .catalog { background: #f0f0f0; padding: 8px 16px; border-radius: 8px; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 14px; color: #666; }
            a { color: #1a1a2e; }
          </style>
        </head>
        <body>
          <h1>🌊 ${manifest.name}</h1>
          <p><span class="badge">v${manifest.version}</span></p>
          <p>${manifest.description}</p>
          <h3>📦 Catalogs</h3>
          <div class="catalogs">
            ${manifest.catalogs.map(c => `<span class="catalog">${c.name}</span>`).join('')}
          </div>
          <div class="footer">
            <p>🔗 <a href="/manifest.json">View manifest.json</a></p>
            <p>📊 <a href="/data/cache.json">View cache.json</a></p>
            <p>⚡ Updated via GitHub Actions every 6 hours</p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>🌊 South Streams</h1><p>Addon is running</p>');
  }
});

server.listen(PORT, () => {
  console.log(`🌊 South Streams server running on port ${PORT}`);
});
