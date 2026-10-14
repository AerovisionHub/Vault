// State and county hub pages: /banks-in-oklahoma, /banks-in-tulsa-county-ok
//
// Two jobs, both load-bearing.
//
// 1. Crawl paths. The sitemap lists 8,603 institution URLs, but a sitemap is a
//    hint, not a structure — pages reachable only from a sitemap behave like
//    orphans and are crawled shallowly and ranked poorly. Hubs give every
//    institution an internal link from a topical parent, which is what turns
//    a list of URLs into a site.
//
// 2. Search intent nobody is serving well. "banks in oklahoma", "largest banks
//    in tulsa county" are real recurring queries whose current results are
//    branch locators and directory spam, not the actual deposit and asset data.
//
// Rendered entirely server-side rather than as SPA routes. The whole point is
// content that exists without JavaScript, so routing these through index.html
// would reintroduce the exact problem the institution edge function fixed.

const FDIC_BASE = 'https://banks.data.fdic.gov/api';
const CENSUS_VINTAGE = 2024;

const STATES = {
  AL:['Alabama','01'], AK:['Alaska','02'], AZ:['Arizona','04'], AR:['Arkansas','05'],
  CA:['California','06'], CO:['Colorado','08'], CT:['Connecticut','09'], DE:['Delaware','10'],
  DC:['District of Columbia','11'], FL:['Florida','12'], GA:['Georgia','13'], HI:['Hawaii','15'],
  ID:['Idaho','16'], IL:['Illinois','17'], IN:['Indiana','18'], IA:['Iowa','19'],
  KS:['Kansas','20'], KY:['Kentucky','21'], LA:['Louisiana','22'], ME:['Maine','23'],
  MD:['Maryland','24'], MA:['Massachusetts','25'], MI:['Michigan','26'], MN:['Minnesota','27'],
  MS:['Mississippi','28'], MO:['Missouri','29'], MT:['Montana','30'], NE:['Nebraska','31'],
  NV:['Nevada','32'], NH:['New Hampshire','33'], NJ:['New Jersey','34'], NM:['New Mexico','35'],
  NY:['New York','36'], NC:['North Carolina','37'], ND:['North Dakota','38'], OH:['Ohio','39'],
  OK:['Oklahoma','40'], OR:['Oregon','41'], PA:['Pennsylvania','42'], RI:['Rhode Island','44'],
  SC:['South Carolina','45'], SD:['South Dakota','46'], TN:['Tennessee','47'], TX:['Texas','48'],
  UT:['Utah','49'], VT:['Vermont','50'], VA:['Virginia','51'], WA:['Washington','53'],
  WV:['West Virginia','54'], WI:['Wisconsin','55'], WY:['Wyoming','56'], PR:['Puerto Rico','72'],
};
const NAME_TO_ABBR = Object.fromEntries(Object.entries(STATES).map(([a, [n]]) => [n.toLowerCase().replace(/\s+/g, '-'), a]));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Must stay identical to slugify() in index.html, functions/sitemap.js and
// netlify/edge-functions/institution-seo.js. If these drift, every internal
// link from a hub lands on a non-canonical URL and the crawl path leaks
// equity into redirects.
function slugify(name, city, state) {
  return `${name} ${city || ''} ${state || ''}`.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function fmtUSD(thousands) {
  const v = Number(thousands) * 1000;
  if (!isFinite(v) || v === 0) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}

async function j(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function getStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore({
      name: 'vault-hub-cache',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
  } catch { return null; }
}

function shell({ title, desc, canonical, body, jsonld }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#1a0a5e">
<style>
html{background:#1a0a5e;}
html,body{overscroll-behavior-y:none;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:linear-gradient(135deg,#0f1240 0%,#1a1060 30%,#2d1080 60%,#1a0a5e 100%);
background-attachment:fixed;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
font-size:15px;line-height:1.6;min-height:100vh;padding:0 0 72px;}
.wrap{max-width:1000px;margin:0 auto;padding:24px 20px 60px;}
header{padding:18px 20px;border-bottom:1px solid rgba(255,255,255,0.1);}
.logo{font-family:Georgia,serif;font-size:22px;color:#fff;text-decoration:none;}
.logo span{color:#4db8ff;}
.tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;letter-spacing:1px;color:rgba(255,255,255,0.65);}
h1{font-size:30px;line-height:1.25;margin:18px 0 10px;}
h2{font-size:19px;margin:30px 0 10px;}
p{margin:10px 0;color:rgba(255,255,255,0.85);}
nav.crumbs{font-family:ui-monospace,monospace;font-size:11px;color:rgba(255,255,255,0.6);margin-top:14px;}
nav.crumbs a{color:#4db8ff;}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid rgba(255,255,255,0.1);}
th{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.5px;color:rgba(255,255,255,0.65);text-transform:uppercase;}
td a{color:#4db8ff;text-decoration:none;}
td a:hover{text-decoration:underline;}
.num{text-align:right;font-variant-numeric:tabular-nums;}
.links{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;}
.links a{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:7px;
padding:6px 11px;color:#4db8ff;text-decoration:none;font-size:13px;}
footer{border-top:1px solid rgba(255,255,255,0.1);padding:18px 20px;font-size:12px;color:rgba(255,255,255,0.6);}
footer a{color:#4db8ff;}
@media(max-width:600px){h1{font-size:24px;}table{font-size:13px;}th,td{padding:7px 6px;}}
</style>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
</head>
<body>
<header><a class="logo" href="/">Vault<span>.</span></a><div class="tag">BANK &amp; CREDIT UNION INTELLIGENCE</div></header>
<div class="wrap">${body}</div>
<footer>© 2026 iDENTIFY · Data sourced from <a href="https://www.fdic.gov/">FDIC</a> and <a href="https://www.ncua.gov/">NCUA</a> public filings · <a href="/">Search all institutions</a> · <a href="/mcp">MCP for AI agents</a></footer>
</body>
</html>`;
}

async function buildState(abbr, origin) {
  const [name, fips] = STATES[abbr];
  const banksRaw = await j(`${FDIC_BASE}/institutions?filters=STALP%3A${abbr}%20AND%20ACTIVE%3A1&fields=CERT,NAME,CITY,STALP,ASSET,DEP,OFFDOM&limit=250&sort_by=ASSET&sort_order=DESC`);
  const banks = (banksRaw?.data || []).map(d => d.data).filter(Boolean);
  const total = banksRaw?.meta?.total ?? banks.length;

  const cuRaw = await j(`${origin}/.netlify/functions/ncua?state=${abbr}&limit=200`);
  const cus = (cuRaw?.results || []).sort((a, b) => (b.assets || 0) - (a.assets || 0));

  const totalAssets = banks.reduce((s, b) => s + (Number(b.ASSET) || 0), 0);
  const totalDeps = banks.reduce((s, b) => s + (Number(b.DEP) || 0), 0);

  // Counties the state's banks actually operate in, from the branch file —
  // this is what creates the crawl path down to county hubs.
  const sod = await j(`${FDIC_BASE}/sod?filters=STALPBR%3A${abbr}&fields=CNTYNAMB,STCNTYBR,YEAR&limit=2000&sort_by=YEAR&sort_order=DESC`);
  const sodRows = (sod?.data || []).map(d => d.data).filter(Boolean);
  const latestYr = sodRows.length ? Math.max(...sodRows.map(r => Number(r.YEAR) || 0)) : null;
  const counties = [...new Map(sodRows.filter(r => Number(r.YEAR) === latestYr)
    .map(r => [r.CNTYNAMB, r.CNTYNAMB])).keys()].filter(Boolean).sort();

  const bankRows = banks.slice(0, 100).map((b, i) => `<tr>
<td class="num">${i + 1}</td>
<td><a href="/bank/${esc(slugify(b.NAME, b.CITY, b.STALP))}-${esc(b.CERT)}">${esc(b.NAME)}</a></td>
<td>${esc(b.CITY || '')}</td>
<td class="num">${fmtUSD(b.ASSET)}</td>
<td class="num">${fmtUSD(b.DEP)}</td>
<td class="num">${esc(b.OFFDOM ?? '—')}</td></tr>`).join('');

  const cuRows = cus.slice(0, 50).map((c, i) => `<tr>
<td class="num">${i + 1}</td>
<td><a href="/cu/${esc(slugify(c.name, c.city, c.state))}-${esc(c.id)}">${esc(c.name)}</a></td>
<td>${esc(c.city || '')}</td>
<td class="num">${fmtUSD((c.assets || 0) / 1000)}</td>
<td class="num">${c.members ? Number(c.members).toLocaleString() : '—'}</td></tr>`).join('');

  const countyLinks = counties.map(c =>
    `<a href="/banks-in-${esc(c.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))}-county-${abbr.toLowerCase()}">${esc(c)}</a>`
  ).join('');

  const title = `Banks in ${name} — All ${total} FDIC-Insured Banks Ranked by Assets | Vault`;
  const desc = `Complete list of ${total} FDIC-insured banks headquartered in ${name}, ranked by total assets, with deposits and branch counts. Plus ${cus.length} credit unions. Free, no login.`;

  const body = `
<nav class="crumbs"><a href="/">Vault</a> → Banks in ${esc(name)}</nav>
<h1>Banks in ${esc(name)}</h1>
<p>There are <strong>${total}</strong> FDIC-insured banks headquartered in ${esc(name)}, holding
${fmtUSD(totalAssets)} in combined assets and ${fmtUSD(totalDeps)} in deposits, alongside
${cus.length} NCUA-insured credit unions. Every figure below comes from the most recent quarterly
call report each institution filed with its regulator. Banks are ranked by total assets, which is
the standard measure of institution size and the basis regulators use for peer grouping and for
determining which capital rules apply.</p>

<h2>All FDIC-insured banks headquartered in ${esc(name)}</h2>
<p>Ranked by total assets. Branch counts are domestic offices. Click any institution for eight
quarters of financial history, peer benchmarking against similarly sized banks, deposit market
share by county, and leadership contacts.</p>
<table><thead><tr><th>#</th><th>Bank</th><th>City</th><th class="num">Assets</th><th class="num">Deposits</th><th class="num">Branches</th></tr></thead>
<tbody>${bankRows || '<tr><td colspan="6">No data available.</td></tr>'}</tbody></table>
${total > 100 ? `<p>Showing the 100 largest of ${total} banks. <a href="/">Search Vault</a> for any institution by name.</p>` : ''}

${cuRows ? `<h2>Credit unions in ${esc(name)}</h2>
<p>NCUA-insured credit unions headquartered in ${esc(name)}, ranked by total assets, with member counts from 5300 call report filings.</p>
<table><thead><tr><th>#</th><th>Credit union</th><th>City</th><th class="num">Assets</th><th class="num">Members</th></tr></thead>
<tbody>${cuRows}</tbody></table>` : ''}

${countyLinks ? `<h2>Deposit market share by county in ${esc(name)}</h2>
<p>Deposit market share is measured at the county level from the FDIC Summary of Deposits, an
annual branch-level filing as of each June 30. County data shows which institutions actually hold
balances in a given market and how concentrated that market is — a question state-level totals
cannot answer, because a bank can be small statewide and dominant in its home county.</p>
<div class="links">${countyLinks}</div>` : ''}

<h2>About this data</h2>
<p>Vault republishes public FDIC and NCUA filings without modification. Bank figures come from
quarterly call reports; credit union figures from NCUA 5300 filings; branch and deposit market
share from the FDIC Summary of Deposits. Data is free to access and free to cite, with no login or
paywall. The same data is available to AI agents through a public Model Context Protocol server at
<a href="/mcp">vaultbot.ai/mcp</a>.</p>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Banks in ${name}`,
    description: desc,
    numberOfItems: banks.slice(0, 100).length,
    itemListElement: banks.slice(0, 100).map((b, i) => ({
      '@type': 'ListItem', position: i + 1,
      item: { '@type': 'BankOrCreditUnion', name: b.NAME,
        url: `https://vaultbot.ai/bank/${slugify(b.NAME, b.CITY, b.STALP)}-${b.CERT}`,
        address: { '@type': 'PostalAddress', addressLocality: b.CITY || undefined, addressRegion: abbr, addressCountry: 'US' } },
    })),
  };

  return shell({ title, desc, canonical: `https://vaultbot.ai/banks-in-${name.toLowerCase().replace(/\s+/g, '-')}`, body, jsonld });
}

async function buildCounty(countySlug, abbr) {
  const [stateName] = STATES[abbr];
  const countyGuess = countySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const sod = await j(`${FDIC_BASE}/sod?filters=CNTYNAMB%3A%22${encodeURIComponent(countyGuess)}%22%20AND%20STALPBR%3A${abbr}&fields=CERT,NAMEFULL,CNTYNAMB,STCNTYBR,DEPSUMBR,YEAR&limit=2000&sort_by=YEAR&sort_order=DESC`);
  const rows = (sod?.data || []).map(d => d.data).filter(Boolean);
  if (!rows.length) return null;

  const year = Math.max(...rows.map(r => Number(r.YEAR) || 0));
  const cur = rows.filter(r => Number(r.YEAR) === year);
  const countyName = cur[0].CNTYNAMB;
  // FDIC returns STCNTYBR as a NUMBER, not a string. Beyond the obvious
  // crash on .slice(), the numeric form silently drops the leading zero for
  // states with a FIPS below 10 — Alabama's 01003 arrives as 1003 — so this
  // must be padded back to five digits, not merely coerced.
  const fips = String(cur[0].STCNTYBR ?? '').padStart(5, '0');

  const byCert = new Map();
  for (const r of cur) {
    const k = String(r.CERT);
    const e = byCert.get(k) || { cert: k, name: r.NAMEFULL, dep: 0, br: 0 };
    e.dep += Number(r.DEPSUMBR) || 0; e.br += 1;
    byCert.set(k, e);
  }
  const banks = [...byCert.values()].sort((a, b) => b.dep - a.dep);
  const totalDep = banks.reduce((s, b) => s + b.dep, 0);

  // Census adds the market context no competitor page carries alongside
  // deposit share. Optional — a missing key must not break the page.
  let demo = null;
  const key = (process.env.CENSUS_API_KEY || '').trim();
  if (key && /^[0-9a-f]{40}$/i.test(key) && fips) {
    const d = await j(`https://api.census.gov/data/${CENSUS_VINTAGE}/acs/acs5?get=NAME,B01003_001E,B19113_001E,B25077_001E&for=county:${fips.slice(2)}&in=state:${fips.slice(0, 2)}&key=${key}`);
    if (Array.isArray(d) && d.length > 1) {
      const [h, v] = [d[0], d[1]];
      const o = Object.fromEntries(h.map((k2, i) => [k2, v[i]]));
      const n = (x) => { const num = Number(o[x]); return isFinite(num) && num > -666666666 ? num : null; };
      demo = { pop: n('B01003_001E'), famInc: n('B19113_001E'), home: n('B25077_001E') };
    }
  }

  const rowsHtml = banks.slice(0, 60).map((b, i) => `<tr>
<td class="num">${i + 1}</td>
<td><a href="/bank/${esc(b.cert)}">${esc(b.name)}</a></td>
<td class="num">${fmtUSD(b.dep)}</td>
<td class="num">${totalDep > 0 ? (b.dep / totalDep * 100).toFixed(2) + '%' : '—'}</td>
<td class="num">${b.br}</td></tr>`).join('');

  const top = banks[0];
  const title = `Banks in ${countyName} County, ${abbr} — Deposit Market Share ${year} | Vault`;
  const desc = `${banks.length} banks hold ${fmtUSD(totalDep)} in deposits across ${countyName} County, ${stateName}. Market share rankings from FDIC Summary of Deposits ${year}. Free, no login.`;

  const body = `
<nav class="crumbs"><a href="/">Vault</a> → <a href="/banks-in-${esc(stateName.toLowerCase().replace(/\s+/g, '-'))}">Banks in ${esc(stateName)}</a> → ${esc(countyName)} County</nav>
<h1>Banks in ${esc(countyName)} County, ${esc(abbr)}</h1>
<p><strong>${banks.length}</strong> FDIC-insured banks operate ${cur.length} branches in
${esc(countyName)} County, ${esc(stateName)}, holding <strong>${fmtUSD(totalDep)}</strong> in total
deposits as of the ${year} FDIC Summary of Deposits.
${top ? `${esc(top.name)} leads the market with ${(top.dep / totalDep * 100).toFixed(1)}% share.` : ''}
Deposit market share is the clearest available measure of competitive position in a local market:
it reflects where households and businesses actually keep their money, rather than where
institutions advertise or how many branches they operate.</p>

${demo ? `<h2>${esc(countyName)} County market profile</h2>
<p>Understanding a deposit market requires knowing the market itself. These figures come from the
US Census Bureau American Community Survey ${CENSUS_VINTAGE} five-year estimates. Median family
income is the measure federal regulators use to define low- and moderate-income thresholds under
the Community Reinvestment Act, which is why it is reported here separately from household income.</p>
<table><tbody>
${demo.pop ? `<tr><th scope="row">Population</th><td class="num">${demo.pop.toLocaleString()}</td></tr>` : ''}
${demo.famInc ? `<tr><th scope="row">Median family income</th><td class="num">$${demo.famInc.toLocaleString()}</td></tr>` : ''}
${demo.home ? `<tr><th scope="row">Median home value</th><td class="num">$${demo.home.toLocaleString()}</td></tr>` : ''}
<tr><th scope="row">Banks operating in county</th><td class="num">${banks.length}</td></tr>
<tr><th scope="row">Bank branches</th><td class="num">${cur.length}</td></tr>
</tbody></table>` : ''}

<h2>Deposit market share in ${esc(countyName)} County</h2>
<p>Ranked by deposits held within county borders. A bank's county deposits are the sum across all
of its branches in that county, so an institution with several locations appears once. Figures are
as of June 30, ${year}, the annual reporting date for the FDIC Summary of Deposits.</p>
<table><thead><tr><th>Rank</th><th>Bank</th><th class="num">Deposits</th><th class="num">Share</th><th class="num">Branches</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
${banks.length > 60 ? `<p>Showing the top 60 of ${banks.length} institutions.</p>` : ''}

<h2>About this data</h2>
<p>The FDIC Summary of Deposits is an annual survey of branch office deposits filed by every
FDIC-insured institution as of June 30 each year. It is the authoritative source for local deposit
market share and is the dataset regulators use when assessing competitive effects of bank mergers.
Because it is annual, it reflects a point in time rather than current balances. Vault republishes
it without modification, free to access and free to cite. Available to AI agents at
<a href="/mcp">vaultbot.ai/mcp</a>.</p>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `Deposit market share, ${countyName} County, ${stateName}`,
    description: desc,
    creator: { '@type': 'Organization', name: 'Federal Deposit Insurance Corporation' },
    isAccessibleForFree: true,
    temporalCoverage: String(year),
    spatialCoverage: { '@type': 'Place', name: `${countyName} County, ${stateName}` },
  };

  return shell({ title, desc, canonical: `https://vaultbot.ai/banks-in-${countySlug}-county-${abbr.toLowerCase()}`, body, jsonld });
}

exports.handler = async (event) => {
  const origin = `https://${event.headers.host || 'vaultbot.ai'}`;
  const path = (event.path || '').replace(/^\/+|\/+$/g, '');
  const m = path.match(/^banks-in-(.+)$/);
  if (!m) return { statusCode: 404, headers: { 'Content-Type': 'text/html' }, body: '<h1>Not found</h1>' };

  const slug = m[1].toLowerCase();
  const cacheKey = `hub-${slug}`;
  const store = await getStore();
  if (store) {
    try {
      const c = await store.get(cacheKey, { type: 'json' });
      // 12h: call report data moves quarterly, SOD annually.
      if (c && c._at && Date.now() - c._at < 12 * 3600 * 1000) {
        return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, body: c.html };
      }
    } catch { /* fall through to live build */ }
  }

  let html = null, failure = null;
  const countyMatch = slug.match(/^(.+)-county-([a-z]{2})$/);
  try {
    if (countyMatch && STATES[countyMatch[2].toUpperCase()]) {
      html = await buildCounty(countyMatch[1], countyMatch[2].toUpperCase());
      if (!html) failure = 'buildCounty returned null (no SOD rows matched)';
    } else if (NAME_TO_ABBR[slug]) {
      html = await buildState(NAME_TO_ABBR[slug], origin);
    } else {
      failure = 'slug matched neither a county pattern nor a state name';
    }
  } catch (e) {
    failure = `threw: ${e.message}`;
    console.log('[hub] build failed for', slug, e.stack || e.message);
  }

  // ?debug=1 reports why a hub failed instead of leaving a bare 404 to guess
  // at. Diagnosing this from the outside otherwise means redeploying with
  // log statements and waiting for a build each time.
  if ((event.queryStringParameters || {}).debug === '1') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_event_path: event.path, slug,
        county_match: countyMatch ? { county: countyMatch[1], state: countyMatch[2] } : null,
        state_match: NAME_TO_ABBR[slug] || null,
        built: !!html, failure,
        census_key_present: !!(process.env.CENSUS_API_KEY || '').trim(),
      }),
    };
  }

  if (!html) {
    // A real 404, not a soft one: returning 200 with "not found" text teaches
    // search engines that every malformed hub URL is a valid thin page.
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: shell({
        title: 'Page not found | Vault',
        desc: 'This page could not be found.',
        canonical: `https://vaultbot.ai/${path}`,
        jsonld: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Not found' },
        body: `<h1>Page not found</h1><p>No bank data page exists at this address. <a href="/">Search all US banks and credit unions</a>.</p>`,
      }),
    };
  }

  if (store) store.setJSON(cacheKey, { html, _at: Date.now() }).catch(() => {});
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, body: html };
};
