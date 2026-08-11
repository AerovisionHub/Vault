// Vault MCP Server v1.2 — banking intelligence for AI agents with usage analytics
// Implements MCP (Model Context Protocol) over HTTP using JSON-RPC 2.0
// Spec: https://modelcontextprotocol.io/

const FDIC_BASE = 'https://banks.data.fdic.gov/api';
// Summary of Deposits — separate FDIC dataset (annual branch-level census, as of each June 30).
// Same query syntax as FDIC_BASE (filters=field%3Avalue&fields=...&limit=...&sort_by=...&sort_order=...).
const FDIC_SOD_BASE = 'https://banks.data.fdic.gov/api/sod';

// FDIC fetch with rate-limit + bad-response detection.
// FDIC returns plain text "You've exceeded the rate limit..." when throttling, which crashes
// res.json() with cryptic errors. This wrapper detects all common failure modes and throws
// clean, descriptive errors that bubble up to the MCP client as useful messages.
async function fetchFDIC(url, opts = {}) {
  const { timeoutMs = 12000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('FDIC API timeout (>12s). Try again.');
    throw new Error(`FDIC API network error: ${e.message}`);
  }
  clearTimeout(timer);

  const text = await response.text();

  if (text.startsWith("You've exceeded") || text.toLowerCase().includes('rate limit')) {
    throw new Error('FDIC API is rate-limiting requests. Try again in 30-60 seconds.');
  }
  if (!response.ok) {
    if (response.status === 429) throw new Error('FDIC API rate limit (HTTP 429). Wait 30 seconds.');
    if (response.status === 400) throw new Error(`FDIC API rejected the request (HTTP 400). Likely an invalid field name. Response: ${text.slice(0, 200)}`);
    if (response.status >= 500) throw new Error(`FDIC API error (HTTP ${response.status}). Try again.`);
    throw new Error(`FDIC API returned HTTP ${response.status}.`);
  }
  try {
    const json = JSON.parse(text);
    // FDIC sometimes returns 200 with errors in the body
    if (json.errors) {
      throw new Error(`FDIC API error: ${JSON.stringify(json.errors).slice(0, 200)}`);
    }
    return json;
  } catch (e) {
    if (e.message.startsWith('FDIC')) throw e; // re-throw our own errors
    throw new Error(`FDIC returned non-JSON response: ${text.slice(0, 150)}`);
  }
}

// ── Tool Definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_institutions',
    description: 'Search FDIC-insured banks and credit unions by name, city, or partial match. Returns up to 20 results ranked by relevance and asset size. Typically responds in 2-4 seconds. Use this first to get a CERT number before calling other tools.',
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
    description: 'Get detailed profile for a single FDIC-insured bank by certificate number (CERT). Returns institution details, latest financials (assets, deposits, ROA, ROE, NIM, capital ratio), and 8 quarters of historical data. Typically responds in 3-6 seconds — two FDIC API calls run in parallel. Note: always run search_institutions first to get the CERT.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (e.g. "23473"). Get this from search_institutions first.' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_industry_metrics',
    description: 'Get aggregate U.S. banking industry metrics — total banks, total assets, average ROA/ROE/NIM, and trends. Note: this tool scans up to 5,000 bank records and typically takes 8-15 seconds. Let the user know it may take a moment before calling. If using Perplexity, this tool will likely time out — recommend using Claude Desktop for industry-level queries.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Year to fetch (default: most recent available)' },
      },
    },
  },
  {
    name: 'get_recent_charters',
    description: 'List newly chartered FDIC-insured banks (de novo banks). Returns bank name, location, charter date, charter agent, asset size, and holding company. Typically responds in 2-4 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Year to filter by (e.g. 2025, 2024, 2023). Omit for all years 2023+.' },
      },
    },
  },
  {
    name: 'get_ma_activity',
    description: 'List recent bank mergers, acquisitions, and failures from FDIC regulatory filings. Returns acquirer, acquired institution, effective date, and transaction type. Typically responds in 2-4 seconds.',
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
    description: 'Get banks ranked by composite Lending Score (loan concentration + capital strength + asset quality + ROA). Filter by state, city, or asset size tier. Typically responds in 4-8 seconds — fetches and scores up to 100 institutions. Let the user know it may take a moment before calling. Note: if using Perplexity, this tool may time out on broad queries — narrow by state or city for best results.',
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
  {
    name: 'get_asset_quality_detail',
    description: 'Get detailed credit quality breakdown for a specific bank: noncurrent loans, OREO (foreclosed real estate), loan loss reserves, net charge-offs, and key ratios. Returns up to 8 quarters of history. Typically responds in 3-6 seconds. Use to answer "is this bank having credit problems?" or assess reserve adequacy.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (required). Get from search_institutions.' },
        quarters: { type: 'number', description: 'Quarters of history to return (default 4, max 8)' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_loan_mix',
    description: 'Get loan portfolio composition for a specific bank: Real Estate (residential, commercial RE, construction), C&I, Agricultural, and Consumer. Returns dollar amounts and % of total loans. Typically responds in 3-6 seconds. Use to understand lending strategy or CRE concentration risk.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (required). Get from search_institutions.' },
        quarters: { type: 'number', description: 'Quarters of history (default 1 = latest only, max 8)' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_brokered_deposits',
    description: 'Get brokered deposit levels and funding-risk detail for a specific bank: dollar amount, percent of total deposits, and trend over up to 8 quarters. Brokered deposits (funds a bank buys from a broker rather than gathering from local depositors) are a widely-watched funding-risk indicator — high or fast-growing levels can signal liquidity stress or an aggressive growth strategy funded by less-stable "hot money." Typically responds in 3-6 seconds. Use to answer "how reliant is this bank on brokered funding?" or assess deposit funding quality.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (required). Get from search_institutions.' },
        quarters: { type: 'number', description: 'Quarters of history to return (default 4, max 8)' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_branch_data',
    description: 'Get branch-level location and deposit data for a specific bank from the FDIC Summary of Deposits (SOD) — the annual branch-level census FDIC-insured banks file every June. Returns branch count, total branch deposits, and a list of individual branches with address, city, state, deposits, and whether it\'s the main office. Typically responds in 3-6 seconds. Use to answer "how many branches does this bank have," "where does this bank operate," or "which branches hold the most deposits." Note: SOD data updates once a year (as of each June 30), so this reflects the most recent annual filing, not real-time branch counts.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (required). Get from search_institutions.' },
        state: { type: 'string', description: 'Optional 2-letter state code to filter branches to one state (e.g. "OK")' },
        limit: { type: 'number', description: 'Max branches returned (default 50, max 200)' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_bank_leadership',
    description: 'Get key decision-makers for a specific bank, prioritized for B2B sales targeting: CEO/President, CIO/CTO (or closest functional equivalent at smaller banks), and COO — each with name, title, role_category, source URL, and (when found) a LinkedIn profile URL. Useful for building sales target lists: call search_institutions or get_lender_rankings first to find candidate banks matching your criteria, then call this for each one to build out contacts ready for outreach. Typically responds in 8-20 seconds on first lookup, ~150ms on repeat lookups (cached 30 days). LinkedIn URLs come back null on a first-ever lookup of a bank more often than not -- the underlying match takes 1-2 minutes, longer than this tool waits. If a LinkedIn URL is null and you want it: call trigger_linkedin_match (pass this cert so the result gets saved permanently), wait about a minute, then check_linkedin_match. This works the same way for any user, not just bulk workflows -- once someone resolves a match for a bank, it is cached and every future call to this tool for that bank returns the LinkedIn URL immediately. Returns an empty people list when no confident public leadership data can be found.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (required). Get from search_institutions.' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_bank_leadership_bulk',
    description: 'Cache-only batch read of leadership data for many banks at once — instant (typically well under 2 seconds for dozens of certs), because it never runs the live Claude+Bright Data pipeline, only reads whatever is already cached. Built for bulk workflows: e.g. call search_institutions or get_lender_rankings to build a list of banks matching criteria (state, asset size, etc.), then call this once with all their CERTs to see what leadership data already exists. Returns per-cert results plus a top-level `cache_misses` array of CERTs with nothing cached yet — for those, call get_bank_leadership individually (which DOES run the live pipeline) to populate them, then re-call this to get the fresh data. This is the fast first pass for building a report or spreadsheet across many banks; it does not itself trigger any new lookups or incur any Bright Data / Claude cost.',
    inputSchema: {
      type: 'object',
      properties: {
        certs: { type: 'array', items: { type: 'string' }, description: 'FDIC certificate numbers to look up (max 100 per call).' },
      },
      required: ['certs'],
    },
  },
  {
    name: 'trigger_linkedin_match',
    description: 'Kick off a LinkedIn profile match for one named person at a company -- fast (a few seconds), does NOT wait for the match to complete. Returns a snapshot_id. Available to any user, for a single person or many. Pass the bank cert too (strongly recommended) -- doing so saves the result permanently once found, so this exact person never needs to be looked up again by anyone. After calling this, wait about a minute, then call check_linkedin_match. For bulk workflows processing many banks: call this once per priority-role person across ALL banks first, collecting every snapshot_id, THEN wait 30-60 seconds before checking any -- checking immediately wastes calls, and batching triggers before waiting lets them all process in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        company_linkedin_url: { type: 'string', description: 'The bank company LinkedIn page URL, from get_bank_leadership company_linkedin_url field.' },
        full_name: { type: 'string', description: 'The person full name, e.g. "Sean Kouplen".' },
        cert: { type: 'string', description: 'FDIC certificate number for this bank. Strongly recommended: when provided, a resolved match is written back into the shared cache, so every future get_bank_leadership call for this bank (by anyone) returns the LinkedIn URL instantly.' },
      },
      required: ['company_linkedin_url', 'full_name'],
    },
  },
  {
    name: 'check_linkedin_match',
    description: 'Check whether a LinkedIn match started with trigger_linkedin_match is ready, and return the profile URL if so. Fast (a couple seconds) — does NOT wait/poll internally, just checks current status once and returns immediately. Returns {status:"running"} if not ready yet (wait ~15-20 seconds before checking again — checking too frequently wastes calls without helping), {status:"ready", linkedin_url:"..."} once found, or {status:"not_found"} if the search completed but found no match. Most matches complete within 1-3 minutes of being triggered; a few take longer. If trigger_linkedin_match was called with a cert, a ready result here also saves the match into the shared cache automatically — nothing further needed to make it permanent. For a bulk spreadsheet workflow, trigger all people across all banks first, then loop checking the pending ones every 15-20 seconds until all are resolved (ready, not_found, or a reasonable give-up point like 5 minutes) rather than checking one at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'The snapshot_id returned by trigger_linkedin_match.' },
      },
      required: ['snapshot_id'],
    },
  },
];

// ── Analytics Layer ──────────────────────────────────────────────────────────
// Stores per-call telemetry in Netlify Blobs for the dashboard.
// Privacy: we hash the IP, never store full IP; we capture client name from MCP handshake but no other PII.
const crypto = require('crypto');

// ── Netlify Blobs cache ───────────────────────────────────────────────────────
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function getBlobStore() {
  try {
    // Must use dynamic import, not require(). @netlify/blobs' CJS entry
    // internally requires @netlify/runtime-utils, which is ESM-only —
    // require() crashes with "require() of ES Module ... not supported".
    // logCall() already does this correctly for the analytics store.
    const { getStore } = await import('@netlify/blobs');
    // This is a legacy V1 function — Netlify does not auto-inject blob
    // context for V1 (only V2/Edge get zero-config getStore()). Per
    // Netlify's own docs, V1 functions must supply siteID/token manually,
    // exactly like logCall() already does for the analytics store.
    return getStore({
      name: 'vault-fdic-cache',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
  } catch(e) {
    console.log('[vault-cache] getBlobStore unavailable:', e.message);
    return null; // graceful degradation — falls through to live FDIC
  }
}

async function cacheGet(key) {
  try {
    const store = await getBlobStore();
    if (!store) return null;
    const raw = await store.get(key, { type: 'json' });
    if (!raw) return null;
    if (raw._cached_at && (Date.now() - raw._cached_at) > CACHE_TTL_MS) {
      await store.delete(key).catch(() => {});
      return null;
    }
    console.log('[vault-cache] HIT:', key, 'age:', Math.round((Date.now() - raw._cached_at) / 3600000) + 'h');
    return raw;
  } catch(e) {
    console.log('[vault-cache] cacheGet error:', e.message);
    return null;
  }
}

async function cacheSet(key, data) {
  try {
    const store = await getBlobStore();
    if (!store) return;
    await store.setJSON(key, { ...data, _cached_at: Date.now() });
    console.log('[vault-cache] STORED:', key);
  } catch(e) {
    console.log('[vault-cache] cacheSet error:', e.message);
  }
}

// ── Leadership cache (separate store, shared with functions/leadership.js) ──
// Same "vault-leadership-cache" store name as the website's leadership section,
// so a lookup done via either surface (MCP tool call or website page view) warms
// the cache for the other — no duplicate paid Claude calls for the same bank.
const LEADERSHIP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function getLeadershipBlobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore({
      name: 'vault-leadership-cache',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
  } catch(e) {
    console.log('[vault-leadership-cache] getBlobStore unavailable:', e.message);
    return null;
  }
}

async function cacheGetLeadership(key) {
  try {
    const store = await getLeadershipBlobStore();
    if (!store) return null;
    const raw = await store.get(key, { type: 'json' });
    if (!raw) return null;
    if (raw._cached_at && (Date.now() - raw._cached_at) > LEADERSHIP_CACHE_TTL_MS) {
      await store.delete(key).catch(() => {});
      return null;
    }
    return raw;
  } catch(e) {
    console.log('[vault-leadership-cache] cacheGetLeadership error:', e.message);
    return null;
  }
}

async function cacheSetLeadership(key, data) {
  try {
    const store = await getLeadershipBlobStore();
    if (!store) return;
    await store.setJSON(key, { ...data, _cached_at: Date.now() });
  } catch(e) {
    console.log('[vault-leadership-cache] cacheSetLeadership error:', e.message);
  }
}

// ── LinkedIn enrichment (Bright Data) ────────────────────────────────────────
// Two-step: (1) SERP search finds the bank's own LinkedIn company page (bank
// LinkedIn URLs don't follow a guessable pattern), (2) Bright Data's people-
// discovery dataset matches a specific exec by name, scoped to that company.
// Both steps are best-effort — if either fails, get_bank_leadership still
// returns names/titles without linkedin_url rather than failing the whole call.
const BRIGHTDATA_SERP_ZONE = 'serp_api1vault_serp';
const BRIGHTDATA_LINKEDIN_DATASET_ID = 'gd_m8d03he47z8nwb5xc';

async function findCompanyLinkedInUrl(bankName, city, state, deadline) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) return null;
  // NOTE: deliberately NOT using a "site:" operator here. Confirmed via direct
  // testing that Google/Bright Data treats site:-qualified queries as much more
  // bot-like and applies far stricter anti-abuse measures — this exact query
  // pattern was timing out or getting CAPTCHA'd consistently across an entire
  // day of testing, while the identical search minus "site:linkedin.com" (just
  // natural language, filtering organic results client-side afterward)
  // succeeded cleanly and immediately. This was the actual root cause behind
  // a full day of "company URL search returns null" investigation.
  const q = `"${bankName}" ${city} ${state} linkedin company page`;

  // Each attempt gets its OWN fresh AbortController + timeout. A single
  // shared 8s timer covering two sequential calls + a delay between them
  // was a real bug: it aborted the retry attempt mid-flight whenever the
  // first call plus the delay already ate into most of the 8s, which is
  // easy to hit with real network latency. Found by direct comparison —
  // a manual call to Bright Data succeeded cleanly while this function
  // still returned null for the identical query.
  const doSerpCall = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    try {
      const resp = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          zone: BRIGHTDATA_SERP_ZONE,
          url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
          format: 'json',
          data_format: 'parsed_light',
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
      const j = await resp.json();
      // Bright Data returns a structured error even on 200 (e.g. Google served a
      // CAPTCHA) rather than throwing — check for it explicitly instead of
      // blindly attempting JSON.parse(j.body), which throws on an empty body
      // and gets silently swallowed as "no match found" otherwise. CAPTCHAs
      // are a known, expected, intermittent failure mode of any Google-SERP
      // based search, not specific to any one bank name — worth one retry.
      const errCode = j.headers?.['x-brd-error-code'];
      if (errCode || !j.body) {
        return { ok: false, reason: `Bright Data SERP error: ${errCode || 'empty body'} (status_code ${j.status_code})` };
      }
      const parsed = typeof j.body === 'string' ? JSON.parse(j.body) : j;
      const organic = parsed.organic || parsed.organic_results || [];
      const hit = organic.find(o => (o.link || '').includes('linkedin.com/company/'));
      return { ok: true, url: hit ? hit.link : null };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout (>14s)' : e.message };
    }
  };

  let result = await doSerpCall();
  if (!result.ok) {
    // Only retry on a genuine error (CAPTCHA, malformed response) — NOT on a
    // plain timeout. A timeout means the request was just slow; retrying
    // immediately costs more time without meaningfully improving the odds.
    // Also skip the retry if there isn't enough of the overall function
    // budget left — 14s (attempt 1) + 1.5s delay + up to 14s (retry) can hit
    // 29.5s on its own, independent of Claude's parallel search, which is
    // enough on its own to blow past Netlify's real platform ceiling with no
    // chance for any code here to fail soft. Confirmed live: this exact path
    // is why "Sovereign Bank" (Shawnee, OK) failed 3/3 times.
    const budgetLeftMs = deadline ? deadline - Date.now() : Infinity;
    if (result.reason.includes('timeout')) {
      console.log('[vault-linkedin] SERP attempt 1 timed out — not retrying');
    } else if (budgetLeftMs < 16000) {
      console.log('[vault-linkedin] SERP attempt 1 failed:', result.reason, '- skipping retry, only', Math.round(budgetLeftMs), 'ms left in budget');
    } else {
      console.log('[vault-linkedin] SERP attempt 1 failed:', result.reason, '- retrying once');
      await new Promise(r => setTimeout(r, 1500));
      result = await doSerpCall();
    }
  }
  if (!result.ok) {
    console.log('[vault-linkedin] SERP giving up for this lookup:', result.reason);
    return null;
  }
  return result.url;
}

// Real root cause of the earlier 0-for-4 LinkedIn match failures: the /scrape
// endpoint we were calling is documented as "if the request takes too long
// [internally, before its own ~1min patience runs out], receive a snapshot_id
// to poll instead" — meaning slow matches return {snapshot_id, status} rather
// than actual data. The old code did `Array.isArray(arr) ? arr[0] : null`,
// which silently returned null for that object shape every single time,
// indistinguishable from a genuine "no match found." This is the proper
// trigger + poll + download pattern instead, bounded by whatever time budget
// the caller has left (deadlineMs), so a still-running job degrades to null
// rather than either hanging or being misread as "no match."
async function lookupLinkedInProfile(companyUrl, fullName, deadlineMs) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey || !fullName) return null;
  const parts = fullName.trim().split(/\s+/);
  const first_name = parts[0];
  const last_name = parts.slice(1).join(' ') || parts[0];

  try {
    const triggerResp = await fetch(`https://api.brightdata.com/datasets/v3/trigger?dataset_id=${BRIGHTDATA_LINKEDIN_DATASET_ID}&include_errors=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ input: [{ url: companyUrl, first_name, last_name }] }),
    });
    if (!triggerResp.ok) return null;
    const { snapshot_id } = await triggerResp.json();
    if (!snapshot_id) return null;

    // Poll /progress until status is "ready" (or "failed"), checking every
    // 1.5s, never past the caller's deadline.
    while (Date.now() < deadlineMs) {
      await new Promise(r => setTimeout(r, 1500));
      const progResp = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snapshot_id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!progResp.ok) return null;
      const prog = await progResp.json();
      if (prog.status === 'failed') return null;
      if (prog.status !== 'ready') continue; // starting or running — keep polling

      const dlResp = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshot_id}?format=json`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!dlResp.ok) return null;
      const arr = await dlResp.json();
      const match = Array.isArray(arr) ? arr[0] : null;
      if (match?.url && !experienceMatchesCompany(match.experience, companyUrl)) {
        console.log('[vault-linkedin] REJECTED likely false match for', fullName, ':', match.name, '| experience:', match.experience);
        return null;
      }
      return match?.url || null;
    }
    console.log('[vault-linkedin] ran out of time budget polling for', fullName);
    return null; // out of time — job may still complete on Bright Data's side, just not in time for us
  } catch (e) {
    console.log('[vault-linkedin] person lookup failed for', fullName, ':', e.message);
    return null;
  }
}

// ── Bulk-friendly LinkedIn matching: trigger + check, no internal waiting ──
// Split out of lookupLinkedInProfile specifically so a bulk/spreadsheet workflow
// (Claude orchestrating across many banks in one conversation, not a single
// live synchronous tool call) can do its own waiting BETWEEN fast calls,
// rather than any one Netlify function call racing the ~26s ceiling. Neither
// of these two functions loops or sleeps — each does one or two quick HTTP
// calls and returns, so they're safe to call as often as needed without
// timeout risk.

// Verifies a matched LinkedIn profile actually has some connection to the
// target company, using the 'experience' field Bright Data returns (e.g.
// "Meta, +4 more"). Found via a real false-positive: matching "Tom Wayne" at
// The Bank of Oak Ridge returned Tom (Thomas WAYNE Busey) Busey, a Meta
// employee — his middle name is Wayne. The company_linkedin_url we pass in
// is evidently used as a soft ranking hint by Bright Data's matcher, NOT a
// hard filter, so it can confidently return someone with zero connection to
// the target company. This check extracts distinctive words from the
// company's LinkedIn slug (e.g. "the-bank-of-oak-ridge" -> "oak", "ridge")
// and requires at least one to appear in the experience string before a
// match is trusted. Conservative on purpose: a missed real match (false
// negative) is far less costly than confidently contacting the wrong person.
function experienceMatchesCompany(experience, companyLinkedInUrl) {
  if (!companyLinkedInUrl) return true; // nothing to verify against — allow through
  const slug = companyLinkedInUrl.split('/company/')[1]?.split('/')[0] || '';
  const stopWords = new Set(['the','bank','of','na','national','association','inc','corp','corporation','company','llc','group','financial','trust','and','co','bancorp','bankshares']);

  // Two representations of the slug, since LinkedIn company slugs are
  // inconsistent about hyphenation — some are "the-bank-of-oak-ridge" (real
  // word boundaries), others are "sonatabank" (no hyphen at all, words run
  // together). Splitting only on hyphens misses the second case entirely:
  // "sonatabank" never matches "Sonata Bank" (with a space) in the experience
  // field. Found via a real false-negative — Wendell Bontrager's actual
  // experience said "Sonata Bank, +6 more" and was wrongly rejected because
  // the un-hyphenated slug produced one token, "sonatabank", that doesn't
  // literally appear in text that has a space in it.
  const hyphenWords = slug.replace(/-/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  const concatenatedSlug = slug.replace(/-/g, '').toLowerCase();

  if (!hyphenWords.length && concatenatedSlug.length <= 3) return true; // nothing distinctive to check — allow through
  if (!experience) return false; // Bright Data gave us nothing to verify with — conservative reject

  const expLower = experience.toLowerCase();
  const expNoSpaces = expLower.replace(/[\s,]+/g, ''); // strip spaces/commas so "Sonata Bank" -> "sonatabank"

  const hyphenMatch = hyphenWords.some(w => expLower.includes(w));
  const concatMatch = concatenatedSlug.length > 3 && expNoSpaces.includes(concatenatedSlug);
  return hyphenMatch || concatMatch;
}

async function triggerLinkedinMatch(args) {
  const { company_linkedin_url, full_name, cert } = args || {};
  if (!company_linkedin_url || !full_name) {
    throw new Error('Required parameters "company_linkedin_url" and "full_name" missing.');
  }
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) throw new Error('BRIGHTDATA_API_KEY not configured on the server.');

  const parts = full_name.trim().split(/\s+/);
  const first_name = parts[0];
  const last_name = parts.slice(1).join(' ') || parts[0];

  const resp = await fetch(`https://api.brightdata.com/datasets/v3/trigger?dataset_id=${BRIGHTDATA_LINKEDIN_DATASET_ID}&include_errors=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ input: [{ url: company_linkedin_url, first_name, last_name }] }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Bright Data trigger returned HTTP ${resp.status}. ${text.slice(0, 200)}`);
  }
  const { snapshot_id } = await resp.json();
  if (!snapshot_id) throw new Error('Bright Data trigger did not return a snapshot_id.');

  // Always remember company_linkedin_url so check_linkedin_match can verify
  // the eventual match — not just when a cert is provided. Verification
  // matters for every lookup, not only ones that get cached.
  await cacheSetLeadership(`linkedin-pending-${snapshot_id}`, { cert: cert || null, full_name, company_linkedin_url });
  return { snapshot_id, full_name, status: 'triggered' };
}

async function checkLinkedinMatch(args) {
  const { snapshot_id } = args || {};
  if (!snapshot_id) throw new Error('Required parameter "snapshot_id" missing.');
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) throw new Error('BRIGHTDATA_API_KEY not configured on the server.');

  const progResp = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snapshot_id}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!progResp.ok) {
    const text = await progResp.text().catch(() => '');
    throw new Error(`Bright Data progress check returned HTTP ${progResp.status}. ${text.slice(0, 200)}`);
  }
  const prog = await progResp.json();
  if (prog.status === 'failed') return { snapshot_id, status: 'failed' };
  if (prog.status !== 'ready') return { snapshot_id, status: 'running' };

  const dlResp = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshot_id}?format=json`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!dlResp.ok) {
    const text = await dlResp.text().catch(() => '');
    throw new Error(`Bright Data snapshot download returned HTTP ${dlResp.status}. ${text.slice(0, 200)}`);
  }
  const arr = await dlResp.json();
  const match = Array.isArray(arr) ? arr[0] : null;

  if (match?.url) {
    const pending = await cacheGetLeadership(`linkedin-pending-${snapshot_id}`);
    const verified = experienceMatchesCompany(match.experience, pending?.company_linkedin_url);
    if (!verified) {
      console.log('[vault-linkedin] REJECTED likely false match:', match.name, '| experience:', match.experience, '| expected company:', pending?.company_linkedin_url);
      return { snapshot_id, status: 'not_found', rejected_reason: 'experience did not mention target company — likely false match, not a real profile' };
    }
    // Write this result back into the shared leadership cache if we know
    // which cert/person it belongs to (i.e. trigger_linkedin_match was called
    // with a cert). This is what makes a match PERMANENT — the next lookup of
    // this bank, by anyone, on either the website or MCP, gets the LinkedIn
    // URL immediately from cache instead of needing to trigger/wait/check again.
    try {
      if (pending?.cert) {
        const cacheKey = `leadership-${pending.cert}`;
        const existing = await cacheGetLeadership(cacheKey);
        if (existing?.people?.length) {
          const idx = existing.people.findIndex(p => p.name === pending.full_name);
          if (idx !== -1) {
            existing.people[idx].linkedin_url = match.url;
            await cacheSetLeadership(cacheKey, { people: existing.people, company_linkedin_url: existing.company_linkedin_url });
            console.log('[vault-linkedin] wrote resolved match back into leadership cache for', pending.cert, pending.full_name);
          }
        }
      }
    } catch (e) {
      console.log('[vault-linkedin] cache write-back failed (non-fatal):', e.message);
    }
    return { snapshot_id, status: 'ready', linkedin_url: match.url };
  }
  return { snapshot_id, status: 'not_found' };
}

async function getBankLeadership(args) {
  // Measured from true entry — cache check and FDIC fetch below both consume
  // real wall-clock time against the ~26s function ceiling, and the LinkedIn
  // enrichment budget later needs to account for that, not just its own slice.
  const overallStart = Date.now();
  const { cert } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');

  const cacheKey = `leadership-${cert}`;
  const cached = await cacheGetLeadership(cacheKey);
  if (cached) {
    return {
      cert,
      people: cached.people || [],
      _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) },
    };
  }

  // Need institution name/city/state/website to search for — same fields other tools use
  const iR = await fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP,WEBADDR&limit=1`);
  const inst = iR.data?.[0]?.data;
  if (!inst) throw new Error(`No institution found for CERT ${cert}.`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the server.');

  const webAddr = inst.WEBADDR || null;
  const domainHint = webAddr
    ? `Focus your search on the bank's own website: ${webAddr.replace(/^https?:\/\//i, '').split('/')[0]}. `
    : '';
  const prompt = `You are a financial research assistant. ${domainHint}Find the following specific decision-makers at the US bank "${inst.NAME}" (FDIC-chartered, headquartered near ${inst.CITY}, ${inst.STALP}) — in priority order:

1. CEO or President (top executive — may hold either or both titles)
2. CIO or CTO — the technology/information leader (HIGH priority; this is who evaluates data infrastructure vendors). Community banks often don't use these exact titles — look for the closest functional equivalent, e.g. "SVP of Information Technology," "Chief Digital Officer," "VP of IT," "EVP of Technology," or similar. Use judgment on title wording, not an exact string match.
3. COO (lower priority — include only if clearly identified, skip if uncertain)

Important: banks often have a registered/charter address that differs from where their executive team actually operates — company-wide executive leadership is exactly what's wanted here, regardless of which specific office is on file with regulators. Do not discard a bank's real, published leadership team just because it's described as "company-wide" rather than tied to one specific address.

Return ONLY a JSON array (no markdown, no explanation):
[{"name":"Full Name","title":"Their actual title as published","role_category":"ceo|president|cio_cto|coo","source":"URL or public record"}]

Max 4 people, one per role above. Only include people you are highly confident about based on search results. If you found no relevant information at all, return [].`;

  // Track wall-clock time against the ~26s function ceiling. History here:
  // 18s Claude budget caused a real production timeout on "Bank of DeSoto"
  // (18s wasn't enough). Bumped to 22s — that fixed the timeout, but the
  // same bank then completed at 26.3s internally, dangerously close to
  // Netlify's actual platform ceiling (not just our own accounting). Settled
  // on 19s for Claude as the safer middle ground, with the LinkedIn phase
  // hard-capped by an overall time-budget race (not a per-call timeout) so a
  // slow LinkedIn lookup degrades to nulls instead of ever risking the
  // names/titles Claude already found, or the 26s ceiling itself.
  const claudeController = new AbortController();
  const claudeTimer = setTimeout(() => claudeController.abort(), 19000);

  const claudePromise = fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: claudeController.signal,
  }).finally(() => clearTimeout(claudeTimer));

  const [claudeSettled, companyLinkedInUrl] = await Promise.all([
    claudePromise.then(r => ({ ok: true, resp: r })).catch(e => ({ ok: false, error: e })),
    findCompanyLinkedInUrl(inst.NAME, inst.CITY, inst.STALP, overallStart + 24000),
  ]);

  if (!claudeSettled.ok) {
    const e = claudeSettled.error;
    if (e.name === 'AbortError') throw new Error('Claude API timeout (>19s) looking up leadership.');
    throw new Error(`Claude API network error: ${e.message}`);
  }
  const resp = claudeSettled.resp;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Claude API returned HTTP ${resp.status}. ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  const text = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';
  const clean = text.replace(/```json|```/g, '').trim();

  let people = [];
  if (clean) {
    const jsonMatch = clean.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : clean;
    if (jsonStr !== '[]') {
      try { people = JSON.parse(jsonStr); } catch (e) { people = []; }
    }
  }

  // Enrich with a LinkedIn profile URL — but ONLY for people in the priority
  // role categories (ceo, president, cio_cto, coo). This directly targets
  // spend: if Claude's prompt slips in an extra person outside those roles,
  // we don't pay a Bright Data credit (or spend time budget) looking them up.
  // Non-priority people still get returned with linkedin_url: null rather
  // than being dropped from the response entirely — Lee still sees who they
  // are, we just don't spend enrichment budget on them.
  const PRIORITY_ROLES = new Set(['ceo', 'president', 'cio_cto', 'coo']);
  const elapsedMs = Date.now() - overallStart;
  const remainingBudgetMs = Math.max(1500, 23000 - elapsedMs);
  const linkedinDeadline = Date.now() + remainingBudgetMs;

  if (companyLinkedInUrl && people.length) {
    const priorityIdx = people
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => PRIORITY_ROLES.has(p.role_category));

    const lookupPromise = Promise.allSettled(
      priorityIdx.map(({ p }) => lookupLinkedInProfile(companyLinkedInUrl, p.name, linkedinDeadline))
    );
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), remainingBudgetMs));
    const linkedinResults = await Promise.race([lookupPromise, timeoutPromise]);

    // Start everyone at null, then fill in results for the priority subset
    // that was actually looked up (whether the race finished or not — if it
    // timed out, linkedinResults is null and everyone correctly stays null).
    people = people.map(p => ({ ...p, linkedin_url: null }));
    if (linkedinResults !== null) {
      priorityIdx.forEach(({ i }, j) => {
        people[i].linkedin_url = linkedinResults[j].status === 'fulfilled' ? linkedinResults[j].value : null;
      });
    } else {
      console.log('[vault-linkedin] enrichment phase skipped — out of time budget (', remainingBudgetMs, 'ms remaining)');
    }
  } else {
    people = people.map(p => ({ ...p, linkedin_url: null }));
  }

  await cacheSetLeadership(cacheKey, { people });

  return {
    cert,
    name: inst.NAME,
    city: inst.CITY,
    state: inst.STALP,
    company_linkedin_url: companyLinkedInUrl,
    people,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };

}

// Cache-only batch read across many banks at once. Deliberately never calls
// fetchLeadershipFromClaude or Bright Data — this is a fast first pass over
// whatever's already been resolved (by anyone, on either surface, since the
// site and MCP share the same vault-leadership-cache store). Real enrichment
// for cache_misses still has to go through getBankLeadership one cert at a
// time, same as always; this tool just makes it cheap to see, across a whole
// list of banks, which ones need that follow-up and which are already done.
async function getBankLeadershipBulk(args) {
  const { certs } = args || {};
  if (!Array.isArray(certs) || !certs.length) throw new Error('Required parameter "certs" missing or empty — pass an array of FDIC certificate numbers.');
  const capped = certs.slice(0, 100).map(String);

  const results = await Promise.all(capped.map(async cert => {
    const cacheKey = `leadership-${cert}`;
    const cached = await cacheGetLeadership(cacheKey);
    if (cached) {
      return {
        cert,
        cached: true,
        people: cached.people || [],
        company_linkedin_url: cached.company_linkedin_url || null,
        age_hours: Math.round((Date.now() - cached._cached_at) / 3600000),
      };
    }
    return { cert, cached: false, people: [] };
  }));

  return {
    results,
    cache_misses: results.filter(r => !r.cached).map(r => r.cert),
    checked: capped.length,
    hit_count: results.filter(r => r.cached).length,
  };
}

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
  if (!cert) throw new Error('Required parameter "cert" missing. Use search_institutions to get a CERT first.');

  // ── Cache check ──────────────────────────────────────────────────────────
  const cacheKey = `bank-profile-${cert}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };
  }

  // ── Cache miss: fetch from FDIC ──────────────────────────────────────────
  const instFields = 'NAME,CERT,CITY,STALP,ADDRESS,ZIP,WEBADDR,ESTYMD,ACTIVE,INSTCAT,CHRTAGNT,REPDTE,ASSET,DEP,EQ,NETINC,STNAME,NAMEHCR';
  const finFields = 'REPDTE,ASSET,DEP,EQ,NETINC,RBC1AAJ,ROA,ROE,NIMY,NCLNLSR,LNLSDEPR,NUMEMP';
  const [iR, fR] = await Promise.all([
    fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=${instFields}&limit=1`),
    fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=${finFields}&limit=8&sort_by=REPDTE&sort_order=DESC`),
  ]);
  const inst = iR.data?.[0]?.data;
  const history = (fR.data || []).map(d => d.data);
  if (!inst && !history.length) throw new Error(`No institution found for CERT ${cert}`);
  const latest = history[0] || {};
  const result = {
    cert,
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
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };

  // Store in cache — awaited, not fire-and-forget. Serverless containers can
  // freeze immediately after the response returns, racing an unawaited write;
  // this was silently dropping cache stores on faster-returning endpoints.
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getIndustryMetrics(args) {
  const { year } = args || {};
  const cacheKey = `industry-metrics-${year || 'current'}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

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
  const result = {
    period: allRecs[0]?.REPDTE,
    total_banks: allRecs.length,
    total_assets_thousands: totalAssets,
    total_deposits_thousands: totalDeposits,
    total_net_income_thousands: totalNetInc,
    avg_roa_percent: Number(avgROA.toFixed(3)),
    avg_roe_percent: Number(avgROE.toFixed(2)),
    avg_nim_percent: Number(avgNIM.toFixed(3)),
    industry_url: 'https://vaultbot.ai/industry',
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getRecentCharters(args) {
  const { year } = args || {};
  const cacheKey = `recent-charters-${year || 'all'}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  const fields = 'NAME,CERT,CITY,STALP,ASSET,ESTYMD,CHRTAGNT,WEBADDR,NAMEHCR';
  const filters = year
    ? `ESTYMD%3A%5B${year}0101%20TO%20${year}1231%5D%20AND%20ACTIVE%3A1`
    : `ESTYMD%3A%5B20230101%20TO%2099999999%5D%20AND%20ACTIVE%3A1`;
  const r = await fetchFDIC(`${FDIC_BASE}/institutions?filters=${filters}&fields=${fields}&limit=100&sort_by=ESTYMD&sort_order=DESC`).catch(() => ({ data: [] }));
  const charters = (r.data || []).map(d => ({
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
  const result = {
    charters,
    count: charters.length,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getMAActivity(args) {
  const { year, limit = 50 } = args || {};
  const max = Math.min(Number(limit) || 50, 200);
  const cacheKey = `ma-activity-${year || 'all'}-${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  const fields = 'TRANSNUM,EFFDATE,CHANGECODE_DESC,ACQ_INSTNAME,ACQ_CERT,ACQ_PCITY,ACQ_PSTALP,OUT_INSTNAME,OUT_CERT,OUT_PCITY,OUT_PSTALP,ASSISTED_PAYOUT_FLAG';
  let filters = 'REPORT_TYPE%3A223';
  if (year) filters += `%20AND%20EFFDATE%3A%5B${year}0101%20TO%20${year}1231%5D`;
  else filters += `%20AND%20EFFDATE%3A%5B20230101%20TO%2099999999%5D`;
  const r = await fetchFDIC(`${FDIC_BASE}/history?filters=${filters}&fields=${fields}&limit=${max}&sort_by=EFFDATE&sort_order=DESC`).catch(() => ({ data: [] }));
  const seen = new Map();
  (r.data || []).forEach(d => {
    if (!seen.has(d.data.TRANSNUM)) seen.set(d.data.TRANSNUM, d.data);
  });
  const transactions = [...seen.values()].map(d => ({
    transaction_number: d.TRANSNUM,
    effective_date: d.EFFDATE,
    transaction_type: d.ASSISTED_PAYOUT_FLAG ? 'failure' : 'merger',
    acquirer: { name: d.ACQ_INSTNAME, cert: d.ACQ_CERT, city: d.ACQ_PCITY, state: d.ACQ_PSTALP },
    acquired: { name: d.OUT_INSTNAME, cert: d.OUT_CERT, city: d.OUT_PCITY, state: d.OUT_PSTALP },
  }));
  const result = {
    transactions,
    count: transactions.length,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getLenderRankings(args) {
  const { state, city, loan_type = 'residential', asset_size = 'community', limit = 25 } = args || {};
  const max = Math.min(Number(limit) || 25, 100);
  const cacheKey = `lender-rankings-${state || 'all'}-${city || 'all'}-${loan_type}-${asset_size}-${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

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

  const fields    = 'NAME,CERT,CITY,STALP,ASSET,WEBADDR';
  const finFields = 'CERT,RBC1AAJ,ROA,NCLNLSR,LNLSNET,ASSET,REPDTE';

  // 100 rows instead of 200 — still plenty for ranking, ~40% faster FDIC response
  const [instR, finR] = await Promise.all([
    fetchFDIC(`${FDIC_BASE}/institutions?filters=${instFilters}&fields=${fields}&limit=100&sort_by=ASSET&sort_order=DESC`).catch(() => ({ data: [] })),
    // Sorted by REPDTE (most recent quarter first), NOT by ASSET. The FDIC
    // financials dataset is one row PER INSTITUTION PER QUARTER going back
    // years — sorting by ASSET DESC with no date constraint (the original
    // bug here) let a handful of institutions' entire multi-year quarterly
    // history dominate the top 100 rows, starving out every other
    // institution's join and silently collapsing results to a tiny fraction
    // of the real count (confirmed live: Oklahoma community banks returned
    // only 5 of 9+ known-active institutions). Sorting by REPDTE DESC + a
    // larger limit + de-dup-to-most-recent-per-CERT below fixes this: since
    // most banks share standard quarter-end report dates, the most recent
    // REPDTE alone typically covers every matching institution's current
    // financials.
    fetchFDIC(`${FDIC_BASE}/financials?filters=${instFilters}&fields=${finFields}&limit=500&sort_by=REPDTE&sort_order=DESC`).catch(() => ({ data: [] })),
  ]);
  const insts = (instR.data || []).map(d => d.data).filter(Boolean);
  if (!insts.length) {
    const empty = { rankings: [], count: 0, _cache: { hit: false, stored_at: new Date().toISOString() } };
    await cacheSet(cacheKey, empty).catch(() => {});
    return empty;
  }

  // De-dupe to each CERT's most recent quarter — first occurrence wins since
  // rows are sorted REPDTE DESC.
  const fins = new Map();
  for (const d of (finR.data || [])) {
    const rec = d.data;
    if (rec?.CERT && !fins.has(rec.CERT)) fins.set(rec.CERT, rec);
  }

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
  const rankings = scored.slice(0, max);
  const result = {
    rankings,
    count: rankings.length,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getAssetQualityDetail(args) {
  const { cert, quarters = 4 } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');
  const max = Math.min(Math.max(Number(quarters) || 4, 1), 8);

  // Cache key includes quarters so different depth requests cache separately
  const cacheKey = `asset-quality-${cert}-q${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  // FDIC asset quality fields — using fields verified against the BankFind v2 API.
  // Past-due aging is not consistently exposed at the consolidated level via this API; we use
  // FDIC's pre-computed noncurrent ratio (NCLNLSR) and core asset-quality fields.
  // Core fields confirmed working:
  //   NCLNLSR: Noncurrent loans % (precomputed by FDIC)
  //   LNATRES: Allowance for Loan & Lease Losses (loan loss reserves)
  //   ORE: Other Real Estate Owned (OREO)
  //   NTLNLSQ: Net charge-offs to loans QTD
  //   LNLSGR: Gross loans (denominator)
  //   ASSET: Total assets
  //   ELNATR: Earnings, Loan Loss Allowance Provision
  const finFields = 'REPDTE,LNLSGR,ASSET,ORE,LNATRES,NTLNLSQ,NCLNLSR,ELNATR';

  let history;
  try {
    const fR = await fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=${finFields}&limit=${max}&sort_by=REPDTE&sort_order=DESC`);
    history = (fR.data || []).map(d => d.data).filter(Boolean);
  } catch (e) {
    throw new Error(`Asset quality lookup for CERT ${cert}: ${e.message}`);
  }
  if (!history.length) throw new Error(`No financial data found for CERT ${cert}. The certificate may be inactive or not FDIC-insured. Verify with search_institutions or get_bank_profile first.`);

  // Also fetch institution name for context
  const iR = await fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP&limit=1`).catch(() => ({ data: [] }));
  const inst = iR.data?.[0]?.data;

  const quarterly = history.map(h => {
    const grossLoans = Number(h.LNLSGR) || 0;
    const totalAssets = Number(h.ASSET) || 0;
    const oreo = Number(h.ORE) || 0;
    const reserves = Number(h.LNATRES) || 0;
    const provision = Number(h.ELNATR) || 0;
    const noncurrentPct = h.NCLNLSR != null ? Number(h.NCLNLSR) : null;
    // Derive noncurrent loans $ from FDIC's precomputed ratio
    const noncurrentLoans = (noncurrentPct != null && grossLoans > 0) ? Math.round(grossLoans * noncurrentPct / 100) : null;
    const chargeoffPct = h.NTLNLSQ != null ? Number(h.NTLNLSQ) : null;

    return {
      report_date: h.REPDTE,
      // Dollar amounts (thousands)
      gross_loans_thousands: grossLoans,
      noncurrent_loans_thousands: noncurrentLoans,
      oreo_thousands: oreo,
      loan_loss_reserves_thousands: reserves,
      loan_loss_provision_ytd_thousands: provision,
      // Ratios
      noncurrent_loans_percent: noncurrentPct,
      net_chargeoffs_to_loans_qtd_percent: chargeoffPct,
      reserves_to_loans_percent: grossLoans > 0 ? Number((reserves / grossLoans * 100).toFixed(2)) : null,
      reserve_coverage_of_noncurrent_percent: (noncurrentLoans && noncurrentLoans > 0) ? Number((reserves / noncurrentLoans * 100).toFixed(1)) : null,
      oreo_to_assets_percent: totalAssets > 0 ? Number((oreo / totalAssets * 100).toFixed(3)) : null,
      problem_assets_thousands: (noncurrentLoans || 0) + oreo,
      problem_assets_to_loans_percent: grossLoans > 0 ? Number(((((noncurrentLoans || 0) + oreo) / grossLoans) * 100).toFixed(2)) : null,
    };
  });

  const result = {
    cert,
    name: inst?.NAME || `CERT ${cert}`,
    city: inst?.CITY,
    state: inst?.STALP,
    quarters_returned: quarterly.length,
    latest_quarter: quarterly[0] || null,
    quarterly_history: quarterly,
    interpretation_notes: {
      noncurrent_loans_percent: 'FDIC-precomputed ratio. Industry healthy range: 0.5–1.5%. Above 3% indicates elevated credit stress.',
      reserve_coverage_of_noncurrent_percent: 'Above 100% means reserves fully cover noncurrent loans. Below 60% may indicate under-reserving.',
      net_chargeoffs_to_loans_qtd_percent: 'Quarter-to-date net charge-offs as % of loans. Annualized rate above 0.5% is elevated.',
      oreo: 'Other Real Estate Owned — foreclosed properties on bank balance sheet. New OREO often signals worked-out problem loans.',
      note: 'Past-due aging bucket detail (30-89, 90+) is sourced from Call Report Schedule RC-N and not available via this consolidated API endpoint. For aging buckets at the institution level, consult the bank\'s Call Report directly.',
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getLoanMix(args) {
  const { cert, quarters = 1 } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');
  const max = Math.min(Math.max(Number(quarters) || 1, 1), 8);

  const cacheKey = `loan-mix-${cert}-q${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  // FDIC loan mix fields. LNREMULT (multifamily) is the most likely to cause field-name issues
  // in BankFind v2, so we try with it first, then fall back without it if FDIC rejects the query.
  const fieldsWithMult = 'REPDTE,LNLSGR,LNRE,LNRECONS,LNRENRES,LNRERES,LNREMULT,LNCI,LNAG,LNCON';
  const fieldsNoMult   = 'REPDTE,LNLSGR,LNRE,LNRECONS,LNRENRES,LNRERES,LNCI,LNAG,LNCON';

  let history = null;
  let usedMultifamily = true;
  try {
    const fR = await fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=${fieldsWithMult}&limit=${max}&sort_by=REPDTE&sort_order=DESC`);
    history = (fR.data || []).map(d => d.data).filter(Boolean);
  } catch (e) {
    // If FDIC rejected the field list (HTTP 400), retry without LNREMULT
    if (e.message.includes('400') || e.message.toLowerCase().includes('field')) {
      const fR = await fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=${fieldsNoMult}&limit=${max}&sort_by=REPDTE&sort_order=DESC`);
      history = (fR.data || []).map(d => d.data).filter(Boolean);
      usedMultifamily = false;
    } else {
      throw e; // re-throw rate limit, timeout, etc.
    }
  }

  if (!history || !history.length) {
    throw new Error(`No financial data found for CERT ${cert}. The certificate may be inactive or not FDIC-insured. Verify with search_institutions or get_bank_profile first.`);
  }

  // Institution name for context
  const iR = await fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP&limit=1`).catch(() => ({ data: [] }));
  const inst = iR.data?.[0]?.data;

  const pct = (n, d) => d > 0 ? Number((n / d * 100).toFixed(2)) : null;

  const quarterly = history.map(h => {
    const total = Number(h.LNLSGR) || 0;
    const totalRE = Number(h.LNRE) || 0;
    const construction = Number(h.LNRECONS) || 0;
    const cre = Number(h.LNRENRES) || 0;
    const resi = Number(h.LNRERES) || 0;
    const multifamily = usedMultifamily ? (Number(h.LNREMULT) || 0) : null;
    const ci = Number(h.LNCI) || 0;
    const ag = Number(h.LNAG) || 0;
    const consumer = Number(h.LNCON) || 0;
    const otherLoans = Math.max(0, total - totalRE - ci - ag - consumer);

    const reBreakdown = {
      residential_1_4_family: { thousands: resi, percent_of_loans: pct(resi, total), percent_of_re: pct(resi, totalRE) },
      commercial_real_estate: { thousands: cre, percent_of_loans: pct(cre, total), percent_of_re: pct(cre, totalRE) },
      construction_land_dev: { thousands: construction, percent_of_loans: pct(construction, total), percent_of_re: pct(construction, totalRE) },
    };
    if (multifamily !== null) {
      reBreakdown.multifamily = { thousands: multifamily, percent_of_loans: pct(multifamily, total), percent_of_re: pct(multifamily, totalRE) };
    }

    return {
      report_date: h.REPDTE,
      gross_loans_thousands: total,
      // Top-level category breakdown
      categories: {
        real_estate: { thousands: totalRE, percent_of_loans: pct(totalRE, total) },
        commercial_industrial: { thousands: ci, percent_of_loans: pct(ci, total) },
        agricultural: { thousands: ag, percent_of_loans: pct(ag, total) },
        consumer: { thousands: consumer, percent_of_loans: pct(consumer, total) },
        other: { thousands: otherLoans, percent_of_loans: pct(otherLoans, total) },
      },
      // Real estate subcategories
      real_estate_breakdown: reBreakdown,
      // Concentration flags
      concentration_flags: {
        commercial_re_concentration_percent: pct(cre + construction, total),
        cre_construction_warning: pct(cre + construction, total) > 300 ? 'High CRE+Construction concentration vs capital (regulator threshold)' : null,
      },
    };
  });

  const result = {
    cert,
    name: inst?.NAME || `CERT ${cert}`,
    city: inst?.CITY,
    state: inst?.STALP,
    quarters_returned: quarterly.length,
    latest_quarter: quarterly[0] || null,
    quarterly_history: quarterly,
    multifamily_data_available: usedMultifamily,
    interpretation_notes: {
      categories: 'Five top-level loan categories. Percentages are of gross loans & leases.',
      real_estate_breakdown: 'RE subcategories break out the key types regulators watch.',
      cre_concentration: 'Commercial RE + Construction over 300% of risk-based capital flags regulator attention (FDIC FIL-22-2006).',
      multifamily: usedMultifamily ? 'Multifamily (5+ unit residential) included.' : 'Multifamily data not available in this query (FDIC field not exposed for this institution).',
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getBrokeredDeposits(args) {
  const { cert, quarters = 4 } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');
  const max = Math.min(Math.max(Number(quarters) || 4, 1), 8);

  const cacheKey = `brokered-deposits-${cert}-q${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  // BRO = Brokered deposits (thousands), DEP = Total deposits (thousands)
  const finFields = 'REPDTE,DEP,BRO,ASSET';
  let history;
  try {
    const fR = await fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=${finFields}&limit=${max}&sort_by=REPDTE&sort_order=DESC`);
    history = (fR.data || []).map(d => d.data).filter(Boolean);
  } catch (e) {
    throw new Error(`Brokered deposits lookup for CERT ${cert}: ${e.message}`);
  }
  if (!history.length) throw new Error(`No financial data found for CERT ${cert}. The certificate may be inactive or not FDIC-insured. Verify with search_institutions or get_bank_profile first.`);

  const iR = await fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP&limit=1`).catch(() => ({ data: [] }));
  const inst = iR.data?.[0]?.data;

  const pct = (n, d) => d > 0 ? Number((n / d * 100).toFixed(2)) : null;

  const quarterly = history.map(h => {
    const dep = Number(h.DEP) || 0;
    const bro = Number(h.BRO) || 0;
    const broPct = pct(bro, dep);
    let riskLevel = 'low';
    if (broPct !== null) {
      if (broPct >= 40) riskLevel = 'high';
      else if (broPct >= 20) riskLevel = 'elevated';
    }
    return {
      report_date: h.REPDTE,
      total_deposits_thousands: dep,
      brokered_deposits_thousands: bro,
      brokered_deposits_percent_of_total: broPct,
      funding_risk_level: riskLevel,
    };
  });

  const result = {
    cert,
    name: inst?.NAME || `CERT ${cert}`,
    city: inst?.CITY,
    state: inst?.STALP,
    quarters_returned: quarterly.length,
    latest_quarter: quarterly[0] || null,
    quarterly_history: quarterly,
    interpretation_notes: {
      brokered_deposits: 'Deposits a bank purchases through a broker rather than gathers directly from local customers. Not inherently bad, but a fast-growing or high level relative to total deposits can indicate reliance on less-stable, rate-sensitive "hot money" funding.',
      funding_risk_level: 'Qualitative guidance, not a formal regulatory threshold: under 20% = low, 20-39% = elevated, 40%+ = high. Compare against peers and trend direction — a rising trend matters more than a single snapshot.',
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getBranchData(args) {
  const { cert, state, limit = 50 } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const cacheKey = `branch-data-${cert}-${state || 'all'}-l${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  // Full field set first; SOD field names are less battle-tested in this codebase than
  // the /financials fields, so fall back to a smaller safe subset if FDIC rejects the query.
  const fieldsFull = 'CERT,NAMEFULL,ADDRESBR,CITYBR,STALPBR,ZIPBR,DEPSUMBR,BRSERTYP,ESTYMD,RUNDATE,MAINOFF,UNINUMBR';
  const fieldsSafe = 'CERT,NAMEFULL,CITYBR,STALPBR,DEPSUMBR,MAINOFF,RUNDATE';

  let branchFilters = `CERT%3A${cert}`;
  if (state) branchFilters += `%20AND%20STALPBR%3A${state.toUpperCase()}`;

  let rows;
  let usedFullFields = true;
  try {
    // Pull a generous batch sorted by most recent RUNDATE first, since SOD is an annual
    // snapshot and a given CERT will have one row per branch per year on file.
    const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}&fields=${fieldsFull}&limit=200&sort_by=RUNDATE&sort_order=DESC`);
    rows = (r.data || []).map(d => d.data).filter(Boolean);
  } catch (e) {
    if (e.message.includes('400') || e.message.toLowerCase().includes('field')) {
      usedFullFields = false;
      const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}&fields=${fieldsSafe}&limit=200&sort_by=RUNDATE&sort_order=DESC`);
      rows = (r.data || []).map(d => d.data).filter(Boolean);
    } else {
      throw new Error(`Branch data lookup for CERT ${cert}: ${e.message}`);
    }
  }

  if (!rows.length) throw new Error(`No branch data found for CERT ${cert}${state ? ` in ${state.toUpperCase()}` : ''}. The certificate may be inactive, not FDIC-insured, or have no branches in that state. Verify with search_institutions or get_bank_profile first.`);

  // SOD returns one row per branch per filing year — keep only the most recent year present
  const latestRunDate = rows.reduce((max, r) => (r.RUNDATE > max ? r.RUNDATE : max), rows[0].RUNDATE);
  let latestRows = rows.filter(r => r.RUNDATE === latestRunDate);

  // De-dupe by branch identifier if available, then cap to requested limit
  if (usedFullFields) {
    const seen = new Set();
    latestRows = latestRows.filter(r => {
      if (seen.has(r.UNINUMBR)) return false;
      seen.add(r.UNINUMBR);
      return true;
    });
  }
  latestRows = latestRows
    .sort((a, b) => (Number(b.DEPSUMBR) || 0) - (Number(a.DEPSUMBR) || 0))
    .slice(0, max);

  const totalBranchDeposits = latestRows.reduce((sum, r) => sum + (Number(r.DEPSUMBR) || 0), 0);

  const branches = latestRows.map(r => ({
    name: r.NAMEFULL || null,
    address: usedFullFields ? (r.ADDRESBR || null) : null,
    city: r.CITYBR || null,
    state: r.STALPBR || null,
    zip: usedFullFields ? (r.ZIPBR || null) : null,
    deposits_thousands: Number(r.DEPSUMBR) || 0,
    is_main_office: r.MAINOFF === '1' || r.MAINOFF === 1,
    established: usedFullFields ? (r.ESTYMD || null) : null,
  }));

  const result = {
    cert,
    as_of: latestRunDate,
    branch_count: branches.length,
    total_branch_deposits_thousands: totalBranchDeposits,
    state_filter: state ? state.toUpperCase() : null,
    branches,
    interpretation_notes: {
      source: 'FDIC Summary of Deposits (SOD) — an annual census of branch locations and deposits, filed as of June 30 each year. Not real-time; reflects the most recent annual filing on record.',
      branch_field_availability: usedFullFields ? 'Full field set returned (address, zip, establish date included).' : 'Reduced field set returned — some fields (address, zip, establish date) were not available for this query.',
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}


const TOOL_HANDLERS = {
  search_institutions: searchInstitutions,
  get_bank_profile: getBankProfile,
  get_industry_metrics: getIndustryMetrics,
  get_recent_charters: getRecentCharters,
  get_ma_activity: getMAActivity,
  get_lender_rankings: getLenderRankings,
  get_asset_quality_detail: getAssetQualityDetail,
  get_loan_mix: getLoanMix,
  get_brokered_deposits: getBrokeredDeposits,
  get_branch_data: getBranchData,
  get_bank_leadership: getBankLeadership,
  get_bank_leadership_bulk: getBankLeadershipBulk,
  trigger_linkedin_match: triggerLinkedinMatch,
  check_linkedin_match: checkLinkedinMatch,
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
        name: 'vault-mcp', version: '1.11.2',
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
          serverInfo: { name: 'vault-mcp', version: '1.11.2' },
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
        const toolStart = Date.now();
        const data = await handler(args || {});
        const durationMs = Date.now() - toolStart;
        // Attach timing so the AI agent can naturally report "fetched in X seconds"
        // without the user wondering if something hung.
        const enriched = typeof data === 'object' && data !== null && !Array.isArray(data)
          ? { ...data, _vault_meta: { fetched_in_ms: durationMs, fetched_in_s: Number((durationMs/1000).toFixed(1)), powered_by: 'Vault MCP by iDENTIFY · vaultbot.ai' } }
          : data;
        await safeLog({ method, toolName, durationMs: Date.now()-t0, success: true });
        return reply({
          content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
          isError: false,
        });
      }

      case 'ping':
        return reply({});

      // MCP protocol notifications — client-to-server signals that don't need a response.
      // Per JSON-RPC 2.0 spec, these have no 'id' field. We return 200 with empty body
      // (more compatible with HTTP-bridged MCP clients than 204 No Content).
      case 'initialized':
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
      case 'notifications/cancelled':
      case 'notifications/progress':
        await safeLog({ method, durationMs: Date.now()-t0, success: true });
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: '',
        };

      default:
        // Treat any other 'notifications/*' or methods without an id as silent notifications
        if (method?.startsWith('notifications/') || id === undefined || id === null) {
          await safeLog({ method, durationMs: Date.now()-t0, success: true });
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: '',
          };
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
