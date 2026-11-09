// NCUA proxy stand-in for MCP tests (the sandbox can't reach vaultbot.ai or ncua.gov).
// Same synthetic CU pool as qa/search_regression_web.py, scored with a port of
// functions/ncua.js fuzzyScore(query, target). Reproduces ranking pressure, not NCUA data.
const CUS = [ // NCUA-shaped: FOICU drops most charter suffixes, as real data does
 ['5536','NAVY FEDERAL CREDIT UNION','Vienna','VA',180e9,'Federal CU'],
 ['24694','AMERICA FIRST','Riverdale','UT',20e9,'Federal CU'],
 ['68534','AMERICAN AIRLINES','Fort Worth','TX',11e9,'Federal CU'],
 ['23279','MICHIGAN STATE UNIVERSITY','East Lansing','MI',8e9,'Federal CU'],
 ['19914','TINKER','Tinker AFB','OK',6e9,'Federal CU'],
 ['5621','AMERICAN HERITAGE','Philadelphia','PA',5e9,'Federal CU'],
 ['67712','AMERICAN EAGLE FINANCIAL','East Hartford','CT',2.3e9,'State CU'],
 ['61003','BANK-FUND STAFF','Washington','DC',1.5e9,'Federal CU'],
 ['66310','AMERICAN FIRST','La Habra','CA',1.2e9,'State CU'],
 ['7016','OKLAHOMA CENTRAL','Tulsa','OK',1.0e9,'State CU'],
 ['24051','HERITAGE','Newburgh','IN',0.9e9,'Federal CU'],
 ['2219','HERITAGE FAMILY','Rutland','VT',0.6e9,'State CU'],
 ['5302','HERITAGE FINANCIAL','Middletown','NY',0.4e9,'State CU'],
 ['61010','HERITAGE VALLEY','York','PA',0.3e9,'Federal CU'],
 ['9999','SAPULPA COMMUNITY','Sapulpa','OK',0.05e9,'State CU'],
];
function fz(q, t) {
  q = q.toLowerCase(); t = t.toLowerCase();
  if (t === q) return 100; if (t.startsWith(q)) return 90; if (t.includes(q)) return 80;
  const ac = t.split(/\s+/).filter(Boolean).map(w => w[0]).join('');
  if (ac === q) return 85; if (ac.startsWith(q)) return 75;
  const qw = q.split(/\s+/).filter(w => w.length > 1), m = qw.filter(w => t.includes(w));
  if (qw.length && m.length === qw.length) return 70; if (m.length) return 50 + m.length / qw.length * 20;
  let qi = 0; for (const ch of t) if (qi < q.length && ch === q[qi]) qi++;
  return qi === q.length ? 30 + Math.floor(q.length / t.length * 20) : 0;
}
const TRADE_NAMES = { '23279': ['MSUFCU'] };
const INCOMPLETE = new Set(['9999']); // a CU whose 5300 accounts weren't located
let mode = 'ok'; // 'ok' | 'down'
const realFetch = global.fetch;
const calls = [];
global.fetch = async (url, opts) => {
  if (!String(url).includes('/.netlify/functions/ncua')) return realFetch(url, opts);
  const u = new URL(url); calls.push(u.search);
  if (mode === 'down') return new Response('Bad Gateway', { status: 502 });
  const q = u.searchParams.get('q') || '', st = u.searchParams.get('state'), lim = +(u.searchParams.get('limit') || 20);
  // Same matching as functions/ncua.js: name or trade name (-3); a numeric query hoists the exact charter.
  const tn = c => TRADE_NAMES[c[0]] || [];
  const sc = CUS.filter(c => !st || c[3] === st).map(c => [Math.max(fz(q, c[1]), ...tn(c).map(t => fz(q, t) - 3)), c]).filter(x => x[0] >= 30)
    .sort((a, b) => b[0] - a[0] || b[1][4] - a[1][4]);
  if (/^\d+$/.test(q)) { const hit = CUS.find(c => c[0] === q); if (hit) sc.unshift([100, hit]); }
  const results = sc.slice(0, lim).map(([, c]) => ({ id: c[0], name: c[1], city: c[2], state: c[3], assets: c[4], members: 50000, type: c[5],
    tradeNames: tn(c), ...(INCOMPLETE.has(c[0]) ? { loans: null, shares: null, netWorth: null, netWorthRatio: null, netIncomeYtd: null, delinquentLoans: null, allowance: null }
      : { loans: c[4] * 0.7, shares: c[4] * 0.85, netWorth: c[4] * 0.105, netWorthRatio: 10.5, netIncomeYtd: c[4] * 0.004, delinquentLoans: c[4] * 0.7 * 0.006, allowance: c[4] * 0.7 * 0.012 }),
    asOf: '2026-06-30' }));
  return new Response(JSON.stringify({ results, totalResultCount: sc.length, asOf: '2026-06-30', accountSources: { ACCT_018: 'FS220.txt', ACCT_025B: 'FS220A.txt' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
module.exports = { setMode: m => { mode = m; }, calls };
