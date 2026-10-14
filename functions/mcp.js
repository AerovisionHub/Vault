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
    name: 'get_county_deposit_share',
    description: 'Get deposit market share and competitive rank by county, from the FDIC Summary of Deposits. Two ways to call it. (1) Pass `cert` to see every county a bank operates in, with its deposits, market share, rank, number of competing banks, and the top competitor in each — answers "where is this bank strong or weak," "which markets does it dominate," and "who is beating it in its own backyard." (2) Pass `county` plus `state` to get the full ranked leaderboard of every bank operating in that county — answers "who holds deposit share in this market" and "who would we compete against if we entered." Use the county name alone, without the word "County" (e.g. "Tulsa", not "Tulsa County"). All deposit figures are in thousands of dollars. Standard uses: Community Reinvestment Act deposit market-share analysis, M&A target screening, branch expansion and market-entry planning, and peer benchmarking within a footprint. Note: SOD is an annual filing as of each June 30, so this reflects the most recent annual snapshot, not real-time deposits. Typically responds in 3-8 seconds; a bank spanning many counties takes longer, since each county is ranked separately.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number. Returns this bank\'s share and rank in every county it operates in. Get from search_institutions. Provide this OR county+state.' },
        county: { type: 'string', description: 'County name without the word "County" (e.g. "Tulsa"). Must be paired with state. Returns the full ranked leaderboard for that county.' },
        state: { type: 'string', description: '2-letter state code (e.g. "OK"). Required when using county.' },
        limit: { type: 'number', description: 'Max banks returned in county leaderboard mode (default 25, max 200). Ignored in cert mode.' },
      },
    },
  },
  {
    name: 'get_county_demographics',
    description: 'Get county-level demographic and housing data from the U.S. Census Bureau American Community Survey (ACS 5-year): population, median household income, median family income, median home value, total/owner-occupied/renter-occupied housing units, poverty rate, and unemployment rate. Three ways to call it: `county` plus `state` for one county, `county_fips` for a direct 5-digit state+county FIPS lookup, or `cert` to get demographics for every county a bank operates in (joined through its FDIC branch footprint). Pair it with get_county_deposit_share to build a full market profile: deposit share and competitive rank from one, the demographics of that market from the other, keyed on the same county. Standard uses: Community Reinvestment Act performance evaluations (median FAMILY income is the basis for low/moderate-income thresholds, and is returned separately from household income), branch expansion and market-entry analysis, and assessing lending opportunity in a market. Use the county name without the word "County" (e.g. "Davidson", not "Davidson County"); Louisiana parishes and Alaska boroughs are handled too. Note: ACS is a rolling 5-year survey estimate, not a point-in-time count, and suppressed values are returned as null rather than Census\'s negative sentinel codes.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'County name without the word "County" (e.g. "Davidson"). Pair with state.' },
        state: { type: 'string', description: '2-letter state code (e.g. "TN"). Required when using county.' },
        county_fips: { type: 'string', description: '5-digit state+county FIPS (e.g. "47037"). Matches STCNTYBR from get_county_deposit_share.' },
        cert: { type: 'string', description: 'FDIC certificate number. Returns demographics for each county this bank operates in. Get from search_institutions.' },
      },
    },
  },
  {
    name: 'get_bank_leadership',
    description: 'Get key decision-makers for a specific bank, prioritized for B2B sales targeting: CEO/President, CIO/CTO (or closest functional equivalent at smaller banks), and COO -- each with name, title, role_category, source URL, and (when found) a LinkedIn profile URL. Useful for building sales target lists: call search_institutions or get_lender_rankings first to find candidate banks matching your criteria, then call this for each one to build out contacts ready for outreach. On an uncached bank, the FIRST call returns almost instantly (1-2 seconds) with status: "pending" -- enrichment runs in the background (can take 30 seconds to a few minutes, longer for banks with generic/common names) rather than blocking the call. Call this same tool again with the same cert a little later to check; it returns the finished result once ready, or another pending status if still running. Repeat calls on an already-resolved bank return in ~150ms (cached 30 days). linkedin_source tells you how a LinkedIn match was confirmed -- "brightdata_verified" (matched by name+company search, verified against real work history) or "ai_search_scrape_verified" (found via an AI web search, then independently confirmed by scraping that exact profile to check its real data) -- both are safe to use for outreach; null means no LinkedIn URL was found. Nothing is ever returned as an unverified guess. Returns an empty people list when no confident public leadership data can be found for the bank at all.',
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

async function cacheDeleteLeadership(key) {
  try {
    const store = await getLeadershipBlobStore();
    if (!store) return;
    await store.delete(key);
  } catch(e) {
    console.log('[vault-leadership-cache] cacheDeleteLeadership error:', e.message);
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

// DEAD CODE as of the leadership-background.js architectural change:
// getBankLeadership below no longer calls this directly (it hands off to
// leadership-background.js, which has its own copy with generous timeouts).
// Not called from anywhere in this file anymore; if you're debugging a
// LinkedIn company-search issue, you want functions/leadership-background.js.
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
// DEAD CODE as of the leadership-background.js architectural change — same
// situation as findCompanyLinkedInUrl above. Not called from anywhere in
// this file anymore.
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
      const candidates = Array.isArray(arr) ? arr : [];
      const match = candidates.find(c => c?.url && experienceMatchesCompany(c.experience, companyUrl));
      if (!match && candidates.length) {
        console.log('[vault-linkedin] REJECTED all', candidates.length, 'candidate(s) for', fullName, ':', candidates.map(c => `${c?.name} (${c?.experience})`).join(' | '));
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
  const candidates = Array.isArray(arr) ? arr : [];
  const pending = await cacheGetLeadership(`linkedin-pending-${snapshot_id}`);
  const match = candidates.find(c => c?.url && experienceMatchesCompany(c.experience, pending?.company_linkedin_url)) || null;

  if (candidates.length && !match) {
    console.log('[vault-linkedin] REJECTED all', candidates.length, 'candidate(s):', candidates.map(c => `${c?.name} (${c?.experience})`).join(' | '), '| expected company:', pending?.company_linkedin_url);
    return { snapshot_id, status: 'not_found', rejected_reason: 'experience did not mention target company — likely false match, not a real profile' };
  }

  if (match?.url) {
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

const LEADERSHIP_PENDING_TTL_MS = 10 * 60 * 1000; // 10 min — guards against a crashed background run leaving a stale pending marker that blocks retries forever

async function getBankLeadership(args) {
  const { cert } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');

  const cacheKey = `leadership-${cert}`;
  const cached = await cacheGetLeadership(cacheKey);
  if (cached) {
    return {
      cert,
      people: cached.people || [],
      company_linkedin_url: cached.company_linkedin_url || null,
      _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) },
    };
  }

  // Not cached. Rather than running the search inline and racing Netlify's
  // real ~26s ceiling (see leadership-background.js header comment for the
  // full history — confirmed live: "Security Bank," Tulsa OK, failed 5/5
  // times synchronously because its generic name forces Claude's search to
  // wade through unrelated same-named banks elsewhere), hand this off to a
  // background function with a genuinely generous budget (~15 min) and
  // return immediately. The caller (this tool, called again) picks up the
  // result once it's ready.
  const pendingKey = `leadership-pending-${cert}`;
  const pending = await cacheGetLeadership(pendingKey);
  if (pending && (Date.now() - pending._cached_at) < LEADERSHIP_PENDING_TTL_MS) {
    return {
      cert,
      status: 'pending',
      message: 'Enrichment already running for this bank. Typically takes 30-90 seconds (longer for banks with generic/common names) -- call get_bank_leadership again with this same cert to check.',
      started_at: new Date(pending._cached_at).toISOString(),
    };
  }

  const iR = await fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP,WEBADDR&limit=1`);
  const inst = iR.data?.[0]?.data;
  if (!inst) throw new Error(`No institution found for CERT ${cert}.`);

  await cacheSetLeadership(pendingKey, { started: true });

  const siteUrl = process.env.URL || 'https://vaultbot.ai';
  try {
    // Deliberately not awaited beyond the initial connection -- Netlify
    // returns 202 to this fetch almost immediately for a "-background"
    // function without waiting for its actual handler logic to run, so this
    // stays fast without needing any fire-and-forget tricks.
    await fetch(`${siteUrl}/.netlify/functions/leadership-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cert, name: inst.NAME, city: inst.CITY, state: inst.STALP, webAddr: inst.WEBADDR || null }),
    });
  } catch (e) {
    console.log('[vault-leadership] failed to trigger background enrichment for', cert, ':', e.message);
    await cacheDeleteLeadership(pendingKey).catch(() => {}); // clear the marker we just set -- the trigger itself failed, don't block future retries
    throw new Error(`Failed to start leadership enrichment: ${e.message}`);
  }

  return {
    cert,
    name: inst.NAME,
    city: inst.CITY,
    state: inst.STALP,
    status: 'pending',
    message: 'Enrichment started -- typically takes 30-90 seconds (longer for banks with generic/common names). Call get_bank_leadership again with this same cert to check.',
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
    // Vault's own website and the Wrapped OG-image renderer call this same
    // endpoint. Untagged, that first-party traffic is indistinguishable from a
    // real third-party MCP client — and Wrapped shares would inflate
    // get_lender_rankings without anyone actually using Vault.
    const source = event.headers?.['x-vault-source'] || 'mcp-client';
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);  // YYYY-MM-DD
    const callId = `${dayKey}/${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

    await store.setJSON(callId, {
      timestamp: now.toISOString(),
      method: method || null,
      tool: toolName || null,
      client: clientName || 'unknown',
      source,
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
    // total_calls counts EVERY JSON-RPC method — initialize, tools/list,
    // notifications/*, ping, tools/call. MCP clients (mcp-remote especially)
    // re-handshake constantly, so this number is dominated by protocol chatter
    // and is NOT a usage metric. It's kept for continuity; the tool_* fields
    // below are the ones that mean anything.
    existing.total_calls += 1;
    if (!existing.unique_ips.includes(hashIP(ip))) existing.unique_ips.push(hashIP(ip));
    if (clientName) existing.by_client[clientName] = (existing.by_client[clientName] || 0) + 1;
    if (success === false) existing.errors += 1;

    // Real work only. toolName is set exclusively on a tools/call, so these
    // fields answer "did somebody actually use Vault" rather than "did a
    // client reconnect."
    if (toolName) {
      existing.tool_calls = (existing.tool_calls || 0) + 1;
      existing.by_tool[toolName] = (existing.by_tool[toolName] || 0) + 1;
      if (success === false) existing.tool_errors = (existing.tool_errors || 0) + 1;

      if (!Array.isArray(existing.tool_unique_ips)) existing.tool_unique_ips = [];
      if (!existing.tool_unique_ips.includes(hashIP(ip))) existing.tool_unique_ips.push(hashIP(ip));

      // clientInfo only arrives on `initialize`, never on tools/call — which is
      // why by_client above has only ever measured handshakes. Fall back to the
      // user-agent so tool calls can be attributed to a client too.
      const attribution = clientName || userAgent.split(/[\s/]/)[0] || 'unknown';
      if (!existing.by_client_tools) existing.by_client_tools = {};
      existing.by_client_tools[attribution] = (existing.by_client_tools[attribution] || 0) + 1;

      // First-party vs third-party. tool_calls_external is the number that
      // actually answers "is anyone else using this."
      if (!existing.by_source) existing.by_source = {};
      existing.by_source[source] = (existing.by_source[source] || 0) + 1;
      if (source === 'mcp-client') {
        existing.tool_calls_external = (existing.tool_calls_external || 0) + 1;
      }

      // Latency per tool — matters for the 15s Perplexity ceiling and for
      // spotting a tool that has quietly gotten slow.
      if (typeof durationMs === 'number') {
        if (!existing.tool_latency) existing.tool_latency = {};
        const lat = existing.tool_latency[toolName] || { n: 0, sum: 0, max: 0 };
        lat.n += 1;
        lat.sum += durationMs;
        lat.max = Math.max(lat.max, durationMs);
        existing.tool_latency[toolName] = lat;
      }

      // Which tool is failing, not just how many failures there were.
      if (success === false) {
        if (!existing.errors_by_tool) existing.errors_by_tool = {};
        existing.errors_by_tool[toolName] = (existing.errors_by_tool[toolName] || 0) + 1;
      }
    }
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

  // SOD gotcha, verified against the live API 2026-09-07: RUNDATE is an ACCEPTED
  // field name but is never populated in a response, AND it is not sortable —
  // `sort_by=RUNDATE` returns HTTP 400 "No mapping found for [RUNDATE] in order
  // to sort on". YEAR is both populated and sortable. Use YEAR for sorting and
  // for picking the latest annual snapshot; do not reintroduce RUNDATE.
  const fieldsFull = 'CERT,NAMEFULL,ADDRESBR,CITYBR,STALPBR,ZIPBR,DEPSUMBR,BRSERTYP,ESTYMD,YEAR,MAINOFF,UNINUMBR';
  const fieldsSafe = 'CERT,NAMEFULL,CITYBR,STALPBR,DEPSUMBR,MAINOFF,YEAR';

  let branchFilters = `CERT%3A${cert}`;
  if (state) branchFilters += `%20AND%20STALPBR%3A${state.toUpperCase()}`;

  let rows;
  let usedFullFields = true;
  try {
    // Pull a generous batch sorted by most recent YEAR first, since SOD is an annual
    // snapshot and a given CERT will have one row per branch per year on file.
    const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}&fields=${fieldsFull}&limit=200&sort_by=YEAR&sort_order=DESC`);
    rows = (r.data || []).map(d => d.data).filter(Boolean);
  } catch (e) {
    if (e.message.includes('400') || e.message.toLowerCase().includes('field')) {
      usedFullFields = false;
      try {
        const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}&fields=${fieldsSafe}&limit=200&sort_by=YEAR&sort_order=DESC`);
        rows = (r.data || []).map(d => d.data).filter(Boolean);
      } catch (e2) {
        // Previously this escaped bare and surfaced to the user as a useless
        // "Internal error", which is exactly why the RUNDATE bug went
        // undiagnosed. Always say which tool failed and why.
        throw new Error(`Branch data lookup for CERT ${cert} failed on both full and reduced field sets. FDIC said: ${e2.message}`);
      }
    } else {
      throw new Error(`Branch data lookup for CERT ${cert}: ${e.message}`);
    }
  }

  if (!rows.length) throw new Error(`No branch data found for CERT ${cert}${state ? ` in ${state.toUpperCase()}` : ''}. The certificate may be inactive, not FDIC-insured, or have no branches in that state. Verify with search_institutions or get_bank_profile first.`);

  // SOD returns one row per branch per filing year — keep only the most recent
  // year. This previously compared RUNDATE, which is always undefined, so
  // `undefined === undefined` matched every row and silently blended ~20 years
  // of branch history into one "current" answer.
  const years = rows.map(r => Number(r.YEAR)).filter(y => !isNaN(y));
  const latestYear = years.length ? Math.max(...years) : null;
  let latestRows = latestYear != null ? rows.filter(r => Number(r.YEAR) === latestYear) : rows;

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
    as_of_year: latestYear,
    branch_count: branches.length,
    total_branch_deposits_thousands: totalBranchDeposits,
    state_filter: state ? state.toUpperCase() : null,
    branches,
    interpretation_notes: {
      source: `FDIC Summary of Deposits (SOD) — an annual census of branch locations and deposits, filed as of June 30 each year. Not real-time; these figures are the ${latestYear || 'latest'} filing.`,
      branch_field_availability: usedFullFields ? 'Full field set returned (address, zip, establish date included).' : 'Reduced field set returned — some fields (address, zip, establish date) were not available for this query.',
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result).catch(() => {});
  return result;
}


// ── get_county_deposit_share ────────────────────────────────────────────────
// Built from a real user workflow: an FDIC compliance examiner was using
// get_branch_data and then assembling deposit market share and rank-within-
// county by hand in a separate artifact, because Vault returned branches but
// never aggregated them. Everything here comes from SOD data the server
// already pulls — this just does the grouping and ranking server-side.
//
// Two modes:
//   cert            -> every county that bank operates in, with its share and rank
//   county + state  -> the full ranked leaderboard of banks in one county
//
// SOD gotchas that apply here exactly as they do in getBranchData: RUNDATE is
// accepted but never populated and is NOT sortable (sort_by=RUNDATE returns
// HTTP 400). YEAR is both. Never reintroduce RUNDATE.
const COUNTY_SOD_FIELDS = 'CERT,NAMEFULL,CNTYNAMB,STCNTYBR,STALPBR,DEPSUMBR,YEAR';
const COUNTY_FETCH_LIMIT = 2000;  // largest US counties run ~1,500 branches
const MAX_COUNTIES_PER_BANK = 10; // bounds fan-out: one API call per county

// Aggregate branch rows into one ranked row per bank. Deposits are summed per
// CERT because a bank books deposits at many branches inside one county.
function rankBanksInCounty(rows) {
  const byCert = new Map();
  for (const r of rows) {
    const cert = String(r.CERT);
    const dep = Number(r.DEPSUMBR) || 0;
    const cur = byCert.get(cert) || { cert, name: r.NAMEFULL, deposits: 0, branches: 0 };
    cur.deposits += dep;
    cur.branches += 1;
    byCert.set(cert, cur);
  }
  const banks = [...byCert.values()].sort((a, b) => b.deposits - a.deposits);
  const total = banks.reduce((s, b) => s + b.deposits, 0);
  banks.forEach((b, i) => {
    b.rank = i + 1;
    // Guard against a county whose rows all report zero deposits, which would
    // otherwise produce NaN% across the whole leaderboard.
    b.market_share_pct = total > 0 ? Number((b.deposits / total * 100).toFixed(2)) : null;
  });
  return { banks, total_county_deposits: total, bank_count: banks.length };
}

// Resolve the newest filing year with a 1-row probe BEFORE pulling rows.
// Without this, an unfiltered query drags in every historical year (Tulsa
// County OK returns ~6,300 rows across ~20 years for ~200 actual branches),
// burns the page limit on history, and makes the row-count check meaningless.
// Filtering to one year up front keeps the page small and makes the
// incomplete_warning mean what it says.
async function latestSodYear(filters) {
  const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${filters}&fields=YEAR&limit=1&sort_by=YEAR&sort_order=DESC`);
  const row = (r.data || []).map(d => d.data).filter(Boolean)[0];
  const y = row ? Number(row.YEAR) : NaN;
  return isNaN(y) ? null : y;
}

async function fetchCountyRows(filters) {
  const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${filters}&fields=${COUNTY_SOD_FIELDS}&limit=${COUNTY_FETCH_LIMIT}&sort_by=YEAR&sort_order=DESC`);
  return {
    rows: (r.data || []).map(d => d.data).filter(Boolean),
    reported_total: r.meta?.total ?? null,
  };
}

async function getCountyDepositShare(args) {
  const { cert, county, state, limit = 25 } = args || {};
  if (!cert && !(county && state)) {
    throw new Error('Provide either "cert" (to see every county that bank competes in) or both "county" and "state" (to see the ranked leaderboard for one county). Get a CERT from search_institutions.');
  }
  const max = Math.min(Math.max(Number(limit) || 25, 1), 200);

  // ── Mode B: one county, full leaderboard ──────────────────────────────────
  if (!cert) {
    const st = String(state).toUpperCase();
    const cacheKey = `county-share-${st}-${String(county).toLowerCase()}-l${max}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

    const nameFilter = `CNTYNAMB%3A%22${encodeURIComponent(county)}%22%20AND%20STALPBR%3A${st}`;
    let year, probe;
    try {
      year = await latestSodYear(nameFilter);
      if (year == null) {
        throw new Error(`No FDIC branch data found for county "${county}" in ${st}. Use the county name only, without the word "County" (e.g. "Tulsa", not "Tulsa County"), and confirm the state code is right.`);
      }
      probe = await fetchCountyRows(`${nameFilter}%20AND%20YEAR%3A${year}`);
    } catch (e) {
      if (e.message.startsWith('No FDIC branch data')) throw e;
      throw new Error(`County lookup for "${county}, ${st}" failed. FDIC said: ${e.message}`);
    }
    if (!probe.rows.length) {
      throw new Error(`No FDIC branch data found for county "${county}" in ${st} for filing year ${year}.`);
    }
    const rows = probe.rows;
    const { banks, total_county_deposits, bank_count } = rankBanksInCounty(rows);

    const result = {
      mode: 'county_leaderboard',
      county: rows[0].CNTYNAMB,
      state: st,
      county_fips: rows[0].STCNTYBR ?? null,
      as_of_year: year,
      bank_count,
      total_county_deposits_thousands: total_county_deposits,
      banks: banks.slice(0, max),
      truncated: banks.length > max ? { showing: max, of: banks.length } : null,
      // Surfaced rather than swallowed: if SOD held more branch rows than one
      // page returned, the ranking is computed on a partial county and the
      // caller needs to know rather than trust a silently wrong rank.
      incomplete_warning: (probe.reported_total && probe.reported_total > probe.rows.length)
        ? `FDIC reported ${probe.reported_total} branch rows but only ${probe.rows.length} were retrieved; ranking may be incomplete for this county.`
        : null,
      source: 'FDIC Summary of Deposits (SOD), annual branch-level filing as of June 30',
    };
    await cacheSet(cacheKey, result);
    return result;
  }

  // ── Mode A: one bank, its rank in every county it operates in ─────────────
  const cacheKey = `county-share-cert-${cert}-l${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  let bankProbe, year;
  try {
    year = await latestSodYear(`CERT%3A${cert}`);
    if (year == null) {
      throw new Error(`No branch data found for CERT ${cert}. It may be inactive or not FDIC-insured. Verify with search_institutions.`);
    }
    // Year-filtered for the same reason as county mode: a large multi-state
    // bank has thousands of branch-years on file and would blow the page cap.
    bankProbe = await fetchCountyRows(`CERT%3A${cert}%20AND%20YEAR%3A${year}`);
  } catch (e) {
    if (e.message.startsWith('No branch data found')) throw e;
    throw new Error(`Branch lookup for CERT ${cert} failed. FDIC said: ${e.message}`);
  }
  if (!bankProbe.rows.length) {
    throw new Error(`No branch data found for CERT ${cert} in filing year ${year}.`);
  }
  const bankRows = bankProbe.rows;

  // Group the bank's own branches by county first, so we only query the
  // counties it actually competes in.
  const own = new Map();
  for (const r of bankRows) {
    const fips = String(r.STCNTYBR);
    const cur = own.get(fips) || { county_fips: r.STCNTYBR, county: r.CNTYNAMB, state: r.STALPBR, deposits: 0, branches: 0 };
    cur.deposits += Number(r.DEPSUMBR) || 0;
    cur.branches += 1;
    own.set(fips, cur);
  }
  const ordered = [...own.values()].sort((a, b) => b.deposits - a.deposits);
  const selected = ordered.slice(0, MAX_COUNTIES_PER_BANK);

  const counties = [];
  for (const c of selected) {
    try {
      const probe = await fetchCountyRows(`STCNTYBR%3A${c.county_fips}%20AND%20YEAR%3A${year}`);
      const { banks, total_county_deposits, bank_count } = rankBanksInCounty(probe.rows);
      const me = banks.find(b => String(b.cert) === String(cert));
      counties.push({
        county: c.county,
        state: c.state,
        county_fips: c.county_fips,
        bank_deposits_thousands: c.deposits,
        bank_branches: c.branches,
        total_county_deposits_thousands: total_county_deposits,
        market_share_pct: me ? me.market_share_pct : null,
        rank: me ? me.rank : null,
        banks_in_county: bank_count,
        top_competitor: banks[0] && String(banks[0].cert) !== String(cert)
          ? { cert: banks[0].cert, name: banks[0].name, market_share_pct: banks[0].market_share_pct }
          : (banks[1] ? { cert: banks[1].cert, name: banks[1].name, market_share_pct: banks[1].market_share_pct } : null),
      });
    } catch (e) {
      // One county failing must not void the whole answer — report it in place.
      counties.push({ county: c.county, state: c.state, county_fips: c.county_fips,
        bank_deposits_thousands: c.deposits, bank_branches: c.branches, error: e.message });
    }
  }

  const result = {
    mode: 'bank_county_footprint',
    cert: String(cert),
    bank_name: bankRows[0].NAMEFULL,
    as_of_year: year,
    county_count: ordered.length,
    counties,
    truncated: ordered.length > selected.length
      ? { showing: selected.length, of: ordered.length, note: `Showing the ${selected.length} counties where this bank holds the most deposits.` }
      : null,
    source: 'FDIC Summary of Deposits (SOD), annual branch-level filing as of June 30',
  };
  await cacheSet(cacheKey, result);
  return result;
}

// ── get_county_demographics ─────────────────────────────────────────────────
// The second item from the FDIC examiner call: every CRA performance
// evaluation carries standardized demographic tables (median family income,
// median housing value, unemployment, owner-occupied units, lending
// opportunity counts), and they all come from Census ACS. Pairing them with
// the deposit-share tool means one agent can assemble a CRA market profile
// without leaving the MCP.
//
// The join is free: SOD's STCNTYBR is already the 5-digit state+county FIPS
// that Census keys on (40143 = state 40, county 143), so bank footprint and
// demographics line up with no crosswalk table.
//
// Needs CENSUS_API_KEY. Census dropped its keyless allowance — every data
// request 302s to a "Missing Key" page without one. Metadata endpoints are
// still keyless, which is how the variable IDs below were verified.
const CENSUS_VINTAGE = 2024; // newest ACS 5-year; 2025 returns 404 as of Oct 2026
const CENSUS_BASE = `https://api.census.gov/data/${CENSUS_VINTAGE}/acs/acs5`;

// Verified against the live variables endpoint before coding — do not swap
// these for look-alikes. B19113 (FAMILY income) is the one CRA low/moderate
// income thresholds are built on; B19013 (HOUSEHOLD income) is a different
// number and is kept alongside it rather than substituted.
const CENSUS_VARS = {
  B01003_001E: 'population',
  B19013_001E: 'median_household_income',
  B19113_001E: 'median_family_income',
  B25077_001E: 'median_home_value',
  B25001_001E: 'housing_units_total',
  B25003_002E: 'housing_units_owner_occupied',
  B25003_003E: 'housing_units_renter_occupied',
  B17001_002E: 'population_below_poverty',
};
// Unemployment lives in the SUBJECT table family, a separate endpoint — it
// cannot be requested in the same call as the detail variables above.
const CENSUS_SUBJECT_BASE = `https://api.census.gov/data/${CENSUS_VINTAGE}/acs/acs5/subject`;
const CENSUS_UNEMP_VAR = 'S2301_C04_001E';

// State abbreviation -> FIPS. Static because FIPS codes do not change, and a
// lookup call per request would be pure overhead.
const STATE_FIPS = {
  AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',DC:'11',FL:'12',GA:'13',
  HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',MD:'24',MA:'25',
  MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',NM:'35',NY:'36',
  NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',SD:'46',TN:'47',TX:'48',
  UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56',PR:'72',
};

function censusKey() {
  const raw = process.env.CENSUS_API_KEY;
  if (!raw) throw new Error('Census demographics are unavailable: CENSUS_API_KEY is not configured on the server. Census requires a key on every data request.');
  // Trim before use. A key pasted into a dashboard field commonly carries a
  // trailing newline or space; Census then answers with an HTML error page
  // instead of JSON, which surfaces as an opaque parse failure rather than
  // anything pointing at the key.
  const k = String(raw).trim();
  if (!/^[0-9a-f]{40}$/i.test(k)) {
    // Never echo the value, not even a prefix — length and shape are enough
    // to tell a truncated paste from a wrong-field paste.
    throw new Error(`CENSUS_API_KEY is malformed: expected 40 hex characters, got ${k.length}. Re-copy it from the Census key email.`);
  }
  return k;
}

// Errors from upstream can quote the request back, and the request carries the
// key in its query string. Everything thrown from the Census path goes through
// this first so a credential can never reach a tool response or a log line.
function scrubSecret(text) {
  return String(text)
    .replace(/\b[0-9A-Fa-f]{40}\b/g, '<redacted>')
    .replace(/([?&]key=)[^&\s"']+/gi, '$1<redacted>');
}

// Census returns [[header...],[row...]] arrays, not objects.
function censusRowsToObjects(payload) {
  if (!Array.isArray(payload) || payload.length < 2) return [];
  const [header, ...rows] = payload;
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// Census encodes missing/suppressed values as large negatives (-666666666 and
// friends). Passing those straight through would render as real dollar figures
// on a profile, so they become null.
function censusNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return n <= -666666666 ? null : n;
}

// Census-specific, not fetchFDIC: its messages all say "FDIC API", and Census
// has a failure mode FDIC doesn't — a missing, unactivated or wrong key gets
// a redirect to an HTML "Missing Key" page served with HTTP 200, which would
// otherwise surface as an opaque JSON parse error instead of the real cause.
async function fetchCensusJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Census API timeout (>12s). Try again.');
    throw new Error(`Census API network error: ${e.message}`);
  }
  clearTimeout(timer);
  const text = await response.text();

  if (/missing[_ ]key|valid key must be included|invalid key/i.test(text)) {
    throw new Error('Census API rejected the key. CENSUS_API_KEY is set but wrong, or not yet activated — the key email contains an activation link that must be clicked once before the key works.');
  }
  if (response.status === 204 || !text.trim()) {
    throw new Error('Census API returned no data for that geography. Check the state and county codes.');
  }
  if (!response.ok) {
    throw new Error(`Census API returned HTTP ${response.status}: ${scrubSecret(text.slice(0, 200))}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Scrubbed, and longer than before: the previous 120-char window was too
    // short to show what an HTML error page was actually complaining about.
    throw new Error(`Census API returned a non-JSON response: ${scrubSecret(text.slice(0, 220))}`);
  }
}

async function fetchCensus(base, varList, stateFips, countyFips) {
  const url = `${base}?get=NAME,${varList.join(',')}&for=county:${countyFips}&in=state:${stateFips}&key=${censusKey()}`;
  return censusRowsToObjects(await fetchCensusJSON(url));
}

async function countyDemographics(stateFips, countyFips) {
  const detailVars = Object.keys(CENSUS_VARS);
  const [detail, subject] = await Promise.all([
    fetchCensus(CENSUS_BASE, detailVars, stateFips, countyFips),
    fetchCensus(CENSUS_SUBJECT_BASE, [CENSUS_UNEMP_VAR], stateFips, countyFips).catch(() => []),
  ]);
  if (!detail.length) return null;
  const d = detail[0];
  const out = { name: d.NAME, county_fips: `${stateFips}${countyFips}` };
  for (const [code, label] of Object.entries(CENSUS_VARS)) out[label] = censusNum(d[code]);
  out.unemployment_rate_pct = subject.length ? censusNum(subject[0][CENSUS_UNEMP_VAR]) : null;
  // Derived because every CRA table reports it, and computing it here avoids
  // each caller re-deriving it slightly differently.
  out.owner_occupied_pct = (out.housing_units_owner_occupied != null && out.housing_units_total)
    ? Number((out.housing_units_owner_occupied / out.housing_units_total * 100).toFixed(1)) : null;
  out.poverty_rate_pct = (out.population_below_poverty != null && out.population)
    ? Number((out.population_below_poverty / out.population * 100).toFixed(1)) : null;
  out.vintage = `ACS ${CENSUS_VINTAGE} 5-year`;
  return out;
}

async function getCountyDemographics(args) {
  const { cert, county, state, county_fips } = args || {};
  if (!cert && !county_fips && !(county && state)) {
    throw new Error('Provide one of: "cert" (demographics for every county a bank operates in), "county" plus "state", or "county_fips" (5-digit state+county FIPS).');
  }

  // Direct FIPS
  if (county_fips && !cert) {
    const f = String(county_fips).padStart(5, '0');
    const cacheKey = `demo-fips-${f}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return { ...cached, _cache: { hit: true } };
    const d = await countyDemographics(f.slice(0, 2), f.slice(2));
    if (!d) throw new Error(`No Census data found for county FIPS ${f}.`);
    const result = { mode: 'county', ...d, source: 'U.S. Census Bureau American Community Survey' };
    await cacheSet(cacheKey, result);
    return result;
  }

  // County + state name
  if (county && !cert) {
    const st = String(state).toUpperCase();
    const sf = STATE_FIPS[st];
    if (!sf) throw new Error(`Unrecognized state code "${state}". Use a 2-letter code (e.g. "TN").`);
    const cacheKey = `demo-name-${st}-${String(county).toLowerCase()}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return { ...cached, _cache: { hit: true } };

    // Resolve the county name against Census's own naming rather than guessing
    // a FIPS code. Census NAME reads "Tulsa County, Oklahoma"; Louisiana uses
    // "Parish" and Alaska "Borough"/"Census Area", so match the leading
    // segment instead of appending the word "County".
    const all = await fetchCensus(CENSUS_BASE, ['B01003_001E'], sf, '*');
    const want = String(county).toLowerCase().replace(/\s+(county|parish|borough|census area)$/i, '').trim();
    const hit = all.find(r => String(r.NAME).split(',')[0].toLowerCase()
      .replace(/\s+(county|parish|borough|city and borough|census area|municipality)$/i, '').trim() === want);
    if (!hit) throw new Error(`No county matching "${county}" found in ${st}. Use the county name without the word "County" (e.g. "Davidson", not "Davidson County").`);

    const d = await countyDemographics(sf, hit.county);
    const result = { mode: 'county', ...d, source: 'U.S. Census Bureau American Community Survey' };
    await cacheSet(cacheKey, result);
    return result;
  }

  // Bank footprint: demographics for each county the bank operates in.
  const cacheKey = `demo-cert-${cert}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true } };

  const year = await latestSodYear(`CERT%3A${cert}`);
  if (year == null) throw new Error(`No branch data found for CERT ${cert}. Verify with search_institutions.`);
  const probe = await fetchCountyRows(`CERT%3A${cert}%20AND%20YEAR%3A${year}`);
  if (!probe.rows.length) throw new Error(`No branch data found for CERT ${cert} in filing year ${year}.`);

  const seen = new Map();
  for (const r of probe.rows) {
    const f = String(r.STCNTYBR).padStart(5, '0');
    if (!seen.has(f)) seen.set(f, { county: r.CNTYNAMB, state: r.STALPBR, county_fips: f });
  }
  const selected = [...seen.values()].slice(0, MAX_COUNTIES_PER_BANK);

  const counties = [];
  for (const c of selected) {
    try {
      const d = await countyDemographics(c.county_fips.slice(0, 2), c.county_fips.slice(2));
      counties.push(d ? { ...c, ...d } : { ...c, error: 'No Census data returned for this county.' });
    } catch (e) {
      // One county failing must not void the whole answer.
      counties.push({ ...c, error: e.message });
    }
  }

  const result = {
    mode: 'bank_footprint',
    cert: String(cert),
    bank_name: probe.rows[0].NAMEFULL,
    branch_year: year,
    county_count: seen.size,
    counties,
    truncated: seen.size > selected.length ? { showing: selected.length, of: seen.size } : null,
    source: 'U.S. Census Bureau American Community Survey, joined to FDIC Summary of Deposits county FIPS',
  };
  await cacheSet(cacheKey, result);
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
  get_county_deposit_share: getCountyDepositShare,
  get_county_demographics: getCountyDemographics,
  get_bank_leadership: getBankLeadership,
  get_bank_leadership_bulk: getBankLeadershipBulk,
  trigger_linkedin_match: triggerLinkedinMatch,
  check_linkedin_match: checkLinkedinMatch,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  // MCP clients send MCP-Protocol-Version (and Mcp-Session-Id for stateful
  // servers). Allowing only Content-Type fails their CORS preflight.
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS };

  if (event.httpMethod === 'GET') {
    // A streamable-HTTP client may GET this endpoint to open a server-initiated
    // SSE stream. Vault is stateless and offers no such stream, so the correct
    // answer is 405 — returning the 200 JSON info blob below makes the client
    // think it opened a stream and then choke on the payload.
    const accept = event.headers?.accept || event.headers?.Accept || '';
    if (accept.includes('text/event-stream')) {
      return {
        statusCode: 405,
        headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
        body: JSON.stringify({ error: 'This MCP server is stateless and does not offer a GET SSE stream. POST JSON-RPC to this same URL.' }),
      };
    }
    return {
      statusCode: 200, headers: CORS_HEADERS,
      body: JSON.stringify({
        name: 'vault-mcp', version: '1.19.0',
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
        // Echo back the version the client asked for when it's one we can
        // honour. Vault is a stateless tools-only server, so every version in
        // this list behaves identically here — but replying 2024-11-05 to a
        // client that opened with 2025-06-18 makes newer clients think the
        // server is stale.
        const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2026-07-28'];
        const requestedProtocol = params?.protocolVersion;
        const negotiatedProtocol = SUPPORTED_PROTOCOLS.includes(requestedProtocol) ? requestedProtocol : '2024-11-05';
        await safeLog({ method, clientName: `${clientName}/${clientVersion}`, durationMs: Date.now()-t0, success: true });
        return reply({
          protocolVersion: negotiatedProtocol,
          serverInfo: { name: 'vault-mcp', version: '1.19.0' },
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
    // Surface the real reason in `message`, not just `data`. Agents relay the
    // message field to the user, so a bare "Internal error" turns an
    // actionable problem ("that CERT has no SOD filing") into a dead end —
    // and hides genuine bugs from us. Every throw in this file is a curated
    // message, so there's nothing sensitive to leak here.
    return err(-32603, e.message || 'Internal error', e.message);
  }
};
