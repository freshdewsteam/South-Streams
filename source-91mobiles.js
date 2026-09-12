/**
 * source-91mobiles.js — human-curated OTT editorial lists from 91mobiles.com
 *
 * Why this source exists: MoN and JustWatch index regional Indian platforms
 * (SunNXT, Aha, Zee5 regional, ManoramaMAX) late or not at all. 91mobiles
 * editors maintain these lists by hand, so they catch real premieres fast.
 *
 * Pages used:
 *   ott-release-this-week      — weekly digest, all languages (mixed types)
 *   new-malayalam-movies       — Malayalam movies, OTT-marked
 *   new-tamil-movies           — Tamil movies, OTT-marked
 *   new-malayalam-web-series   — Malayalam series (page is all-OTT by nature)
 *   new-tamil-web-series       — Tamil series (404s are skipped gracefully)
 *
 * Theatre releases are excluded by demanding the literal "(OTT)" marker on
 * movie + weekly pages. Series pages are OTT-only by definition.
 *
 * Zero dependencies: items are <h1>–<h4>-headed blocks, so we split the raw
 * HTML on heading tags and regex each block's text. If 91mobiles ever
 * redesigns, blocks simply stop matching and this source returns [] — the
 * scraper's other sources keep working, and failure alerts still fire.
 */

const BASE_URL = 'https://www.91mobiles.com/entertainment/';
const LOOKBACK_DAYS = 35;   // ignore entries older than this (bounded TMDB cost)
const REQUEST_DELAY_MS = 300;

const PAGES = {
  ml: { movie: ['new-malayalam-movies'], series: ['new-malayalam-web-series'] },
  ta: { movie: ['new-tamil-movies'],        series: ['new-tamil-web-series'] },
};

const LANG_LABEL = { ml: 'Malayalam', ta: 'Tamil' };
const WEEKLY_PAGE = 'ott-release-this-week';

// ── HTML TEXT SURGERY (no cheerio needed) ────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Items on 91mobiles listicles are headed by h1–h4 tags. Slice the page into
// heading-led blocks; everything between two headings belongs to the first.
function splitBlocks(html) {
  return html
    .split(/<h[1-4][^>]*>/i)
    .slice(1)
    .map(chunk => {
      const end  = chunk.search(/<\/h[1-4]>/i);
      const head = end === -1 ? chunk : chunk.slice(0, end);
      const body = end === -1 ? '' : chunk.slice(end);
      return { head: stripTags(head), body };
    })
    .filter(b => b.head);
}

// Body HTML → text lines (block-level closes become line breaks)
function blockLines(bodyHtml) {
  const text = stripTags(
    bodyHtml
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|td|th|span|a)>/gi, '\n')
  );
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

// ── FACTORY (deps injected from scraper.js — shared rate limiter & caches) ──
module.exports = function create91MobilesSource(deps) {
  const { fetchUrl, tmdb, parseAnyDate, isReleased, daysAgo,
          readCacheEntry, setRetry, movieCache, seriesCache,
          sendFailureAlert, clearFailure } = deps;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const slug  = s => s.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);

  // Parse one page's HTML into raw editorial items.
  //   pageKind:    'movie' | 'series'  (what this scrape run wants)
  //   forcedType:  same as pageKind for language pages; null for weekly page
  //   requireOtt:  demand the literal "(OTT)" marker (movie + weekly pages)
  function parsePage(html, lang, slugName, pageKind, forcedType, requireOtt) {
    const label    = LANG_LABEL[lang];
    const rawItems = [];

    for (const block of splitBlocks(html)) {
      // Title: drop cert suffix "(UA-16+)", "(U/A 16+)", "(A)", "(PG-13)"...
      let title = block.head
        .replace(/^\d+[\.\)]\s*/, '')                                   // "1. Varavu"
        .replace(/\s*\((?:U\s*\/\s*A|UA|U|A|PG-13|R|NR)[^)]*\)\s*$/, '') // cert
        .trim();
      if (!title || title.length > 120) continue;

      const lines = blockLines(block.body);

      // Find the "Language | [duration |] DD Mon YYYY [(OTT)]" line
      let date = null, isOtt = !requireOtt, year = null;
      for (const line of lines) {
        if (!line.toLowerCase().startsWith(label.toLowerCase())) continue;
        if (!line.includes('|')) continue;
        const m = line.match(/\b(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/);
        if (!m) continue;
        const d = parseAnyDate(m[0]);
        if (!d) continue;
        date = d;
        year = m[3];
        if (/\(OTT\)/i.test(line)) isOtt = true;
        break;
      }
      if (!date || !isOtt) continue;                       // no date or theatre release
      if (!isReleased(date)) continue;                     // future-dated entries
      if (date.getTime() < Date.now() - LOOKBACK_DAYS * 86400 * 1000) continue;

      // Type signals: "New Season"/"New Episode" badges or "Season N" in title
      const isNewSeason = /\bNew Season\b|\bNew Episode\b/i.test(lines.join(' '));
      const titleSeason = /season\s*\d+/i.test(title);
      let type = forcedType || (isNewSeason || titleSeason ? 'series' : 'movie');
      title = title.replace(/\s*:\s*Season\s*\d+\s*$/i, '').trim();  // "X : Season 2" → "X"
      if (pageKind === 'movie' && type !== 'movie') continue;  // weekly page: keep only what we came for
      if (pageKind === 'series' && type !== 'series') continue;

      // Platform: the line right after "Where To Stream"
      let platform = '';
      const wts = lines.findIndex(l => /^where to stream/i.test(l));
      if (wts !== -1 && lines[wts + 1] && !/^similar/i.test(lines[wts + 1])) {
        platform = lines[wts + 1].split(',').map(p => p.trim()).filter(Boolean).join(', ');
      }

      rawItems.push({ title, date, year, platform, isNewSeason });
    }

    console.log('[91m] ' + slugName + ': ' + rawItems.length + ' ' + label + ' ' + pageKind + ' item(s)');
    return rawItems;
  }

  // Resolve editorial items to TMDB IDs — same contract as fetchJustWatch:
  // returns [{ id, arrivalDate, title, imdbId, year, isNewSeason? }]
  async function fetch91Mobiles(lang, kind) {
    const isShow   = kind === 'SHOW';
    const pageKind = isShow ? 'series' : 'movie';
    const retryStore = isShow ? seriesCache : movieCache;

    const slugs = [...PAGES[lang][pageKind], WEEKLY_PAGE]
      .filter((s, i, a) => a.indexOf(s) === i);

    // 1) Fetch + parse all relevant pages
    const raws = [];
    for (const s of slugs) {
      let html;
      try {
        html = await fetchUrl(BASE_URL + s, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        });
      } catch (e) {
        console.warn('[91m] ' + s + ' fetch failed: ' + e.message);
        await sendFailureAlert('91mobiles', '91mobiles page failed: ' + s + ' (' + e.message + ')');
        continue; // one dead page must not kill the source
      }
      raws.push(...parsePage(html, lang, s, pageKind, s === WEEKLY_PAGE ? null : pageKind, true));
      await sleep(REQUEST_DELAY_MS);
    }

    // 2) Dedupe by title+date, resolve via TMDB (year-restricted search)
    const seenKeys = new Set();
    const seenIds  = new Set();
    const resolved = [];

    for (const item of raws) {
      const key = slug(item.title) + '_' + item.date.toISOString().slice(0, 10);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const retryKey = '91m_' + kind.toLowerCase() + '_' + slug(item.title);
      if (readCacheEntry(retryStore[retryKey]) === 'retry') continue;

      try {
        const yearParam = item.year
          ? (isShow ? '&first_air_date_year=' : '&primary_release_year=') + item.year
          : '';
        const endpoint = isShow ? '/search/tv?query=' : '/search/movie?query=';
        const data = await tmdb(endpoint + encodeURIComponent(item.title) + '&language=en-US&page=1' + yearParam);
        const r = (data.results || [])[0];
        if (r && !seenIds.has(r.id)) {
          seenIds.add(r.id);
          resolved.push({
            id: r.id,
            arrivalDate: item.date.toISOString().slice(0, 10),
            title: item.title,
            imdbId: null,
            year: item.year,
            isNewSeason: item.isNewSeason === true,
          });
          console.log('[91m OK] ' + item.title + ' -> TMDB ' + r.id + (item.platform ? ' on ' + item.platform : ''));
        } else {
          console.log('[91m] "' + item.title + '" not on TMDB yet — will retry');
          setRetry(retryStore, retryKey);
        }
      } catch (e) {
        console.warn('[91m] TMDB search failed for "' + item.title + '": ' + e.message);
      }
      await sleep(120);
    }

    if (resolved.length) clearFailure('91mobiles').catch(() => {});
    console.log('[91m] Resolved ' + resolved.length + ' ' + LANG_LABEL[lang] + ' ' + pageKind + ' to TMDB IDs');
    return resolved;
  }

  return { fetch91Mobiles };
};
