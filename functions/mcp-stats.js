// MCP Stats endpoint — read-only summary of usage from Netlify Blobs
// Returns valid empty response if store has no data or fails to load

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }

  const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const EMPTY = {
    all_time: { total_calls: 0, unique_users: 0, total_errors: 0, error_rate: '0%', tool_usage: {}, client_usage: {} },
    daily: [],
    last_updated: new Date().toISOString(),
  };

  try {
    let store;
    try {
      const { getStore } = await import('@netlify/blobs');
      store = getStore({
        name: 'mcp-analytics',
        siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
      });
    } catch (e) {
      console.log('Blobs init failed (returning empty):', e.message);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(EMPTY) };
    }

    let days = [];
    try {
      const list = await store.list({ prefix: '_counters/' });
      days = list.blobs || [];
    } catch (e) {
      console.log('store.list failed (returning empty):', e.message);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(EMPTY) };
    }

    if (!days.length) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(EMPTY) };
    }

    // Fetch each daily counter — skip any that fail
    const dayData = await Promise.all(
      days.map(async (b) => {
        try { return await store.get(b.key, { type: 'json' }); }
        catch { return null; }
      })
    );

    const valid = dayData.filter(Boolean).sort((a, b) => (b.day || '').localeCompare(a.day || ''));

    const totals = {
      total_calls: 0,
      total_unique_users: new Set(),
      total_errors: 0,
      tools: {},
      clients: {},
    };
    valid.forEach(d => {
      totals.total_calls += d.total_calls || 0;
      totals.total_errors += d.errors || 0;
      (d.unique_ips || []).forEach(ip => totals.total_unique_users.add(ip));
      Object.entries(d.by_tool || {}).forEach(([t, n]) => totals.tools[t] = (totals.tools[t] || 0) + n);
      Object.entries(d.by_client || {}).forEach(([c, n]) => totals.clients[c] = (totals.clients[c] || 0) + n);
    });

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        all_time: {
          total_calls: totals.total_calls,
          unique_users: totals.total_unique_users.size,
          total_errors: totals.total_errors,
          error_rate: totals.total_calls > 0 ? `${((totals.total_errors / totals.total_calls) * 100).toFixed(2)}%` : '0%',
          tool_usage: totals.tools,
          client_usage: totals.clients,
        },
        daily: valid.slice(0, 30).map(d => ({
          day: d.day,
          calls: d.total_calls,
          unique_users: (d.unique_ips || []).length,
          errors: d.errors,
          top_tool: Object.entries(d.by_tool || {}).sort((a,b) => b[1]-a[1])[0]?.[0] || null,
          top_client: Object.entries(d.by_client || {}).sort((a,b) => b[1]-a[1])[0]?.[0] || null,
        })),
        last_updated: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('Stats endpoint unexpected error:', e.message);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ...EMPTY, error: e.message }) };
  }
};
