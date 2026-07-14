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
    meta:            found || null,
    cacheMaxAge:     3600,
    staleRevalidate: 86400,
    staleError:      86400,
  }));
  return;
}
