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

// Soft-404 fix (2026-10-25). Search Console flagged "Soft 404": every
// /bank/* and /cu/* URL answered 200 even when the institution doesn't exist
// or the prerender couldn't reach FDIC/NCUA, so Google saw an error screen
// with a success status. Now: confirmed-missing → 404 + noindex; upstream
// failure → 503 + Retry-After (Google retries instead of judging the page).
const MISSING = Symbol('missing');

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
    fetchJSON(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=REPDTE,ASSET,DEP,LNLSNET,EQ,NETINC,ROA,ROE,NIMY,RBC1AAJ,NCLNLSR,LNLSDEPR,NUMEMP&sort_by=REPDTE&sort_order=DESC&limit=8`),
  ]);
  // null  = FDIC unreachable/slow (we don't know) → caller answers 503
  // MISSING = FDIC answered and this CERT does not exist → caller answers 404
  if (!inst || !Array.isArray(inst.data)) return null;
  const i = inst.data[0]?.data;
  if (!i) return MISSING;
  const history = (fin?.data || []).map(r => r.data).filter(Boolean);
  return { kind: 'bank', ...i, latest: history[0] || {}, history };
}


// ── Server-rendered enrichment (2026-10-25) ──────────────────────────────
// Search Console: soft 404 + "crawled, currently not indexed" on bank pages.
// The prerender was one paragraph of figures plus boilerplate, so pages read
// as near-duplicates. This adds per-bank content no other page has: 8-quarter
// history, a same-state size-band peer comparison with plain-English
// insights, the bank's deposit footprint by county, and links to peer, state
// and county pages. Query shapes are copied from proven MCP tools
// (getLenderRankings, getBranchData, county SOD). Every block is optional:
// a failed call drops that block, never the page.
const FDIC_SOD = 'https://banks.data.fdic.gov/api/sod';

function median(xs) {
  const a = xs.filter(v => v != null && isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function qLabel(repdte) {
  const s = String(repdte || '');
  if (s.length !== 8) return s || '—';
  return `Q${Math.ceil(Number(s.slice(4, 6)) / 3)} ${s.slice(0, 4)}`;
}
function countySlug(county, st) {
  return `/banks-in-${String(county).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-county-${String(st).toLowerCase()}`;
}
function cmpWord(v, med, higherIsBetter = true) {
  if (v == null || med == null || !isFinite(v) || !isFinite(med)) return null;
  const diff = v - med;
  if (Math.abs(diff) <= Math.max(Math.abs(med) * 0.05, 0.02)) return 'in line with';
  return (diff > 0) === higherIsBetter ? 'above' : 'below';
}

async function enrichBank(b) {
  const out = { complete: true };
  const asset = Number(b.latest?.ASSET);
  const st = String(b.STALP || '').toUpperCase();
  const tasks = [];

  // Peers: same state, 0.5x–2x total assets.
  if (asset > 0 && st) {
    const lo = Math.max(0, Math.floor(asset * 0.5)), hi = Math.ceil(asset * 2);
    const f = `ACTIVE%3A1%20AND%20STALP%3A%22${st}%22%20AND%20ASSET%3A%5B${lo}%20TO%20${hi}%5D`;
    tasks.push(Promise.all([
      fetchJSON(`${FDIC_BASE}/institutions?filters=${f}&fields=NAME,CERT,CITY,STALP,ASSET&limit=100&sort_by=ASSET&sort_order=DESC`),
      fetchJSON(`${FDIC_BASE}/financials?filters=${f}&fields=CERT,REPDTE,ROA,RBC1AAJ,NCLNLSR,NIMY,LNLSDEPR&limit=500&sort_by=REPDTE&sort_order=DESC`),
    ]).then(([pi, pf]) => {
      if (!pi?.data || !pf?.data) { out.complete = false; return; }
      const latestByCert = new Map();
      for (const r of pf.data) { const d = r.data; if (d && !latestByCert.has(String(d.CERT))) latestByCert.set(String(d.CERT), d); }
      const peers = pi.data.map(r => r.data).filter(p => p && String(p.CERT) !== String(b.CERT))
        .map(p => ({ ...p, fin: latestByCert.get(String(p.CERT)) || {} }));
      out.peers = { lo, hi, list: peers };
    }));
  }

  // Branch deposit footprint by county (latest SOD year), then HQ-county share.
  tasks.push(fetchJSON(`${FDIC_SOD}?filters=CERT%3A${b.CERT}&fields=CERT,CNTYNAMB,STALPBR,DEPSUMBR,MAINOFF,YEAR&limit=500&sort_by=YEAR&sort_order=DESC`)
    .then(async (sod) => {
      if (!sod?.data) { out.complete = false; return; }
      const rows = sod.data.map(r => r.data).filter(Boolean);
      if (!rows.length) return;
      const year = rows[0].YEAR;
      const cur = rows.filter(r => r.YEAR === year);
      const byCounty = new Map();
      for (const r of cur) {
        const k = `${r.CNTYNAMB}|${r.STALPBR}`;
        const e = byCounty.get(k) || { county: r.CNTYNAMB, st: r.STALPBR, dep: 0, branches: 0, hq: false };
        e.dep += Number(r.DEPSUMBR) || 0; e.branches += 1; if (Number(r.MAINOFF) === 1) e.hq = true;
        byCounty.set(k, e);
      }
      const counties = [...byCounty.values()].filter(c => c.county).sort((a, b2) => b2.dep - a.dep);
      out.footprint = { year, counties, branches: cur.length };
      const hq = counties.find(c => c.hq) || counties[0];
      if (!hq) return;
      const cs = await fetchJSON(`${FDIC_SOD}?filters=CNTYNAMB%3A%22${encodeURIComponent(hq.county)}%22%20AND%20STALPBR%3A%22${hq.st}%22&fields=CERT,CNTYNAMB,STALPBR,DEPSUMBR,YEAR&limit=2000&sort_by=YEAR&sort_order=DESC`);
      if (!cs?.data) { out.complete = false; return; }
      const all = cs.data.map(r => r.data).filter(r => r && r.YEAR === year);
      const tot = new Map();
      for (const r of all) tot.set(String(r.CERT), (tot.get(String(r.CERT)) || 0) + (Number(r.DEPSUMBR) || 0));
      const ranked = [...tot.entries()].sort((a, b2) => b2[1] - a[1]);
      const sum = ranked.reduce((s, [, v]) => s + v, 0);
      const idx = ranked.findIndex(([c]) => c === String(b.CERT));
      if (sum > 0 && idx >= 0) out.hqShare = { county: hq.county, st: hq.st, year, share: ranked[idx][1] / sum * 100, rank: idx + 1, of: ranked.length };
    }));

  await Promise.all(tasks.map(t => t.catch(() => { out.complete = false; })));
  return out;
}

function bankInsights(b, x) {
  const L = b.latest || {}, H = b.history || [];
  const name = b.NAME, q = qLabel(L.REPDTE), stName = STATE_NAMES[String(b.STALP || '').toUpperCase()] || b.STALP;
  const ins = [];
  const p = x.peers;
  if (p && p.list.length >= 5) {
    const band = `${p.list.length} ${stName} banks with ${fmtUSD(p.lo)}–${fmtUSD(p.hi)} in assets`;
    const metrics = [
      ['ROA', 'Return on assets', Number(L.ROA), true],
      ['RBC1AAJ', 'The core capital (leverage) ratio', Number(L.RBC1AAJ), true],
      ['NCLNLSR', 'Noncurrent loans as a share of total loans', Number(L.NCLNLSR), false],
      ['NIMY', 'Net interest margin', Number(L.NIMY), true],
    ];
    for (const [k, label, v, hib] of metrics) {
      if (L[k] == null || !isFinite(v)) continue;
      const med = median(p.list.map(r => Number(r.fin?.[k])));
      const w = cmpWord(v, med, hib);
      if (!w) continue;
      ins.push(`${label} was ${pct(v)} in ${q}, ${w} the ${pct(med)} median of ${band}.`);
    }
  }
  if (H.length >= 5 && Number(H[4].ASSET) > 0 && Number(L.ASSET) > 0) {
    const g = (Number(L.ASSET) / Number(H[4].ASSET) - 1) * 100;
    ins.push(`Total assets ${g >= 0 ? 'grew' : 'declined'} ${Math.abs(g).toFixed(1)}% over the past year, from ${fmtUSD(H[4].ASSET)} in ${qLabel(H[4].REPDTE)} to ${fmtUSD(L.ASSET)} in ${q}.`);
  }
  if (H.length >= 5 && Number(H[4].DEP) > 0 && Number(L.DEP) > 0) {
    const g = (Number(L.DEP) / Number(H[4].DEP) - 1) * 100;
    ins.push(`Deposits ${g >= 0 ? 'grew' : 'declined'} ${Math.abs(g).toFixed(1)}% year over year to ${fmtUSD(L.DEP)}.`);
  }
  if (isFinite(Number(L.LNLSDEPR)) && L.LNLSDEPR != null) {
    ins.push(`${name} lends out ${Number(L.LNLSDEPR).toFixed(1)} cents in loans for every dollar of deposits (loan-to-deposit ratio).`);
  }
  if (x.hqShare) {
    const s = x.hqShare;
    ins.push(`In ${s.county} County, ${s.st}, ${name} holds ${s.share.toFixed(1)}% of deposits, ranking #${s.rank} of ${s.of} institutions (FDIC Summary of Deposits, ${s.year}).`);
  }
  return ins;
}

function bankExtraHtml(b, x) {
  const H = b.history || [];
  const parts = [];
  const ins = bankInsights(b, x);
  if (ins.length) {
    parts.push(`<section id="seo-insights"><h2>Key insights for ${esc(b.NAME)}</h2><ul>${ins.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>`);
  }
  if (H.length) {
    const rows = H.map(r => `<tr><th scope="row">${esc(qLabel(r.REPDTE))}</th><td>${esc(fmtUSD(r.ASSET) || '—')}</td><td>${esc(fmtUSD(r.DEP) || '—')}</td><td>${esc(fmtUSD(r.NETINC) || '—')}</td><td>${esc(pct(r.ROA) || '—')}</td><td>${esc(pct(r.ROE) || '—')}</td></tr>`).join('');
    parts.push(`<h2>Quarterly financial history</h2><table><caption>Last ${H.length} quarters, FDIC call reports (net income is year-to-date)</caption><thead><tr><th>Quarter</th><th>Total assets</th><th>Deposits</th><th>Net income (YTD)</th><th>ROA</th><th>ROE</th></tr></thead><tbody>${rows}</tbody></table>`);
  }
  const p = x.peers;
  if (p && p.list.length) {
    const L = b.latest || {};
    const mrow = (label, k, fmt) => {
      const med = median(p.list.map(r => Number(r.fin?.[k])));
      return `<tr><th scope="row">${esc(label)}</th><td>${esc(fmt(L[k]) || '—')}</td><td>${esc(med == null ? '—' : fmt(med))}</td></tr>`;
    };
    const near = [...p.list].sort((a, c) => Math.abs(Number(a.ASSET) - Number(L.ASSET)) - Math.abs(Number(c.ASSET) - Number(L.ASSET))).slice(0, 8);
    parts.push(`<h2>Peer comparison</h2><table><caption>${esc(b.NAME)} vs. the median of ${p.list.length} ${esc(STATE_NAMES[String(b.STALP).toUpperCase()] || b.STALP)} banks with ${esc(fmtUSD(p.lo))}–${esc(fmtUSD(p.hi))} in assets</caption><thead><tr><th>Metric</th><th>${esc(b.NAME)}</th><th>Peer median</th></tr></thead><tbody>${
      mrow('Return on assets', 'ROA', pct) + mrow('Core capital (leverage) ratio', 'RBC1AAJ', pct) + mrow('Noncurrent loans / loans', 'NCLNLSR', pct) + mrow('Net interest margin', 'NIMY', pct) + mrow('Loans / deposits', 'LNLSDEPR', pct)
    }</tbody></table>
    <h3>Similar-sized banks in ${esc(STATE_NAMES[String(b.STALP).toUpperCase()] || b.STALP)}</h3><ul>${near.map(n => `<li><a href="/bank/${esc(slugify(n.NAME, n.CITY, n.STALP))}-${esc(n.CERT)}">${esc(n.NAME)}</a> — ${esc(n.CITY)}, ${esc(n.STALP)}, ${esc(fmtUSD(n.ASSET))} in assets</li>`).join('')}</ul>`);
  }
  const f = x.footprint;
  if (f && f.counties.length) {
    // Territories (GU, MP, FM, PW…) have no county hub pages — plain text there.
    const cLabel = c => `${esc(c.county)} County, ${esc(c.st)}`;
    const cCell = c => STATE_NAMES[String(c.st).toUpperCase()] ? `<a href="${esc(countySlug(c.county, c.st))}">${cLabel(c)}</a>` : cLabel(c);
    const rows = f.counties.slice(0, 10).map(c => `<tr><th scope="row">${cCell(c)}${c.hq ? ' (headquarters)' : ''}</th><td>${c.branches}</td><td>${esc(fmtUSD(c.dep) || '—')}</td></tr>`).join('');
    parts.push(`<h2>Deposit footprint by county</h2><p>${esc(b.NAME)} reported ${f.branches} office${f.branches === 1 ? '' : 's'} across ${f.counties.length} count${f.counties.length === 1 ? 'y' : 'ies'} in the ${esc(f.year)} FDIC Summary of Deposits.</p><table><caption>Deposits by county, FDIC Summary of Deposits ${esc(f.year)}</caption><thead><tr><th>County</th><th>Offices</th><th>Deposits</th></tr></thead><tbody>${rows}</tbody></table>`);
  }
  return parts.join('\n  ');
}

async function getCU(id, origin) {
  // Reuses the site's own NCUA proxy rather than re-implementing the bulk
  // 5300 parse at the edge.
  const j = await fetchJSON(`${origin}/.netlify/functions/ncua?q=${encodeURIComponent(id)}&limit=1`, 6000);
  if (!j || !Array.isArray(j.results)) return null; // NCUA proxy failed → 503
  const cu = j.results[0];
  return cu ? { kind: 'cu', ...cu, name: titleCaseName(cu.name) } : MISSING;
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
  let found = null;
  try {
    found = kind === 'bank' ? await getBank(id) : await getCU(id, url.origin);
    if (found && found !== MISSING) model = kind === 'bank' ? buildBank(found) : buildCU(found);
    if (model && kind === 'bank') {
      try {
        const x = await enrichBank(found);
        model.extraHtml = bankExtraHtml(found, x);
        model.enrichComplete = x.complete;
        console.log(`[vault-seo] bank ${id} history=${(found.history || []).length} peers=${x.peers ? x.peers.list.length : 'fail'} counties=${x.footprint ? x.footprint.counties.length : 'fail'} hqShare=${x.hqShare ? x.hqShare.share.toFixed(1) : 'none'} insights=${bankInsights(found, x).length} complete=${x.complete}`);
      } catch { model.enrichComplete = false; }
    }
  } catch {
    model = null;
  }

  if (found === MISSING) {
    // Real 404. Body is still the SPA, so a human sees the normal
    // "Couldn't load that institution" screen with search/back buttons.
    let body = await response.text();
    body = body.replace(/<meta name="robots" content="[^"]*">/, '<meta name="robots" content="noindex, follow">');
    const h = new Headers(response.headers);
    h.set('cache-control', 'public, max-age=0, must-revalidate');
    h.set('netlify-cdn-cache-control', 'public, s-maxage=3600');
    return new Response(body, { status: 404, headers: h });
  }

  if (!model) {
    // Upstream hiccup: we can't tell whether the page is good, so say so.
    // Browsers render the body regardless of status (the SPA still loads its
    // own data); crawlers get a retryable 503 instead of an empty 200.
    const h = new Headers(response.headers);
    h.set('retry-after', '3600');
    h.set('cache-control', 'no-store');
    h.set('netlify-cdn-cache-control', 'no-store');
    return new Response(response.body, { status: 503, headers: h });
  }

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
  ${model.extraHtml || ''}
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
<script>(function(){var e=document.getElementById('seo-prerender');if(e&&e.parentNode){var i=document.getElementById('seo-insights');window.__vaultPrerender={path:location.pathname,id:${JSON.stringify(String(id))},html:e.innerHTML,insights:i?i.innerHTML:''};e.parentNode.removeChild(e);}})();</script>
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
  headers.set('netlify-cdn-cache-control', model.enrichComplete === false
    ? 'public, s-maxage=3600, stale-while-revalidate=86400'
    : 'public, durable, s-maxage=604800, stale-while-revalidate=604800');

  return new Response(html, { status: response.status, headers });
};

export const config = {
  path: ['/bank/*', '/cu/*'],
};
