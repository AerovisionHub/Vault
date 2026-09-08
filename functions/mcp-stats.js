// MCP Stats endpoint — read-only summary of usage from Netlify Blobs
// Returns valid empty response if store has no data or fails to load

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }

  const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const EMPTY = {
    all_time: { tool_calls: 0, tool_unique_users: 0, tool_error_rate: 'not yet measured', tool_errors: 0, tool_client_usage: {}, handshakes: 0, total_requests: 0, connections_unique_ips: 0, total_calls: 0, unique_users: 0, total_errors: 0, error_rate: '0%', tool_usage: {}, client_usage: {} },
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
      total_requests: 0,
      tool_calls: 0,
      tool_errors: 0,
      tool_error_basis: 0,   // tool calls on days where tool_errors was instrumented
      total_unique_users: new Set(),
      tool_unique_users: new Set(),
      total_errors: 0,
      tools: {},
      clients: {},
      tool_clients: {},
      sources: {},
      tool_calls_external: 0,
      latency: {},
      errors_by_tool: {},
      ip_days: {},        // ip_hash -> count of distinct days it ran a tool
    };

    // Per-day tool_calls is derivable retroactively: by_tool has only ever been
    // written on a tools/call, so its sum IS the real tool-call count for days
    // recorded before tool_calls existed. No history is lost by this change.
    const dayToolCalls = (d) => {
      if (typeof d.tool_calls === 'number') return d.tool_calls;
      return Object.values(d.by_tool || {}).reduce((a, b) => a + b, 0);
    };

    valid.forEach(d => {
      const tc = dayToolCalls(d);
      totals.total_requests += d.total_calls || 0;
      totals.tool_calls += tc;
      totals.total_errors += d.errors || 0;
      if (typeof d.tool_errors === 'number') {
        totals.tool_errors += d.tool_errors;
        totals.tool_error_basis += tc;
      }
      (d.unique_ips || []).forEach(ip => totals.total_unique_users.add(ip));
      (d.tool_unique_ips || []).forEach(ip => totals.tool_unique_users.add(ip));
      Object.entries(d.by_tool || {}).forEach(([t, n]) => totals.tools[t] = (totals.tools[t] || 0) + n);
      Object.entries(d.by_client || {}).forEach(([c, n]) => totals.clients[c] = (totals.clients[c] || 0) + n);
      Object.entries(d.by_client_tools || {}).forEach(([c, n]) => totals.tool_clients[c] = (totals.tool_clients[c] || 0) + n);
      Object.entries(d.by_source || {}).forEach(([k, n]) => totals.sources[k] = (totals.sources[k] || 0) + n);
      Object.entries(d.errors_by_tool || {}).forEach(([k, n]) => totals.errors_by_tool[k] = (totals.errors_by_tool[k] || 0) + n);
      totals.tool_calls_external += d.tool_calls_external || 0;
      Object.entries(d.tool_latency || {}).forEach(([t, l]) => {
        const cur = totals.latency[t] || { n: 0, sum: 0, max: 0 };
        cur.n += l.n || 0; cur.sum += l.sum || 0; cur.max = Math.max(cur.max, l.max || 0);
        totals.latency[t] = cur;
      });
      // Retention: an ip_hash that ran a tool on 2+ distinct days came back.
      (d.tool_unique_ips || []).forEach(ip => { totals.ip_days[ip] = (totals.ip_days[ip] || 0) + 1; });
    });

    const ipDayCounts = Object.values(totals.ip_days);
    const returning_tool_users = ipDayCounts.filter(n => n >= 2).length;
    const latency_ms = Object.fromEntries(
      Object.entries(totals.latency).map(([t, l]) => [t, { avg: l.n ? Math.round(l.sum / l.n) : null, max: l.max, samples: l.n }])
    );

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        all_time: {
          // Headline metric: actual tools/call requests.
          tool_calls: totals.tool_calls,
          tool_unique_users: totals.tool_unique_users.size,
          tool_error_rate: totals.tool_error_basis > 0
            ? `${((totals.tool_errors / totals.tool_error_basis) * 100).toFixed(2)}%`
            : 'not yet measured',
          tool_errors: totals.tool_errors,
          tool_client_usage: totals.tool_clients,

          // Third-party only. Vault's own website and the Wrapped OG-image
          // renderer hit this same endpoint; they're tagged and excluded here.
          tool_calls_external: totals.tool_calls_external,
          by_source: totals.sources,

          // Retention and health.
          returning_tool_users,
          tool_users_seen: ipDayCounts.length,
          latency_ms,
          errors_by_tool: totals.errors_by_tool,

          // Protocol chatter — connections and reconnects, not usage.
          handshakes: Math.max(totals.total_requests - totals.tool_calls, 0),
          total_requests: totals.total_requests,
          connections_unique_ips: totals.total_unique_users.size,

          // Retained for backwards compatibility. total_calls is every JSON-RPC
          // method, NOT tool calls — do not quote it as a usage number.
          total_calls: totals.total_requests,
          unique_users: totals.total_unique_users.size,
          total_errors: totals.total_errors,
          error_rate: totals.total_requests > 0 ? `${((totals.total_errors / totals.total_requests) * 100).toFixed(2)}%` : '0%',
          tool_usage: totals.tools,
          client_usage: totals.clients,
        },
        daily: valid.slice(0, 30).map(d => ({
          day: d.day,
          tool_calls: dayToolCalls(d),
          handshakes: Math.max((d.total_calls || 0) - dayToolCalls(d), 0),
          calls: d.total_calls,
          unique_users: (d.unique_ips || []).length,
          tool_unique_users: (d.tool_unique_ips || []).length,
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
