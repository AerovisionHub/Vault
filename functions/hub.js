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

const FDIC_BASE = 'https://api.fdic.gov/banks';
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
ul.ins{margin:10px 0 10px 20px;color:rgba(255,255,255,0.85);}ul.ins li{margin:6px 0;}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;}
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
  const banksRaw = await j(`${FDIC_BASE}/institutions?filters=STALP%3A%22${abbr}%22%20AND%20ACTIVE%3A1&fields=CERT,NAME,CITY,STALP,ASSET,DEP,OFFDOM&limit=250&sort_by=ASSET&sort_order=DESC`);
  const banks = (banksRaw?.data || []).map(d => d.data).filter(Boolean);
  const total = banksRaw?.meta?.total ?? banks.length;

  const cuRaw = await j(`${origin}/.netlify/functions/ncua?state=${abbr}&limit=200`);
  const cus = (cuRaw?.results || []).sort((a, b) => (b.assets || 0) - (a.assets || 0));

  const totalAssets = banks.reduce((s, b) => s + (Number(b.ASSET) || 0), 0);
  const totalDeps = banks.reduce((s, b) => s + (Number(b.DEP) || 0), 0);

  // Counties the state's banks actually operate in, from the branch file —
  // this is what creates the crawl path down to county hubs.
  const sod = await j(`${FDIC_BASE}/sod?filters=STALPBR%3A%22${abbr}%22&fields=CNTYNAMB,STCNTYBR,YEAR&limit=10000&sort_by=YEAR&sort_order=DESC`);
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

// County links are built by slugifying the FDIC's own CNTYNAMB, so resolve a
// slug back by slugifying the state's real county names and matching — never
// by guessing. Guessing broke every name with punctuation: "st-charles" →
// "St Charles" ≠ "St. Charles"; also Ste. Genevieve, O'Brien, Miami-Dade,
// Prince of Wales-Hyder and Virginia's independent cities (Search Console
// "Not found (404)", 2026-10-26).
function countySlugOf(c) {
  return String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
// Returns { name, fips, year } — the state's latest SOD year comes back with
// the same query, so the county page needs no separate "latest year" probe.
async function resolveCounty(countySlug, abbr) {
  const r = await j(`${FDIC_BASE}/sod?filters=STALPBR%3A%22${abbr}%22&fields=CNTYNAMB,STCNTYBR,YEAR&limit=10000&sort_by=YEAR&sort_order=DESC`);
  const rows = (r?.data || []).map(d => d.data).filter(Boolean);
  const hit = rows.find(x => x.CNTYNAMB && countySlugOf(x.CNTYNAMB) === countySlug);
  if (!hit) return null;
  return { name: hit.CNTYNAMB, fips: String(hit.STCNTYBR ?? '').padStart(5, '0'), year: Number(rows[0].YEAR) || Number(hit.YEAR) };
}

// SOD's CNTYNAMB is the bare name ("Tulsa", "East Baton Rouge", "Alexandria
// (City)"). Appending "County" to everything produced "Alexandria (City)
// County, VA" and "Caddo County" for a Louisiana parish. Census NAME is the
// authority when we have it; this is the fallback.
function placeLabel(cnty, abbr, censusName) {
  if (censusName) return String(censusName).split(',')[0].trim();
  const n = String(cnty || '').trim();
  const city = n.match(/^(.*) \(City\)$/);
  if (city) return abbr === 'VA' && /^(Charles|James)$/.test(city[1]) ? `${city[1]} City County` : `${city[1]} City`;
  if (abbr === 'LA') return `${n} Parish`;
  if (abbr === 'AK' || abbr === 'PR') return n;
  return `${n} County`;
}

const CENSUS_DETAIL = {
  B01003_001E: 'pop', B19013_001E: 'hhInc', B19113_001E: 'famInc', B25077_001E: 'home',
  B25001_001E: 'units', B25003_002E: 'owner', B17001_002E: 'poor',
};
function censusKeyOk() {
  const k = (process.env.CENSUS_API_KEY || '').trim();
  return /^[0-9a-f]{40}$/i.test(k) ? k : null;
}
async function censusRow(base, vars, geo, key) {
  const d = await j(`${base}?get=NAME,${vars.join(',')}&${geo}&key=${key}`, 6000);
  if (!Array.isArray(d) || d.length < 2) return null;
  const o = Object.fromEntries(d[0].map((h, i) => [h, d[1][i]]));
  return o;
}
// Census encodes "not available" as large negative sentinels (-666666666 etc.).
const cnum = (v) => { const n = Number(v); return isFinite(n) && n > -100000000 ? n : null; };

// Same variables the MCP's get_county_demographics uses (verified against the
// live Census variables endpoint there) plus the state median family income
// for context. Optional: no key or a Census outage drops the section only.
async function countyCensus(fips) {
  const key = censusKeyOk();
  if (!key || !/^\d{5}$/.test(fips)) return null;
  const base = `https://api.census.gov/data/${CENSUS_VINTAGE}/acs/acs5`;
  const [c, sub, st] = await Promise.all([
    censusRow(base, Object.keys(CENSUS_DETAIL), `for=county:${fips.slice(2)}&in=state:${fips.slice(0, 2)}`, key),
    censusRow(`${base}/subject`, ['S2301_C04_001E'], `for=county:${fips.slice(2)}&in=state:${fips.slice(0, 2)}`, key),
    censusRow(base, ['B19113_001E'], `for=state:${fips.slice(0, 2)}`, key),
  ]);
  if (!c) return null;
  const out = { name: c.NAME };
  for (const [code, k] of Object.entries(CENSUS_DETAIL)) out[k] = cnum(c[code]);
  out.unemp = sub ? cnum(sub.S2301_C04_001E) : null;
  out.stateFamInc = st ? cnum(st.B19113_001E) : null;
  out.ownerPct = out.owner != null && out.units ? out.owner / out.units * 100 : null;
  out.povPct = out.poor != null && out.pop ? out.poor / out.pop * 100 : null;
  return out;
}

function hhiOf(byCert, total) {
  if (!total) return null;
  let h = 0;
  for (const b of byCert.values()) { const s = b.dep / total * 100; h += s * s; }
  return Math.round(h);
}
function groupYear(rows, yr) {
  const m = new Map();
  for (const r of rows) {
    if (Number(r.YEAR) !== yr) continue;
    const k = String(r.CERT);
    const e = m.get(k) || { cert: k, name: r.NAMEFULL, dep: 0, br: 0 };
    e.dep += Number(r.DEPSUMBR) || 0; e.br += 1;
    m.set(k, e);
  }
  return m;
}
const pctTxt = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}%`;

// Server-rendered bar chart (no JS: it must exist for crawlers and for the
// page's no-script audience). Vault palette.
function trendSvg(trend) {
  if (trend.length < 2) return '';
  const W = 640, H = 230, pad = { l: 8, r: 8, t: 16, b: 34 };
  const max = Math.max(...trend.map(t => t.dep)) || 1;
  const bw = (W - pad.l - pad.r) / trend.length;
  const bars = trend.map((t, i) => {
    const h = Math.max(2, (t.dep / max) * (H - pad.t - pad.b));
    const x = pad.l + i * bw + bw * 0.15, y = H - pad.b - h;
    const last = i === trend.length - 1;
    const lbl = (i === 0 || last || trend.length <= 8 || i % 2 === 0)
      ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="18" fill="rgba(255,255,255,0.7)">${t.year}</text>` : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${last ? '#4db8ff' : 'rgba(77,184,255,0.45)'}"><title>${t.year}: ${fmtUSD(t.dep)}</title></rect>${lbl}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Total deposits by year, ${trend[0].year} to ${trend[trend.length - 1].year}" style="max-width:${W}px;display:block;margin:12px 0;">${bars}</svg>`;
}

async function buildCounty(countySlug, abbr) {
  const [stateName] = STATES[abbr];
  let loc = await resolveCounty(countySlug, abbr);
  if (!loc) {
    // Fallback for a slug the state scan missed: try the title-cased guess.
    const guess = countySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const g = await j(`${FDIC_BASE}/sod?filters=CNTYNAMB%3A%22${encodeURIComponent(guess)}%22%20AND%20STALPBR%3A%22${abbr}%22&fields=CNTYNAMB,STCNTYBR,YEAR&limit=1&sort_by=YEAR&sort_order=DESC`);
    const r = g?.data?.[0]?.data;
    if (!r) return null;
    loc = { name: r.CNTYNAMB, fips: String(r.STCNTYBR ?? '').padStart(5, '0'), year: Number(r.YEAR) };
  }
  const { fips } = loc;
  const fq = `STCNTYBR%3A${Number(fips)}`;

  // Everything below is independent, so it runs in parallel. Only the
  // current-year rows are required; every other block is optional.
  const [agg, rowsRes, census] = await Promise.all([
    j(`${FDIC_BASE}/sod?filters=${fq}&agg_by=YEAR&agg_sum_fields=DEPSUMBR&agg_limit=40&limit=0`),
    j(`${FDIC_BASE}/sod?filters=${fq}%20AND%20(YEAR%3A${loc.year}%20OR%20YEAR%3A${loc.year - 5})&fields=CERT,NAMEFULL,CNTYNAMB,DEPSUMBR,YEAR&limit=10000`),
    countyCensus(fips).catch(() => null),
  ]);
  const rows = (rowsRes?.data || []).map(d => d.data).filter(Boolean);
  // The state scan's latest year can run ahead of a county with no branches
  // that year; fall back to the newest year this county actually has.
  let year = loc.year;
  if (!rows.some(r => Number(r.YEAR) === year)) {
    const ys = (agg?.data || []).map(d => Number(d.data?.YEAR)).filter(Boolean);
    if (!ys.length) return null;
    year = Math.max(...ys);
    const again = await j(`${FDIC_BASE}/sod?filters=${fq}%20AND%20(YEAR%3A${year}%20OR%20YEAR%3A${year - 5})&fields=CERT,NAMEFULL,CNTYNAMB,DEPSUMBR,YEAR&limit=10000`);
    rows.splice(0, rows.length, ...((again?.data || []).map(d => d.data).filter(Boolean)));
  }
  const curMap = groupYear(rows, year);
  if (!curMap.size) return null;
  const prevYear = year - 5;
  const prevMap = groupYear(rows, prevYear);

  const banks = [...curMap.values()].sort((a, b) => b.dep - a.dep);
  const totalDep = banks.reduce((s, b) => s + b.dep, 0);
  const branches = banks.reduce((s, b) => s + b.br, 0);
  const prevBanks = [...prevMap.values()].sort((a, b) => b.dep - a.dep);
  const prevTotal = prevBanks.reduce((s, b) => s + b.dep, 0);
  const prevBranches = prevBanks.reduce((s, b) => s + b.br, 0);

  const place = placeLabel(loc.name, abbr, census?.name);
  const placeFull = `${place}, ${stateName}`;

  // Bank links in the canonical slug form. SOD rows carry no HQ city, and a
  // bare /bank/{cert} link is a canonicalised alternate (Search Console
  // "Alternate page with proper canonical tag") — one batch lookup fixes it.
  const linkCerts = [...new Set([...banks.slice(0, 60).map(b => b.cert)])];
  const instRes = linkCerts.length
    ? await j(`${FDIC_BASE}/institutions?filters=CERT%3A(${linkCerts.join('%20OR%20')})&fields=CERT,NAME,CITY,STALP&limit=${linkCerts.length}`)
    : null;
  const slugByCert = new Map(((instRes?.data) || []).map(d => d.data).filter(Boolean)
    .map(i => [String(i.CERT), `/bank/${slugify(i.NAME, i.CITY, i.STALP)}-${i.CERT}`]));
  const href = (cert) => slugByCert.get(String(cert)) || `/bank/${cert}`;

  // ── Insights (plain English, every one computed from the figures shown) ──
  const trend = (agg?.data || []).map(d => d.data).filter(Boolean)
    .map(t => ({ year: Number(t.YEAR), dep: Number(t.sum_DEPSUMBR) || 0, br: Number(t.count) || 0 }))
    .filter(t => t.year && t.year <= year).sort((a, b) => a.year - b.year).slice(-10);
  const hhi = hhiOf(curMap, totalDep);
  const prevHhi = prevMap.size ? hhiOf(prevMap, prevTotal) : null;
  const insights = [];
  if (prevTotal > 0) {
    const g = (totalDep / prevTotal - 1) * 100;
    const cagr = (Math.pow(totalDep / prevTotal, 1 / 5) - 1) * 100;
    insights.push(`Deposits held in ${esc(place)} branches ${g >= 0 ? 'grew' : 'fell'} ${Math.abs(g).toFixed(1)}% from ${prevYear} to ${year} (${fmtUSD(prevTotal)} → ${fmtUSD(totalDep)}), ${pctTxt(cagr)} a year.`);
  }
  if (prevBranches) {
    insights.push(prevBranches === branches
      ? `The branch count is unchanged at ${branches} since ${prevYear}.`
      : `Bank branches went from ${prevBranches} in ${prevYear} to ${branches} in ${year} (${branches > prevBranches ? '+' : '−'}${Math.abs(branches - prevBranches)}).`);
  }
  if (hhi != null) {
    const lvl = hhi > 1800 ? 'above the 1,800 level the 2023 DOJ/FTC Merger Guidelines treat as highly concentrated'
      : 'below the 1,800 level the 2023 DOJ/FTC Merger Guidelines treat as highly concentrated';
    insights.push(`Market concentration (HHI) is ${hhi.toLocaleString()}, ${lvl}${prevHhi != null ? `; it was ${prevHhi.toLocaleString()} in ${prevYear}` : ''}.`);
  }
  if (prevBanks.length && banks.length) {
    insights.push(prevBanks[0].cert === banks[0].cert
      ? `${esc(banks[0].name)} has held the largest deposit share since at least ${prevYear}.`
      : `The deposit leader changed: ${esc(prevBanks[0].name)} led in ${prevYear}; ${esc(banks[0].name)} leads in ${year}.`);
    const movers = banks.filter(b => prevMap.has(b.cert)).map(b => ({ b, d: b.dep / totalDep * 100 - prevMap.get(b.cert).dep / prevTotal * 100 }));
    movers.sort((a, b) => b.d - a.d);
    if (movers.length >= 2 && movers[0].d >= 0.5) insights.push(`Biggest share gain since ${prevYear}: ${esc(movers[0].b.name)} (${movers[0].d >= 0 ? '+' : '−'}${Math.abs(movers[0].d).toFixed(1)} points).`);
    const lo = movers[movers.length - 1];
    if (movers.length >= 2 && lo.d <= -0.5) insights.push(`Biggest share loss: ${esc(lo.b.name)} (−${Math.abs(lo.d).toFixed(1)} points).`);
    const entrants = banks.filter(b => !prevMap.has(b.cert)).length;
    const exits = prevBanks.filter(b => !curMap.has(b.cert)).length;
    if (entrants || exits) insights.push(`${entrants} bank${entrants === 1 ? '' : 's'} entered the county and ${exits} left or were acquired between ${prevYear} and ${year}.`);
  }
  if (census?.pop && totalDep) {
    insights.push(`That is about $${Math.round(totalDep * 1000 / census.pop).toLocaleString()} in branch deposits per resident (deposits are booked where the branch is, so commuter and business centers run high).`);
  }

  const rowsHtml = banks.slice(0, 60).map((b, i) => {
    const p = prevMap.get(b.cert);
    const chg = p && prevTotal ? (b.dep / totalDep - p.dep / prevTotal) * 100 : null;
    return `<tr>
<td class="num">${i + 1}</td>
<td><a href="${esc(href(b.cert))}">${esc(b.name)}</a></td>
<td class="num">${fmtUSD(b.dep)}</td>
<td class="num">${totalDep > 0 ? (b.dep / totalDep * 100).toFixed(2) + '%' : '—'}</td>
<td class="num">${chg == null ? 'new' : (chg >= 0 ? '+' : '−') + Math.abs(chg).toFixed(1)}</td>
<td class="num">${b.br}</td></tr>`;
  }).join('');

  const trendRows = trend.slice().reverse().map(t => `<tr><td>${t.year}</td><td class="num">${fmtUSD(t.dep)}</td><td class="num">${t.br}</td></tr>`).join('');

  const top = banks[0];
  const title = `Banks in ${place}, ${abbr} — Deposit Market Share ${year} | Vault`;
  const desc = `${banks.length} banks hold ${fmtUSD(totalDep)} in deposits across ${placeFull}${prevTotal ? ` (${pctTxt((totalDep / prevTotal - 1) * 100)} since ${prevYear})` : ''}. Market share, concentration and 10-year trend from the FDIC Summary of Deposits. Free, no login.`;

  const c = census;
  const demoRows = c ? [
    ['Population', c.pop != null ? c.pop.toLocaleString() : null],
    ['Median household income', c.hhInc != null ? `$${c.hhInc.toLocaleString()}` : null],
    ['Median family income', c.famInc != null ? `$${c.famInc.toLocaleString()}${c.stateFamInc ? ` (${Math.round(c.famInc / c.stateFamInc * 100)}% of the ${esc(stateName)} median)` : ''}` : null],
    ['Median home value', c.home != null ? `$${c.home.toLocaleString()}` : null],
    ['Owner-occupied housing', c.ownerPct != null ? `${c.ownerPct.toFixed(1)}%` : null],
    ['Poverty rate', c.povPct != null ? `${c.povPct.toFixed(1)}%` : null],
    ['Unemployment rate', c.unemp != null ? `${c.unemp.toFixed(1)}%` : null],
  ].filter(([, v]) => v).map(([k, v]) => `<tr><th scope="row">${k}</th><td class="num">${v}</td></tr>`).join('') : '';

  const body = `
<nav class="crumbs"><a href="/">Vault</a> → <a href="/banks-in-${esc(stateName.toLowerCase().replace(/\s+/g, '-'))}">Banks in ${esc(stateName)}</a> → ${esc(place)}</nav>
<h1>Banks in ${esc(place)}, ${esc(abbr)}</h1>
<p><strong>${banks.length}</strong> FDIC-insured banks operate ${branches} branches in
${esc(placeFull)}, holding <strong>${fmtUSD(totalDep)}</strong> in total
deposits as of the ${year} FDIC Summary of Deposits.
${top ? `${esc(top.name)} leads the market with ${(top.dep / totalDep * 100).toFixed(1)}% share.` : ''}
Deposit market share is the clearest available measure of competitive position in a local market:
it reflects where households and businesses actually keep their money, rather than where
institutions advertise or how many branches they operate.</p>

${insights.length ? `<h2>Key insights for ${esc(place)}</h2>
<ul class="ins">${insights.map(t => `<li>${t}</li>`).join('')}</ul>` : ''}

${trend.length >= 2 ? `<h2>Deposit trend, ${trend[0].year}–${trend[trend.length - 1].year}</h2>
<p>Total deposits booked at bank branches in ${esc(place)} each June 30, with the number of branches
reporting. Year-to-year swings in small markets often reflect a single large depositor or one bank
re-booking balances between branches, so the multi-year direction says more than any one year.</p>
${trendSvg(trend)}
<div class="tw"><table><thead><tr><th>Year</th><th class="num">Deposits</th><th class="num">Branches</th></tr></thead><tbody>${trendRows}</tbody></table></div>` : ''}

${c && demoRows ? `<h2>${esc(place)} market profile</h2>
<p>Understanding a deposit market requires knowing the market itself. These figures come from the
US Census Bureau American Community Survey ${CENSUS_VINTAGE} five-year estimates. Median family
income is the measure federal regulators use to define low- and moderate-income thresholds under
the Community Reinvestment Act, which is why it is reported here separately from household income.</p>
<div class="tw"><table><tbody>${demoRows}
<tr><th scope="row">Banks operating here</th><td class="num">${banks.length}</td></tr>
<tr><th scope="row">Bank branches</th><td class="num">${branches}</td></tr>
</tbody></table></div>` : ''}

<h2>Deposit market share in ${esc(place)}</h2>
<p>Ranked by deposits held within county borders. A bank's county deposits are the sum across all
of its branches in the county, so an institution with several locations appears once. Figures are
as of June 30, ${year}, the annual reporting date for the FDIC Summary of Deposits. "Change" is the
movement in share, in percentage points, since ${prevYear}.</p>
<div class="tw"><table><thead><tr><th>Rank</th><th>Bank</th><th class="num">Deposits</th><th class="num">Share</th><th class="num">Change</th><th class="num">Branches</th></tr></thead>
<tbody>${rowsHtml}</tbody></table></div>
${banks.length > 60 ? `<p>Showing the top 60 of ${banks.length} institutions.</p>` : ''}

<h2>About this data</h2>
<p>The FDIC Summary of Deposits is an annual survey of branch office deposits filed by every
FDIC-insured institution as of June 30 each year. It is the authoritative source for local deposit
market share and is the dataset regulators use when assessing competitive effects of bank mergers.
Because it is annual, it reflects a point in time rather than current balances. The concentration
index (HHI) is the sum of squared market shares, the same calculation used in merger screening.
Vault republishes the underlying data without modification, free to access and free to cite.
Available to AI agents at <a href="/mcp">vaultbot.ai/mcp</a>.</p>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `Deposit market share, ${placeFull}`,
    description: desc,
    creator: { '@type': 'Organization', name: 'Federal Deposit Insurance Corporation' },
    // FDIC filings are US federal government works and therefore public
    // domain. Google flagged this field as missing site-wide.
    license: 'https://www.usa.gov/government-works',
    isAccessibleForFree: true,
    temporalCoverage: trend.length >= 2 ? `${trend[0].year}/${trend[trend.length - 1].year}` : String(year),
    spatialCoverage: { '@type': 'Place', name: placeFull },
    variableMeasured: ['Deposits by institution', 'Deposit market share', 'Branch count', 'Herfindahl-Hirschman Index'],
  };

  return shell({ title, desc, canonical: `https://vaultbot.ai/banks-in-${countySlug}-county-${abbr.toLowerCase()}`, body, jsonld });
}

exports.handler = async (event) => {
  const origin = `https://${event.headers.host || 'vaultbot.ai'}`;
  const path = (event.path || '').replace(/^\/+|\/+$/g, '');
  const m = path.match(/^banks-in-(.+)$/);
  if (!m) return { statusCode: 404, headers: { 'Content-Type': 'text/html' }, body: '<h1>Not found</h1>' };

  const slug = m[1].toLowerCase();
  // v2 (2026-11-09): county pages gained trend/HHI/insights; bump so the
  // 12h Blobs cache can't keep serving the old thin markup.
  const cacheKey = `hub2-${slug}`;
  const store = await getStore();
  // ?refresh=1 bypasses the cache. Without it a fix to page markup stays
  // invisible for up to 12 hours with no way to force it through — which is
  // precisely what happened when a structured-data fix shipped and the hub
  // kept serving the pre-fix cached HTML. The sitemap function already
  // learned this lesson; the hub had not.
  const refresh = (event.queryStringParameters || {}).refresh === '1';
  if (store && !refresh) {
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
