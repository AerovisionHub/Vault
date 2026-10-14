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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  return cu ? { kind: 'cu', ...cu } : null;
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
      creator: { '@type': 'Organization', name: 'Federal Deposit Insurance Corporation' },
      isAccessibleForFree: true,
      temporalCoverage: l.REPDTE ? String(l.REPDTE) : undefined,
    },
  };

  return { title, desc, h1: b.NAME, lead, detail, where, jsonld, kind: 'bank' };
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
      creator: { '@type': 'Organization', name: 'National Credit Union Administration' },
      isAccessibleForFree: true,
    },
  };

  return { title, desc, h1: c.name, lead, detail, where, jsonld, kind: 'cu' };
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

  const canonical = `${url.origin}${url.pathname}`;
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
  const block = `
<div id="seo-prerender">
  <h1>${esc(model.h1)}</h1>
  <p>${esc(model.lead)}</p>
  ${model.detail ? `<p>${esc(model.detail)}</p>` : ''}
  <p>Vault provides free ${model.kind === 'bank' ? 'FDIC' : 'NCUA'} call report data for ${esc(model.h1)}, including quarterly financials, peer benchmarking against similarly sized institutions, and deposit market share by county. Data is sourced from public ${model.kind === 'bank' ? 'FDIC BankFind' : 'NCUA 5300'} filings and is free to access with no login.</p>
</div>
<script>(function(){var e=document.getElementById('seo-prerender');if(e&&e.parentNode)e.parentNode.removeChild(e);})();</script>
<script type="application/ld+json">${JSON.stringify(model.jsonld)}</script>`;

  html = html.replace(/<body([^>]*)>/, `<body$1>${block}`);

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
