// landing.js — South Streams landing / configure page
// Rendered by server.js for "/" and "/configure" (also "/<codes>/configure").
// Shows this week's real releases from the live catalogue, a catalogue picker
// that builds the install link, and short answers to common questions.

const LANGS = [
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം', font: 'Anek Malayalam' },
  { code: 'ta', name: 'Tamil',     native: 'தமிழ்',   font: 'Anek Tamil' },
];
const CATALOGS = [
  { code: 'mm', key: 'malayalam-movies', lang: 'ml', label: 'Movies' },
  { code: 'ms', key: 'malayalam-series', lang: 'ml', label: 'Series' },
  { code: 'tm', key: 'tamil-movies',     lang: 'ta', label: 'Movies' },
  { code: 'ts', key: 'tamil-series',     lang: 'ta', label: 'Series' },
];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function platformOf(m) {
  const d = m.description || '';
  const soon = d.match(/Streaming soon on ([^\n]+)/);
  const now  = d.match(/Streaming on:\s*([^\n]+)/);
  const raw = (soon && soon[1]) || (now && now[1]) || '';
  const first = raw.split(',')[0].trim();
  return /^ott\s*\/\s*streaming$/i.test(first) ? '' : first;
}

function niceDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] : '';
}

// Latest releases across all four catalogues: "Streaming soon" first, then newest
function latestReleases(cache, limit) {
  const all = [];
  for (const c of CATALOGS) {
    (cache[c.key] || []).forEach((m, i) => {
      if (!m || !m.id || !m.poster) return;
      all.push({ m, lang: c.lang, kind: c.label, rank: i });
    });
  }
  const soon = all.filter(x => x.m.releaseInfo === 'Streaming soon');
  const out = all.filter(x => /^\d{4}-\d{2}-\d{2}/.test(x.m.releaseInfo || ''))
    .sort((a, b) => b.m.releaseInfo.localeCompare(a.m.releaseInfo) || a.rank - b.rank);
  const seen = new Set();
  return soon.concat(out).filter(x => !seen.has(x.m.id) && seen.add(x.m.id)).slice(0, limit);
}

const ICON = {
  copy:  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  left:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  github:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>',
};

function renderLanding({ manifest, cache, host, selected }) {
  const isSel = (code) => !selected || selected.includes(code);
  const rail = latestReleases(cache || {}, 14);
  const repo = 'https://github.com/freshdewsteam/South-Streams';

  const railHtml = rail.length ? rail.map(({ m, lang, kind }) => {
    const L = LANGS.find(l => l.code === lang);
    const soon = m.releaseInfo === 'Streaming soon';
    const plat = platformOf(m);
    const when = soon ? 'Streaming soon' : niceDate(m.releaseInfo);
    return `
        <li class="film${soon ? ' is-soon' : ''}">
          <div class="frame"><img src="${esc(m.poster)}" alt="" loading="lazy" decoding="async" width="300" height="450"></div>
          <p class="film-title">${esc(m.name)}</p>
          <p class="film-meta"><span lang="${lang}" class="script" style="font-family:'${L.font}',var(--sans)">${L.native}</span> ${kind === 'Movies' ? 'film' : 'series'}</p>
          <p class="film-when">${esc(when)}${plat ? ` <span>on ${esc(plat)}</span>` : ''}</p>
        </li>`;
  }).join('') : `
        <li class="empty">This week's releases are loading. Refresh in a minute.</li>`;

  const groups = LANGS.map(L => `
        <fieldset class="lang">
          <legend><span lang="${L.code}" class="script" style="font-family:'${L.font}',var(--sans)">${L.native}</span> <span class="en">${L.name}</span></legend>
          ${CATALOGS.filter(c => c.lang === L.code).map(c => `
          <label class="pick">
            <input type="checkbox" value="${c.code}"${isSel(c.code) ? ' checked' : ''}>
            <span class="box" aria-hidden="true">${ICON.check}</span>
            <span>${c.label}</span>
          </label>`).join('')}
        </fieldset>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(manifest.name)}: new Malayalam and Tamil OTT releases</title>
<meta name="description" content="${esc(manifest.description)}">
<meta name="theme-color" content="#0f2a2c">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anek+Latin:wdth,wght@75..100,400..800&family=Anek+Malayalam:wght@500;700&family=Anek+Tamil:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --night: #0f2a2c;      /* backwater at night */
    --deep:  #0a1f21;
    --line:  #24474a;
    --mist:  #9db5b3;
    --paper: #eef3ef;
    --gold:  #d9b45f;      /* kasavu border */
    --gold-ink: #2a2006;
    --teal:  #3cc0ad;
    --sans: 'Anek Latin', system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body { background: var(--night); color: var(--paper); font: 400 1.0625rem/1.55 var(--sans); font-stretch: 100%; }
  img { display: block; max-width: 100%; }
  a { color: inherit; }
  :focus-visible { outline: 3px solid var(--gold); outline-offset: 3px; border-radius: 4px; }
  .wrap { width: min(1080px, 100% - 32px); margin-inline: auto; }

  header.top { display: flex; align-items: center; justify-content: space-between; padding: 18px 0; }
  .mark { font-weight: 800; font-stretch: 80%; font-size: 1.25rem; letter-spacing: .01em; text-decoration: none; }
  .mark i { font-style: normal; color: var(--teal); }
  .gh { display: inline-flex; align-items: center; gap: 8px; color: var(--mist); text-decoration: none; font-size: .95rem; }
  .gh:hover { color: var(--paper); }
  .gh svg, .btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .lead { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "hero" "week" "install"; }
  .hero { grid-area: hero; padding: 28px 0 8px; }
  .week { grid-area: week; }
  #configure { grid-area: install; }
  .week-head { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
  .nav { display: none; gap: 8px; }
  .jump { margin-top: 22px; }
  .nav button { width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line); background: transparent; color: var(--paper); cursor: pointer; display: grid; place-items: center; }
  .nav button:hover { border-color: var(--mist); }
  .nav svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  h1 { font-weight: 800; font-stretch: 75%; font-size: clamp(2.6rem, 9vw, 5.25rem); line-height: .95; letter-spacing: -.01em; max-width: 13ch; }
  .lede { margin-top: 18px; max-width: 46ch; color: var(--mist); font-size: 1.125rem; }
  .lede strong { color: var(--paper); font-weight: 600; }

  /* The memorable part: this week's real releases */
  .week { padding: 36px 0 12px; }
  .week h2, .section h2 { font-weight: 700; font-stretch: 85%; font-size: 1.5rem; }
  .week .note { color: var(--mist); font-size: .95rem; margin-top: 2px; }
  .rail { list-style: none; display: grid; grid-auto-flow: column; grid-auto-columns: 150px; gap: 16px;
          overflow-x: auto; padding: 18px 16px 20px; margin: 0 -16px; scroll-snap-type: x mandatory; scroll-padding-inline: 16px;
          scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .film { scroll-snap-align: start; }
  .frame { position: relative; aspect-ratio: 2 / 3; border-radius: 8px; overflow: hidden; background: var(--deep);
           box-shadow: 0 0 0 1px var(--line); }
  .frame img { width: 100%; height: 100%; object-fit: cover; }
  .is-soon .frame { box-shadow: 0 0 0 2px var(--gold); }
  .film-title { margin-top: 10px; font-weight: 600; line-height: 1.2; font-size: 1rem;
                display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .film-meta { color: var(--mist); font-size: .875rem; margin-top: 2px; }
  .script { font-weight: 700; }
  .film-when { font-size: .875rem; margin-top: 2px; color: var(--paper); }
  .film-when span { color: var(--mist); }
  .is-soon .film-when { color: var(--gold); font-weight: 600; }
  .empty { color: var(--mist); padding: 24px 0; }

  /* Install */
  .install { margin-top: 28px; background: var(--deep); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  .install h2 { font-weight: 700; font-stretch: 85%; font-size: 1.5rem; }
  .install .sub { color: var(--mist); margin-top: 4px; max-width: 52ch; }
  .langs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 20px; }
  fieldset.lang { border: 0; }
  legend { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; font-size: 1.25rem; }
  legend .en { color: var(--mist); font-size: .9rem; }
  .pick { display: inline-flex; align-items: center; gap: 10px; margin: 0 8px 8px 0; padding: 10px 16px 10px 12px;
          border: 1px solid var(--line); border-radius: 999px; cursor: pointer; user-select: none; font-weight: 500; }
  .pick input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .pick .box { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--mist); display: grid; place-items: center; }
  .pick .box svg { width: 14px; height: 14px; fill: none; stroke: var(--gold-ink); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; opacity: 0; }
  .pick:has(input:checked) { border-color: var(--gold); }
  .pick:has(input:checked) .box { background: var(--gold); border-color: var(--gold); }
  .pick:has(input:checked) .box svg { opacity: 1; }
  .pick:has(input:focus-visible) { outline: 3px solid var(--gold); outline-offset: 3px; }

  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 0 22px;
         border-radius: 10px; font: 600 1rem var(--sans); text-decoration: none; cursor: pointer; border: 1px solid transparent; }
  .btn-main { background: var(--gold); color: var(--gold-ink); }
  .btn-main:hover { background: #e6c374; }
  .btn-alt { background: transparent; color: var(--paper); border-color: var(--line); }
  .btn-alt:hover { border-color: var(--mist); }
  .btn[aria-disabled="true"] { opacity: .4; pointer-events: none; }
  .link-row { margin-top: 14px; color: var(--mist); font-size: .9rem; overflow-wrap: anywhere; }
  .link-row code { font-family: inherit; color: var(--paper); }
  .status { min-height: 1.4em; margin-top: 6px; font-size: .9rem; color: var(--teal); }

  /* Steps and questions */
  .section { padding: 48px 0 8px; }
  .steps { list-style: none; counter-reset: s; display: grid; gap: 18px; margin-top: 16px; max-width: 640px; }
  .steps li { counter-increment: s; display: grid; grid-template-columns: 36px 1fr; gap: 12px; color: var(--mist); }
  .steps li::before { content: counter(s); width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid var(--teal);
                      color: var(--teal); display: grid; place-items: center; font-weight: 700; }
  .steps b { color: var(--paper); font-weight: 600; display: block; }
  .faq { margin-top: 12px; max-width: 680px; }
  details { border-top: 1px solid var(--line); padding: 14px 0; }
  details:last-child { border-bottom: 1px solid var(--line); }
  summary { cursor: pointer; font-weight: 600; list-style: none; display: flex; justify-content: space-between; gap: 16px; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: '+'; color: var(--gold); font-weight: 700; font-size: 1.25rem; line-height: 1; }
  details[open] summary::after { content: '\\2212'; }
  details p { color: var(--mist); margin-top: 8px; max-width: 62ch; }

  footer { margin-top: 56px; padding: 24px 0 40px; border-top: 1px solid var(--line); color: var(--mist); font-size: .9rem; }
  footer p + p { margin-top: 6px; }

  @media (min-width: 960px) {
    .lead { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); column-gap: 56px; grid-template-areas: "hero install" "week week"; align-items: center; }
    .hero h1 { font-size: 4.5rem; }
    .install { margin-top: 28px; }
    .nav { display: flex; }
    .jump { display: none; }
  }
  @media (min-width: 760px) {
    .hero { padding-top: 48px; }
    .rail { grid-auto-columns: 172px; gap: 20px; }
    .install { padding: 32px; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .rail { scroll-behavior: smooth; }
  }
</style>
</head>
<body>
  <header class="top wrap">
    <a class="mark" href="/">South<i>Streams</i></a>
    <a class="gh" href="${repo}" rel="noopener">${ICON.github}<span>Source code</span></a>
  </header>

  <main>
   <div class="lead wrap">
    <section class="hero">
      <h1>New Malayalam and Tamil releases, the day they reach OTT.</h1>
      <p class="lede">A catalogue addon for <strong>Stremio</strong> and <strong>Nuvio</strong>. It shows what has just arrived on Netflix, Prime Video, JioHotstar, SonyLIV, ZEE5, ManoramaMAX and the rest, sorted by streaming date, not cinema date.</p>
      <a class="btn btn-main jump" href="#configure">Install</a>
    </section>

    <section class="week" aria-labelledby="week-h">
      <div class="week-head">
        <div>
          <h2 id="week-h">On OTT right now</h2>
          <p class="note">Straight from the catalogue, updated several times a day.</p>
        </div>
        <div class="nav">
          <button type="button" id="prev" aria-label="Scroll back">${ICON.left}</button>
          <button type="button" id="next" aria-label="Scroll forward">${ICON.right}</button>
        </div>
      </div>
      <ul class="rail" id="rail">${railHtml}
      </ul>
    </section>

    <section id="configure" aria-labelledby="install-h">
      <div class="install">
        <h2 id="install-h">Install</h2>
        <p class="sub">Pick the rows you want on your home screen. You can change this later from the Configure button in Stremio.</p>
        <div class="langs">${groups}
        </div>
        <div class="actions">
          <a class="btn btn-main" id="install" href="stremio://${esc(host)}/manifest.json">Install in Stremio</a>
          <button class="btn btn-alt" id="copy" type="button">${ICON.copy}<span>Copy link for Nuvio</span></button>
        </div>
        <p class="link-row">Install link: <code id="link">https://${esc(host)}/manifest.json</code></p>
        <p class="status" id="status" role="status" aria-live="polite"></p>
      </div>
    </section>
   </div>

    <section class="section wrap" aria-labelledby="how-h">
      <h2 id="how-h">How to watch</h2>
      <ol class="steps">
        <li><span><b>Install South Streams</b>Choose your rows above and install.</span></li>
        <li><span><b>Add a stream addon</b>South Streams lists titles but doesn't play them. Use whichever stream addon you already have.</span></li>
        <li><span><b>Open a title</b>New releases appear at the top of each row on the day they land.</span></li>
      </ol>
    </section>

    <section class="section wrap" aria-labelledby="faq-h">
      <h2 id="faq-h">Questions</h2>
      <div class="faq">
        <details><summary>Why can't I play anything?</summary>
          <p>South Streams only lists what's new. Playback comes from a separate stream addon. Without one, Stremio has nothing to play.</p></details>
        <details><summary>Which languages are included?</summary>
          <p>Malayalam and Tamil only, including dubbed audio where the original is Malayalam or Tamil. Other languages aren't listed.</p></details>
        <details><summary>What does "Streaming soon" mean?</summary>
          <p>The title is due on OTT within the next two days. It switches to a normal listing on release day, or drops off quietly if it's postponed.</p></details>
        <details><summary>A new release is missing or wrong</summary>
          <p>Open an issue on <a href="${repo}/issues" rel="noopener">GitHub</a> with the title and platform. Most fixes go live within a few hours.</p></details>
        <details><summary>Does it cost anything?</summary>
          <p>No. There's no account, no key and no tracking.</p></details>
      </div>
    </section>
  </main>

  <footer class="wrap">
    <p>South Streams provides listings only. It hosts no video and links to no streams.</p>
    <p><a href="${repo}" rel="noopener">Source code on GitHub</a></p>
  </footer>

<script>
(function () {
  var host = ${JSON.stringify(String(host))};
  var boxes = [].slice.call(document.querySelectorAll('.pick input'));
  var install = document.getElementById('install');
  var copy = document.getElementById('copy');
  var link = document.getElementById('link');
  var status = document.getElementById('status');
  var url = '';
  function update() {
    var codes = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    var none = codes.length === 0;
    var path = (codes.length === boxes.length ? '' : '/' + codes.join(',')) + '/manifest.json';
    url = 'https://' + host + path;
    install.href = 'stremio://' + host + path;
    link.textContent = none ? 'Pick at least one row' : url;
    install.setAttribute('aria-disabled', none ? 'true' : 'false');
    copy.setAttribute('aria-disabled', none ? 'true' : 'false');
    status.textContent = '';
  }
  boxes.forEach(function (b) { b.addEventListener('change', update); });
  copy.addEventListener('click', function () {
    if (!url || copy.getAttribute('aria-disabled') === 'true') return;
    var done = function () { status.textContent = 'Link copied. Paste it into the addon search in Stremio or Nuvio.'; };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(done, function () { status.textContent = 'Copy the link above by hand.'; });
    } else { status.textContent = 'Copy the link above by hand.'; }
  });
  update();
  var rail = document.getElementById('rail');
  function step(dir) { rail.scrollBy({ left: dir * rail.clientWidth * 0.8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
  document.getElementById('prev').addEventListener('click', function () { step(-1); });
  document.getElementById('next').addEventListener('click', function () { step(1); });
})();
</script>
</body>
</html>`;
}

module.exports = { renderLanding };
