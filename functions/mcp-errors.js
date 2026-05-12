// Diagnostic endpoint — surface recent MCP errors with full detail
exports.handler = async (event) => {
  const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({
      name: 'mcp-analytics',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    const today = new Date().toISOString().slice(0, 10);
    const list = await store.list({ prefix: today + '/' });
    const blobs = list.blobs || [];

    const calls = await Promise.all(
      blobs.map(async b => {
        try { return await store.get(b.key, { type: 'json' }); }
        catch { return null; }
      })
    );

    const valid = calls.filter(Boolean);
    const errors = valid.filter(c => c.success === false);
    const succeeded = valid.filter(c => c.success !== false);

    // Group errors by tool and message
    const errorPatterns = {};
    errors.forEach(e => {
      const key = `${e.tool || e.method || 'unknown'} :: ${e.error || 'no message'}`;
      if (!errorPatterns[key]) errorPatterns[key] = { count: 0, examples: [] };
      errorPatterns[key].count += 1;
      if (errorPatterns[key].examples.length < 3) {
        errorPatterns[key].examples.push({
          time: e.timestamp,
          client: e.client,
          duration: e.duration_ms,
        });
      }
    });

    // Sort by count
    const sortedPatterns = Object.entries(errorPatterns)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([pattern, data]) => ({ pattern, ...data }));

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        summary: {
          total: valid.length,
          succeeded: succeeded.length,
          errors: errors.length,
          error_rate: valid.length ? `${(errors.length / valid.length * 100).toFixed(1)}%` : '0%',
        },
        error_patterns: sortedPatterns,
        recent_errors: errors.slice(-10).reverse().map(e => ({
          time: e.timestamp,
          method: e.method,
          tool: e.tool,
          client: e.client,
          error: e.error,
        })),
      }, null, 2),
    };
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
