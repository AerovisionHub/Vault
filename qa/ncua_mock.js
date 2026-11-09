// NCUA proxy stand-in for MCP tests (the sandbox can't reach vaultbot.ai or ncua.gov).
// Same synthetic CU pool as qa/search_regression_web.py, scored with a port of
// functions/ncua.js fuzzyScore(query, target). Reproduces ranking pressure, not NCUA data.
const CUS = [
 ['5536','Navy Federal Credit Union','Vienna','VA',180e9], ['24694','America First Federal Credit Union','Riverdale','UT',20e9],
 ['68534','American Airlines Federal Credit Union','Fort Worth','TX',11e9], ['65428','Michigan State University Federal Credit Union','East Lansing','MI',8e9],
 ['19914','Tinker Federal Credit Union','Tinker AFB','OK',6e9], ['60431','American Heritage Federal Credit Union','Philadelphia','PA',5e9],
 ['67712','American Eagle Financial Credit Union','East Hartford','CT',2.3e9], ['61003','Bank-Fund Staff Federal Credit Union','Washington','DC',1.5e9],
 ['66310','American First Credit Union','La Habra','CA',1.2e9], ['7016','Oklahoma Central Credit Union','Tulsa','OK',1.0e9],
 ['24051','Heritage Federal Credit Union','Newburgh','IN',0.9e9], ['2219','Heritage Family Credit Union','Rutland','VT',0.6e9],
 ['5302','Heritage Financial Credit Union','Middletown','NY',0.4e9], ['61010','Heritage Valley Federal Credit Union','York','PA',0.3e9],
 ['9999','Sapulpa Community Credit Union','Sapulpa','OK',0.05e9],
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
  const results = sc.slice(0, lim).map(([, c]) => ({ id: c[0], name: c[1], city: c[2], state: c[3], assets: c[4], members: 0, type: 'FCU' }));
  return new Response(JSON.stringify({ results, totalResultCount: sc.length, asOf: '2026-06-30' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
module.exports = { setMode: m => { mode = m; }, calls };
