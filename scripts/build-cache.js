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
    const movies = await scrapeMalayalam('movie');
    result['malayalam-movies'] = movies;
    console.log('✅ Done: ' + movies.length + ' items');
  } catch (e) { 
    console.error('❌ Failed: ' + e.message); 
  }

  console.log('\n[2/4] Malayalam series...');
  try {
    const series = await scrapeMalayalam('series');
    result['malayalam-series'] = series;
    console.log('✅ Done: ' + series.length + ' items');
  } catch (e) { 
    console.error('❌ Failed: ' + e.message); 
  }

  console.log('\n[3/4] Tamil movies...');
  try {
    const movies = await scrapeTamil('movie');
    result['tamil-movies'] = movies;
    console.log('✅ Done: ' + movies.length + ' items');
  } catch (e) { 
    console.error('❌ Failed: ' + e.message); 
  }

  console.log('\n[4/4] Tamil series...');
  try {
    const series = await scrapeTamil('series');
    result['tamil-series'] = series;
    console.log('✅ Done: ' + series.length + ' items');
  } catch (e) { 
    console.error('❌ Failed: ' + e.message); 
  }

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const cachePath = path.join(dataDir, 'cache.json');
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  console.log('\n✅ Cache saved to: ' + cachePath);
  console.log('📊 Summary:');
  console.log('   Malayalam Movies: ' + result['malayalam-movies'].length);
  console.log('   Malayalam Series: ' + result['malayalam-series'].length);
  console.log('   Tamil Movies:     ' + result['tamil-movies'].length);
  console.log('   Tamil Series:     ' + result['tamil-series'].length);
}

buildCache().catch(e => { 
  console.error('❌ Build failed:', e.message);
  process.exit(1);
});
