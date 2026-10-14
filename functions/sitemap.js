// The static sitemap.xml listed 9 URLs. Vault has roughly 9,400 institution
// pages, so search and AI crawlers had no path to any of them except by
// following links rendered in JavaScript they may never execute.
//
// This generates the full set from the same sources the site uses, cached in
// Netlify Blobs for a day. Institution rosters change on charter, merger and
// failure events — daily is far more often than that moves.
//
// Slugs must match what the client builds in index.html, or every URL here
// redirects and the crawl budget is wasted on hops.

const FDIC_BASE = 'https://banks.data.fdic.gov/api';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SITE = 'https://vaultbot.ai';

// Sitemaps are capped at 50,000 URLs / 50 MB uncompressed. ~9,400 fits in
// one file comfortably; this guard exists so growth fails loudly in the logs
// rather than producing a silently truncated sitemap.
const SITEMAP_URL_CAP = 45000;

const STATIC_PATHS = ['/', '/mcp', '/mcp/setup', '/industry', '/lenders', '/compare', '/ma', '/charters', '/about'];

// State hubs are listed explicitly. County hubs are not: there are ~3,100 of
// them, they are linked from their state hub, and letting crawlers discover
// them by following links is both cheaper and a better signal of site
// structure than dumping every one into the sitemap.
const STATE_SLUGS = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
'district-of-columbia','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana',
'nebraska','nevada','new-hampshire','new-jersey','new-mexico','new-york','north-carolina','north-dakota','ohio',
'oklahoma','oregon','pennsylvania','rhode-island','south-carolina','south-dakota','tennessee','texas','utah',
'vermont','virginia','washington','west-virginia','wisconsin','wyoming','puerto-rico'];

// Byte-identical to slugify() in index.html. Deliberately duplicated rather
// than approximated: if these drift, every URL in this sitemap resolves via a
// client-side rewrite to a different canonical path, which burns crawl budget
// on redirects and splits ranking signals across two URLs for the same bank.
// Note "&" is REMOVED here, not expanded to "and", because that is what the
// client does — matching it matters more than it being prettier.
function slugify(name, city, state) {
  return `${name} ${city || ''} ${state || ''}`.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function getStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore({
      name: 'vault-sitemap-cache',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
  } catch (e) {
    console.log('[sitemap] blobs unavailable:', e.message);
    return null;
  }
}

async function fetchAllBanks() {
  // FDIC caps a single response well below the full roster, so page through.
  const out = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 8000; offset += pageSize) {
    const url = `${FDIC_BASE}/institutions?filters=ACTIVE%3A1&fields=CERT,NAME,CITY,STALP&limit=${pageSize}&offset=${offset}&sort_by=CERT&sort_order=ASC`;
    const r = await fetch(url);
    if (!r.ok) break;
    const j = await r.json();
    const rows = (j.data || []).map(d => d.data).filter(Boolean);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function fetchAllCUs(origin) {
  // Reuse the site's own NCUA proxy rather than re-parsing the bulk 5300 zip.
  const r = await fetch(`${origin}/.netlify/functions/ncua?all=1&limit=6000`);
  if (!r.ok) return [];
  const j = await r.json();
  return j.results || [];
}

exports.handler = async (event) => {
  const origin = `https://${event.headers.host || 'vaultbot.ai'}`;
  const store = await getStore();

  // ?refresh=1 forces a rebuild. Without it, a bad generation stays served
  // for a full day with no way to correct it short of waiting out the TTL —
  // which is exactly what happened when the credit-union fetch came back
  // empty and the result was cached anyway.
  const refresh = (event.queryStringParameters || {}).refresh === '1';

  if (store && !refresh) {
    try {
      const cached = await store.get('sitemap-xml', { type: 'json' });
      if (cached && cached._at && Date.now() - cached._at < CACHE_TTL_MS) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, body: cached.xml };
      }
    } catch (e) {
      console.log('[sitemap] cache read failed:', e.message);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const urls = STATIC_PATHS.map(p => ({ loc: `${SITE}${p}`, priority: p === '/' ? '1.0' : '0.8', changefreq: 'weekly' }));
  for (const st of STATE_SLUGS) {
    urls.push({ loc: `${SITE}/banks-in-${st}`, priority: '0.7', changefreq: 'monthly' });
  }

  let banks = [], cus = [];
  try { banks = await fetchAllBanks(); } catch (e) { console.log('[sitemap] bank fetch failed:', e.message); }
  try { cus = await fetchAllCUs(origin); } catch (e) { console.log('[sitemap] cu fetch failed:', e.message); }

  for (const b of banks) {
    const slug = slugify(b.NAME, b.CITY, b.STALP);
    urls.push({ loc: `${SITE}/bank/${slug}-${b.CERT}`, priority: '0.6', changefreq: 'monthly' });
  }
  for (const c of cus) {
    const slug = slugify(c.name, c.city, c.state);
    urls.push({ loc: `${SITE}/cu/${slug}-${c.id}`, priority: '0.6', changefreq: 'monthly' });
  }

  if (urls.length > SITEMAP_URL_CAP) {
    console.log(`[sitemap] WARNING ${urls.length} urls exceeds cap ${SITEMAP_URL_CAP}; truncating. Split into a sitemap index.`);
    urls.length = SITEMAP_URL_CAP;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${xmlEscape(u.loc)}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n') +
    `\n</urlset>\n`;

  console.log(`[sitemap] generated ${urls.length} urls (${banks.length} banks, ${cus.length} CUs)`);

  // Only cache a generation that actually pulled both rosters. Caching a
  // partial result pins the failure in place for 24 hours.
  if (store && banks.length > 1000 && cus.length > 1000) {
    store.setJSON('sitemap-xml', { xml, _at: Date.now() }).catch(e => console.log('[sitemap] cache write failed:', e.message));
  } else {
    console.log(`[sitemap] NOT caching partial result (banks=${banks.length}, cus=${cus.length})`);
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, body: xml };
};
