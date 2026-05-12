// Diagnostic — try Blobs operations directly and report exact errors
exports.handler = async (event) => {
  const results = [];

  // Step 1: Try the dynamic import
  let getStore;
  try {
    const mod = await import('@netlify/blobs');
    getStore = mod.getStore;
    results.push('✓ Dynamic import succeeded — keys: ' + Object.keys(mod).join(', '));
  } catch (e) {
    results.push('✗ Dynamic import FAILED: ' + e.message);
    return { statusCode: 200, body: results.join('\n\n') };
  }

  // Step 2: Try creating the store
  let store;
  try {
    store = getStore('mcp-analytics');
    results.push('✓ getStore("mcp-analytics") returned: ' + (store ? 'store object' : 'null/undefined'));
  } catch (e) {
    results.push('✗ getStore FAILED: ' + e.message + '\nStack: ' + e.stack);
    return { statusCode: 200, body: results.join('\n\n') };
  }

  // Step 3: Try writing
  try {
    const testKey = 'diag-test-' + Date.now();
    await store.setJSON(testKey, { test: 'hello', ts: new Date().toISOString() });
    results.push('✓ setJSON succeeded with key: ' + testKey);
  } catch (e) {
    results.push('✗ setJSON FAILED: ' + e.message + '\nStack: ' + (e.stack || 'no stack').slice(0, 1500));
  }

  // Step 4: Try reading back
  try {
    const list = await store.list();
    results.push('✓ store.list returned: ' + (list.blobs?.length || 0) + ' blobs');
    if (list.blobs?.length) {
      results.push('First few keys: ' + list.blobs.slice(0, 5).map(b => b.key).join(', '));
    }
  } catch (e) {
    results.push('✗ store.list FAILED: ' + e.message);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
    body: results.join('\n\n'),
  };
};
