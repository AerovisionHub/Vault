// Read-only status for the daily self-check (seo-health-background.js).
// Public data only: check names, counts, and URL paths.
exports.handler = async () => {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: 'vault-seo-health', siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN });
    const last = await store.get('last', { type: 'json' });
    if (!last) return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: null, note: 'no run recorded yet' }) };
    const { alert, ...pub } = last;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ...pub, ageMinutes: Math.round((Date.now() - last.at) / 60000), alerting: !!alert }, null, 1) };
  } catch (e) {
    return { statusCode: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};
