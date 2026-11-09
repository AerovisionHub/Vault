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
let mode = 'ok'; // 'ok' | 'down'
const realFetch = global.fetch;
const calls = [];
global.fetch = async (url, opts) => {
  if (!String(url).includes('/.netlify/functions/ncua')) return realFetch(url, opts);
  const u = new URL(url); calls.push(u.search);
  if (mode === 'down') return new Response('Bad Gateway', { status: 502 });
  const q = u.searchParams.get('q') || '', st = u.searchParams.get('state'), lim = +(u.searchParams.get('limit') || 20);
  const sc = CUS.filter(c => !st || c[3] === st).map(c => [fz(q, c[1]), c]).filter(x => x[0] >= 30)
    .sort((a, b) => b[0] - a[0] || b[1][4] - a[1][4]);
  const results = sc.slice(0, lim).map(([, c]) => ({ id: c[0], name: c[1], city: c[2], state: c[3], assets: c[4], members: 0, type: c[5] }));
  return new Response(JSON.stringify({ results, totalResultCount: sc.length, asOf: '2026-06-30' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
module.exports = { setMode: m => { mode = m; }, calls };
