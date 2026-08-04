// Vault — Leadership Lookup (server-side)
// Replaces the old client-side call to api.anthropic.com, which had no auth header
// and was almost certainly failing silently in production (401/CORS on every request).
// This function:
//   1. Runs the Claude + web_search lookup server-side, where ANTHROPIC_API_KEY can
//      live safely (never exposed to the browser).
//   2. Enriches priority-role people (CEO/President/CIO-CTO/COO) with a LinkedIn
//      profile URL via Bright Data, mirroring the same logic as get_bank_leadership
//      in functions/mcp.js — this file and that one intentionally duplicate this
//      logic rather than sharing a module, matching the existing pattern in this
//      codebase (e.g. two separate fetchFDIC implementations, client vs server).
//   3. Caches results in Netlify Blobs, 30-day TTL, SHARED with functions/mcp.js
//      (same store name, same cache key pattern) — a lookup via either the website
//      or the MCP tool warms the cache for the other.

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BRIGHTDATA_SERP_ZONE = 'serp_api1vault_serp';
const BRIGHTDATA_LINKEDIN_DATASET_ID = 'gd_m8d03he47z8nwb5xc';
const PRIORITY_ROLES = new Set(['ceo', 'president', 'cio_cto', 'coo']);

// Same proven pattern as functions/mcp.js — dynamic import (not require()) because
// @netlify/blobs' CJS entry internally requires @netlify/runtime-utils, which is
// ESM-only; require() crashes with "require() of ES Module ... not supported".
// This is also a legacy V1 function, so siteID/token must be supplied manually —
// Netlify only auto-injects Blobs context for V2/Edge functions.
async function getBlobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore({
      name: 'vault-leadership-cache',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
  } catch (e) {
    console.log('[vault-leadership-cache] getBlobStore unavailable:', e.message);
    return null;
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
    console.log('[vault-leadership-cache] HIT:', key, 'age:', Math.round((Date.now() - raw._cached_at) / 3600000) + 'h');
    return raw;
  } catch (e) {
    console.log('[vault-leadership-cache] cacheGet error:', e.message);
    return null;
  }
}

async function cacheSet(key, data) {
  try {
    const store = await getBlobStore();
    if (!store) return;
    await store.setJSON(key, { ...data, _cached_at: Date.now() });
    console.log('[vault-leadership-cache] STORED:', key);
  } catch (e) {
    console.log('[vault-leadership-cache] cacheSet error:', e.message);
  }
}

// Find the bank's own LinkedIn company page via a SERP search — bank LinkedIn
// URLs don't follow a guessable pattern, so this has to be a search, not a
// direct lookup. Best-effort: returns null on any failure rather than
// throwing, since the core name/title data shouldn't depend on this succeeding.
async function findCompanyLinkedInUrl(bankName, city, state, debugSink) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) return null;
  const q = `"${bankName}" ${city} ${state} site:linkedin.com/company`;

  // Each attempt gets its OWN fresh AbortController + timeout. A single
  // shared 8s timer covering two sequential calls + a delay between them
  // was a real bug: it aborted the retry attempt mid-flight whenever the
  // first call plus the delay already ate into most of the 8s, which is
  // easy to hit with real network latency. Found by direct comparison —
  // a manual call to Bright Data succeeded cleanly while this function
  // still returned null for the identical query.
  const doSerpCall = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 22000);
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
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout (>22s)' : e.message };
    }
  };

  let result = await doSerpCall();
  if (!result.ok) {
    if (debugSink) debugSink.attempt1 = result.reason;
    // Only retry on a genuine error (CAPTCHA, malformed response) — NOT on a
    // plain timeout. A timeout means the request was just slow; retrying
    // immediately costs more time without meaningfully improving the odds,
    // and this whole call is already racing Claude's own budget in parallel.
    if (result.reason.includes('timeout')) {
      console.log('[vault-linkedin] SERP attempt 1 timed out — not retrying (retrying a timeout rarely helps and costs more time)');
    } else {
      console.log('[vault-linkedin] SERP attempt 1 failed:', result.reason, '- retrying once');
      await new Promise(r => setTimeout(r, 1500));
      result = await doSerpCall();
      if (debugSink) debugSink.attempt2 = result.ok ? 'succeeded' : result.reason;
    }
  }
  if (!result.ok) {
    console.log('[vault-linkedin] SERP giving up for this lookup:', result.reason);
    return null;
  }
  if (debugSink) debugSink.success = true;
  return result.url;
}

// Match a named person against Bright Data's LinkedIn discover-new-profiles
// dataset, scoped to a company URL. Uses the proper trigger + poll + download
// pattern (POST /trigger -> GET /progress until "ready" -> GET /snapshot),
// bounded by an absolute deadline the caller passes in. Earlier code called
// the /scrape sync shortcut directly, which is documented to fall back to
// returning {snapshot_id, status} when the match takes too long internally —
// that shape was silently misread as "no match," which is why every lookup
// came back null even when the company URL was correct. This is the real fix.
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

    while (Date.now() < deadlineMs) {
      await new Promise(r => setTimeout(r, 1500));
      const progResp = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snapshot_id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!progResp.ok) return null;
      const prog = await progResp.json();
      if (prog.status === 'failed') return null;
      if (prog.status !== 'ready') continue;

      const dlResp = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshot_id}?format=json`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!dlResp.ok) return null;
      const arr = await dlResp.json();
      const match = Array.isArray(arr) ? arr[0] : null;
      return match?.url || null;
    }
    console.log('[vault-linkedin] ran out of time budget polling for', fullName);
    return null;
  } catch (e) {
    console.log('[vault-linkedin] person lookup failed for', fullName, ':', e.message);
    return null;
  }
}

async function fetchLeadershipFromClaude(bankName, city, state, webAddr) {
  const overallStart = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the server.');

  const domainHint = webAddr
    ? `Focus your search on the bank's own website: ${webAddr.replace(/^https?:\/\//i, '').split('/')[0]}. `
    : '';
  const prompt = `You are a financial research assistant. ${domainHint}Find the following specific decision-makers at the US bank "${bankName}" (FDIC-chartered, headquartered near ${city}, ${state}) — in priority order:

1. CEO or President (top executive — may hold either or both titles)
2. CIO or CTO — the technology/information leader (HIGH priority; this is who evaluates data infrastructure vendors). Community banks often don't use these exact titles — look for the closest functional equivalent, e.g. "SVP of Information Technology," "Chief Digital Officer," "VP of IT," "EVP of Technology," or similar. Use judgment on title wording, not an exact string match.
3. COO (lower priority — include only if clearly identified, skip if uncertain)

Important: banks often have a registered/charter address that differs from where their executive team actually operates — company-wide executive leadership is exactly what's wanted here, regardless of which specific office is on file with regulators. Do not discard a bank's real, published leadership team just because it's described as "company-wide" rather than tied to one specific address.

Return ONLY a JSON array (no markdown, no explanation):
[{"name":"Full Name","title":"Their actual title as published","role_category":"ceo|president|cio_cto|coo","source":"URL or public record"}]

Max 4 people, one per role above. Only include people you are highly confident about based on search results. If you found no relevant information at all, return [].`;

  // Claude and the Bright Data company-URL search run in parallel — they're
  // independent, and stacking them sequentially would eat into the ~26s
  // function ceiling unnecessarily. Claude gets 19s (see functions/mcp.js for
  // the full history: 22s completed a real request at 26.3s internally,
  // dangerously close to Netlify's actual platform ceiling — 19s is the
  // safer settled value).
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

  const serpDebug = {};
  const [claudeSettled, companyLinkedInUrl] = await Promise.all([
    claudePromise.then(r => ({ ok: true, resp: r })).catch(e => ({ ok: false, error: e })),
    findCompanyLinkedInUrl(bankName, city, state, serpDebug),
  ]);

  if (!claudeSettled.ok) {
    const e = claudeSettled.error;
    if (e.name === 'AbortError') throw new Error('Claude API timeout (>19s).');
    throw new Error(`Claude API network error: ${e.message}`);
  }
  const resp = claudeSettled.resp;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Claude API returned HTTP ${resp.status}. ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const blockTypes = (data.content || []).map(b => b.type);
  // Use the LAST text block, not the first — when the model uses the web_search tool,
  // the response can contain multiple text blocks: preliminary "I'll look into this"
  // text BEFORE the tool runs, then the actual synthesized answer AFTER search results
  // come back. Grabbing the first block risks parsing pre-search preamble as if it were
  // the final JSON answer, which fails to parse and silently returns [] — indistinguishable
  // from a genuine "no confident answer" unless you know to look for this.
  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  const text = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';
  const clean = text.replace(/```json|```/g, '').trim();
  const debug = { stop_reason: data.stop_reason, block_types: blockTypes, text_block_count: textBlocks.length, last_text_preview: clean.slice(0, 400), serp_debug: serpDebug };

  let people = [];
  if (clean) {
    // The model sometimes adds a preamble sentence before the JSON array despite being
    // told "no explanation" — extract just the [...] substring rather than requiring the
    // ENTIRE response to be pure JSON.
    const jsonMatch = clean.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : clean;
    if (jsonStr !== '[]') {
      try { people = JSON.parse(jsonStr); } catch (e) { people = []; }
    }
  }

  // Enrich with a LinkedIn profile URL — ONLY for priority-role people, so
  // Bright Data credits and time budget aren't spent on anyone outside the
  // actual buying committee. Whatever wall-clock time is left (floor 1.5s)
  // gets raced against the lookups as a group; if it doesn't finish in time,
  // everyone gets linkedin_url: null rather than extending total time further.
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

  if (!people.length) {
    console.log('[vault-leadership] model returned genuinely empty result');
    return { people: [], company_linkedin_url: companyLinkedInUrl, debug };
  }
  console.log('[vault-leadership] found', people.length, 'people');
  return { people, company_linkedin_url: companyLinkedInUrl, debug };
}

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const params = event.queryStringParameters || {};
  const action = params.action || '';

  // ── action=trigger / action=check ────────────────────────────────────────
  // Lets the BROWSER itself trigger and poll a LinkedIn match client-side,
  // with no per-call timeout risk — a live page visit isn't bound by any
  // single Netlify function's ~26s ceiling the way get_bank_leadership is,
  // because the waiting happens in the browser's own JS (index.html), not
  // inside one function invocation. This is what makes "click the name,
  // land on LinkedIn" work automatically for any website visitor, not just
  // via the MCP bulk workflow.
  if (action === 'trigger') {
    const companyUrl = (params.company_linkedin_url || '').trim();
    const fullName = (params.full_name || '').trim();
    const triggerCert = (params.cert || '').trim();
    if (!companyUrl || !fullName) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Required params "company_linkedin_url" and "full_name" missing.' }) };
    }
    try {
      const apiKey = process.env.BRIGHTDATA_API_KEY;
      if (!apiKey) throw new Error('BRIGHTDATA_API_KEY not configured on the server.');
      const parts = fullName.split(/\s+/);
      const first_name = parts[0];
      const last_name = parts.slice(1).join(' ') || parts[0];
      const resp = await fetch(`https://api.brightdata.com/datasets/v3/trigger?dataset_id=${BRIGHTDATA_LINKEDIN_DATASET_ID}&include_errors=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ input: [{ url: companyUrl, first_name, last_name }] }),
      });
      if (!resp.ok) throw new Error(`Bright Data trigger returned HTTP ${resp.status}`);
      const { snapshot_id } = await resp.json();
      if (!snapshot_id) throw new Error('No snapshot_id returned.');
      if (triggerCert) await cacheSet(`linkedin-pending-${snapshot_id}`, { cert: triggerCert, full_name: fullName });
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ snapshot_id, status: 'triggered' }) };
    } catch (e) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'failed', error: e.message }) };
    }
  }

  if (action === 'check') {
    const snapshotId = (params.snapshot_id || '').trim();
    if (!snapshotId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Required param "snapshot_id" missing.' }) };
    }
    try {
      const apiKey = process.env.BRIGHTDATA_API_KEY;
      if (!apiKey) throw new Error('BRIGHTDATA_API_KEY not configured on the server.');
      const progResp = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snapshotId}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!progResp.ok) throw new Error(`Progress check HTTP ${progResp.status}`);
      const prog = await progResp.json();
      if (prog.status === 'failed') return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'failed' }) };
      if (prog.status !== 'ready') return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'running' }) };

      const dlResp = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!dlResp.ok) throw new Error(`Snapshot download HTTP ${dlResp.status}`);
      const arr = await dlResp.json();
      const match = Array.isArray(arr) ? arr[0] : null;

      if (match?.url) {
        // Write back into the shared leadership cache — same mechanism as the
        // MCP side, so this bank's cache entry is permanently updated for
        // every future visitor/user regardless of which surface resolved it.
        try {
          const pending = await cacheGet(`linkedin-pending-${snapshotId}`);
          if (pending?.cert) {
            const leadershipKey = `leadership-${pending.cert}`;
            const existing = await cacheGet(leadershipKey);
            if (existing?.people?.length) {
              const idx = existing.people.findIndex(p => p.name === pending.full_name);
              if (idx !== -1) {
                existing.people[idx].linkedin_url = match.url;
                await cacheSet(leadershipKey, { people: existing.people, company_linkedin_url: existing.company_linkedin_url });
              }
            }
          }
        } catch (e) { /* non-fatal */ }
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'ready', linkedin_url: match.url }) };
      }
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'not_found' }) };
    } catch (e) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'failed', error: e.message }) };
    }
  }

  const cert = (params.cert || '').trim();
  const name = (params.name || '').trim();
  const city = (params.city || '').trim();
  const state = (params.state || '').trim();
  const webAddr = (params.webAddr || '').trim() || null;
  const wantDebug = params.debug === '1';
  const bypassCache = params.nocache === '1';

  if (!cert || !name) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Required params "cert" and "name" missing.' }),
    };
  }

  const cacheKey = `leadership-${cert}`;

  try {
    if (!bypassCache) {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            people: cached.people || [],
            company_linkedin_url: cached.company_linkedin_url || null,
            _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) },
          }),
        };
      }
    }

    const { people, company_linkedin_url, debug } = await fetchLeadershipFromClaude(name, city, state, webAddr);
    await cacheSet(cacheKey, { people, company_linkedin_url });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        people,
        company_linkedin_url,
        _cache: { hit: false, stored_at: new Date().toISOString() },
        ...(wantDebug ? { _debug: debug } : {}),
      }),
    };
  } catch (e) {
    console.log('[vault-leadership] error:', e.message);
    // Fail soft — client already falls back to "No leadership data found" on empty/error
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ people: [], error: e.message }),
    };
  }
};
