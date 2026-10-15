// Makes /bank/* and /cu/* pages exist for crawlers that do not run JavaScript.
//
// Measured before writing this, against the live site: a bank profile served
// 336 KB of HTML containing 537 characters of visible text and ZERO mentions
// of the bank's own name. Everything on those pages is rendered client-side
// after an API call. Googlebot executes JS and can eventually see it, but
// GPTBot, ClaudeBot and PerplexityBot do not execute JS at all — so to every
// AI engine, ~9,400 institution pages were empty documents.
//
// This does the same job wrapped-meta.js does for /wrapped/*, one step
// further: as well as correcting the meta tags, it injects a real <h1>, a
// summary paragraph of actual figures, and schema.org JSON-LD describing the
// institution and its data provenance.
//
// IMPORTANT, and the reason this is not bot-gated: every crawler and every
// human gets the identical injected markup. Serving richer content only to
// bots is cloaking, which is a search-ranking risk and simply dishonest. The
// injected block is the same data the page renders anyway, just present
// before JS runs — the client-side render then paints over it normally.
//
// Follows wrapped-meta.js in using plain string/regex replacement rather than
// HTMLRewriter, for the same reason given there: a non-matching regex no-ops
// instead of throwing, so the worst case is an unchanged page rather than a
// broken one.

const FDIC_BASE = 'https://banks.data.fdic.gov/api';

// Google flagged these Dataset nodes: missing "description" (critical,
// suppresses the rich result entirely) and missing "license" (non-critical
// today, and Google's own notice warns non-critical issues can be
// reclassified).
//
// FDIC, NCUA, Census and CFPB filings are works of the US federal government
// and are in the public domain, so this is the accurate license rather than a
// placeholder picked to satisfy a validator.
const PUBLIC_DOMAIN_LICENSE = 'https://www.usa.gov/government-works';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Matches slugify() in index.html and functions/sitemap.js. Needed here so
// the canonical can always point at the slug URL regardless of which form
// was requested.
function slugify(name, city, state) {
  return `${name} ${city || ''} ${state || ''}`.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// NCUA publishes credit union names in all caps. An all-caps <title> reads as
// shouting in a SERP and looks low-quality; Google also truncates on width,
// so caps cost visible characters. Known initialisms stay uppercase.
const KEEP_UPPER = new Set(['FCU','CU','NA','USA','US','ATM','FSB','NAFCU','SSB','PSFCU']);
// Short all-caps tokens in institution names are usually initialisms (MSU,
// OSU, UVA, IBM), so the default for 2-4 letter words is to keep them upper.
// These are the short words where that would be wrong.
const SHORT_WORDS = new Set(['THE','OF','AND','FOR','OUR','NEW','OLD','BAY','OAK','SUN','ONE','ALL','KEY','MID','TRI','RED','BIG','ELM','FOX','AIR','GAS','OIL','SEA','TOP','WAY','SON','INC','LTD','CO','ST','MT','FT','LA','EL','DEL','SAN','RIO','TWO','SIX','TEN','AG','ON','IN','AT','TO','BY']);
function titleCaseName(s) {
  const str = String(s || '');
  if (str !== str.toUpperCase()) return str; // already mixed case — leave alone
  return str.split(/\s+/).map(w => {
    const bare = w.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!bare) return w;
    if (KEEP_UPPER.has(bare)) return w.toUpperCase();
    // 3 letters or fewer is the initialism cutoff. At 4 the false positives
    // take over (NAVY, TECH, EAST, FIRST are words, not acronyms).
    if (bare.length <= 3 && !SHORT_WORDS.has(bare)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

const STATE_NAMES = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',
NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',
ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',PR:'Puerto Rico'};
function stateHub(abbr) {
  const n = STATE_NAMES[String(abbr || '').toUpperCase()];
  return n ? { name: n, href: `/banks-in-${n.toLowerCase().replace(/\s+/g, '-')}` } : null;
}

function fmtUSD(thousands) {
  const n = Number(thousands);
  if (!isFinite(n) || n === 0) return null;
  const v = n * 1000;
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)} trillion`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)} billion`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)} million`;
  return `$${Math.round(v).toLocaleString()}`;
}

function pct(v) {
  const n = Number(v);
  return isFinite(n) ? `${n.toFixed(2)}%` : null;
}

async function fetchJSON(url, ms = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getBank(cert) {
  const [inst, fin] = await Promise.all([
    fetchJSON(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=CERT,NAME,CITY,STALP,STNAME,ACTIVE,ESTYMD,WEBADDR,OFFDOM&limit=1`),
    fetchJSON(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=REPDTE,ASSET,DEP,LNLSNET,EQ,NETINC,ROA,ROE,NUMEMP&sort_by=REPDTE&sort_order=DESC&limit=1`),
  ]);
  const i = inst?.data?.[0]?.data;
  if (!i) return null;
  return { kind: 'bank', ...i, latest: fin?.data?.[0]?.data || {} };
}

async function getCU(id, origin) {
  // Reuses the site's own NCUA proxy rather than re-implementing the bulk
  // 5300 parse at the edge.
  const j = await fetchJSON(`${origin}/.netlify/functions/ncua?q=${encodeURIComponent(id)}&limit=1`, 6000);
  const cu = j?.results?.[0];
  return cu ? { kind: 'cu', ...cu, name: titleCaseName(cu.name) } : null;
}

function buildBank(b) {
  const l = b.latest || {};
  const where = [b.CITY, b.STALP].filter(Boolean).join(', ');
  const assets = fmtUSD(l.ASSET);
  const deps = fmtUSD(l.DEP);
  const loans = fmtUSD(l.LNLSNET);

  const title = `${b.NAME} (FDIC Cert ${b.CERT}) — Financials, Deposits & Peer Data | Vault`;

  const bits = [`${b.NAME} is an FDIC-insured bank`];
  if (where) bits.push(`headquartered in ${where}`);
  if (assets) bits.push(`with ${assets} in total assets`);
  if (deps) bits.push(`and ${deps} in deposits`);
  const lead = bits.join(' ') + '.';

  const extra = [];
  if (loans) extra.push(`Net loans and leases total ${loans}`);
  if (pct(l.ROA)) extra.push(`return on assets is ${pct(l.ROA)}`);
  if (pct(l.ROE)) extra.push(`return on equity is ${pct(l.ROE)}`);
  if (l.NUMEMP) extra.push(`and it reports ${Number(l.NUMEMP).toLocaleString()} full-time employees`);
  const detail = extra.length ? extra.join(', ') + '.' : '';

  const desc = `${lead} ${detail} Free quarterly financials, peer comparison, branch and deposit data from FDIC filings.`
    .replace(/\s+/g, ' ').trim().slice(0, 300);

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'BankOrCreditUnion',
    name: b.NAME,
    identifier: [{ '@type': 'PropertyValue', name: 'FDIC Certificate', value: String(b.CERT) }],
    address: { '@type': 'PostalAddress', addressLocality: b.CITY || undefined, addressRegion: b.STALP || undefined, addressCountry: 'US' },
    url: b.WEBADDR || undefined,
    numberOfEmployees: l.NUMEMP ? { '@type': 'QuantitativeValue', value: Number(l.NUMEMP) } : undefined,
    // Provenance stated explicitly: an AI engine deciding whether to cite a
    // figure cares where it came from and how current it is.
    subjectOf: {
      '@type': 'Dataset',
      name: `${b.NAME} quarterly financial data`,
      description: `Quarterly financial data for ${b.NAME}, FDIC certificate ${b.CERT}${where ? `, headquartered in ${where}` : ''}. Includes total assets, deposits, net loans and leases, equity capital, net income, return on assets, return on equity and employee counts, drawn from FDIC call report filings and updated each reporting quarter. Free to access and free to cite.`,
      creator: { '@type': 'Organization', name: 'Federal Deposit Insurance Corporation' },
      license: PUBLIC_DOMAIN_LICENSE,
      isAccessibleForFree: true,
      temporalCoverage: l.REPDTE ? String(l.REPDTE) : undefined,
    },
  };

  return { title, desc, h1: b.NAME, lead, detail, where, jsonld, kind: 'bank',
           canonicalPath: `/bank/${slugify(b.NAME, b.CITY, b.STALP)}-${b.CERT}`,
           stateLink: stateHub(b.STALP),
           facts: [
             ['Total assets', assets], ['Deposits', deps], ['Net loans & leases', loans],
             ['Return on assets', pct(l.ROA)], ['Return on equity', pct(l.ROE)],
             ['Full-time employees', l.NUMEMP ? Number(l.NUMEMP).toLocaleString() : null],
             ['FDIC certificate', String(b.CERT)],
             ['Headquarters', where || null],
           ].filter(([,v]) => v) };
}

function buildCU(c) {
  const where = [c.city, c.state].filter(Boolean).join(', ');
  const assets = fmtUSD(c.assets / 1000);
  const title = `${c.name} (NCUA Charter ${c.id}) — Financials & Member Data | Vault`;

  const bits = [`${c.name} is an NCUA-insured credit union`];
  if (where) bits.push(`based in ${where}`);
  if (assets) bits.push(`with ${assets} in total assets`);
  if (c.members) bits.push(`serving ${Number(c.members).toLocaleString()} members`);
  const lead = bits.join(' ') + '.';

  const extra = [];
  if (c.employees) extra.push(`It reports ${Number(c.employees).toLocaleString()} full-time employees`);
  if (c.members && c.assets) extra.push(`and holds ${fmtUSD(Math.round(c.assets / c.members / 1000))} in assets per member`);
  const detail = extra.length ? extra.join(', ') + '.' : '';

  const desc = `${lead} ${detail} Free financials, member metrics and peer benchmarks from NCUA 5300 call report filings.`
    .replace(/\s+/g, ' ').trim().slice(0, 300);

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'BankOrCreditUnion',
    name: c.name,
    identifier: [{ '@type': 'PropertyValue', name: 'NCUA Charter Number', value: String(c.id) }],
    address: { '@type': 'PostalAddress', addressLocality: c.city || undefined, addressRegion: c.state || undefined, addressCountry: 'US' },
    numberOfEmployees: c.employees ? { '@type': 'QuantitativeValue', value: Number(c.employees) } : undefined,
    subjectOf: {
      '@type': 'Dataset',
      name: `${c.name} NCUA 5300 call report data`,
      description: `Financial and membership data for ${c.name}, NCUA charter number ${c.id}${where ? `, based in ${where}` : ''}. Includes total assets, member counts, employee counts and assets per member, drawn from NCUA 5300 call report filings. Free to access and free to cite.`,
      creator: { '@type': 'Organization', name: 'National Credit Union Administration' },
      license: PUBLIC_DOMAIN_LICENSE,
      isAccessibleForFree: true,
    },
  };

  return { title, desc, h1: c.name, lead, detail, where, jsonld, kind: 'cu',
           canonicalPath: `/cu/${slugify(c.name, c.city, c.state)}-${c.id}`,
           stateLink: stateHub(c.state),
           facts: [
             ['Total assets', assets],
             ['Members', c.members ? Number(c.members).toLocaleString() : null],
             ['Full-time employees', c.employees ? Number(c.employees).toLocaleString() : null],
             ['NCUA charter number', String(c.id)],
             ['Headquarters', where || null],
           ].filter(([,v]) => v) };
}

export default async (request, context) => {
  const response = await context.next();

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const url = new URL(request.url);
  // Trailing numeric id, whether the path is the bare id or the SEO slug
  // (/cu/68713 and /cu/desert-financial-phoenix-az-68713 both resolve).
  const m = url.pathname.match(/^\/(bank|cu)\/(?:.*?-)?(\d+)\/?$/);
  if (!m) return response;

  const [, kind, id] = m;

  let model = null;
  try {
    if (kind === 'bank') {
      const b = await getBank(id);
      if (b) model = buildBank(b);
    } else {
      const c = await getCU(id, url.origin);
      if (c) model = buildCU(c);
    }
  } catch {
    model = null;
  }
  // Upstream hiccup must never break the page — fall through untouched.
  if (!model) return response;

  // Both /bank/5962 and /bank/sutton-bank-attica-oh-5962 serve identical
  // content. Self-canonicalising each one leaves two indexable URLs per
  // institution — ~17,000 URLs for 8,600 institutions — splitting link equity
  // and ranking signals across duplicates. The slug URL is the single
  // canonical, and it is the form the sitemap lists.
  const canonical = `${url.origin}${model.canonicalPath || url.pathname}`;
  const t = esc(model.title);
  const d = esc(model.desc);
  const u = esc(canonical);

  let html = await response.text();

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`);
  html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`);
  html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`);

  // The crawlable body. Positioned immediately after <body> so it is the
  // first content in the document, and removed by the client on load so a
  // real browser never shows it twice.
  const srcName = model.kind === 'bank' ? 'FDIC' : 'NCUA';
  const srcLong = model.kind === 'bank'
    ? 'FDIC BankFind call report filings and the FDIC Summary of Deposits'
    : 'NCUA 5300 call report filings';
  const idLabel = model.kind === 'bank' ? 'FDIC certificate number' : 'NCUA charter number';

  const factRows = (model.facts || [])
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');

  // Structured as headed sections with a data table rather than one block of
  // prose. Retrieval systems chunk on headings and extract tables cleanly;
  // measured work on AI citation rates found sections in the 120-180 word
  // range are cited roughly 70% more often than sections under 50 words.
  const block = `
<div id="seo-prerender">
  <h1>${esc(model.h1)}</h1>
  <p>${esc(model.lead)}</p>
  ${model.detail ? `<p>${esc(model.detail)}</p>` : ''}

  <h2>Key financial data for ${esc(model.h1)}</h2>
  ${factRows ? `<table><caption>Reported figures from ${esc(srcName)} filings</caption><tbody>${factRows}</tbody></table>` : ''}
  <p>These figures come directly from ${esc(srcLong)}, the quarterly regulatory reports every
  federally insured institution is required to file. Vault republishes them without modification
  and updates them as each reporting period is published. Figures are point-in-time as of the most
  recent filing, so a number here reflects the end of that reporting quarter rather than today's
  balance. The ${esc(idLabel)} shown above is the permanent identifier regulators use for this
  institution, and it stays constant across name changes, relocations and most acquisitions, which
  makes it the reliable way to track an institution over time.</p>

  <h2>How ${esc(model.h1)} compares to similar institutions</h2>
  <p>Vault benchmarks ${esc(model.h1)} against institutions in the same asset range rather than
  the same geography alone, because a bank's cost structure, capital requirements and competitive
  set track far more closely with its size than with its state. A community institution and a
  regional one operating on the same street are not peers in any meaningful sense, and comparing
  them produces conclusions that look rigorous and are not. The profile includes eight quarters of
  history for assets, deposits, net loans, return on assets and return on equity, so direction is
  visible rather than only the latest snapshot — a single quarter cannot distinguish a temporary
  swing from a sustained trend. ${model.kind === 'bank'
    ? 'Deposit market share and competitive rank by county are available from the FDIC Summary of Deposits, so concentration is measurable against the actual competitors in each market rather than against a national average. County demographics from the Census American Community Survey and mortgage lending activity from CFPB HMDA filings complete the picture of the markets this bank serves.'
    : 'Member counts, assets per member and employee productivity are benchmarked against credit unions in the same asset tier, which is the comparison that reveals whether a credit union is deepening relationships with existing members or primarily adding new ones.'}</p>

  ${model.stateLink ? `<h2>Other institutions in ${esc(model.stateLink.name)}</h2>
  <p>Every FDIC-insured bank and NCUA-insured credit union headquartered in
  ${esc(model.stateLink.name)} is listed and ranked by total assets on the
  <a href="${esc(model.stateLink.href)}">banks in ${esc(model.stateLink.name)}</a> page, along with
  deposit market share by county. Comparing an institution against others in its own state shows
  local competitive position, while comparing against its asset-range peers nationally shows
  whether its performance is typical for its size — the two questions are different and both are
  worth asking.</p>` : ''}

  <h2>Where this data comes from</h2>
  <p>Every figure on this page traces to a public regulatory filing. ${esc(srcName)} data is free
  to access and free to cite, and it is the same source regulators, analysts and the institutions
  themselves work from. Vault adds no proprietary estimates, modelled values or scores to these
  reported numbers, so what appears here is what the institution told its regulator — where Vault
  does compute something, such as a peer percentile or a per-employee ratio, the inputs behind it
  are shown alongside. Call report data is filed quarterly and published on a lag of several weeks,
  so the most recent quarter available here may trail the current date. Vault is free to use with
  no login or paywall, and the same data is available to AI agents through a public Model Context
  Protocol server at vaultbot.ai/mcp.</p>
</div>
<script>(function(){var e=document.getElementById('seo-prerender');if(e&&e.parentNode)e.parentNode.removeChild(e);})();</script>
<script type="application/ld+json">${JSON.stringify(model.jsonld)}</script>`;

  // index.html has <head> but NO </head> and NO opening <body> tag — the
  // browser auto-closes them. A /<body[^>]*>/ anchor silently no-ops here,
  // which is exactly what it did on the first deploy: meta tags updated,
  // content block never injected. <header> is the first structural element
  // in the document, so inserting before it puts the crawlable block at the
  // top of the body where it belongs. Falls back to </body> if the markup
  // is ever restructured, so this can degrade in position but not vanish.
  if (html.includes('<header>')) {
    html = html.replace('<header>', `${block}\n<header>`);
  } else {
    html = html.replace('</body>', `${block}\n</body>`);
  }

  const headers = new Headers(response.headers);
  // Cache at the CDN so the extra upstream calls are paid once per bank per
  // hour, not on every crawl. Call report data changes quarterly.
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.set('netlify-cdn-cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  return new Response(html, { status: response.status, headers });
};

export const config = {
  path: ['/bank/*', '/cu/*'],
};
