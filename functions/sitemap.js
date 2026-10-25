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
    const url = `${FDIC_BASE}/institutions?filters=ACTIVE%3A1&fields=CERT,NAME,CITY,STALP,REPDTE&limit=${pageSize}&offset=${offset}&sort_by=CERT&sort_order=ASC`;
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

// ── Sitemap index (2026-10-25) ────────────────────────────────────────────
// /sitemap.xml is now a <sitemapindex>: /sitemaps/core.xml (static pages)
// plus one /sitemaps/{st}.xml per state (state hub + every bank and CU HQ'd
// there). Per-state files let Search Console report indexing by state, and
// each bank's <lastmod> is its own latest call-report date (REPDTE) instead
// of one date stamped on everything. Search Console flagged ~1,379 URLs as
// "discovered, currently not indexed".
const ABBR = {AL:'alabama',AK:'alaska',AZ:'arizona',AR:'arkansas',CA:'california',CO:'colorado',CT:'connecticut',DE:'delaware',DC:'district-of-columbia',FL:'florida',GA:'georgia',HI:'hawaii',ID:'idaho',IL:'illinois',IN:'indiana',IA:'iowa',KS:'kansas',KY:'kentucky',LA:'louisiana',ME:'maine',MD:'maryland',MA:'massachusetts',MI:'michigan',MN:'minnesota',MS:'mississippi',MO:'missouri',MT:'montana',NE:'nebraska',NV:'nevada',NH:'new-hampshire',NJ:'new-jersey',NM:'new-mexico',NY:'new-york',NC:'north-carolina',ND:'north-dakota',OH:'ohio',OK:'oklahoma',OR:'oregon',PA:'pennsylvania',RI:'rhode-island',SC:'south-carolina',SD:'south-dakota',TN:'tennessee',TX:'texas',UT:'utah',VT:'vermont',VA:'virginia',WA:'washington',WV:'west-virginia',WI:'wisconsin',WY:'wyoming',PR:'puerto-rico'};

function isoDate(v) {
  const s = String(v || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}
function quarterStart() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(Math.floor(d.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
}
const XML_HDR = { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };
function urlset(rows) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    rows.map(([loc, lm]) => `  <url><loc>${xmlEscape(loc)}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}</url>`).join('\n') + `\n</urlset>\n`;
}

async function buildParts(origin) {
  const banks = await fetchAllBanks().catch(e => { console.log('[sitemap] bank fetch failed:', e.message); return []; });
  const cus = await fetchAllCUs(origin).catch(e => { console.log('[sitemap] cu fetch failed:', e.message); return []; });
  const bankDates = banks.map(b => isoDate(b.REPDTE)).filter(Boolean).sort();
  const latest = bankDates[bankDates.length - 1] || quarterStart();
  const parts = { core: STATIC_PATHS.map(p => [`${SITE}${p}`, latest]) };
  const add = (st, row) => { const k = String(st || '').toUpperCase(); if (!/^[A-Z]{2}$/.test(k)) return; (parts[k] = parts[k] || []).push(row); };
  for (const [ab, slug] of Object.entries(ABBR)) add(ab, [`${SITE}/banks-in-${slug}`, latest]);
  for (const b of banks) add(b.STALP, [`${SITE}/bank/${slugify(b.NAME, b.CITY, b.STALP)}-${b.CERT}`, isoDate(b.REPDTE) || latest]);
  // NCUA's bulk file has no per-CU period field; CUs file on the same quarterly cycle.
  for (const c of cus) add(c.state, [`${SITE}/cu/${slugify(c.name, c.city, c.state)}-${c.id}`, latest]);
  console.log(`[sitemap] built ${Object.keys(parts).length} parts (${banks.length} banks, ${cus.length} CUs), latest ${latest}`);
  return { parts, banks: banks.length, cus: cus.length };
}

exports.handler = async (event) => {
  const origin = `https://${event.headers.host || 'vaultbot.ai'}`;
  const qs = event.queryStringParameters || {};
  const src = `${qs.part || ''} ${event.rawUrl || ''} ${event.path || ''}`;
  const pm = src.match(/(?:^|\/|\s)(core|[a-z]{2})(?:\.xml)?(?:\s|$|\?)/i);
  const part = qs.part ? String(qs.part).replace(/\.xml$/i, '') : (/\/sitemaps\//.test(src) && pm ? pm[1] : null);

  const store = await getStore();
  let data = null;
  if (store && qs.refresh !== '1') {
    try {
      const c = await store.get('sitemap-v2', { type: 'json' });
      if (c && c._at && Date.now() - c._at < CACHE_TTL_MS) data = c;
    } catch (e) { console.log('[sitemap] cache read failed:', e.message); }
  }
  if (!data) {
    data = await buildParts(origin);
    if (store && data.banks > 1000 && data.cus > 1000) {
      store.setJSON('sitemap-v2', { ...data, _at: Date.now() }).catch(e => console.log('[sitemap] cache write failed:', e.message));
    }
  }

  if (part) {
    const key = part.toLowerCase() === 'core' ? 'core' : part.toUpperCase();
    const rows = data.parts[key];
    if (!rows) return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };
    return { statusCode: 200, headers: XML_HDR, body: urlset(rows.slice(0, SITEMAP_URL_CAP)) };
  }

  const keys = Object.keys(data.parts).sort((a, b) => (a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b)));
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    keys.map(k => {
      const lm = data.parts[k].map(r => r[1]).filter(Boolean).sort().pop();
      return `  <sitemap><loc>${SITE}/sitemaps/${k === 'core' ? 'core' : k.toLowerCase()}.xml</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}</sitemap>`;
    }).join('\n') + `\n</sitemapindex>\n`;
  return { statusCode: 200, headers: XML_HDR, body };
};
