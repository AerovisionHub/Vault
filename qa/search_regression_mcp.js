// MCP search regression: runs search_institutions through the real handler against live FDIC.
// Run from the repo root: node qa/search_regression_mcp.js
// Banks: live FDIC. Credit unions: qa/ncua_mock.js (synthetic pool + the proxy's real scorer).
const ncuaMock = require('./ncua_mock.js');
const { handler } = require('../functions/mcp.js');
const cases = [['American Heritage Bank',4190,1],['American Heritage Oklahoma',4190,1],['American Heritage OK',4190,1],['American Heritage Sapulpa',4190,1],
 ['Heritage Sapulpa',4190,3],['american heritage',4190,3],['First Fidelity Bank',23473,5],['Sutton Bank',5962,5],['MidFirst Bank',4063,5],['Triad Bank',24677,5],
 ['Citizens Bank',17211,5],['Bank of the Plains',18118,5],['Wells Fargo',3511,5],['First National Bank Oklahoma',4211,5],['First National Bank of Oklahoma',4211,1],
 ['JPMorgan Chase',628,5],['Fidelity Bank',30895,5],['Legend Bank',3108,1],['Legend Bank Bowie',3108,1],['Texas Capital Bank',34383,1],['Bank of Oklahoma',4214,1],['bank of oklahoma',4214,1],['Bank of Albuquerque',4214,1],['Chase',628,1],['Chase Manhattan',628,1],['Bank of Texas',4214,3],['Pinnacle Bank TN',35583,1],
 ['Navy Federal','5536',1],['MSUFCU','23279',1],['msufcu','23279',1],['Tinker','19914',1],['American Heritage Credit Union','5621',1],['Navy Federal Credit Union','5536',1],['Heritage Valley Federal Credit Union','61010',1],['Heritage Valley','61010',1],['Oklahoma Central Credit Union','7016',1]];
const call = async (args) => { const r = await handler({ httpMethod:'POST', headers:{'x-vault-source':'qa'}, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name:'search_institutions', arguments: args } }) }, {});
  const j = JSON.parse(r.body); if (j.result?.isError) return { err: j.result.content[0].text }; return JSON.parse(j.result.content[0].text); };
(async () => { let pass = 0;
  for (const [q, cert, top] of cases) { const t = Date.now(); const res = await call({ query: q });
    const list = Array.isArray(res) ? res : (res.results || []); const pos = list.findIndex(r => (typeof cert === 'number' ? r.cert === cert : r.charter_number === cert)) + 1; const ok = pos > 0 && pos <= top; pass += ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${q.padEnd(32)} #${cert} top${top} -> ${pos || 'missing'} (${list.length}) ${Date.now()-t}ms | ${list[0]?.name} [${list[0]?.match_score}]${list[0]?.matched_name ? ' via ' + list[0].matched_name : ''}`);
    await new Promise(r => setTimeout(r, 300)); }
  // Shape checks on a mixed result
  const mix = await call({ query: 'American Heritage' });
  const kinds = [...new Set(mix.map(r => r.type))].join(',');
  const cuRow = mix.find(r => r.type === 'credit_union');
  const shapeOk = kinds.includes('bank') && kinds.includes('credit_union') && cuRow?.charter_number && cuRow.profile_url.includes('/cu/') && cuRow.assets_thousands === 5000000 && !mix.some(r => '_assets' in r);
  console.log(`${shapeOk ? 'PASS' : 'FAIL'} mixed shape: types=[${kinds}] cu=${cuRow?.name} ${cuRow?.profile_url} assets_k=${cuRow?.assets_thousands}`); pass += shapeOk;
  // NCUA down: banks still return, plus an explicit notice (never a silent gap)
  ncuaMock.setMode('down');
  const down = await call({ query: 'American Heritage Bank' });
  const downOk = down[0]?.cert === 4190 && down.some(r => r.type === 'notice' && /credit union/i.test(r.message));
  console.log(`${downOk ? 'PASS' : 'FAIL'} NCUA down: top=${down[0]?.name} notice=${!!down.find(r => r.type === 'notice')}`); pass += downOk;
  ncuaMock.setMode('ok');
  console.log(`\n${pass}/${cases.length + 2}`);
  const s = await call({ query: 'American Heritage', state: 'OK' }); console.log('state arg OK ->', (Array.isArray(s) ? s : []).slice(0,2).map(r => `${r.name} ${r.city} [${r.match_score}]`).join(' ; '));
})();
