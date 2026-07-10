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
    builtAt: new Date().toISOString(),
  };

  console.log('\n[1/4] Malayalam movies...');
  try {
    result['malayalam-movies'] = await scrapeMalayalam('movie');
    console.log('✅ Done: ' + result['malayalam-movies'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  console.log('\n[2/4] Malayalam series...');
  try {
    result['malayalam-series'] = await scrapeMalayalam('series');
    console.log('✅ Done: ' + result['malayalam-series'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  console.log('\n[3/4] Tamil movies...');
  try {
    result['tamil-movies'] = await scrapeTamil('movie');
    console.log('✅ Done: ' + result['tamil-movies'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  console.log('\n[4/4] Tamil series...');
  try {
    result['tamil-series'] = await scrapeTamil('series');
    console.log('✅ Done: ' + result['tamil-series'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const cachePath = path.join(dataDir, 'cache.json');
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));

  console.log('\n=== Cache saved ===');
  console.log('Malayalam Movies: ' + result['malayalam-movies'].length);
  console.log('Malayalam Series: ' + result['malayalam-series'].length);
  console.log('Tamil Movies:     ' + result['tamil-movies'].length);
  console.log('Tamil Series:     ' + result['tamil-series'].length);
}

buildCache().catch(e => { 
  console.error('❌ Build failed:', e.message);
  process.exit(1);
});
