// Diagnostic v2 — try with explicit siteID + token
exports.handler = async (event) => {
  const results = [];

  // Step 0: Check env vars
  results.push('NETLIFY_SITE_ID set: ' + !!process.env.NETLIFY_SITE_ID);
  results.push('NETLIFY_BLOBS_TOKEN set: ' + !!process.env.NETLIFY_BLOBS_TOKEN);
  if (process.env.NETLIFY_SITE_ID) results.push('  Site ID value: ' + process.env.NETLIFY_SITE_ID);
  if (process.env.NETLIFY_BLOBS_TOKEN) results.push('  Token starts with: ' + process.env.NETLIFY_BLOBS_TOKEN.slice(0,7) + '... (length: ' + process.env.NETLIFY_BLOBS_TOKEN.length + ')');

  // Step 1: import
  let getStore;
  try {
    const mod = await import('@netlify/blobs');
    getStore = mod.getStore;
    results.push('✓ Dynamic import succeeded');
  } catch (e) {
    results.push('✗ Import failed: ' + e.message);
    return { statusCode: 200, body: results.join('\n') };
  }

  // Step 2: try explicit auth
  let store;
  try {
    store = getStore({
      name: 'mcp-analytics',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    results.push('✓ getStore with explicit auth returned store object');
  } catch (e) {
    results.push('✗ getStore FAILED: ' + e.message);
    results.push('Stack: ' + (e.stack || '').slice(0, 1500));
    return { statusCode: 200, body: results.join('\n\n') };
  }

  // Step 3: try writing
  try {
    const testKey = 'diag-' + Date.now();
    await store.setJSON(testKey, { test: 'hello', ts: new Date().toISOString() });
    results.push('✓ setJSON SUCCEEDED with key: ' + testKey);
  } catch (e) {
    results.push('✗ setJSON FAILED: ' + e.message);
    results.push('Stack: ' + (e.stack || '').slice(0, 1500));
  }

  // Step 4: list
  try {
    const list = await store.list();
    results.push('✓ store.list returned ' + (list.blobs?.length || 0) + ' blobs');
    if (list.blobs?.length) {
      results.push('Keys: ' + list.blobs.slice(0, 10).map(b => b.key).join(', '));
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
