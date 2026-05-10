// MCP Stats endpoint — read-only summary of usage from Netlify Blobs
// Public endpoint — only shows aggregated counts, no PII

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    };
  }

  try {
    // Dynamic import to avoid ESM/CJS conflict at module load time
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('mcp-analytics');
    const list = await store.list({ prefix: '_counters/' });
    const days = list.blobs || [];

    // Fetch all daily counters
    const dayData = await Promise.all(
      days.map(async (b) => {
        try { return await store.get(b.key, { type: 'json' }); }
        catch { return null; }
      })
    );

    const valid = dayData.filter(Boolean).sort((a, b) => (b.day || '').localeCompare(a.day || ''));

    // Aggregate totals
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
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
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
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
