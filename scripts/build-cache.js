// scripts/build-cache.js
const fs = require('fs');
const path = require('path');
const { scrapeMalayalam, scrapeTamil } = require('../scraper.js');

async function buildCache() {
  console.log('=== Building South Streams Cache ===');
  console.log('Time: ' + new Date().toISOString());

  const result = {
    'malayalam-movies': [],
    'malayalam-series': [],
    'tamil-movies': [],
    'tamil-series': [],
    'builtAt': new Date().toISOString(),
  };

  console.log('\n[1/4] Malayalam movies...');
  try {
    result['malayalam-movies'] = await scrapeMalayalam('movie');
    console.log('✅ Done: ' + result['malayalam-movies'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  // ... similar for other catalogs ...

  // Save to the data folder
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const cachePath = path.join(dataDir, 'cache.json');
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  console.log('\n✅ Cache saved to: ' + cachePath);
}

buildCache().catch(e => { 
  console.error('❌ Build failed:', e.message);
  process.exit(1);
});
