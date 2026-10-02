// scripts/build-cache.js — South Streams
// Runs the four scrapes sequentially and publishes data/cache.json.
// Safety: never overwrites a good catalogue with an empty one.

const fs = require('fs');
const path = require('path');
const { scrapeMalayalam, scrapeTamil } = require('../scraper.js');

const KEYS = ['malayalam-movies', 'malayalam-series', 'tamil-movies', 'tamil-series'];

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

  // ── SAFETY NET ──────────────────────────────────────────────────────────
  // If a whole section comes back empty (API outage, revoked key, site
  // change), fall back to the previous published data instead of wiping it.
  const cachePath = path.join(__dirname, '..', 'data', 'cache.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) {}

  for (const key of KEYS) {
    if ((!result[key] || result[key].length === 0) &&
        previous && Array.isArray(previous[key]) && previous[key].length > 0) {
      console.warn('⚠️ ' + key + ': scrape returned 0 items — keeping ' +
        previous[key].length + ' items from previous cache');
      result[key] = previous[key];
    }
  }

  const total = KEYS.reduce((n, k) => n + result[k].length, 0);
  if (total < 20) {
    console.error('❌ FATAL: only ' + total + ' items total — refusing to publish. Last good cache.json untouched.');
    process.exit(1);
  }

  const dataDir = path.dirname(cachePath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

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
