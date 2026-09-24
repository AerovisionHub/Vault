// Replaces api.rss2json.com, which every news-fetching call in index.html
// depended on. Confirmed dead 2026-09-18: rss2json's own documented example
// call — no api_key, straight from their docs — now returns HTTP 422. That
// took down the homepage news feed, per-bank news, new-charter news, and
// CU-charter news simultaneously, silently, since it fails to the "no news
// available" empty state rather than an error a user would report.
//
// Fix: fetch Google News RSS ourselves, server-side (no CORS issue here,
// unlike a client-side fetch), and parse the XML into the exact JSON shape
// rss2json used to return: { status: 'ok'|'error', items: [{title, link,
// pubDate}] }. Every client call site keeps its existing parsing logic
// (the title's trailing " - Source Name" split, the pubDate Date parsing)
// unchanged — only the URL each one fetches changes.
//
// Deliberately takes `q` (the search query) rather than a full passthrough
// RSS URL: building the Google News URL server-side, not accepting an
// arbitrary upstream URL from the client, avoids turning this into an
// open proxy.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min — news doesn't need to be to-the-second, and this keeps repeat searches (e.g. re-opening the same bank profile) from re-hitting Google every time.

async function getBlobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore({
      name: 'vault-news-cache',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
  } catch (e) {
    console.log('[news-proxy] getBlobStore unavailable:', e.message);
    return null; // graceful degradation — falls through to a live fetch every time
  }
}

// Google News wraps title/description in CDATA and HTML-escapes entities
// inside it. A full XML parser is overkill for a feed this uniform; a
// targeted regex extraction is simpler and has no new dependency to bundle.
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTag(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1];
  return decodeEntities(v).trim();
}

function parseGoogleNewsRSS(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    if (title && link) items.push({ title, link, pubDate });
  }
  return items;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const q = (event.queryStringParameters || {}).q;
  if (!q || !q.trim()) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ status: 'error', message: 'Missing required query param: q' }) };
  }

  const cacheKey = `news:${q.trim().toLowerCase()}`;
  const store = await getBlobStore();

  if (store) {
    try {
      const cached = await store.get(cacheKey, { type: 'json' });
      if (cached && cached._cached_at && (Date.now() - cached._cached_at) < CACHE_TTL_MS) {
        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ status: 'ok', items: cached.items }) };
      }
    } catch (e) {
      console.log('[news-proxy] cache read failed, continuing live:', e.message);
    }
  }

  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch(rssUrl, {
      signal: controller.signal,
      // Google has been seen returning 403 to requests with no browser-like
      // User-Agent (a generic Node/undici default UA gets blocked; a real
      // browser UA does not). Confirmed necessary during this fix — an
      // unset UA reproduced the same failure this proxy exists to solve.
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' },
    });
    clearTimeout(timeout);

    if (!r.ok) {
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ status: 'error', message: `Google News returned HTTP ${r.status}` }) };
    }

    const xml = await r.text();
    const items = parseGoogleNewsRSS(xml);

    if (store) {
      store.setJSON(cacheKey, { items, _cached_at: Date.now() }).catch((e) => console.log('[news-proxy] cache write failed:', e.message));
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ status: 'ok', items }) };
  } catch (e) {
    clearTimeout(timeout);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ status: 'error', message: e.message }) };
  }
};
