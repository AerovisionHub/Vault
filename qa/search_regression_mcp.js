// MCP search regression: runs search_institutions through the real handler against live FDIC.
// Run from the repo root: node qa/search_regression_mcp.js
const { handler } = require('../functions/mcp.js');
const cases = [['American Heritage Bank',4190,1],['American Heritage Oklahoma',4190,1],['American Heritage OK',4190,1],['American Heritage Sapulpa',4190,1],
 ['Heritage Sapulpa',4190,3],['american heritage',4190,3],['First Fidelity Bank',23473,5],['Sutton Bank',5962,5],['MidFirst Bank',4063,5],['Triad Bank',24677,5],
 ['Citizens Bank',17211,5],['Bank of the Plains',18118,5],['Wells Fargo',3511,5],['First National Bank Oklahoma',4211,5],['First National Bank of Oklahoma',4211,1],
 ['JPMorgan Chase',628,5],['Fidelity Bank',30895,5],['Legend Bank',3108,1],['Legend Bank Bowie',3108,1],['Texas Capital Bank',34383,1],['Pinnacle Bank TN',35583,1]];
const call = async (args) => { const r = await handler({ httpMethod:'POST', headers:{'x-vault-source':'qa'}, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name:'search_institutions', arguments: args } }) }, {});
  const j = JSON.parse(r.body); if (j.result?.isError) return { err: j.result.content[0].text }; return JSON.parse(j.result.content[0].text); };
(async () => { let pass = 0;
  for (const [q, cert, top] of cases) { const t = Date.now(); const res = await call({ query: q });
    const list = Array.isArray(res) ? res : (res.results || []); const pos = list.findIndex(r => r.cert === cert) + 1; const ok = pos > 0 && pos <= top; pass += ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${q.padEnd(32)} #${cert} top${top} -> ${pos || 'missing'} (${list.length}) ${Date.now()-t}ms | ${list[0]?.name} [${list[0]?.match_score}]${list[0]?.matched_name ? ' via ' + list[0].matched_name : ''}`);
    await new Promise(r => setTimeout(r, 300)); }
  console.log(`\n${pass}/${cases.length}`);
  const s = await call({ query: 'American Heritage', state: 'OK' }); console.log('state arg OK ->', (Array.isArray(s) ? s : []).slice(0,2).map(r => `${r.name} ${r.city} [${r.match_score}]`).join(' ; '));
})();
