// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle favicon
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route for manifest.json
  if (req.url === '/manifest.json' || req.url === '/') {
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

  // Route for data/cache.json
  if (req.url === '/data/cache.json') {
    const cachePath = path.join(__dirname, 'data', 'cache.json');
    if (fs.existsSync(cachePath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      fs.createReadStream(cachePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Cache not found');
    }
    return;
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
      <head><title>South Streams Addon</title></head>
      <body>
        <h1>🌊 South Streams</h1>
        <p>Stremio Addon for Malayalam and Tamil OTT content</p>
        <a href="/manifest.json">View manifest</a>
      </body>
    </html>
  `);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
