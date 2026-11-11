// Vault MCP Server v1.2 — banking intelligence for AI agents with usage analytics
// Implements MCP (Model Context Protocol) over HTTP using JSON-RPC 2.0
// Spec: https://modelcontextprotocol.io/

const VAULT_MCP_VERSION = '1.28.2';
const FDIC_BASE = 'https://api.fdic.gov/banks';
// Summary of Deposits — separate FDIC dataset (annual branch-level census, as of each June 30).
// Same query syntax as FDIC_BASE (filters=field%3Avalue&fields=...&limit=...&sort_by=...&sort_order=...).
const FDIC_SOD_BASE = 'https://api.fdic.gov/banks/sod';

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
    title: 'Search banks & credit unions',
    annotations: { title: 'Search banks & credit unions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Search FDIC-insured banks AND NCUA-insured credit unions by name, trade name (\"Bank of Oklahoma\"), former name, acronym (\"MSUFCU\"), city, state or partial match (\"American Heritage Oklahoma\", \"Navy Federal\"). Returns up to 20 results ranked by relevance (match_score), then asset size. Each result has type \"bank\" (with an FDIC cert) or \"credit_union\" (with an NCUA charter_number and profile_url). For a credit union, pass its charter_number to get_credit_union_profile; the cert-based tools (get_bank_profile, get_loan_mix, etc.) cover banks only. A result with type \"notice\" means one data source was unreachable and its results are missing. Typically responds in 1-4 seconds. Use this first to get a CERT before calling other tools.',
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
    name: 'get_credit_union_profile',
    title: 'Credit union profile & financials',
    annotations: { title: 'Credit union profile & financials', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Get the profile and latest-quarter NCUA 5300 financials for one federally insured credit union by NCUA charter number: total assets, loans, shares and deposits, net worth, year-to-date net income, delinquent loans, members, employees, trade names, plus derived ratios (net worth ratio and capital category, annualized ROA, loan-to-share, delinquency rate). Get the charter_number from search_institutions (rows with type "credit_union"). Latest quarter only. Typically responds in 1-3 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        charter_number: { type: 'string', description: 'NCUA charter number (e.g. "5536" for Navy Federal). Get it from search_institutions.' },
      },
      required: ['charter_number'],
    },
  },
  {
    name: 'get_bank_profile',
    title: 'Bank profile & financial history',
    annotations: { title: 'Bank profile & financial history', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Get detailed profile for a single FDIC-insured bank by certificate number (CERT). Returns institution details, latest financials (assets, deposits, ROA, ROE, NIM, capital ratio), and by default the latest 8 quarters. For long-run trends, pass start_year (back to 1992) to rebuild history from that year — with frequency:"annual" you get one Dec-31 row per year (period_label "FY2019") plus the latest partial quarter flagged is_partial_year, or frequency:"quarterly" for every quarter (capped at the most recent 40). Note: call-report net income is year-to-date as of each report_date (net_income_ytd), so compare full years to full years; ROA/ROE are FDIC-annualized. Grain notes: call reports are quarterly — no public source has monthly deposits or loans; announced acquisitions do not appear in FDIC data until they close. Typically responds in 3-6 seconds. Always run search_institutions first to get the CERT.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (e.g. "23473"). Get this from search_institutions first.' },
        start_year: { type: 'number', description: 'Optional. Rebuild financial history from this year (earliest 1992). Omit for the default latest-8-quarters view.' },
        frequency: { type: 'string', enum: ['quarterly', 'annual'], description: 'With start_year: "annual" (one year-end row per year + latest partial) or "quarterly" (default, max 40 quarters).' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_industry_metrics',
    title: 'Industry metrics',
    annotations: { title: 'Industry metrics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'New bank charters',
    annotations: { title: 'New bank charters', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Bank M&A activity',
    annotations: { title: 'Bank M&A activity', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Lender rankings',
    annotations: { title: 'Lender rankings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Asset quality detail',
    annotations: { title: 'Asset quality detail', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Loan mix & CRE concentration',
    annotations: { title: 'Loan mix & CRE concentration', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Get loan portfolio composition for a specific bank: Real Estate (residential, commercial RE with owner-occupied / non-owner-occupied split, construction, multifamily, farmland), C&I, Agricultural, and Consumer, plus ag_total (ag production + farmland). Returns dollar amounts and % of total loans, and the regulatory CRE concentration test (construction >= 100%, total CRE >= 300% with 50% 36-month growth, FDIC FIL-22-2006) measured against tier 1 capital + the allowance for credit losses, the basis examiners use since 2020 (FDIC FIL-31-2020) and one that covers community bank leverage ratio banks too; the older total-risk-based-capital view is also returned — distinct from cre_and_construction_pct_of_loans, which is a share of loans. Pass quarters for the latest N (max 8), or start_year (back to 1992) with frequency:"annual" / "quarterly" to rebuild the mix over many years (period_label per row; latest partial year flagged). Typically responds in 3-6 seconds. Use to understand lending strategy or CRE concentration risk and how it has shifted over time. Call reports are quarterly; no public source has monthly loan data.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (required). Get from search_institutions.' },
        quarters: { type: 'number', description: 'Quarters of history (default 1 = latest only, max 8). Ignored when start_year is set.' },
        start_year: { type: 'number', description: 'Optional. Rebuild loan-mix history from this year (earliest 1992). Omit for the default latest view.' },
        frequency: { type: 'string', enum: ['quarterly', 'annual'], description: 'With start_year: "annual" (one year-end row per year + latest partial) or "quarterly" (default, max 40 quarters).' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_brokered_deposits',
    title: 'Brokered deposits',
    annotations: { title: 'Brokered deposits', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Branch footprint & history',
    annotations: { title: 'Branch footprint & history', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Get branch-level location and deposit data for a specific bank from the FDIC Summary of Deposits (SOD) — the annual branch-level census FDIC-insured banks file every June. Returns branch count, total branch deposits, and a list of individual branches with address, city, state, deposits, service type (FDIC office type: full service, limited service facility/administrative, etc.), established date, and whether it is the main office (sorted first). A $0-deposit site is usually a limited-service office that books no deposits of its own, flagged with zero_deposits, not a dead branch. Pass `year` for a single past SOD year, or `start_year`+`end_year` to rebuild the footprint annually across years — multi-year returns per-year totals (by_year) plus a per-branch history keyed by FDIC branch number, so openings, closures and relocations show as gaps. Typically responds in 3-6 seconds. Use to answer "how many branches," "where does this bank operate," "which branches hold the most deposits," or "how has the branch footprint changed over time." Very large banks (over ~1,200 branch-years on file) return the top branches by deposits plus per-year totals with truncated:true — pass `state` for complete lists. Grain notes: SOD is one snapshot per year (June 30), so branch-level history is annual only — no public source has sub-annual branch data; and SOD lists physical branches, not loan production offices.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number (required). Get from search_institutions.' },
        state: { type: 'string', description: 'Optional 2-letter state code to filter branches to one state (e.g. "OK")' },
        year: { type: 'number', description: 'Optional single SOD filing year (e.g. 2026). Defaults to the latest filing. SOD years run from 1994.' },
        start_year: { type: 'number', description: 'Optional. With end_year, returns a multi-year footprint (by_year totals + per-branch history). Earliest 1994.' },
        end_year: { type: 'number', description: 'Optional end of the multi-year range. Defaults to the latest filing year.' },
        limit: { type: 'number', description: 'Max branches returned per year (default 50, max 200)' },
      },
      required: ['cert'],
    },
  },
  {
    name: 'get_county_deposit_share',
    title: 'County deposit market share',
    annotations: { title: 'County deposit market share', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Get deposit market share and competitive rank by county, from the FDIC Summary of Deposits. Two ways to call it. (1) Pass `cert` to see every county a bank operates in, with its deposits, market share, rank, number of competing banks, and the top competitor in each — answers "where is this bank strong or weak," "which markets does it dominate," and "who is beating it in its own backyard." (2) Pass `county` plus `state` to get the full ranked leaderboard of every bank operating in that county — answers "who holds deposit share in this market" and "who would we compete against if we entered." Use the county name alone, without the word "County" (e.g. "Tulsa", not "Tulsa County"). All deposit figures are in thousands of dollars. Standard uses: Community Reinvestment Act deposit market-share analysis, M&A target screening, branch expansion and market-entry planning, and peer benchmarking within a footprint. Note: SOD is an annual filing as of each June 30, so this reflects the most recent annual snapshot, not real-time deposits. Pass start_year (and optionally end_year) for share and rank by year — e.g. how a bank\'s position in each market moved over five years; multi-year is capped at the most recent 5 years and the bank\'s top 10 counties, and an uncached multi-year call can exceed Perplexity\'s 15-second tool limit. Typically responds in 3-8 seconds; a bank spanning many counties takes longer, since each county is ranked separately.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number. Returns this bank\'s share and rank in every county it operates in. Get from search_institutions. Provide this OR county+state.' },
        county: { type: 'string', description: 'County name without the word "County" (e.g. "Tulsa"). Must be paired with state. Returns the full ranked leaderboard for that county.' },
        state: { type: 'string', description: '2-letter state code (e.g. "OK"). Required when using county.' },
        limit: { type: 'number', description: 'Max banks returned in county leaderboard mode (default 25, max 200). Ignored in cert mode.' },
        start_year: { type: 'number', description: 'Optional. Return share and rank by year from this SOD year (earliest 1994). Capped to the most recent 5 years in the range.' },
        end_year: { type: 'number', description: 'Optional end of the multi-year range. Defaults to the latest filing year.' },
      },
    },
  },
  {
    name: 'get_county_demographics',
    title: 'County demographics',
    annotations: { title: 'County demographics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    name: 'get_hmda_lending',
    title: 'HMDA mortgage lending',
    annotations: { title: 'HMDA mortgage lending', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Get mortgage lending activity from CFPB HMDA data: originations, denials, withdrawals, dollar volume and denial rate. Two ways to call it: `cert` for one bank\'s lending record (the FDIC certificate is resolved to the lender\'s LEI automatically — you never need an LEI), or `county` plus `state` / `county_fips` for all lending in a market. Pair with get_county_deposit_share and get_county_demographics to build a full Community Reinvestment Act picture: who holds deposits, who the market is, and who is actually lending in it. Also a credit-appetite and growth signal for M&A screening and vendor targeting. Defaults to the most recent published year. IMPORTANT coverage note to pass on when a bank returns nothing: roughly half of active banks have an LEI recorded with the FDIC (around 94% above \$5B in assets, about 10% under \$100M), and smaller banks often fall under HMDA reporting thresholds and legitimately do not file — an empty result usually means the bank is small, not that the data is broken. Denial rate is computed against decisioned applications only and excludes purchased loans, which are bought from other lenders rather than decided by this bank.',
    inputSchema: {
      type: 'object',
      properties: {
        cert: { type: 'string', description: 'FDIC certificate number. Resolved to the lender LEI internally. Get from search_institutions.' },
        county: { type: 'string', description: 'County name without the word "County" (e.g. "Davidson"). Pair with state.' },
        state: { type: 'string', description: '2-letter state code (e.g. "TN"). Required when using county.' },
        county_fips: { type: 'string', description: '5-digit state+county FIPS (e.g. "47037").' },
        year: { type: 'number', description: 'HMDA filing year. Defaults to the most recent published year.' },
      },
    },
  },
  {
    name: 'get_bank_leadership',
    title: 'Bank leadership contacts',
    annotations: { title: 'Bank leadership contacts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Bank leadership (bulk, cached only)',
    annotations: { title: 'Bank leadership (bulk, cached only)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: 'Start LinkedIn profile match',
    annotations: { title: 'Start LinkedIn profile match', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    title: 'Check LinkedIn match status',
    annotations: { title: 'Check LinkedIn match status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    // Per-entry TTL (5.1): closed periods (e.g. a published SOD year) store a
    // longer _ttl_ms; everything else keeps the 7-day default.
    if (raw._cached_at && (Date.now() - raw._cached_at) > (raw._ttl_ms || CACHE_TTL_MS)) {
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

async function cacheSet(key, data, ttlMs) {
  try {
    const store = await getBlobStore();
    if (!store) return;
    await store.setJSON(key, { ...data, _cached_at: Date.now(), ...(ttlMs ? { _ttl_ms: ttlMs } : {}) });
    console.log('[vault-cache] STORED:', key);
  } catch(e) {
    console.log('[vault-cache] cacheSet error:', e.message);
  }
}

// ── Leadership cache (separate store, shared with functions/leadership.js) ──
// Same "vault-leadership-cache" store name as the website's leadership section,
// so a lookup done via either surface (MCP tool call or website page view) warms
// the cache for the other — no duplicate paid Claude calls for the same bank.
// 90 days (was 30). Bank executive teams rarely turn over, and every cache
// miss is a paid Claude + web_search + Bright Data run. Failed lookups
// (entries carrying an `error`) expire after 7 days so a transient failure
// doesn't block a retry for a whole quarter. Cost-reduction pass, 2026-10-22.
const LEADERSHIP_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ── Cost controls (2026-10-22) ────────────────────────────────────────────
// Oct 14 SEO push (sitemap of ~9,400 institution pages + hub pages) let JS-
// rendering crawlers trigger paid leadership enrichment on every uncached
// bank page they rendered. Three guards, duplicated in leadership.js and
// mcp.js per this codebase's no-shared-module pattern:
//   1. Daily cap on NEW (uncached) enrichments, counted in Blobs.
//   2. Internal token on the leadership-background trigger, so the background
//      function can't be POSTed directly to bypass the cap.
//   3. (leadership.js only) crawler user-agents get cache reads, never a run.
const LEADERSHIP_DAILY_CAP = parseInt(process.env.LEADERSHIP_DAILY_CAP || '50', 10);
const ERROR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function vaultInternalToken() {
  return require('crypto').createHash('sha256').update('vault-bg:' + (process.env.ANTHROPIC_API_KEY || '')).digest('hex');
}
async function claimEnrichmentSlot(store) {
  // Returns 'ok' | 'cap' | 'unavailable'. Approximate (no atomic increment in
  // Blobs) — fine for a spend ceiling.
  // FAILS CLOSED (v1.21.2): if Blobs is unreachable (e.g. NETLIFY_BLOBS_TOKEN
  // expired), pending markers can't be written either, so every poll would
  // start a NEW paid run. No Blobs = no paid enrichment.
  if (!store) return 'unavailable';
  try {
    const key = `enrich-budget-${new Date().toISOString().slice(0, 10)}`;
    const cur = (await store.get(key, { type: 'json' })) || { count: 0 };
    if (cur.count >= LEADERSHIP_DAILY_CAP) {
      console.log('[vault-budget] daily enrichment cap reached:', cur.count, '/', LEADERSHIP_DAILY_CAP);
      return 'cap';
    }
    await store.setJSON(key, { count: cur.count + 1 });
    return 'ok';
  } catch (e) {
    console.log('[vault-budget] Blobs unavailable — blocking paid enrichment (check NETLIFY_BLOBS_TOKEN):', e.message);
    return 'unavailable';
  }
}

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
    if (raw._cached_at && (Date.now() - raw._cached_at) > (raw.error ? ERROR_TTL_MS : LEADERSHIP_CACHE_TTL_MS)) {
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
      _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000), model: cached._model || null },
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

  const slot = await claimEnrichmentSlot(await getLeadershipBlobStore());
  if (slot === 'unavailable') {
    return { cert, name: inst.NAME, people: [], status: 'unavailable', message: 'Leadership lookups are temporarily unavailable (cache storage unreachable). Please try again later.' };
  }
  if (slot === 'cap') {
    return {
      cert,
      name: inst.NAME,
      people: [],
      status: 'daily_limit',
      message: 'Daily limit for new leadership lookups reached. Already-researched banks still return instantly; try this one again tomorrow. Use get_bank_leadership_bulk to see which banks already have cached leadership.',
    };
  }

  await cacheSetLeadership(pendingKey, { started: true });

  const siteUrl = process.env.URL || 'https://vaultbot.ai';
  try {
    // Deliberately not awaited beyond the initial connection -- Netlify
    // returns 202 to this fetch almost immediately for a "-background"
    // function without waiting for its actual handler logic to run, so this
    // stays fast without needing any fire-and-forget tricks.
    await fetch(`${siteUrl}/.netlify/functions/leadership-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vault-internal': vaultInternalToken() },
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
// ── Search relevance — VERBATIM COPY of index.html (2026-11-09). Keep both in sync:
// the website and the MCP must rank the same query the same way.
const STATE_NAME_TO_CODE = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO',
  'montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ',
  'new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND','ohio':'OH',
  'oklahoma':'OK','oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'district of columbia':'DC',
};

const VALID_STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));

function fuzzyScore(name, query) {
  // Strip a leading "The" and trailing legal boilerplate (", National Association",
  // ", N.A.", ", Inc.", ", FSB", ", SSB") so "Fidelity Bank" is an exact match for
  // "Fidelity Bank, National Association" — people don't type the suffix.
  const n = name.toLowerCase().replace(/^the\s+/, '')
    .replace(/,?\s+(national association|n\.\s?a\.?|inc\.?|f\.?s\.?b\.?|s\.?s\.?b\.?)\s*$/, '').trim();
  const q = query.toLowerCase().trim().replace(/^the\s+/, '');
  if (n === q) return 100;
  if (n.startsWith(q)) return 90;
  if (n.includes(q)) return 80;
  // Acronym match: "MSUFCU" matches "Michigan State University Federal Credit Union"
  const words = n.replace(/[^a-z0-9 ]/g, '').split(/\s+/);
  const acronym = words.map(w => w[0]).join('');
  if (acronym.includes(q.toLowerCase())) return 75;
  if (acronym.startsWith(q.toLowerCase())) return 85;
  // Token match — but weight distinctive words more heavily
  // Common banking words that shouldn't drive score on their own
  const commonWords = new Set(['first','bank','national','federal','savings','trust','state',
    'community','commercial','peoples','heritage','home','liberty','union','american',
    'united','citizens','central','western','eastern','northern','southern','premier','credit']);
  const qTokens = q.split(/\s+/).filter(t => t.length > 1);
  const distinctiveQ = qTokens.filter(t => !commonWords.has(t));
  // If query has distinctive words, require at least one to match
  if (distinctiveQ.length > 0) {
    const distinctiveMatches = distinctiveQ.filter(t => n.includes(t)).length;
    if (distinctiveMatches === 0) return 0; // no distinctive word matched — irrelevant
    if (qTokens.every(t => n.includes(t))) return 70; // all words match
    const matchCount = qTokens.filter(t => n.includes(t)).length;
    // Partial matches stay below the all-words-match score (70): otherwise a name
    // sharing 3 of 4 words could outrank one containing all 4.
    return Math.round(10 + (distinctiveMatches / distinctiveQ.length) * 35 + (matchCount / qTokens.length) * 20);
  }
  // All query words are common (e.g. "First Bank") — standard partial match
  if (qTokens.every(t => n.includes(t))) return 60;
  const matchCount = qTokens.filter(t => n.includes(t)).length;
  return Math.round((matchCount / qTokens.length) * 40);
}

const SEARCH_STOP = new Set(['of','the','and','a','an','at','in','for','by','to','de','la','le','&']);

const SEARCH_COMMON = new Set(['first','bank','banks','national','federal','savings','trust','state',
  'community','commercial','peoples','heritage','home','liberty','union','american','united','citizens',
  'central','western','eastern','northern','southern','premier','financial','credit','unions','company',
  'association','fcu','cu','na','n.a.','co','inc']);

function titleCase(s) { return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()); }

function parseSearchLocation(query) {
  const raw = query.trim().replace(/\s+/g, ' ');
  let rest = raw, state = null;
  const names = Object.keys(STATE_NAME_TO_CODE).sort((a, b) => b.length - a.length);
  for (const n of names) {
    // "Kansas City", "Oklahoma City", "Texas City": a state name followed by "city" is a city, not a state.
    const re = new RegExp(`(^|\\s)(?!of\\s)(\\S+\\s)?${n.replace(/\s+/g, '\\s+')}(?=\\s|$)(?!\\s+city\\b)`, 'i');
    const m = rest.match(re);
    if (m && !/^of\s$/i.test(m[2] || '')) {
      const idx = m.index + m[1].length + (m[2] ? m[2].length : 0);
      const stripped = (rest.slice(0, idx) + rest.slice(idx + m[0].length - m[1].length - (m[2] ? m[2].length : 0))).trim();
      if (stripped) { state = STATE_NAME_TO_CODE[n]; rest = stripped; }
      break;
    }
  }
  if (!state) {
    const toks = rest.split(' ');
    const last = toks[toks.length - 1];
    if (toks.length > 1 && last.length === 2 && VALID_STATE_CODES.has(last.toUpperCase()) && !/^(of|in|or|me|to|at|by|la|de|co|na)$/.test(last)) {
      state = last.toUpperCase(); rest = toks.slice(0, -1).join(' ');
    }
  }
  const cityOk = w => w.length > 2 && !SEARCH_STOP.has(w.toLowerCase()) && !SEARCH_COMMON.has(w.toLowerCase());
  const cities = [];
  // City candidates come from the raw query as well as the state-stripped one,
  // so a city containing a state name ("Oklahoma City", "Kansas City") survives.
  for (const words of [raw.split(' '), rest.split(' ')]) {
    const w = words.filter(Boolean);
    if (w.length >= 1 && cityOk(w[w.length - 1])) cities.push(titleCase(w[w.length - 1]));
    if (w.length >= 2 && cityOk(w[w.length - 1]) && (cityOk(w[w.length - 2]) || STATE_NAME_TO_CODE[w[w.length - 2].toLowerCase()]))
      cities.push(titleCase(w.slice(-2).join(' ')));
  }
  return { nameQuery: rest, state, cities: [...new Set(cities)].filter(c => !STATE_NAME_TO_CODE[c.toLowerCase()]).slice(0, 3) };
}

function searchRelevance(inst, query) {
  const name = inst.name || '';
  const full = fuzzyScore(name, query);
  const city = (inst.city || '').toLowerCase();
  const st = (inst.state || '').toUpperCase();
  const stateName = Object.keys(STATE_NAME_TO_CODE).find(k => STATE_NAME_TO_CODE[k] === st) || '';
  let rest = ' ' + query.toLowerCase().replace(/\s+/g, ' ') + ' ';
  let located = false;
  // The whole city name must appear: "Oklahoma" alone must not match "Oklahoma City".
  if (city && rest.includes(' ' + city + ' ')) { rest = rest.replace(' ' + city + ' ', ' '); located = true; }
  if (stateName && rest.includes(' ' + stateName + ' ') && !rest.includes(' of ' + stateName + ' ') && !rest.includes(' ' + stateName + ' city ')) { rest = rest.replace(' ' + stateName + ' ', ' '); located = true; }
  const t = rest.trim().split(' ');
  if (st && t.length > 1 && t[t.length - 1] === st.toLowerCase()) { t.pop(); rest = ' ' + t.join(' ') + ' '; located = true; }
  if (!located) return full;
  const remaining = rest.replace(/\b(of|the|in|near)\b/g, ' ').replace(/\s+/g, ' ').trim();
  // If only generic words are left ("bank", "state bank"), the location reading
  // says little about the name, so it is capped low instead of matching every "Bank …".
  const GENERIC = new Set(['bank','banks','trust','company','credit','union','savings','national','state','financial','and','&']);
  const genericOnly = remaining && remaining.split(' ').every(w => GENERIC.has(w));
  let loc = remaining ? fuzzyScore(name, remaining) : 55; // pure-location query, e.g. "Sapulpa"
  if (genericOnly) loc = Math.min(loc, 55);
  // Capped at 95 so an exact full-name match ("Texas Capital Bank") still
  // outranks a location reading of the same words ("Capital Bank" in Texas).
  return Math.max(full, loc >= 40 ? Math.min(95, loc + 5) : 0);
}

const FDIC_ALIAS_FIELDS = ['TE01N529','TE02N529','TE03N529','TE04N529','TE05N529','TE06N529','TE07N529','TE08N529','TE09N529','TE10N529',
  'PRIORNAME1','PRIORNAME2','PRIORNAME3','PRIORNAME4','PRIORNAME5','PRIORNAME6'];

function institutionRelevance(d, query) {
  const loc = { city: d.CITY, state: d.STALP };
  let best = { score: searchRelevance({ ...loc, name: d.NAME || '' }, query), aka: null };
  for (const f of FDIC_ALIAS_FIELDS) {
    const alias = d[f];
    if (!alias || typeof alias !== 'string' || alias === d.NAME) continue;
    const trade = f.startsWith('TE');
    const sc = searchRelevance({ ...loc, name: alias }, query) - (trade ? 3 : 8);
    if (sc > best.score) best = { score: sc, aka: { name: alias, kind: trade ? 'trade name' : 'former name' } };
  }
  return best;
}

function fdicAliasUrls(base, words, fields, extraFilter = '') {
  const w = words.filter(Boolean).map(x => encodeURIComponent(titleCase(x))).join('*');
  if (!w) return [];
  const or = (prefix, n) => '(' + Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}N529%3A*${w}*`).join('%20OR%20') + ')';
  const orPrior = '(' + [1,2,3,4,5,6].map(i => `PRIORNAME${i}%3A*${w}*`).join('%20OR%20') + ')';
  return [or('TE', 10), orPrior].map(f => `${base}/institutions?filters=${f}%20AND%20ACTIVE%3A1${extraFilter}&fields=${fields}&limit=20&sort_by=ASSET&sort_order=DESC`);
}

function cuRelevance(cu, query) {
  const name = cu.name || '';
  const loc = { city: cu.city, state: cu.state };
  let best = { score: searchRelevance({ ...loc, name }, query), aka: null };
  if (!/credit union|\bf?cu$/i.test(name.trim())) {
    const kind = String(cu.cuType || cu.type || '');
    const suffix = /federal/i.test(kind) ? ' Federal Credit Union' : ' Credit Union';
    best.score = Math.max(best.score, searchRelevance({ ...loc, name: name + suffix }, query));
  }
  // NCUA TradeNames ("MSUFCU"), scored like FDIC trade names: 3 points under
  // the legal name so a legal-name match still wins a tie.
  for (const t of (cu.tradeNames || cu.trade_names || [])) {
    const sc = searchRelevance({ ...loc, name: t }, query) - 3;
    if (sc > best.score) best = { score: sc, aka: { name: t, kind: 'trade name' } };
  }
  return best;
}

function cuFinancials(cu) {
  const n = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  const r2 = v => v === null ? null : Math.round(v * 100) / 100;
  const assets = n(cu.assets), loans = n(cu.loans), shares = n(cu.shares), netWorth = n(cu.netWorth);
  const netIncomeYtd = n(cu.netIncomeYtd), delinquentLoans = n(cu.delinquentLoans), allowance = n(cu.allowance);
  const pct = (a, b) => (a !== null && b) ? r2(a / b * 100) : null;
  const months = cu.asOf ? Number(String(cu.asOf).slice(5, 7)) : null;
  const computed = pct(netWorth, assets);
  // NCUA's own net worth ratio (account 998). Live data stores it in basis
  // points (Navy Federal: 1165 = 11.65%, matching 997/010 exactly). The unit
  // is still resolved against net worth / assets (bps, percent or decimal,
  // whichever lands closest) rather than assumed; with no net worth to check
  // against, anything over 100 is read as basis points.
  let reported = n(cu.netWorthRatio);
  if (reported !== null) {
    const options = [reported / 100, reported, reported * 100];
    reported = computed !== null
      ? options.reduce((best, v) => Math.abs(v - computed) < Math.abs(best - computed) ? v : best)
      : (Math.abs(reported) > 100 ? reported / 100 : reported);
  }
  return {
    assets, loans, shares, netWorth, netIncomeYtd, delinquentLoans, allowance,
    netWorthRatioPct: reported !== null ? r2(reported) : computed,
    netWorthToAssetsPct: computed,
    roaPct: (netIncomeYtd !== null && assets && months) ? r2(netIncomeYtd / assets * (12 / months) * 100) : null,
    loanToSharePct: pct(loans, shares),
    delinquencyPct: pct(delinquentLoans, loans),
    allowancePctOfLoans: pct(allowance, loans),
  };
}
// ── end of verbatim search block ──




// ── Credit unions in search_institutions (MCP 1.27.0) ──────────────────────
// The MCP used to search FDIC banks only, while its title promised credit
// unions too. It now asks the same NCUA proxy the website uses
// (functions/ncua.js), which keeps the full NCUA quarterly roster warm in
// memory. Loading that ZIP inside mcp.js would add a cold multi-second
// download to every new instance, so this is an HTTP call, not a require().
// Results are scored with the shared searchRelevance and the same >=40
// cutoff as banks, so both lists merge on one scale.
function cuSlugPath(cu) {
  const slug = `${cu.name || ''} ${cu.city || ''} ${cu.state || ''}`.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug ? `/cu/${slug}-${cu.id}` : `/cu/${cu.id}`;
}
async function fetchNCUAProxy(q, stateCode, limit = 20, timeoutMs = 8000) {
  const siteUrl = process.env.URL || 'https://vaultbot.ai';
  const url = `${siteUrl}/.netlify/functions/ncua?q=${encodeURIComponent(q)}&limit=${limit}${stateCode ? `&state=${encodeURIComponent(stateCode)}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { 'X-Vault-Source': 'mcp-internal' } });
    if (!r.ok) throw new Error(`NCUA proxy returned ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return { results: data.results || [], asOf: data.asOf || null, accountSources: data.accountSources || null };
  } finally { clearTimeout(timer); }
}
// Returns { rows, failed, asOf }. failed=true only when every NCUA call
// failed, so the caller can say so instead of implying "no credit unions".
async function searchCreditUnions(q, scoreQuery, stCode, loc) {
  const calls = [fetchNCUAProxy(q, stCode)];
  // Acronyms ("MSUFCU"): NCUA stores "MICHIGAN STATE UNIVERSITY", whose initials
  // are "MSU", so also ask the proxy for the acronym minus its charter suffix
  // (same trick as the website's searchNCUA).
  const acr = q.trim().match(/^([a-z0-9]{2,8}?)(fcu|ecu|tcu|scu|cu)$/i);
  if (acr && !/\s/.test(q.trim())) calls.push(fetchNCUAProxy(acr[1], stCode, 15));
  // "Navy Federal Virginia": also search the name part within the stated state.
  if (!stCode && loc.state && loc.nameQuery && loc.nameQuery !== q) calls.push(fetchNCUAProxy(loc.nameQuery, loc.state));
  const settled = await Promise.allSettled(calls);
  const ok = settled.filter(s => s.status === 'fulfilled');
  if (!ok.length) {
    console.log('[vault-search] NCUA proxy unavailable:', settled.map(s => s.reason?.message).join(' | '));
    return { rows: [], failed: true, asOf: null };
  }
  const seen = new Map();
  ok.forEach(s => s.value.results.forEach(cu => { if (cu?.id != null && !seen.has(String(cu.id))) seen.set(String(cu.id), cu); }));
  const rows = [...seen.values()]
    .map(cu => { const { score, aka } = cuRelevance(cu, scoreQuery); return { cu, score, aka }; })
    .filter(x => x.score >= 40);
  return { rows, failed: false, asOf: ok[0].value.asOf };
}

// get_credit_union_profile (MCP 1.28.0): the credit-union counterpart to
// get_bank_profile. Latest NCUA 5300 quarter only (the proxy loads one
// quarter); history is a later build. Ratios come from the shared
// cuFinancials, so they match the website's Financial Health row exactly.
async function getCreditUnionProfile(args) {
  const raw = String((args || {}).charter_number ?? (args || {}).charter ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error('Required parameter "charter_number" missing or not numeric. Get it from search_institutions (rows with type "credit_union").');
  const { results, asOf, accountSources } = await fetchNCUAProxy(raw, null, 5, 9000);
  // Exact charter match only: a digit query can also name-match ("1199 SEIU"), see bug #40.
  const cu = results.find(c => String(c.id) === raw || parseInt(c.id, 10) === parseInt(raw, 10));
  if (!cu) throw new Error(`No credit union found with NCUA charter number ${raw}. Verify with search_institutions.`);
  const f = cuFinancials({ ...cu, asOf: cu.asOf || asOf });
  const k = v => v === null ? null : Math.round(v / 1000);
  const nwr = f.netWorthRatioPct;
  // NCUA prompt corrective action categories (12 CFR 702.102). Credit unions
  // under 10 years old with <= $10M in assets follow 702 subpart C instead.
  const capitalCategory = nwr === null ? null : nwr >= 7 ? 'well capitalized' : nwr >= 6 ? 'adequately capitalized'
    : nwr >= 4 ? 'undercapitalized' : nwr >= 2 ? 'significantly undercapitalized' : 'critically undercapitalized';
  const isFederal = /federal/i.test(cu.type || '');
  const fullName = isFederal && !/credit union/i.test(cu.name || '')
    ? `${cu.name}${/[a-z]/.test(cu.name) ? ' Federal Credit Union' : ' FEDERAL CREDIT UNION'}` : cu.name;
  const missing = Object.entries({ total_loans: f.loans, shares_and_deposits: f.shares, net_worth: f.netWorth, net_income_ytd: f.netIncomeYtd, delinquent_loans: f.delinquentLoans })
    .filter(([, v]) => v === null).map(([key]) => key);
  return {
    type: 'credit_union',
    charter_number: String(cu.id),
    name: cu.name,
    full_name: fullName,
    trade_names: cu.tradeNames || [],
    charter_type: cu.type || null,
    city: cu.city, state: cu.state, zip: cu.zip || null,
    year_opened: cu.charterYear || null,
    data_as_of: cu.asOf || asOf,
    members: cu.members || null,
    employees_full_time: cu.employees ?? null,
    employees_part_time: cu.employeesPartTime ?? null,
    financials_thousands: {
      total_assets: k(f.assets), total_loans: k(f.loans), shares_and_deposits: k(f.shares),
      net_worth: k(f.netWorth), net_income_ytd: k(f.netIncomeYtd), delinquent_loans: k(f.delinquentLoans),
      allowance_for_loan_losses: k(f.allowance),
    },
    ratios_pct: {
      net_worth_ratio: nwr, net_worth_to_assets: f.netWorthToAssetsPct, roa_annualized: f.roaPct,
      loan_to_share: f.loanToSharePct, delinquency_rate: f.delinquencyPct, allowance_to_loans: f.allowancePctOfLoans,
    },
    capital_category: capitalCategory,
    assets_per_member: f.assets && cu.members ? Math.round(f.assets / cu.members) : null,
    profile_url: `https://vaultbot.ai${cuSlugPath(cu)}`,
    source: `NCUA 5300 Call Report, quarter ending ${cu.asOf || asOf}`,
    notes: [
      'Latest quarter only. NCUA call reports are quarterly; net income is year-to-date and ROA is annualized from it.',
      'net_worth_ratio is NCUA\u2019s own reported ratio (account 998); net_worth_to_assets is net worth / total assets.',
      'FDIC cert-based tools (get_bank_profile, get_loan_mix, get_branch_data, etc.) cover banks only.',
      ...(missing.length ? [`Not available in this NCUA file: ${missing.join(', ')}.`] : []),
    ],
    ...(accountSources ? { _ncua_source_files: accountSources } : {}),
  };
}

async function searchInstitutions(args) {
  const { query, state, limit = 20 } = args || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('Required parameter "query" missing or empty. Provide a search term like a bank name or city.');
  }
  const max = Math.min(Number(limit) || 20, 50);
  const fields = 'NAME,CERT,CITY,STALP,ASSET,REPDTE,WEBADDR,INSTCAT,' + FDIC_ALIAS_FIELDS.join(',');
  const q = query.trim();
  const qNoThe = q.replace(/^the\s+/i, '');
  const stopWords = new Set(['of','the','and','a','an','at','in','for','by','to','de','la','le','&']);
  const commonBankWords = new Set(['first','bank','national','federal','savings','trust','state',
    'community','commercial','peoples','heritage','home','liberty','union','american',
    'united','citizens','central','western','eastern','northern','southern','premier','financial']);
  const tokenWords = (qNoThe.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w.toLowerCase())));
  const tw = tokenWords.length ? tokenWords : qNoThe.split(/\s+/);
  const distinct = tw.filter(w => !commonBankWords.has(w.toLowerCase()));
  const searchWords = distinct.length ? distinct : tw;
  const loc = parseSearchLocation(q);
  const stCode = state ? String(state).toUpperCase() : null;
  const stateFilter = stCode ? `%20AND%20STALP%3A${stCode}` : '';
  const base = (f, n) => `${FDIC_BASE}/institutions?filters=${f}%20AND%20ACTIVE%3A1${stateFilter}&fields=${fields}&limit=${n}&sort_by=ASSET&sort_order=DESC`;

  // Same retrieval as the website: starts-with per distinctive word, the
  // combined contains query, contains for short single words, "The" prefix,
  // plus the location-aware queries (name within a stated state; city names).
  const urls = [
    `${FDIC_BASE}/institutions?search=${encodeURIComponent(q)}&fields=${fields}&limit=30&sort_by=ASSET&sort_order=DESC&filters=ACTIVE%3A1${stateFilter}`,
    ...searchWords.slice(0, 4).map(w => base(`NAME%3A${encodeURIComponent(w)}*`, 50)),
    base(`NAME%3AThe*${encodeURIComponent(searchWords[0])}*`, 20),
  ];
  if (tw.length > 1) urls.push(base(`NAME%3A*${tw.map(encodeURIComponent).join('*')}*`, 20));
  if (tw.length === 1 && tw[0].length <= 6) urls.push(base(`NAME%3A*${encodeURIComponent(tw[0])}*`, 50));
  if (loc.state && loc.nameQuery && loc.nameQuery !== qNoThe && !stCode) {
    const nw = loc.nameQuery.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()));
    const nd = nw.filter(w => !commonBankWords.has(w.toLowerCase()));
    (nd.length ? nd : nw).slice(0, 3).forEach(w => urls.push(`${FDIC_BASE}/institutions?filters=NAME%3A*${encodeURIComponent(w)}*%20AND%20STALP%3A${loc.state}%20AND%20ACTIVE%3A1&fields=${fields}&limit=50&sort_by=ASSET&sort_order=DESC`));
  }
  loc.cities.forEach(c => urls.push(base(`CITY%3A%22${encodeURIComponent(c)}%22`, 100)));
  urls.push(...fdicAliasUrls(FDIC_BASE, tw, fields, stateFilter)); // trade + former names ("Bank of Oklahoma" -> BOKF)

  const scoreQuery = stCode ? `${q} ${stCode}` : q;
  const cuPromise = searchCreditUnions(q, scoreQuery, stCode, loc)
    .catch(e => ({ rows: [], failed: true, asOf: null, error: e.message }));

  let failures = 0;
  const get = u => fetchFDIC(u).catch(() => new Promise(r => setTimeout(r, 700)).then(() => fetchFDIC(u))).catch(() => { failures++; return { data: [] }; });
  const results = await Promise.all(urls.map(get));
  const cu = await cuPromise;
  const fdicFailed = failures === urls.length;
  if (fdicFailed && cu.failed) throw new Error('The FDIC and NCUA data sources are both busy right now. Please retry in a few seconds.');

  // Score every candidate (the old version returned them in asset order with
  // no scoring, so 50 large "American…" banks crowded out "American Heritage Bank").
  const seen = new Map();
  results.forEach(r => (r.data || []).forEach(x => {
    const d = x.data; if (!d?.CERT) return;
    const { score, aka } = institutionRelevance(d, scoreQuery);
    if (!seen.has(d.CERT) || seen.get(d.CERT).score < score) seen.set(d.CERT, { d, score, aka });
  }));
  const banks = [...seen.values()]
    .filter(x => x.score >= 40)
    .map(({ d, score, aka }) => ({
      type: 'bank',
      cert: d.CERT,
      name: d.NAME,
      city: d.CITY,
      state: d.STALP,
      assets_thousands: d.ASSET,
      website: d.WEBADDR || null,
      match_score: score,
      ...(aka ? { matched_name: aka.name, matched_name_type: aka.kind } : {}),
      profile_url: `https://vaultbot.ai/bank/${d.CERT}`,
      _assets: Number(d.ASSET) || 0,
    }));
  const creditUnions = cu.rows.map(({ cu: c, score, aka }) => ({
    type: 'credit_union',
    charter_number: String(c.id),
    name: c.name,
    city: c.city,
    state: c.state,
    assets_thousands: c.assets != null ? Math.round(Number(c.assets) / 1000) : null, // NCUA reports dollars; banks are in thousands
    members: c.members ?? null,
    match_score: score,
    ...(aka ? { matched_name: aka.name, matched_name_type: aka.kind } : {}),
    ...((c.tradeNames || []).length ? { trade_names: c.tradeNames } : {}),
    data_as_of: cu.asOf,
    profile_url: `https://vaultbot.ai${cuSlugPath(c)}`,
    _assets: (Number(c.assets) || 0) / 1000,
  }));
  // Relevance first, then size (both in thousands of dollars).
  const merged = [...banks, ...creditUnions]
    .sort((a, b) => b.match_score - a.match_score || b._assets - a._assets)
    .slice(0, max)
    .map(({ _assets, ...r }) => r);
  // Partial failure is reported, never silent (bug #15): an AI client must not
  // read "no credit unions" when NCUA was simply unreachable.
  if (cu.failed) merged.push({ type: 'notice', message: 'Credit union results are unavailable right now (NCUA data source unreachable). Bank results above are complete; retry for credit unions.' });
  if (fdicFailed) merged.push({ type: 'notice', message: 'Bank results are unavailable right now (FDIC API busy). Credit union results above are complete; retry for banks.' });
  return merged;
}

// Parse an FDIC REPDTE (YYYYMMDD) into period metadata for the history
// (start_year/frequency) paths of get_bank_profile and get_loan_mix.
function fdicPeriodInfo(repdte) {
  const s = String(repdte || '');
  const year = Number(s.slice(0, 4));
  const mmdd = s.slice(4, 8);
  const qByMmdd = { '0331': 1, '0630': 2, '0930': 3, '1231': 4 };
  const quarter = qByMmdd[mmdd] || null;
  const isYearEnd = mmdd === '1231';
  // Base label is quarter-based (Q4 for Dec-31); annual mode overrides year-ends to FY below.
  const label = quarter ? `Q${quarter} ${year}` : `${year}`;
  return { year, quarter, isYearEnd, label };
}

// Select which call-report rows to return. `rows` are FDIC financial rows
// (any order). With no start_year, returns them sorted newest-first (the default
// window). With start_year: annual keeps Dec-31 year-ends plus the latest non-Q4
// quarter (flagged _partial); quarterly keeps every quarter from start_year,
// capped at the most recent 40. Each returned row carries a _period.
function selectHistoryRows(rows, { start_year, frequency } = {}) {
  const freq = frequency === 'annual' ? 'annual' : 'quarterly';
  const withP = rows
    .map(r => ({ ...r, _period: fdicPeriodInfo(r.REPDTE) }))
    .filter(r => !isNaN(r._period.year))
    .sort((a, b) => Number(b.REPDTE) - Number(a.REPDTE));
  if (start_year == null) {
    return { rows: withP, frequency: freq, capped: false, multi_year: false };
  }
  const sy = Number(start_year);
  const inRange = withP.filter(r => r._period.year >= sy);
  if (freq === 'annual') {
    const yearEnds = inRange
      .filter(r => r._period.isYearEnd)
      .map(r => ({ ...r, _period: { ...r._period, label: `FY${r._period.year}` } }));
    const newest = withP[0];
    let out = yearEnds.slice();
    if (newest && !newest._period.isYearEnd && newest._period.year >= sy) {
      out = [{ ...newest, _partial: true }, ...yearEnds];
    }
    out.sort((a, b) => Number(b.REPDTE) - Number(a.REPDTE));
    return { rows: out, frequency: 'annual', capped: false, multi_year: true };
  }
  let q = inRange.slice();
  let capped = false;
  if (q.length > 40) { q = q.slice(0, 40); capped = true; }
  return { rows: q, frequency: 'quarterly', capped, multi_year: true };
}

async function getBankProfile(args) {
  const { cert, start_year, frequency } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Use search_institutions to get a CERT first.');
  const useHistory = start_year != null;

  // ── Cache check ──────────────────────────────────────────────────────────
  const cacheKey = useHistory
    ? `bank-profile-${cert}-${frequency === 'annual' ? 'annual' : 'quarterly'}-sy${Number(start_year)}`
    : `bank-profile-${cert}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };
  }

  // ── Cache miss: fetch from FDIC ──────────────────────────────────────────
  const instFields = 'NAME,CERT,CITY,STALP,ADDRESS,ZIP,WEBADDR,ESTYMD,ACTIVE,INSTCAT,CHRTAGNT,REPDTE,ASSET,DEP,EQ,NETINC,STNAME,NAMEHCR';
  const finFields = 'REPDTE,ASSET,DEP,EQ,NETINC,RBC1AAJ,ROA,ROE,NIMY,NCLNLSR,LNLSDEPR,NUMEMP';
  // History mode pulls a multi-year range; default keeps the latest 8 quarters.
  const finLimit = useHistory ? 200 : 8;
  const dateFilter = useHistory ? `%20AND%20REPDTE%3A%5B${Number(start_year)}0101%20TO%20*%5D` : '';
  const [iR, fR] = await Promise.all([
    fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=${instFields}&limit=1`),
    fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}${dateFilter}&fields=${finFields}&limit=${finLimit}&sort_by=REPDTE&sort_order=DESC`),
  ]);
  const inst = iR.data?.[0]?.data;
  const rawHistory = (fR.data || []).map(d => d.data).filter(Boolean);
  if (!inst && !rawHistory.length) throw new Error(`No institution found for CERT ${cert}`);

  const sel = selectHistoryRows(rawHistory, { start_year, frequency });
  const rows = sel.rows;
  const latest = rows[0] || {};

  const mapRow = (h) => {
    const row = {
      report_date: h.REPDTE,
      period_label: (h._period || fdicPeriodInfo(h.REPDTE)).label,
      assets_thousands: h.ASSET,
      deposits_thousands: h.DEP,
      net_income_thousands: h.NETINC,
      net_income_ytd: true,
      roa_percent: h.ROA,
      roe_percent: h.ROE,
    };
    if (h._partial) row.is_partial_year = true;
    return row;
  };

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
      period_label: latest.REPDTE ? (latest._period || fdicPeriodInfo(latest.REPDTE)).label : null,
      assets_thousands: latest.ASSET,
      deposits_thousands: latest.DEP,
      equity_thousands: latest.EQ,
      net_income_thousands: latest.NETINC,
      net_income_ytd: true,
      roa_percent: latest.ROA,
      roe_percent: latest.ROE,
      nim_percent: latest.NIMY,
      capital_ratio_percent: latest.RBC1AAJ,
      noncurrent_loans_percent: latest.NCLNLSR,
      loan_to_deposit_ratio_percent: latest.LNLSDEPR,
      employees: latest.NUMEMP,
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  if (useHistory) {
    result.frequency = sel.frequency;
    result.start_year = Number(start_year);
    result.periods_returned = rows.length;
    if (sel.capped) result.capped = 'Quarterly history capped at the most recent 40 quarters.';
    result.income_basis = 'Call-report net income is year-to-date as of each report_date (net_income_ytd:true). Annual (FY) rows are full years and comparable to each other; a row flagged is_partial_year is a YTD stub, not comparable to a full year. ROA and ROE are FDIC-annualized ratios.';
    result.financials_history = rows.map(mapRow);
  } else {
    result.quarterly_history = rows.map(mapRow);
  }

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
  const cacheKey = `recent-charters-v2-${year || 'all'}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  const fields = 'NAME,CERT,CITY,STALP,ASSET,ESTYMD,CHRTAGNT,WEBADDR,NAMEHCR';
  const filters = year
    ? `ESTYMD%3A%5B${year}0101%20TO%20${year}1231%5D%20AND%20ACTIVE%3A1`
    : `ESTYMD%3A%5B20230101%20TO%20*%5D%20AND%20ACTIVE%3A1`;
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
  // Never cache an empty list: FDIC failures and silent filter mismatches (e.g. the
  // 2026-11-06 history/institutions reindex) look identical to 'nothing found'.
  if ((result.charters || []).length) await cacheSet(cacheKey, result).catch(() => {});
  return result;
}

async function getMAActivity(args) {
  const { year, limit = 50 } = args || {};
  const max = Math.min(Number(limit) || 50, 200);
  const cacheKey = `ma-activity-v2-${year || 'all'}-${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  const fields = 'TRANSNUM,EFFDATE,CHANGECODE_DESC,ACQ_INSTNAME,ACQ_CERT,ACQ_PCITY,ACQ_PSTALP,OUT_INSTNAME,OUT_CERT,OUT_PCITY,OUT_PSTALP,ASSISTED_PAYOUT_FLAG';
  let filters = 'REPORT_TYPE%3A223';
  if (year) filters += `%20AND%20EFFDATE%3A%5B${year}0101%20TO%20${year}1231%5D`;
  else filters += `%20AND%20EFFDATE%3A%5B20230101%20TO%20*%5D`;
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
  // Never cache an empty list: FDIC failures and silent filter mismatches (e.g. the
  // 2026-11-06 history/institutions reindex) look identical to 'nothing found'.
  if ((result.transactions || []).length) await cacheSet(cacheKey, result).catch(() => {});
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
  if (state) instFilters += `%20AND%20STALP%3A%22${state.toUpperCase()}%22`;
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

// ── 5.1 shared helpers ─────────────────────────────────────────────────────
// Null-preserving number parse: FDIC omits or nulls fields it doesn't have,
// and a missing value must stay null rather than becoming a fake 0.
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// Run async fn over items with at most `limit` in flight — keeps fan-out
// queries polite to FDIC's rate limiter and inside the 15s ceiling.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = { ok: true, value: await fn(items[idx], idx) }; }
      catch (e) { out[idx] = { ok: false, error: e }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// Supplementary call-report fields for get_loan_mix (5.1). The first three are
// already proven; the rest are new and verified by behavior (see
// supplementary_field_coverage in the response). Fetched in a separate query
// so an unknown field name can never break the core loan-mix answer.
const LOANMIX_SUPP_KNOWN = ['LNRECONS', 'LNREMULT', 'LNRENRES'];
const LOANMIX_SUPP_NEW = ['LNREAG', 'LNRENROW', 'LNRENROT', 'RBCT1J', 'RBCT2', 'RBC', 'RWAJ', 'RBCRWAJ', 'CBLRIND', 'LNATRES'];

async function fetchLoanMixSupplement(cert, fromRepdte) {
  const base = `${FDIC_BASE}/financials?filters=CERT%3A${cert}%20AND%20REPDTE%3A%5B${fromRepdte}%20TO%20*%5D&limit=200&sort_by=REPDTE&sort_order=DESC`;
  const byDate = new Map();
  const merge = (rows) => {
    for (const r of rows) {
      if (!r || !r.REPDTE) continue;
      byDate.set(String(r.REPDTE), { ...(byDate.get(String(r.REPDTE)) || {}), ...r });
    }
  };
  const all = ['REPDTE', ...LOANMIX_SUPP_KNOWN, ...LOANMIX_SUPP_NEW].join(',');
  try {
    const r = await fetchFDIC(`${base}&fields=${all}`);
    merge((r.data || []).map(d => d.data));
    return { byDate, mode: 'combined' };
  } catch (e) {
    // A rejected field list (400) means at least one name is unknown — fall
    // back to one query per field so every valid field still lands.
    const fields = [...LOANMIX_SUPP_KNOWN, ...LOANMIX_SUPP_NEW];
    const results = await mapLimit(fields, 4, async (f) => {
      const r = await fetchFDIC(`${base}&fields=REPDTE,${f}`);
      return (r.data || []).map(d => d.data);
    });
    results.forEach(res => { if (res.ok) merge(res.value); });
    return { byDate, mode: 'per_field', combined_error: e.message };
  }
}

// Shift an FDIC REPDTE back N years, same quarter-end (20260630 -> 20230630).
function repdteMinusYears(repdte, years) {
  const s = String(repdte);
  return `${Number(s.slice(0, 4)) - years}${s.slice(4, 8)}`;
}

async function getLoanMix(args) {
  const { cert, quarters = 1, start_year, frequency } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');
  const useHistory = start_year != null;
  const max = Math.min(Math.max(Number(quarters) || 1, 1), 8);
  const freq = frequency === 'annual' ? 'annual' : 'quarterly';

  // v51 prefix: the 5.1 response shape differs, so it must not serve a cached 5.0 body.
  const cacheKey = useHistory
    ? `loan-mix-v53-${cert}-${freq}-sy${Number(start_year)}`
    : `loan-mix-v53-${cert}-q${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  // FDIC loan mix fields. LNREMULT (multifamily) is the most likely to cause field-name issues
  // in BankFind v2, so we try with it first, then fall back without it if FDIC rejects the query.
  const fieldsWithMult = 'REPDTE,LNLSGR,LNRE,LNRECONS,LNRENRES,LNRERES,LNREMULT,LNCI,LNAG,LNCON';
  const fieldsNoMult   = 'REPDTE,LNLSGR,LNRE,LNRECONS,LNRENRES,LNRERES,LNCI,LNAG,LNCON';

  const limit = useHistory ? 200 : max;
  const dateFilter = useHistory ? `%20AND%20REPDTE%3A%5B${Number(start_year)}0101%20TO%20*%5D` : '';

  let rawRows = null;
  let usedMultifamily = true;
  try {
    const fR = await fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}${dateFilter}&fields=${fieldsWithMult}&limit=${limit}&sort_by=REPDTE&sort_order=DESC`);
    rawRows = (fR.data || []).map(d => d.data).filter(Boolean);
  } catch (e) {
    if (e.message.includes('400') || e.message.toLowerCase().includes('field')) {
      const fR = await fetchFDIC(`${FDIC_BASE}/financials?filters=CERT%3A${cert}${dateFilter}&fields=${fieldsNoMult}&limit=${limit}&sort_by=REPDTE&sort_order=DESC`);
      rawRows = (fR.data || []).map(d => d.data).filter(Boolean);
      usedMultifamily = false;
    } else {
      throw e;
    }
  }

  if (!rawRows || !rawRows.length) {
    throw new Error(`No financial data found for CERT ${cert}. The certificate may be inactive or not FDIC-insured. Verify with search_institutions or get_bank_profile first.`);
  }

  const sel = selectHistoryRows(rawRows, { start_year, frequency });
  const history = sel.rows;

  // Supplement covers every returned period plus 36 months back, so the
  // FIL-22-2006 growth test has its comparison quarter.
  const oldestReturned = history.length ? String(history[history.length - 1].REPDTE) : String(rawRows[0].REPDTE);
  const suppFrom = Math.max(19920101, Number(repdteMinusYears(oldestReturned, 3)));
  const [iR, supp] = await Promise.all([
    fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP&limit=1`).catch(() => ({ data: [] })),
    fetchLoanMixSupplement(cert, suppFrom).catch(e => ({ byDate: new Map(), mode: 'failed', combined_error: e.message })),
  ]);
  const inst = iR.data?.[0]?.data;

  const pct = (n, d) => (n != null && d != null && d > 0) ? Number((n / d * 100).toFixed(2)) : null;

  // Total risk-based capital, with the formula used recorded honestly.
  const capitalOf = (s) => {
    if (!s) return { value: null, basis: null };
    // Community bank leverage ratio (CBLR) banks don't report risk-based capital:
    // FDIC returns RBC = 0 and RWAJ = 0 but a real RBCT1J. Falling through to
    // tier 1 would publish an estimate the spec forbids (found 2026-11-06 on
    // cert 10012; ~1,800 banks). CBLRIND is the flag; RBC=0 & RWAJ=0 is the backstop.
    const rwaj = numOrNull(s.RWAJ);
    if (numOrNull(s.CBLRIND) === 1 || (numOrNull(s.RBC) === 0 && (rwaj === 0 || rwaj == null)))
      return { value: null, basis: 'CBLR bank: no risk-based capital reported, so capital-based ratios are null (not estimated)' };
    const rbc = numOrNull(s.RBC);
    if (rbc != null && rbc > 0) return { value: rbc, basis: 'RBC (total risk-based capital)' };
    const t1 = numOrNull(s.RBCT1J), t2 = numOrNull(s.RBCT2);
    if (t1 != null && t2 != null && t1 + t2 > 0) return { value: t1 + t2, basis: 'Tier 1 (RBCT1J) + Tier 2 (RBCT2)' };
    const ratio = numOrNull(s.RBCRWAJ), rwa = numOrNull(s.RWAJ);
    if (ratio != null && rwa != null && ratio > 0 && rwa > 0) return { value: Math.round(ratio * rwa / 100), basis: 'Total RBC ratio (RBCRWAJ) x risk-weighted assets (RWAJ)' };
    return { value: null, basis: null };
  };
  // Regulatory CRE per FIL-22-2006: construction + multifamily + non-owner-
  // occupied nonfarm nonresidential. Null when the non-owner split is missing.
  const regCreOf = (s) => {
    if (!s) return null;
    const nonOwner = numOrNull(s.LNRENROT);
    if (nonOwner == null) return null;
    return (numOrNull(s.LNRECONS) || 0) + (numOrNull(s.LNREMULT) || 0) + nonOwner;
  };

  const periods = history.map(h => {
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

    const s = supp.byDate.get(String(h.REPDTE)) || null;
    const farmland = s ? numOrNull(s.LNREAG) : null;
    const ownerOcc = s ? numOrNull(s.LNRENROW) : null;
    const nonOwnerOcc = s ? numOrNull(s.LNRENROT) : null;

    const reBreakdown = {
      residential_1_4_family: { thousands: resi, percent_of_loans: pct(resi, total), percent_of_re: pct(resi, totalRE) },
      commercial_real_estate: { thousands: cre, percent_of_loans: pct(cre, total), percent_of_re: pct(cre, totalRE) },
      construction_land_dev: { thousands: construction, percent_of_loans: pct(construction, total), percent_of_re: pct(construction, totalRE) },
    };
    if (multifamily !== null) {
      reBreakdown.multifamily = { thousands: multifamily, percent_of_loans: pct(multifamily, total), percent_of_re: pct(multifamily, totalRE) };
    }
    if (farmland != null) {
      reBreakdown.farmland = { thousands: farmland, percent_of_loans: pct(farmland, total), percent_of_re: pct(farmland, totalRE) };
      // Residual so the buckets always sum to the real estate total. Named
      // other_re_loans, not other_real_estate, to avoid confusion with ORE
      // (other real estate OWNED, i.e. foreclosed property).
      const residual = Math.max(0, totalRE - resi - cre - construction - (multifamily || 0) - farmland);
      reBreakdown.other_re_loans = { thousands: residual, percent_of_loans: pct(residual, total), percent_of_re: pct(residual, totalRE) };
    }
    if (ownerOcc != null || nonOwnerOcc != null) {
      reBreakdown.commercial_real_estate.owner_occupied_thousands = ownerOcc;
      reBreakdown.commercial_real_estate.non_owner_occupied_thousands = nonOwnerOcc;
    }

    // Regulatory CRE test. Since Mar 31, 2020 examiners measure credit
    // concentrations against tier 1 capital + the allowance for credit losses on
    // loans (FDIC FIL-31-2020, Fed SR 20-8) for ALL banks — which also covers CBLR
    // banks. The FIL-22-2006 total-risk-based-capital basis is kept as a legacy view.
    const cap = capitalOf(s);
    const regCre = regCreOf(s);
    const constrPctCap = pct(construction, cap.value);
    const regCrePctCap = pct(regCre, cap.value);
    const t1 = s ? numOrNull(s.RBCT1J) : null, acl = s ? numOrNull(s.LNATRES) : null;
    const supCap = (t1 != null && t1 > 0 && acl != null) ? t1 + acl : null;
    const constrPctSup = pct(construction, supCap);
    const regCrePctSup = pct(regCre, supCap);
    // Warnings use the current examiner basis; fall back to the legacy basis only if it is missing.
    const wConstr = constrPctSup ?? constrPctCap, wCre = regCrePctSup ?? regCrePctCap;
    const wBasis = supCap != null ? 'tier 1 capital + allowance' : 'total risk-based capital';
    const prior = supp.byDate.get(repdteMinusYears(h.REPDTE, 3)) || null;
    const priorRegCre = regCreOf(prior);
    const creGrowth36 = (regCre != null && priorRegCre != null && priorRegCre > 0)
      ? Number(((regCre - priorRegCre) / priorRegCre * 100).toFixed(1)) : null;
    const warnings = [];
    if (wConstr != null && wConstr >= 100) warnings.push(`Construction & land development is ${wConstr}% of ${wBasis} (guidance threshold 100%).`);
    if (wCre != null && wCre >= 300) {
      warnings.push(creGrowth36 != null && creGrowth36 >= 50
        ? `Total CRE is ${wCre}% of ${wBasis} and grew ${creGrowth36}% over 36 months (guidance thresholds 300% and 50%).`
        : `Total CRE is ${wCre}% of ${wBasis} (guidance threshold 300%; the 50% 36-month growth leg ${creGrowth36 == null ? 'could not be computed' : `is not met at ${creGrowth36}%`}).`);
    }
    const creLoansPct = pct(cre + construction, total);

    const row = {
      report_date: h.REPDTE,
      period_label: (h._period || fdicPeriodInfo(h.REPDTE)).label,
      gross_loans_thousands: total,
      categories: {
        real_estate: { thousands: totalRE, percent_of_loans: pct(totalRE, total) },
        commercial_industrial: { thousands: ci, percent_of_loans: pct(ci, total) },
        agricultural: { thousands: ag, percent_of_loans: pct(ag, total) },
        consumer: { thousands: consumer, percent_of_loans: pct(consumer, total) },
        other: { thousands: otherLoans, percent_of_loans: pct(otherLoans, total) },
      },
      real_estate_breakdown: reBreakdown,
      ag_total: farmland != null
        ? { thousands: ag + farmland, percent_of_loans: pct(ag + farmland, total), note: 'Agricultural production loans plus farmland-secured real estate.' }
        : null,
      concentration_flags: {
        cre_and_construction_pct_of_loans: creLoansPct,
        commercial_re_concentration_percent: creLoansPct, // DEPRECATED alias (5.1) — same value; removed in a later release
        tier1_plus_acl_thousands: supCap,
        construction_pct_of_tier1_plus_acl: constrPctSup,
        regulatory_cre_pct_of_tier1_plus_acl: regCrePctSup,
        total_risk_based_capital_thousands: cap.value,
        capital_basis: cap.basis,
        construction_pct_of_risk_based_capital: constrPctCap,
        regulatory_cre_thousands: regCre,
        regulatory_cre_pct_of_risk_based_capital: regCrePctCap,
        regulatory_cre_growth_36m_pct: creGrowth36,
        cre_construction_warning: warnings.length ? warnings.join(' ') : null,
      },
    };
    if (h._partial) row.is_partial_year = true;
    return row;
  });

  // Field coverage — how many returned periods each supplementary field
  // actually populated. Lets a reader (and our own post-deploy check) tell a
  // real zero from a field FDIC never supplied.
  const coverage = {};
  for (const f of LOANMIX_SUPP_NEW) {
    const n = history.filter(h => { const s = supp.byDate.get(String(h.REPDTE)); return s && numOrNull(s[f]) != null; }).length;
    coverage[f] = `${n}/${history.length}`;
  }

  const result = {
    cert,
    name: inst?.NAME || `CERT ${cert}`,
    city: inst?.CITY,
    state: inst?.STALP,
    latest_quarter: periods[0] || null,
    multifamily_data_available: usedMultifamily,
    interpretation_notes: {
      categories: 'Five top-level loan categories. Percentages are of gross loans & leases.',
      real_estate_breakdown: 'RE subcategories break out the key types regulators watch. When farmland is available, other_re_loans holds any residual so the subcategories sum to the real estate total.',
      ag_exposure: 'ag_total = agricultural production loans + farmland. Ag banks look far less ag-heavy if only the production line is read.',
      cre_concentration: 'cre_and_construction_pct_of_loans is a share of LOANS, not the regulatory test. The regulatory test (FDIC FIL-22-2006): construction & land >= 100% of capital, or total CRE (construction + multifamily + non-owner-occupied nonfarm nonresidential) >= 300% of capital with >= 50% growth over 36 months. Capital is tier 1 + the allowance for credit losses (the *_pct_of_tier1_plus_acl fields; see capital). Loans to finance CRE not secured by real estate are not in public call-report summaries and are excluded. commercial_re_concentration_percent is a deprecated alias of cre_and_construction_pct_of_loans.',
      capital: 'Primary basis: tier 1 capital + allowance for credit losses on loans (RBCT1J + LNATRES), the denominator examiners have used for credit concentrations since March 31, 2020 (FDIC FIL-31-2020; Fed SR 20-8) for all banks, including community bank leverage ratio (CBLR) banks. The *_pct_of_risk_based_capital fields are the original FIL-22-2006 total-risk-based-capital view; CBLR banks do not report risk-based capital, so those are null for them rather than estimated. Warnings use the tier 1 + allowance basis.',
      multifamily: usedMultifamily ? 'Multifamily (5+ unit residential) included.' : 'Multifamily data not available in this query (FDIC field not exposed for this institution).',
      supplementary_field_coverage: coverage,
      supplementary_fetch_mode: supp.mode,
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  if (useHistory) {
    result.frequency = sel.frequency;
    result.start_year = Number(start_year);
    result.periods_returned = periods.length;
    if (sel.capped) result.capped = 'Quarterly history capped at the most recent 40 quarters.';
    result.financials_history = periods;
  } else {
    result.quarters_returned = periods.length;
    result.quarterly_history = periods;
  }
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

// FDIC SOD branch service-type codes (BRSERTYP) -> plain labels. Verified
// against the live SOD response for cert 3108 (main office returns 11). Explains
// $0-deposit sites: a drive-through or limited-service office books no deposits
// of its own but is not a dead branch.
const SOD_SERVICE_TYPES = {
  11: 'Full service, brick and mortar office',
  12: 'Full service, retail office',
  13: 'Full service, cyber office',
  21: 'Limited service, administrative office',
  22: 'Limited service, military facility',
  23: 'Limited service, facility office',
  24: 'Limited service, loan production office',
  25: 'Limited service, consumer credit office',
  26: 'Limited service, contractual office',
  27: 'Limited service, messenger office',
  28: 'Limited service, retail office',
  29: 'Limited service, mobile/seasonal office',
  30: 'Trust office',
};
function decodeServiceType(code) {
  if (code == null || code === '') return null;
  const n = Number(code);
  return SOD_SERVICE_TYPES[n] || `Service type ${code}`;
}

// Branch-year rows above which get_branch_data switches to the size-guarded
// path. Legend (15 branches x 33 years ~ 500 rows) stays on the exact path;
// a top-10 bank (thousands of branches per year) takes the guarded one.
const BRANCH_EXACT_ROW_LIMIT = 1200;
const BRANCH_GUARD_TOP_N = 25;
const BRANCH_GUARD_MAX_YEARS = 15;
const SOD_CLOSED_YEAR_TTL_MS = 365 * 24 * 60 * 60 * 1000; // a published SOD year is final

async function getBranchData(args) {
  const { cert, state, limit = 50, year, start_year, end_year } = args || {};
  if (!cert) throw new Error('Required parameter "cert" missing. Get a CERT from search_institutions.');
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const singleYear = year != null ? Number(year) : null;
  const rangeStart = start_year != null ? Number(start_year) : null;
  const rangeEnd   = end_year != null ? Number(end_year) : null;
  const isRange = rangeStart != null || rangeEnd != null;

  const cacheKey = `branch-data-${cert}-${state || 'all'}-y${singleYear ?? 'latest'}-r${rangeStart ?? ''}_${rangeEnd ?? ''}-l${max}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  // Corrected field names, verified against a raw SOD response for cert 3108
  // (2026 filing): the main-office flag is BKMO (not MAINOFF) and the branch
  // established date is SIMS_ESTABLISHED_DATE (not ESTYMD). FDIC silently
  // drops unknown SOD field names, which is why the old names returned
  // undefined for years without an error.
  const fieldsFull = 'CERT,NAMEFULL,ADDRESBR,CITYBR,STALPBR,ZIPBR,DEPSUMBR,DEPSUM,BRSERTYP,SIMS_ESTABLISHED_DATE,SIMS_ACQUIRED_DATE,YEAR,BKMO,UNINUMBR';
  const fieldsSafe = 'CERT,NAMEFULL,CITYBR,STALPBR,DEPSUMBR,BKMO,YEAR';

  let branchFilters = `CERT%3A${cert}`;
  if (state) branchFilters += `%20AND%20STALPBR%3A%22${state.toUpperCase()}%22`;

  // ── Size probe: one row gives the latest filing year, the bank-wide deposit
  // total (DEPSUM rides on every row), and FDIC's count of branch-year rows.
  let probeTotal = null, latestYear = null;
  try {
    const p = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}&fields=YEAR,DEPSUM&limit=1&sort_by=YEAR&sort_order=DESC`);
    const pr = (p.data || []).map(d => d.data).filter(Boolean)[0];
    probeTotal = numOrNull(p.meta?.total);
    latestYear = pr ? numOrNull(pr.YEAR) : null;
  } catch (e) {
    // Probe failure is not fatal: fall through to the exact path, which has
    // its own error handling and messages.
  }

  // Map one SOD row -> branch object. Shared by every path.
  let usedFullFields = true;
  const toBranch = (r) => ({
    name: r.NAMEFULL || null,
    branch_key: usedFullFields && r.UNINUMBR != null ? Number(r.UNINUMBR) : null,
    address: usedFullFields ? (r.ADDRESBR || null) : null,
    city: r.CITYBR || null,
    state: r.STALPBR || null,
    zip: usedFullFields ? (r.ZIPBR || null) : null,
    deposits_thousands: Number(r.DEPSUMBR) || 0,
    zero_deposits: (Number(r.DEPSUMBR) || 0) === 0,
    is_main_office: Number(r.BKMO) === 1,
    service_type: usedFullFields ? decodeServiceType(r.BRSERTYP) : null,
    established: usedFullFields ? (r.SIMS_ESTABLISHED_DATE || null) : null,
    acquired: usedFullFields ? (r.SIMS_ACQUIRED_DATE || null) : null,
  });
  const buildBranches = (yearRows) => {
    let list = yearRows;
    if (usedFullFields) {
      const seen = new Set();
      list = list.filter(r => {
        const k = r.UNINUMBR;
        if (k != null && seen.has(k)) return false;
        if (k != null) seen.add(k);
        return true;
      });
    }
    return list
      .map(toBranch)
      .sort((a, b) => (Number(b.is_main_office) - Number(a.is_main_office)) || (b.deposits_thousands - a.deposits_thousands))
      .slice(0, max);
  };
  const fieldNote = (branchList) => {
    if (!usedFullFields) return 'Reduced field set returned — address, zip, service type and establish date were unavailable for this query.';
    const n = branchList.length;
    const missEst = branchList.filter(b => !b.established).length;
    return `Established date present for ${n - missEst} of ${n} branches${missEst ? ` (missing for ${missEst})` : ''}.`;
  };
  const ttlFor = (lastYearCovered) => (latestYear != null && lastYearCovered != null && lastYearCovered < latestYear) ? SOD_CLOSED_YEAR_TTL_MS : undefined;
  const SOURCE_NOTE = 'FDIC Summary of Deposits (SOD) — an annual census of branch locations and deposits, filed as of June 30 each year. Branch-level data is annual only; no public source has sub-annual branch data. SOD lists physical branches, not loan production offices.';

  // ════ Size-guarded path (large banks) ════
  if (probeTotal != null && probeTotal > BRANCH_EXACT_ROW_LIMIT && latestYear != null) {
    // Pull one year's top branches by deposits, plus the main office (which
    // could sit outside the top N), without dragging every branch-year in.
    const topBranchesForYear = async (y, n) => {
      const yf = `${branchFilters}%20AND%20YEAR%3A${y}`;
      let top, sortedServerSide = true;
      try {
        top = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${yf}&fields=${fieldsFull}&limit=${n}&sort_by=DEPSUMBR&sort_order=DESC`);
      } catch (e) {
        sortedServerSide = false;
        top = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${yf}&fields=${fieldsFull}&limit=2000&sort_by=YEAR&sort_order=DESC`);
      }
      const main = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${yf}%20AND%20BKMO%3A1&fields=${fieldsFull}&limit=1`).catch(() => ({ data: [] }));
      const rows = [...(top.data || []), ...(main.data || [])].map(d => d.data).filter(Boolean);
      return { rows, total: numOrNull(top.meta?.total), sortedServerSide };
    };
    const hint = state
      ? 'Narrow further with a smaller year range.'
      : 'Pass a 2-letter `state` to get complete branch lists for one state.';

    if (!isRange) {
      const y = singleYear ?? latestYear;
      const t = await topBranchesForYear(y, Math.max(max, BRANCH_GUARD_TOP_N));
      if (!t.rows.length) throw new Error(`No SOD branch data on file for CERT ${cert} in filing year ${y}.`);
      const branches = buildBranches(t.rows);
      const shownSum = branches.reduce((s, b) => s + b.deposits_thousands, 0);
      // DEPSUM (bank-wide SOD deposits) is populated for most banks but came
      // back 0 for JPMorgan (cert 628) in live testing — only trust it when it
      // is positive and at least the sum of the branches shown.
      const rawTotal = !state ? Math.max(0, ...t.rows.map(r => numOrNull(r.DEPSUM) || 0)) : 0;
      const bankTotal = rawTotal > 0 && rawTotal >= shownSum ? rawTotal : null;
      const result = {
        cert,
        as_of_year: y,
        branch_count: branches.length,
        total_branches_on_file: t.total,
        total_branch_deposits_thousands: shownSum,
        bank_total_deposits_thousands: bankTotal,
        state_filter: state ? state.toUpperCase() : null,
        truncated: t.total != null && t.total > branches.length,
        branches,
        interpretation_notes: {
          source: `${SOURCE_NOTE} These figures are the ${y} filing.`,
          size_guard: `This bank has ${t.total ?? 'many'} branches on file for ${y}; showing the top ${branches.length} by deposits (main office first). total_branch_deposits_thousands sums only the branches shown${bankTotal != null ? '; bank_total_deposits_thousands is the bank-wide total' : '; a bank-wide SOD total was not available for this bank — use get_bank_profile for total deposits'}. ${hint}`,
          branch_field_availability: fieldNote(branches),
          ...(t.sortedServerSide ? {} : { ranking_note: 'FDIC would not sort by deposits server-side; the list is ranked from a partial pull and may miss some large branches.' }),
        },
        profile_url: `https://vaultbot.ai/bank/${cert}`,
        _cache: { hit: false, stored_at: new Date().toISOString() },
      };
      await cacheSet(cacheKey, result, ttlFor(y)).catch(() => {});
      return result;
    }

    // Range on a large bank: per-year totals from one 1-row probe per year
    // (meta.total = branch count, DEPSUM = bank-wide deposits), plus the top
    // branches for the last year. No per-branch history at this size.
    const lo = rangeStart ?? 1994;
    const hi = Math.min(rangeEnd ?? latestYear, latestYear);
    let years = [];
    for (let y = hi; y >= lo; y--) years.push(y);
    const yearsCapped = years.length > BRANCH_GUARD_MAX_YEARS;
    years = years.slice(0, BRANCH_GUARD_MAX_YEARS).sort((a, b) => a - b);
    const perYear = await mapLimit(years, 4, async (y) => {
      const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}%20AND%20YEAR%3A${y}&fields=YEAR,DEPSUM&limit=1`);
      const row = (r.data || []).map(d => d.data).filter(Boolean)[0];
      const dep = (!state && row) ? numOrNull(row.DEPSUM) : null;
      return { year: y, branch_count: numOrNull(r.meta?.total) || 0, total_deposits_thousands: dep && dep > 0 ? dep : null };
    });
    const by_year = perYear.map((p, i) => p.ok ? p.value : { year: years[i], error: p.error.message }).filter(p => p.error || p.branch_count > 0);
    const top = await topBranchesForYear(hi, BRANCH_GUARD_TOP_N);
    const result = {
      cert,
      mode: 'multi_year',
      years: by_year.map(b => b.year),
      state_filter: state ? state.toUpperCase() : null,
      truncated: true,
      by_year,
      top_branches_latest_year: { year: hi, branches: buildBranches(top.rows).slice(0, BRANCH_GUARD_TOP_N) },
      interpretation_notes: {
        source: SOURCE_NOTE,
        size_guard: `This bank has ${probeTotal} branch-year rows on file — too many to return branch by branch inside the response budget. Returned per-year branch counts${state ? '' : ' and bank-wide deposit totals'}, plus the top ${BRANCH_GUARD_TOP_N} branches by deposits for ${hi}. ${hint}${yearsCapped ? ` Range capped to the most recent ${BRANCH_GUARD_MAX_YEARS} years.` : ''}`,
      },
      profile_url: `https://vaultbot.ai/bank/${cert}`,
      _cache: { hit: false, stored_at: new Date().toISOString() },
    };
    await cacheSet(cacheKey, result, ttlFor(hi)).catch(() => {});
    return result;
  }

  // ════ Exact path (small/mid banks) — unchanged behavior from 5.0 ════
  let rows;
  try {
    const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}&fields=${fieldsFull}&limit=${BRANCH_EXACT_ROW_LIMIT}&sort_by=YEAR&sort_order=DESC`);
    rows = (r.data || []).map(d => d.data).filter(Boolean);
  } catch (e) {
    if (e.message.includes('400') || e.message.toLowerCase().includes('field')) {
      usedFullFields = false;
      try {
        const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${branchFilters}&fields=${fieldsSafe}&limit=${BRANCH_EXACT_ROW_LIMIT}&sort_by=YEAR&sort_order=DESC`);
        rows = (r.data || []).map(d => d.data).filter(Boolean);
      } catch (e2) {
        throw new Error(`Branch data lookup for CERT ${cert} failed on both full and reduced field sets. FDIC said: ${e2.message}`);
      }
    } else {
      throw new Error(`Branch data lookup for CERT ${cert}: ${e.message}`);
    }
  }

  if (!rows.length) throw new Error(`No branch data found for CERT ${cert}${state ? ` in ${state.toUpperCase()}` : ''}. The certificate may be inactive, not FDIC-insured, or have no branches in that state. Verify with search_institutions or get_bank_profile first.`);

  const allYears = [...new Set(rows.map(r => Number(r.YEAR)).filter(y => !isNaN(y)))].sort((a, b) => b - a);
  if (latestYear == null && allYears.length) latestYear = allYears[0];

  if (isRange) {
    const lo = rangeStart ?? (allYears.length ? Math.min(...allYears) : latestYear);
    const hi = rangeEnd ?? latestYear;
    const yearsInRange = allYears.filter(y => y >= lo && y <= hi).sort((a, b) => a - b);

    const by_year = yearsInRange.map(y => {
      const branches = buildBranches(rows.filter(r => Number(r.YEAR) === y));
      return { year: y, branch_count: branches.length, total_deposits_thousands: branches.reduce((s, b) => s + b.deposits_thousands, 0), branches };
    });

    const history = new Map();
    for (const r of rows) {
      const y = Number(r.YEAR);
      if (isNaN(y) || y < lo || y > hi) continue;
      const k = usedFullFields && r.UNINUMBR != null ? Number(r.UNINUMBR) : `${r.CITYBR}|${r.ADDRESBR}`;
      const cur = history.get(k) || {
        branch_key: usedFullFields && r.UNINUMBR != null ? Number(r.UNINUMBR) : null,
        city: r.CITYBR || null,
        address: usedFullFields ? (r.ADDRESBR || null) : null,
        deposits_by_year: {},
      };
      cur.deposits_by_year[y] = Number(r.DEPSUMBR) || 0;
      history.set(k, cur);
    }
    const branch_history = [...history.values()].sort((a, b) =>
      Math.max(0, ...Object.values(b.deposits_by_year)) - Math.max(0, ...Object.values(a.deposits_by_year)));

    const result = {
      cert,
      mode: 'multi_year',
      years: yearsInRange,
      state_filter: state ? state.toUpperCase() : null,
      by_year,
      branch_history,
      interpretation_notes: {
        source: SOURCE_NOTE,
        branch_key: 'branch_key is FDIC\'s unique branch number (UNINUMBR); a gap in a branch_history row means the branch was not on file that year — an opening, a closure, or a transfer via acquisition.',
      },
      profile_url: `https://vaultbot.ai/bank/${cert}`,
      _cache: { hit: false, stored_at: new Date().toISOString() },
    };
    await cacheSet(cacheKey, result, ttlFor(hi)).catch(() => {});
    return result;
  }

  const targetYear = singleYear ?? latestYear;
  const yearRows = rows.filter(r => Number(r.YEAR) === targetYear);
  if (!yearRows.length) throw new Error(`No SOD branch data on file for CERT ${cert} in filing year ${targetYear}. Available filing years: ${allYears.join(', ')}.`);
  const branches = buildBranches(yearRows);

  const result = {
    cert,
    as_of_year: targetYear,
    branch_count: branches.length,
    total_branch_deposits_thousands: branches.reduce((sum, b) => sum + b.deposits_thousands, 0),
    state_filter: state ? state.toUpperCase() : null,
    branches,
    interpretation_notes: {
      source: `FDIC Summary of Deposits (SOD) — an annual census of branch locations and deposits, filed as of June 30 each year. Not real-time; these figures are the ${targetYear || 'latest'} filing. SOD lists physical branches, not loan production offices.`,
      branch_field_availability: fieldNote(branches),
      available_years: allYears,
    },
    profile_url: `https://vaultbot.ai/bank/${cert}`,
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result, ttlFor(targetYear)).catch(() => {});
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

// ── get_county_deposit_share: multi-year (5.1) ─────────────────────────────
// Caps keep an uncached call inside the response budget: counties x years
// leaderboards are the most expensive query shape Vault runs.
const COUNTY_HIST_MAX_YEARS = 5;
const COUNTY_HIST_MAX_PAGES = 5;

// Pull every branch row for one county filter across [lo..hi]. Tries a single
// YEAR range query (paged, de-duped so an ignored offset can't double-count);
// if FDIC rejects the range syntax, falls back to one equality query per year
// (the proven YEAR:yyyy form).
async function fetchCountyRowsForYears(filter, years) {
  const lo = Math.min(...years), hi = Math.max(...years);
  const fields = `${COUNTY_SOD_FIELDS},UNINUMBR`;
  const seen = new Set();
  const rows = [];
  const keep = (list) => {
    let added = 0;
    for (const r of list) {
      const y = Number(r.YEAR);
      if (!years.includes(y)) continue;
      const k = `${y}|${r.CERT}|${r.UNINUMBR}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r); added++;
    }
    return added;
  };
  let reported = null, mode = 'range';
  try {
    for (let page = 0; page < COUNTY_HIST_MAX_PAGES; page++) {
      const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${filter}%20AND%20YEAR%3A%5B${lo}%20TO%20${hi}%5D&fields=${fields}&limit=${COUNTY_FETCH_LIMIT}&offset=${page * COUNTY_FETCH_LIMIT}&sort_by=YEAR&sort_order=DESC`);
      const list = (r.data || []).map(d => d.data).filter(Boolean);
      reported = numOrNull(r.meta?.total);
      const added = keep(list);
      if (list.length < COUNTY_FETCH_LIMIT || added === 0) break;
    }
    if (!rows.length) throw new Error('range query returned no rows');
  } catch (e) {
    mode = 'per_year';
    rows.length = 0; seen.clear(); reported = 0;
    const res = await mapLimit(years, 3, async (y) => {
      const r = await fetchFDIC(`${FDIC_SOD_BASE}?filters=${filter}%20AND%20YEAR%3A${y}&fields=${fields}&limit=${COUNTY_FETCH_LIMIT}&sort_by=YEAR&sort_order=DESC`);
      return { list: (r.data || []).map(d => d.data).filter(Boolean), total: numOrNull(r.meta?.total) || 0 };
    });
    for (const x of res) if (x.ok) { keep(x.value.list); reported += x.value.total; }
  }
  return { rows, reported_total: reported, incomplete: reported != null && reported > rows.length, mode };
}

function resolveHistoryYears(start_year, end_year, latest) {
  const hi = Math.min(end_year != null ? Number(end_year) : latest, latest);
  const lo = start_year != null ? Math.max(1994, Number(start_year)) : hi - (COUNTY_HIST_MAX_YEARS - 1);
  let years = [];
  for (let y = hi; y >= lo; y--) years.push(y);
  const capped = years.length > COUNTY_HIST_MAX_YEARS;
  years = years.slice(0, COUNTY_HIST_MAX_YEARS).sort((a, b) => a - b);
  return { years, capped, hi };
}

async function getCountyDepositShareHistory(args) {
  const { cert, county, state, limit = 25, start_year, end_year } = args || {};
  const max = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const HIST_NOTE = 'Multi-year county share is the heaviest Vault query (counties x years leaderboards). Capped at the most recent 5 years and the bank\'s top 10 counties per call; can exceed Perplexity\'s 15-second tool limit when uncached. SOD is one snapshot per year (June 30).';

  // ── County leaderboard by year ──
  if (!cert) {
    const st = String(state).toUpperCase();
    const nameFilter = `CNTYNAMB%3A%22${encodeURIComponent(county)}%22%20AND%20STALPBR%3A%22${st}%22`;
    const latest = await latestSodYear(nameFilter);
    if (latest == null) throw new Error(`No FDIC branch data found for county "${county}" in ${st}. Use the county name only, without the word "County".`);
    const { years, capped, hi } = resolveHistoryYears(start_year, end_year, latest);
    const cacheKey = `county-share-hist-${st}-${String(county).toLowerCase()}-${years[0]}_${hi}-l${max}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return { ...cached, capped: capped ? `Range capped to the most recent ${COUNTY_HIST_MAX_YEARS} years.` : null, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

    const got = await fetchCountyRowsForYears(nameFilter, years);
    if (!got.rows.length) throw new Error(`No FDIC branch data found for county "${county}" in ${st} for ${years[0]}–${hi}.`);
    const by_year = years.map(y => {
      const yr = got.rows.filter(r => Number(r.YEAR) === y);
      if (!yr.length) return { year: y, bank_count: 0, total_county_deposits_thousands: 0, banks: [] };
      const { banks, total_county_deposits, bank_count } = rankBanksInCounty(yr);
      return { year: y, bank_count, total_county_deposits_thousands: total_county_deposits, banks: banks.slice(0, max) };
    });
    const result = {
      mode: 'county_leaderboard_history',
      county: got.rows[0].CNTYNAMB, state: st, county_fips: got.rows[0].STCNTYBR ?? null,
      years, by_year,
      capped: capped ? `Range capped to the most recent ${COUNTY_HIST_MAX_YEARS} years.` : null,
      incomplete_warning: got.incomplete ? `FDIC reported ${got.reported_total} branch rows but ${got.rows.length} were retrieved; some years may be ranked on a partial county.` : null,
      interpretation_notes: { source: 'FDIC Summary of Deposits (SOD), annual branch-level filing as of June 30', history: HIST_NOTE, fetch_mode: got.mode },
      _cache: { hit: false, stored_at: new Date().toISOString() },
    };
    await cacheSet(cacheKey, result, hi < latest ? SOD_CLOSED_YEAR_TTL_MS : undefined);
    return result;
  }

  // ── Bank footprint by year ──
  const latest = await latestSodYear(`CERT%3A${cert}`);
  if (latest == null) throw new Error(`No branch data found for CERT ${cert}. It may be inactive or not FDIC-insured. Verify with search_institutions.`);
  const { years, capped, hi } = resolveHistoryYears(start_year, end_year, latest);
  const cacheKey = `county-share-hist-cert-${cert}-${years[0]}_${hi}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, capped: capped ? `Range capped to the most recent ${COUNTY_HIST_MAX_YEARS} years.` : null, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

  // The bank's own branches for each year (proven equality filter), so a
  // county the bank entered or left mid-range still shows up.
  const own = await mapLimit(years, 3, async (y) => (await fetchCountyRows(`CERT%3A${cert}%20AND%20YEAR%3A${y}`)).rows);
  const bankRows = own.filter(x => x.ok).flatMap(x => x.value);
  if (!bankRows.length) throw new Error(`No branch data found for CERT ${cert} for ${years[0]}–${hi}.`);

  const footprint = new Map();
  for (const r of bankRows) {
    const fips = String(r.STCNTYBR);
    const y = Number(r.YEAR);
    const c = footprint.get(fips) || { county_fips: r.STCNTYBR, county: r.CNTYNAMB, state: r.STALPBR, peak: 0, byYear: {} };
    const b = c.byYear[y] || { deposits: 0, branches: 0 };
    b.deposits += Number(r.DEPSUMBR) || 0; b.branches += 1;
    c.byYear[y] = b;
    c.peak = Math.max(c.peak, b.deposits);
    footprint.set(fips, c);
  }
  const ordered = [...footprint.values()].sort((a, b) => b.peak - a.peak);
  const selected = ordered.slice(0, MAX_COUNTIES_PER_BANK);

  const countyResults = await mapLimit(selected, 3, async (c) => {
    const got = await fetchCountyRowsForYears(`STCNTYBR%3A${c.county_fips}`, years);
    const by_year = years.map(y => {
      const mine = c.byYear[y];
      if (!mine) return { year: y, present: false };
      const { banks, total_county_deposits, bank_count } = rankBanksInCounty(got.rows.filter(r => Number(r.YEAR) === y));
      const me = banks.find(b => String(b.cert) === String(cert));
      return {
        year: y, present: true,
        bank_deposits_thousands: mine.deposits, bank_branches: mine.branches,
        total_county_deposits_thousands: total_county_deposits,
        market_share_pct: me ? me.market_share_pct : null,
        rank: me ? me.rank : null,
        banks_in_county: bank_count,
      };
    });
    return {
      county: c.county, state: c.state, county_fips: c.county_fips, by_year,
      incomplete_warning: got.incomplete ? `FDIC reported ${got.reported_total} rows but ${got.rows.length} were retrieved; ranks may be partial.` : null,
    };
  });
  const counties = countyResults.map((r, i) => r.ok ? r.value
    : { county: selected[i].county, state: selected[i].state, county_fips: selected[i].county_fips, error: r.error.message });

  const result = {
    mode: 'bank_county_footprint_history',
    cert: String(cert),
    bank_name: bankRows[0].NAMEFULL,
    years,
    county_count: ordered.length,
    counties,
    capped: capped ? `Range capped to the most recent ${COUNTY_HIST_MAX_YEARS} years.` : null,
    truncated: ordered.length > selected.length
      ? { showing: selected.length, of: ordered.length, note: `Showing the ${selected.length} counties where this bank held the most deposits in any year of the range.` }
      : null,
    interpretation_notes: {
      source: 'FDIC Summary of Deposits (SOD), annual branch-level filing as of June 30',
      history: HIST_NOTE,
      present: 'present:false means the bank had no branch in that county that year (entry or exit).',
    },
    _cache: { hit: false, stored_at: new Date().toISOString() },
  };
  await cacheSet(cacheKey, result, hi < latest ? SOD_CLOSED_YEAR_TTL_MS : undefined);
  return result;
}

async function getCountyDepositShare(args) {
  const { cert, county, state, limit = 25 } = args || {};
  if (!cert && !(county && state)) {
    throw new Error('Provide either "cert" (to see every county that bank competes in) or both "county" and "state" (to see the ranked leaderboard for one county). Get a CERT from search_institutions.');
  }
  const max = Math.min(Math.max(Number(limit) || 25, 1), 200);
  if (args.start_year != null || args.end_year != null) return getCountyDepositShareHistory(args);

  // ── Mode B: one county, full leaderboard ──────────────────────────────────
  if (!cert) {
    const st = String(state).toUpperCase();
    const cacheKey = `county-share-${st}-${String(county).toLowerCase()}-l${max}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return { ...cached, _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) } };

    const nameFilter = `CNTYNAMB%3A%22${encodeURIComponent(county)}%22%20AND%20STALPBR%3A%22${st}%22`;
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

// ── get_hmda_lending ────────────────────────────────────────────────────────
// Third item from the FDIC examiner call, and the one with real reach: HMDA
// is mortgage application outcomes — originations, denials, withdrawals —
// per lender and per county, free and unauthenticated.
//
// The join is the find: FDIC's institutions endpoint carries an LEI field,
// which is HMDA's primary key. CERT -> LEI -> HMDA, no crosswalk file and no
// name matching. Callers pass a CERT like everywhere else in this server and
// never see an LEI.
//
// Coverage caveat worth stating plainly in responses: roughly half of active
// banks have an LEI recorded with FDIC (94% above $5B, ~10% under $100M), and
// small banks fall under HMDA reporting thresholds and legitimately do not
// file at all. A bank with no result here is usually not a bug.
const HMDA_BASE = 'https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations';
const HMDA_LATEST_YEAR = 2024;
// The API requires at least one filter beyond geography/lender, so actions are
// always requested explicitly. Codes per the HMDA filing spec.
const HMDA_ACTIONS = {
  1: 'originated',
  2: 'approved_not_accepted',
  3: 'denied',
  4: 'withdrawn_by_applicant',
  5: 'closed_for_incompleteness',
  6: 'purchased_loan',
  7: 'preapproval_denied',
  8: 'preapproval_approved_not_accepted',
};

async function hmdaFetch(params) {
  const url = `${HMDA_BASE}?${params}&actions_taken=1,2,3,4,5,6,7,8`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let r;
  try {
    r = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('HMDA API timeout (>15s). Try again.');
    throw new Error(`HMDA API network error: ${e.message}`);
  }
  clearTimeout(timer);
  const text = await r.text();
  if (!r.ok) throw new Error(`HMDA API returned HTTP ${r.status}: ${text.slice(0, 180)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`HMDA API returned a non-JSON response: ${text.slice(0, 180)}`); }
  if (j.errorType) throw new Error(`HMDA API error: ${j.message || j.errorType}`);
  return j.aggregations || [];
}

// Collapse the per-action rows into named counts plus the ratios that are the
// actual point of the dataset.
function summarizeHmda(aggs) {
  const by = {};
  let totalCount = 0, totalSum = 0;
  for (const a of aggs) {
    const code = Number(a.actions_taken);
    const name = HMDA_ACTIONS[code] || `action_${code}`;
    by[name] = { count: a.count || 0, dollars_thousands: Math.round((a.sum || 0) / 1000) };
    totalCount += a.count || 0;
    totalSum += a.sum || 0;
  }
  const orig = by.originated?.count || 0;
  const denied = by.denied?.count || 0;
  // Denial rate is computed against decisioned applications only. Including
  // withdrawals and incomplete files would understate it, and including
  // purchased loans (code 6) would be flatly wrong — those are loans bought
  // from another lender, not applications this bank ever decided on.
  const decisioned = orig + denied + (by.approved_not_accepted?.count || 0);
  return {
    by_action: by,
    total_applications: totalCount - (by.purchased_loan?.count || 0),
    total_dollars_thousands: Math.round(totalSum / 1000),
    originated_count: orig,
    denied_count: denied,
    denial_rate_pct: decisioned > 0 ? Number((denied / decisioned * 100).toFixed(1)) : null,
    denial_rate_basis: 'denied / (originated + denied + approved-not-accepted); excludes withdrawn, incomplete and purchased loans',
  };
}

async function certToLEI(cert) {
  const r = await fetchFDIC(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=CERT,NAME,LEI&limit=1`);
  const row = (r.data || []).map(d => d.data)[0];
  if (!row) throw new Error(`No FDIC institution found for CERT ${cert}. Verify with search_institutions.`);
  const lei = (row.LEI || '').trim();
  if (!lei) {
    throw new Error(`${row.NAME} (CERT ${cert}) has no LEI recorded with the FDIC, so its HMDA filings cannot be matched. About half of active banks have one — coverage is high above $1B in assets and sparse below $100M. Smaller banks may also fall under HMDA reporting thresholds and not file at all.`);
  }
  return { lei, name: row.NAME };
}

async function getHmdaLending(args) {
  const { cert, county, state, county_fips, year } = args || {};
  const yr = Number(year) || HMDA_LATEST_YEAR;
  if (!cert && !county_fips && !(county && state)) {
    throw new Error('Provide either "cert" (a bank\'s lending record) or "county" plus "state" / "county_fips" (all lending in a market).');
  }

  if (cert) {
    const cacheKey = `hmda-cert-${cert}-${yr}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return { ...cached, _cache: { hit: true } };
    const { lei, name } = await certToLEI(cert);
    const aggs = await hmdaFetch(`years=${yr}&leis=${encodeURIComponent(lei)}`);
    const result = {
      mode: 'bank',
      cert: String(cert),
      bank_name: name,
      year: yr,
      ...summarizeHmda(aggs),
      source: 'CFPB HMDA Data Browser, joined via the FDIC-recorded LEI',
      note: 'Mortgage applications only. A bank with no record here may simply fall under HMDA reporting thresholds.',
    };
    await cacheSet(cacheKey, result);
    return result;
  }

  // County mode. Resolve a name to FIPS through the demographics path so the
  // two tools cannot disagree about what "Davidson, TN" means.
  let fips = county_fips ? String(county_fips).padStart(5, '0') : null;
  let label = fips;
  if (!fips) {
    const demo = await getCountyDemographics({ county, state });
    fips = demo.county_fips;
    label = demo.name || `${county}, ${state}`;
  }
  const cacheKey = `hmda-county-${fips}-${yr}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cache: { hit: true } };
  const aggs = await hmdaFetch(`years=${yr}&counties=${fips}`);
  const result = {
    mode: 'county',
    county_fips: fips,
    county: label,
    year: yr,
    ...summarizeHmda(aggs),
    source: 'CFPB HMDA Data Browser',
  };
  await cacheSet(cacheKey, result);
  return result;
}

const TOOL_HANDLERS = {
  search_institutions: searchInstitutions,
  get_credit_union_profile: getCreditUnionProfile,
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
  get_hmda_lending: getHmdaLending,
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
        name: 'vault-mcp', version: VAULT_MCP_VERSION,
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
          serverInfo: { name: 'vault-mcp', version: VAULT_MCP_VERSION },
          capabilities: { tools: {} },
        });
      }

      case 'tools/list':
        // Per-tool title + annotations live on each TOOLS entry (required by the Microsoft 365 Copilot connector program).
        await safeLog({ method, durationMs: Date.now()-t0, success: true });
        return reply({ tools: TOOLS.map(t => ({ ...t, annotations: t.annotations || { readOnlyHint: true, idempotentHint: true, openWorldHint: true } })) });

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
          ? { ...data, _vault_meta: { fetched_in_ms: durationMs, fetched_in_s: Number((durationMs/1000).toFixed(1)), powered_by: 'Vault MCP by iDENTIFY · vaultbot.ai', mcp_version: VAULT_MCP_VERSION } }
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
