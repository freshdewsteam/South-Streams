// scripts/tag-posters.js — South Streams
// Draws a "STREAMING SOON" tab on the posters of upcoming titles during the
// GitHub build. The images are published on the `cache` branch next to
// cache.json, so the Render server does no image work at all.
//
// Safe by design: if sharp isn't installed or anything fails, the title keeps
// its normal poster.

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const crypto = require('crypto');

const POSTER_DIR = path.join(__dirname, '..', 'data', 'posters');
const RAW_BASE   = 'https://raw.githubusercontent.com/freshdewsteam/South-Streams/cache/data/posters/';
const DESIGN_VERSION = '1'; // bump to force every tagged poster to be redrawn
const KEYS = ['malayalam-movies', 'malayalam-series', 'tamil-movies', 'tamil-series'];

const W = 500, H = 750;

function fetchBuffer(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SouthStreams/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 4) {
        res.resume();
        return fetchBuffer(new URL(res.headers.location, url).toString(), depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Timeout')));
  });
}

// Centered tab hanging from the top edge, in the addon's teal→blue colours
function bannerSvg() {
  const tabW = 320, tabH = 56, r = 16, x = (W - tabW) / 2;
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#14b8a6"/>
      <stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="${W}" height="120" fill="url(#shade)"/>
  <path filter="url(#s)" fill="url(#g)"
        d="M${x},0 H${x + tabW} V${tabH - r} Q${x + tabW},${tabH} ${x + tabW - r},${tabH} H${x + r} Q${x},${tabH} ${x},${tabH - r} Z"/>
  <text x="${W / 2}" y="${tabH / 2 + 9}" text-anchor="middle"
        font-family="DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif"
        font-size="23" font-weight="700" letter-spacing="2.5" fill="#ffffff">STREAMING SOON</text>
</svg>`);
}

async function tagPosters(result) {
  let sharp;
  try { sharp = require('sharp'); }
  catch (e) {
    console.warn('[Posters] sharp not installed — Streaming Soon titles keep their normal posters');
    for (const k of KEYS) for (const m of (result[k] || [])) delete m._streamingSoon;
    return;
  }

  if (!fs.existsSync(POSTER_DIR)) fs.mkdirSync(POSTER_DIR, { recursive: true });
  const banner = bannerSvg();
  const keep = new Set();
  let drawn = 0, reused = 0, failed = 0;

  for (const k of KEYS) {
    for (const m of (result[k] || [])) {
      // Items carried over from a previous build may already point at a tagged poster
      if (!m._streamingSoon) {
        if (m.poster && m.poster.startsWith(RAW_BASE)) keep.add(m.poster.slice(RAW_BASE.length).split('?')[0]);
        continue;
      }
      delete m._streamingSoon;
      const src = m.poster;
      if (!src) continue;

      const hash = crypto.createHash('sha1').update(src + '|' + DESIGN_VERSION).digest('hex').slice(0, 10);
      const file = m.id.replace(/[^a-z0-9]/gi, '') + '-' + hash + '.jpg';
      const out = path.join(POSTER_DIR, file);
      try {
        if (fs.existsSync(out)) {
          reused++;
        } else {
          const img = await fetchBuffer(src);
          await sharp(img)
            .resize(W, H, { fit: 'cover', position: 'centre' })
            .composite([{ input: banner, top: 0, left: 0 }])
            .jpeg({ quality: 86, mozjpeg: true })
            .toFile(out);
          drawn++;
        }
        keep.add(file);
        m.poster = RAW_BASE + file;
      } catch (e) {
        failed++;
        console.warn('[Posters] ' + m.name + ': ' + e.message + ' — keeping normal poster');
      }
    }
  }

  // Remove images no title uses any more (released or dropped titles)
  for (const f of fs.readdirSync(POSTER_DIR)) {
    if (!keep.has(f)) fs.unlinkSync(path.join(POSTER_DIR, f));
  }
  console.log('[Posters] Streaming Soon: ' + drawn + ' drawn, ' + reused + ' reused, ' + failed + ' failed');
}

module.exports = { tagPosters, RAW_BASE };
