// scripts/build-cache.js — South Streams
// Runs the four scrapes sequentially and publishes data/cache.json.
// Safety: never overwrites a good catalogue with an empty one.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { scrapeMalayalam, scrapeTamil, getUnmatched } = require('../scraper.js');

// Posts to a Discord-style webhook (WEBHOOK_URL secret). Optional.
function postWebhook(text) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ content: text.slice(0, 1900), username: 'South Streams' });
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.write(body); req.end();
    } catch (e) { resolve(); }
  });
}

// ── UNMATCHED REPORT ───────────────────────────────────────────────────────
// data/unmatched.json lists every title a source offered that didn't make it
// into the catalogue, with the reason. Fix one by adding it to overrides.json.
async function writeUnmatched() {
  const file = path.join(__dirname, '..', 'data', 'unmatched.json');
  let prev = { items: [] };
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const keyOf = (u) => u.lang + '|' + u.type + '|' + String(u.title).toLowerCase();
  const prevByKey = new Map((prev.items || []).map(u => [keyOf(u), u]));
  const now = new Date().toISOString();

  const items = getUnmatched().map(u => {
    const p = prevByKey.get(keyOf(u));
    return Object.assign({}, u, { firstSeen: (p && p.firstSeen) || now });
  });
  items.sort((a, b) => String(b.ottDate || '').localeCompare(String(a.ottDate || '')));

  fs.writeFileSync(file, JSON.stringify({
    _help: 'Titles offered by 91mobiles/overrides that are NOT in the catalogue. To fix one, add it to overrides.json.',
    builtAt: now, count: items.length, items }, null, 2));
  console.log('\n📋 Unmatched titles: ' + items.length + ' (see data/unmatched.json)');
  for (const u of items.slice(0, 15)) console.log('   • [' + u.lang + ' ' + u.type + '] ' + u.title + ' — ' + u.reason);

  // Alert only on titles that are new since the last run
  const fresh = items.filter(u => !prevByKey.has(keyOf(u)));
  if (fresh.length) {
    const lines = fresh.slice(0, 15).map(u => '• [' + u.lang + ' ' + u.type + '] **' + u.title + '**' +
      (u.ottDate ? ' (' + u.ottDate + ')' : '') + ' — ' + u.reason);
    await postWebhook('⚠️ ' + fresh.length + ' new title(s) could not be added:\n' + lines.join('\n') +
      (fresh.length > 15 ? '\n…and ' + (fresh.length - 15) + ' more (data/unmatched.json)' : '') +
      '\nFix: add them to overrides.json');
  }
}

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

  try { await writeUnmatched(); } catch (e) { console.warn('⚠️ Unmatched report failed: ' + e.message); }
}

buildCache().catch(e => {
  console.error('❌ Build failed:', e.message);
  process.exit(1);
});
