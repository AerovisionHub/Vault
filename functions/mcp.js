// Vault MCP Server v1.1 — banking intelligence for AI agents with usage analytics
// Implements MCP (Model Context Protocol) over HTTP using JSON-RPC 2.0
// Spec: https://modelcontextprotocol.io/

const FDIC_BASE = 'https://banks.data.fdic.gov/api';

// ── Tool Definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_institutions',
    description: 'Search FDIC-insured banks and savings institutions by name, city, or fuzzy match. Returns up to 20 institutions ranked by relevance and asset size. Use this when a user asks about a specific bank or wants to find banks matching certain criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Bank name, city, or partial name (e.g. "First Fidelity Bank", "Sutton Bank", "Tulsa")' },
        state: { type: 'string', description: 'Optional 2-letter state code to filter (e.g. "OK", "TX")' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_bank_profile',
    description: 'Get detailed profile for a single FDIC-insured bank by certificate number (CERT). Returns institution details, latest financials (assets, deposits, ROA, ROE, NIM, capital ratio), and 8 quarters of historical data.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (e.g. "23473" for First Fidelity Bank)' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_industry_metrics',
    description: 'Get aggregate banking industry metrics — total banks, total assets, average ROA/ROE/NIM, problem banks count, and historical trends. Use for industry-level analysis questions.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Year to fetch (default: most recent available)' },
      },
    },
  },
  {
    name: 'get_recent_charters',
    description: 'List newly chartered FDIC-insured banks (de novo banks). Returns bank name, location, charter date, charter agent, asset size, and holding company.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Year to filter by (e.g. 2025, 2024, 2023). Omit for all years 2023+.' },
      },
    },
  },
  {
    name: 'get_ma_activity',
    description: 'List recent bank mergers, acquisitions, and failures from FDIC regulatory filings. Returns acquirer, acquired institution, effective date, and transaction type (merger vs assisted/failure).',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Year to filter by. Omit for all years 2023+.' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
    },
  },
  {
    name: 'get_lender_rankings',
    description: 'Get banks ranked by composite Lending Score (loan concentration + capital strength + asset quality + ROA). Filter by state, city, or asset size tier. Use for "find a lender" or "best banks for X loans" questions.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Optional 2-letter state code' },
        city: { type: 'string', description: 'Optional city name (partial match)' },
        loan_type: { type: 'string', enum: ['residential','commercial','smallbiz','consumer'], description: 'Loan focus (default: residential)' },
        asset_size: { type: 'string', enum: ['community','regional','large','all'], description: 'Asset size tier (default: community = under $1B)' },
        limit: { type: 'number', description: 'Max results (default 25, max 100)' },
      },
    },
  },
];

// ── Analytics Layer ──────────────────────────────────────────────────────────
// Stores per-call telemetry in Netlify Blobs for the dashboard.
// Privacy: we hash the IP, never store full IP; we capture client name from MCP handshake but no other PII.
const crypto = require('crypto');

function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256').update(ip + 'vault-salt').digest('hex').slice(0, 12);
}

async function logCall(event, { method, toolName, clientName, durationMs, success, errorMsg }) {
  try {
    // Dynamic import — never crashes top-level handler, gracefully fails if module is broken
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({
      name: 'mcp-analytics',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
    const ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
               event.headers?.['client-ip'] || 'unknown';
    const userAgent = event.headers?.['user-agent'] || 'unknown';
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);  // YYYY-MM-DD
    const callId = `${dayKey}/${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

    await store.setJSON(callId, {
      timestamp: now.toISOString(),
      method: method || null,
      tool: toolName || null,
      client: clientName || 'unknown',
      ip_hash: hashIP(ip),
      user_agent: userAgent.slice(0, 200),
      duration_ms: durationMs || null,
      success: success !== false,
      error: errorMsg || null,
    });

    // Also bump aggregate counters per day for fast dashboard queries
    const counterKey = `_counters/${dayKey}`;
    const existing = await store.get(counterKey, { type: 'json' }).catch(() => null) || {
      day: dayKey, total_calls: 0, unique_ips: [], by_tool: {}, by_client: {}, errors: 0
    };
    existing.total_calls += 1;
    if (!existing.unique_ips.includes(hashIP(ip))) existing.unique_ips.push(hashIP(ip));
    if (toolName) existing.by_tool[toolName] = (existing.by_tool[toolName] || 0) + 1;
    if (clientName) existing.by_client[clientName] = (existing.by_client[clientName] || 0) + 1;
    if (success === false) existing.errors += 1;
    await store.setJSON(counterKey, existing);
  } catch (e) {
    console.error('Analytics log failed (non-fatal):', e.message);
  }
}

// ── Tool Implementations ─────────────────────────────────────────────────────
async function searchInstitutions(args) {
  const { query, state, limit = 20 } = args || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('Required parameter "query" missing or empty. Provide a search term like a bank name or city.');
  }
  const max = Math.min(Number(limit) || 20, 50);
  const fields = 'NAME,CERT,CITY,STALP,ASSET,REPDTE,WEBADDR,INSTCAT';
  const stopWords = new Set(['of','the','and','a','an','at','in','for','by','to','&']);
  const words = query.replace(/^the\s+/i,'').split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()));

  const stateFilter = state ? `%20AND%20STALP%3A${state.toUpperCase()}` : '';
  const urls = [
    `${FDIC_BASE}/institutions?search=${encodeURIComponent(query)}&fields=${fields}&limit=${max}&sort_by=ASSET&sort_order=DESC&filters=ACTIVE%3A1${stateFilter}`,
  ];
  if (words.length > 0) {
    urls.push(`${FDIC_BASE}/institutions?filters=NAME%3A${encodeURIComponent(words[0])}*%20AND%20ACTIVE%3A1${stateFilter}&fields=${fields}&limit=50&sort_by=ASSET&sort_order=DESC`);
  }
  if (words.length > 1) {
    urls.push(`${FDIC_BASE}/institutions?filters=NAME%3A*${words.map(encodeURIComponent).join('*')}*%20AND%20ACTIVE%3A1${stateFilter}&fields=${fields}&limit=20&sort_by=ASSET&sort_order=DESC`);
  }

  const results = await Promise.all(urls.map(u => fetch(u).then(r => r.json()).catch(() => ({ data: [] }))));
  const seen = new Map();
  results.forEach(r => (r.data || []).forEach(d => {
    const cert = d.data?.CERT;
    if (cert && !seen.has(cert)) seen.set(cert, d.data);
  }));

  return [...seen.values()].slice(0, max).map(d => ({
    cert: d.CERT,
    name: d.NAME,
    city: d.CITY,
    state: d.STALP,
    assets_thousands: d.ASSET,
    website: d.WEBADDR || null,
    profile_url: `https://vaultbot.ai/bank/${d.CERT}`,
  }));
}

async function getBankProfile(args) {
  const { cert } = args;
  const instFields = 'NAME,CERT,CITY,STALP,ADDRESS,ZIP,WEBADDR,ESTYMD,ACTIVE,INSTCAT,CHRTAGNT,REPDTE,ASSET,DEP,EQ,NETINC,STNAME,NAMEHCR';
  const finFields = 'REPDTE,ASSET,DEP,EQ,NETINC,RBC1AAJ,ROA,ROE,NIMY,NCLNLSR,LNLSDEPR,NUMEMP';
  const [iR, fR] = await Promise.all([
    fetch(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=${instFields}&limit=1`).then(r => r.json()),
    fetch(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=${finFields}&limit=8&sort_by=REPDTE&sort_order=DESC`).then(r => r.json()),
  ]);
  const inst = iR.data?.[0]?.data;
  const history = (fR.data || []).map(d => d.data);
  if (!inst && !history.length) throw new Error(`No institution found for CERT ${cert}`);
  const latest = history[0] || {};
  return {
    cert: cert,
    name: inst?.NAME || `CERT ${cert}`,
    city: inst?.CITY,
    state: inst?.STALP,
    address: inst?.ADDRESS,
    zip: inst?.ZIP,
    website: inst?.WEBADDR || null,
    established: inst?.ESTYMD,
    holding_company: inst?.NAMEHCR || null,
    charter_agent: inst?.CHRTAGNT,
    latest_financials: {
      report_date: latest.REPDTE,
      assets_thousands: latest.ASSET,
      deposits_thousands: latest.DEP,
      equity_thousands: latest.EQ,
      net_income_thousands: latest.NETINC,
      roa_percent: latest.ROA,
      roe_percent: latest.ROE,
      nim_percent: latest.NIMY,
      capital_ratio_percent: latest.RBC1AAJ,
      noncurrent_loans_percent: latest.NCLNLSR,
      loan_to_deposit_ratio_percent: latest.LNLSDEPR,
      employees: latest.NUMEMP,
    },
    quarterly_history: history.map(h => ({
      report_date: h.REPDTE,
      assets_thousands: h.ASSET,
      deposits_thousands: h.DEP,
      net_income_thousands: h.NETINC,
      roa_percent: h.ROA,
      roe_percent: h.ROE,
    })),
    profile_url: `https://vaultbot.ai/bank/${cert}`,
  };
}

async function getIndustryMetrics(args) {
  const { year } = args || {};
  const period = year ? `${year}1231` : '20250930';
  const fields = 'REPDTE,ASSET,DEP,NETINC,ROA,ROE,NIMY';
  const filter = `REPDTE%3A${period}`;
  const allRecs = [];
  let offset = 0;
  const pageSize = 10000;
  while (offset < 50000) {
    const url = `${FDIC_BASE}/financials?filters=${filter}&fields=${fields}&limit=${pageSize}&offset=${offset}&sort_by=ASSET&sort_order=DESC`;
    const r = await fetch(url).then(r => r.json()).catch(() => ({ data: [] }));
    const page = (r.data || []).map(d => d.data);
    allRecs.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  if (allRecs.length === 0 && year) {
    const fallbackPeriod = `${year}0930`;
    const url = `${FDIC_BASE}/financials?filters=REPDTE%3A${fallbackPeriod}&fields=${fields}&limit=10000&sort_by=ASSET&sort_order=DESC`;
    const r = await fetch(url).then(r => r.json()).catch(() => ({ data: [] }));
    allRecs.push(...((r.data || []).map(d => d.data)));
  }
  if (!allRecs.length) throw new Error(`No data found for ${year || 'latest period'}.`);
  const totalAssets = allRecs.reduce((s, x) => s + (Number(x.ASSET) || 0), 0);
  const totalDeposits = allRecs.reduce((s, x) => s + (Number(x.DEP) || 0), 0);
  const totalNetInc = allRecs.reduce((s, x) => s + (Number(x.NETINC) || 0), 0);
  const avgROA = allRecs.reduce((s, x) => s + (Number(x.ROA) || 0), 0) / allRecs.length;
  const avgROE = allRecs.reduce((s, x) => s + (Number(x.ROE) || 0), 0) / allRecs.length;
  const avgNIM = allRecs.reduce((s, x) => s + (Number(x.NIMY) || 0), 0) / allRecs.length;
  return {
    period: allRecs[0]?.REPDTE,
    total_banks: allRecs.length,
    total_assets_thousands: totalAssets,
    total_deposits_thousands: totalDeposits,
    total_net_income_thousands: totalNetInc,
    avg_roa_percent: Number(avgROA.toFixed(3)),
    avg_roe_percent: Number(avgROE.toFixed(2)),
    avg_nim_percent: Number(avgNIM.toFixed(3)),
    industry_url: 'https://vaultbot.ai/industry',
  };
}

async function getRecentCharters(args) {
  const { year } = args || {};
  const fields = 'NAME,CERT,CITY,STALP,ASSET,ESTYMD,CHRTAGNT,WEBADDR,NAMEHCR';
  const filters = year
    ? `ESTYMD%3A%5B${year}0101%20TO%20${year}1231%5D%20AND%20ACTIVE%3A1`
    : `ESTYMD%3A%5B20230101%20TO%2099999999%5D%20AND%20ACTIVE%3A1`;
  const r = await fetch(`${FDIC_BASE}/institutions?filters=${filters}&fields=${fields}&limit=100&sort_by=ESTYMD&sort_order=DESC`).then(r => r.json()).catch(() => ({ data: [] }));
  return (r.data || []).map(d => ({
    cert: d.data.CERT,
    name: d.data.NAME,
    city: d.data.CITY,
    state: d.data.STALP,
    assets_thousands: d.data.ASSET,
    chartered_date: d.data.ESTYMD,
    charter_agent: d.data.CHRTAGNT,
    website: d.data.WEBADDR || null,
    holding_company: d.data.NAMEHCR || null,
    profile_url: `https://vaultbot.ai/bank/${d.data.CERT}`,
  }));
}

async function getMAActivity(args) {
  const { year, limit = 50 } = args || {};
  const max = Math.min(Number(limit) || 50, 200);
  const fields = 'TRANSNUM,EFFDATE,CHANGECODE_DESC,ACQ_INSTNAME,ACQ_CERT,ACQ_PCITY,ACQ_PSTALP,OUT_INSTNAME,OUT_CERT,OUT_PCITY,OUT_PSTALP,ASSISTED_PAYOUT_FLAG';
  let filters = 'REPORT_TYPE%3A223';
  if (year) filters += `%20AND%20EFFDATE%3A%5B${year}0101%20TO%20${year}1231%5D`;
  else filters += `%20AND%20EFFDATE%3A%5B20230101%20TO%2099999999%5D`;
  const r = await fetch(`${FDIC_BASE}/history?filters=${filters}&fields=${fields}&limit=${max}&sort_by=EFFDATE&sort_order=DESC`).then(r => r.json()).catch(() => ({ data: [] }));
  const seen = new Map();
  (r.data || []).forEach(d => {
    if (!seen.has(d.data.TRANSNUM)) seen.set(d.data.TRANSNUM, d.data);
  });
  return [...seen.values()].map(d => ({
    transaction_number: d.TRANSNUM,
    effective_date: d.EFFDATE,
    transaction_type: d.ASSISTED_PAYOUT_FLAG ? 'failure' : 'merger',
    acquirer: { name: d.ACQ_INSTNAME, cert: d.ACQ_CERT, city: d.ACQ_PCITY, state: d.ACQ_PSTALP },
    acquired: { name: d.OUT_INSTNAME, cert: d.OUT_CERT, city: d.OUT_PCITY, state: d.OUT_PSTALP },
  }));
}

async function getLenderRankings(args) {
  const { state, city, loan_type = 'residential', asset_size = 'community', limit = 25 } = args || {};
  const max = Math.min(Number(limit) || 25, 100);
  const sizeRanges = {
    community: '0%20TO%201000000',
    regional:  '1000000%20TO%2010000000',
    large:     '10000000%20TO%2099999999999',
    all:       '0%20TO%2099999999999',
  };
  const range = sizeRanges[asset_size] || sizeRanges.community;
  let instFilters = `ACTIVE%3A1%20AND%20ASSET%3A%5B${range}%5D`;
  if (state) instFilters += `%20AND%20STALP%3A${state.toUpperCase()}`;
  if (city)  instFilters += `%20AND%20CITY%3A${encodeURIComponent(city)}*`;

  const fields = 'NAME,CERT,CITY,STALP,ASSET,DEP,WEBADDR';
  const finFields = 'CERT,RBC1AAJ,ROA,NCLNLSR,LNLSDEPR,LNLSNET,ASSET';

  // Step 1: get filtered institutions
  const instR = await fetch(`${FDIC_BASE}/institutions?filters=${instFilters}&fields=${fields}&limit=200&sort_by=ASSET&sort_order=DESC`).then(r => r.json()).catch(() => ({ data: [] }));
  const insts = (instR.data || []).map(d => d.data).filter(Boolean);
  if (!insts.length) return [];

  // Step 2: get financials for those specific CERTs (financials endpoint doesn't support ASSET range filters)
  const certList = insts.map(i => i.CERT).slice(0, 200).join('%20OR%20CERT%3A');
  const finFilters = `CERT%3A${certList}`;
  const finR = await fetch(`${FDIC_BASE}/financials?filters=${finFilters}&fields=${finFields}&limit=200&sort_by=ASSET&sort_order=DESC`).then(r => r.json()).catch(() => ({ data: [] }));
  const fins = new Map((finR.data || []).map(d => [d.data?.CERT, d.data]).filter(([k]) => k));

  const scored = insts.map(inst => {
    const fin = fins.get(inst.CERT);
    if (!fin) return null;
    const loanRatio = (Number(fin.LNLSNET) || 0) / (Number(fin.ASSET) || 1) * 100;
    const cap = Number(fin.RBC1AAJ) || 0;
    const delinq = Number(fin.NCLNLSR) || 0;
    const roa = Number(fin.ROA) || 0;
    const score = (
      Math.min(loanRatio, 100) * 0.35 +
      Math.min(cap, 25) * 4 * 0.20 +
      (100 - Math.min(delinq * 10, 100)) * 0.25 +
      Math.min(Math.max(roa * 50, 0), 100) * 0.20
    );
    return {
      cert: inst.CERT,
      name: inst.NAME,
      city: inst.CITY,
      state: inst.STALP,
      assets_thousands: inst.ASSET,
      lending_score: Number(score.toFixed(1)),
      loan_to_asset_ratio: Number(loanRatio.toFixed(1)),
      capital_ratio_percent: cap,
      noncurrent_loans_percent: delinq,
      roa_percent: roa,
      website: inst.WEBADDR || null,
      profile_url: `https://vaultbot.ai/bank/${inst.CERT}`,
    };
  }).filter(Boolean).sort((a, b) => b.lending_score - a.lending_score);
  return scored.slice(0, max);
}

// ── MCP JSON-RPC Handler ─────────────────────────────────────────────────────
const TOOL_HANDLERS = {
  search_institutions: searchInstitutions,
  get_bank_profile: getBankProfile,
  get_industry_metrics: getIndustryMetrics,
  get_recent_charters: getRecentCharters,
  get_ma_activity: getMAActivity,
  get_lender_rankings: getLenderRankings,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS };

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200, headers: CORS_HEADERS,
      body: JSON.stringify({
        name: 'vault-mcp', version: '1.1.0',
        description: 'Vault MCP — banking intelligence for AI agents. Built by iDENTIFY.',
        protocol: 'mcp', protocol_version: '2024-11-05',
        endpoint: 'https://vaultbot.ai/.netlify/functions/mcp',
        tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
        documentation: 'https://vaultbot.ai/mcp',
        powered_by: 'iDENTIFY (goidentify.com)',
      }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ jsonrpc:'2.0', id:null, error:{code:-32700,message:'Parse error'}}) }; }

  const { jsonrpc = '2.0', id, method, params } = req;
  const reply = (result) => ({ statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ jsonrpc, id, result }) });
  const err = (code, message, data) => ({ statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ jsonrpc, id, error: { code, message, data } }) });

  const t0 = Date.now();
  let toolName = null, clientName = null, success = true, errorMsg = null;

  // Await logging with a short timeout — fire-and-forget gets killed by Lambda
  // when handler returns. We give it 1 second max, then move on regardless.
  const safeLog = async (data) => {
    try {
      await Promise.race([
        logCall(event, data),
        new Promise((_, rej) => setTimeout(() => rej(new Error('log timeout')), 1000)),
      ]);
    } catch (e) {
      console.error('Analytics log fail (non-blocking):', e.message);
    }
  };

  try {
    switch (method) {
      case 'initialize': {
        clientName = params?.clientInfo?.name || 'unknown';
        const clientVersion = params?.clientInfo?.version || 'unknown';
        await safeLog({ method, clientName: `${clientName}/${clientVersion}`, durationMs: Date.now()-t0, success: true });
        return reply({
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'vault-mcp', version: '1.1.0' },
          capabilities: { tools: {} },
        });
      }

      case 'tools/list':
        await safeLog({ method, durationMs: Date.now()-t0, success: true });
        return reply({ tools: TOOLS });

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        toolName = name;
        const handler = TOOL_HANDLERS[name];
        if (!handler) {
          await safeLog({ method, toolName, durationMs: Date.now()-t0, success: false, errorMsg: 'Unknown tool' });
          return err(-32601, `Unknown tool: ${name}`);
        }
        const data = await handler(args || {});
        await safeLog({ method, toolName, durationMs: Date.now()-t0, success: true });
        return reply({
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        });
      }

      case 'ping':
        return reply({});

      // MCP protocol notifications — client-to-server signals that don't need a response.
      // Per JSON-RPC 2.0 spec, these have no 'id' field and the server should not reply with an error.
      // Per MCP spec, these include: notifications/initialized, notifications/roots/list_changed, etc.
      case 'initialized':
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
      case 'notifications/cancelled':
      case 'notifications/progress':
        await safeLog({ method, durationMs: Date.now()-t0, success: true });
        return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };

      default:
        // Treat any other 'notifications/*' or methods without an id as silent notifications
        if (method?.startsWith('notifications/') || id === undefined || id === null) {
          await safeLog({ method, durationMs: Date.now()-t0, success: true });
          return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
        }
        await safeLog({ method, durationMs: Date.now()-t0, success: false, errorMsg: 'Unknown method' });
        return err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    errorMsg = e.message;
    await safeLog({ method, toolName, durationMs: Date.now()-t0, success: false, errorMsg });
    return err(-32603, 'Internal error', e.message);
  }
};
