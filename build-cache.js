const fs   = require('fs');
const path = require('path');
const { scrapeMalayalam, scrapeTamil } = require('../scraper.js');

async function buildCache() {
  console.log('=== Building OTT cache on GitHub Actions ===');
  console.log('Time: ' + new Date().toISOString());

  // Debug: confirm API keys are present (shows length, not value)
  const tmdbKey = process.env.TMDB_API_KEY || '';
  const omdbKey = process.env.OMDB_API_KEY || '';
  console.log('[Keys] TMDB_API_KEY length: ' + tmdbKey.length + (tmdbKey ? ' ✅' : ' ❌ MISSING'));
  console.log('[Keys] OMDB_API_KEY length: ' + omdbKey.length + (omdbKey ? ' ✅' : ' ❌ MISSING'));

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
    console.log('Done: ' + result['mal-movies'].length + ' items');
  } catch (e) { console.error('Failed: ' + e.message); }

  await new Promise(r => setTimeout(r, 3000));

  console.log('\n[2/4] Malayalam series...');
  try {
    result['mal-series'] = await scrapeMalayalam('series');
    console.log('Done: ' + result['mal-series'].length + ' items');
  } catch (e) { console.error('Failed: ' + e.message); }

  await new Promise(r => setTimeout(r, 3000));

  console.log('\n[3/4] Tamil movies...');
  try {
    result['tam-movies'] = await scrapeTamil('movie');
    console.log('Done: ' + result['tam-movies'].length + ' items');
  } catch (e) { console.error('Failed: ' + e.message); }

  await new Promise(r => setTimeout(r, 3000));

  console.log('\n[4/4] Tamil series...');
  try {
    result['tam-series'] = await scrapeTamil('series');
    console.log('Done: ' + result['tam-series'].length + ' items');
  } catch (e) { console.error('Failed: ' + e.message); }

  const outputPath = path.join(__dirname, '..', 'data', 'cache.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  console.log('\n=== Cache saved ===');
  console.log('Malayalam movies: ' + result['mal-movies'].length);
  console.log('Malayalam series: ' + result['mal-series'].length);
  console.log('Tamil movies:     ' + result['tam-movies'].length);
  console.log('Tamil series:     ' + result['tam-series'].length);
  console.log('Built at:         ' + result.builtAt);
}

buildCache().catch(e => { console.error('Build failed:', e); process.exit(1); });
