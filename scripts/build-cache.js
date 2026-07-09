// scripts/build-cache.js
const fs = require('fs');
const path = require('path');
const { scrapeMalayalam, scrapeTamil } = require('../scraper.js');

async function buildCache() {
  console.log('=== Building OTT cache ===');
  console.log('Time: ' + new Date().toISOString());

  const result = {
    'mal-movies': [],
    'mal-series': [],
    'tam-movies': [],
    'tam-series': [],
    builtAt: new Date().toISOString(),
  };

  console.log('\n[1/4] Malayalam movies...');
  try {
    result['mal-movies'] = await scrapeMalayalam('movie');
    console.log('✅ Done: ' + result['mal-movies'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  console.log('\n[2/4] Malayalam series...');
  try {
    result['mal-series'] = await scrapeMalayalam('series');
    console.log('✅ Done: ' + result['mal-series'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  console.log('\n[3/4] Tamil movies...');
  try {
    result['tam-movies'] = await scrapeTamil('movie');
    console.log('✅ Done: ' + result['tam-movies'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  console.log('\n[4/4] Tamil series...');
  try {
    result['tam-series'] = await scrapeTamil('series');
    console.log('✅ Done: ' + result['tam-series'].length + ' items');
  } catch (e) { console.error('❌ Failed: ' + e.message); }

  // Save to cache files (the scraper already saves separately)
  // But also save combined for backward compatibility
  const combinedPath = path.join(__dirname, '..', 'data', 'cache.json');
  fs.writeFileSync(combinedPath, JSON.stringify(result, null, 2));

  console.log('\n=== Cache saved ===');
  console.log('Malayalam movies: ' + result['mal-movies'].length);
  console.log('Malayalam series: ' + result['mal-series'].length);
  console.log('Tamil movies:     ' + result['tam-movies'].length);
  console.log('Tamil series:     ' + result['tam-series'].length);
}

buildCache().catch(e => { 
  console.error('❌ Build failed:', e.message);
  process.exit(1);
});
