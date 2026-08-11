// Vault — Leadership Enrichment (background)
//
// WHY THIS EXISTS: the synchronous leadership pipeline (functions/leadership.js
// GET handler, functions/mcp.js get_bank_leadership) is bound by Netlify's real
// platform ceiling (~26s even on Pro, confirmed via direct testing — see
// hard-won-bugs history in both files). That's enough for most banks, but not
// all: banks with generic/common names (e.g. "Security Bank" — there are
// unrelated ones in MO, TX, KS, CA) force Claude's web_search step to sift
// through far more noise to disambiguate, and can consistently exceed even a
// generous synchronous budget. Confirmed live: CERT 4178 (Security Bank,
// Tulsa OK) failed 5/5 times synchronously across one session, unrelated to
// the earlier Bright-Data-retry-budget bug that explained a DIFFERENT bank's
// failures.
//
// Named with the "-background" suffix specifically — this is what tells
// Netlify (V1 Functions) to invoke it as fire-and-forget: the caller's POST
// gets an immediate 202, and this function keeps running for up to 15
// minutes, decoupled entirely from any HTTP response. Results are never read
// from this function's own return value (Netlify discards it) — the ONLY way
// results reach anyone is by writing into the shared leadership cache, which
// functions/leadership.js and functions/mcp.js already know how to read.
//
// Intentionally duplicates helper functions (getBlobStore, cacheGet/Set,
// findCompanyLinkedInUrl, lookupLinkedInProfile, experienceMatchesCompany)
// rather than sharing a module — matching the existing pattern already
// established between leadership.js and mcp.js in this codebase. Now THREE
// copies to keep in sync, not two; any future fix to the matching/search
// logic needs to be applied here too.

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min — if a background run crashes without cleaning up, don't let a stale pending marker block retries forever
const BRIGHTDATA_SERP_ZONE = 'serp_api1vault_serp';
const BRIGHTDATA_LINKEDIN_DATASET_ID = 'gd_m8d03he47z8nwb5xc';
const PRIORITY_ROLES = new Set(['ceo', 'president', 'cio_cto', 'coo']);

async function getBlobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore({
      name: 'vault-leadership-cache',
      siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
    });
  } catch (e) {
    console.log('[leadership-background] getBlobStore unavailable:', e.message);
    return null;
  }
}

async function cacheGet(key) {
  try {
    const store = await getBlobStore();
    if (!store) return null;
    const raw = await store.get(key, { type: 'json' });
    if (!raw) return null;
    return raw;
  } catch (e) {
    console.log('[leadership-background] cacheGet error:', e.message);
    return null;
  }
}

async function cacheSet(key, data) {
  try {
    const store = await getBlobStore();
    if (!store) return;
    await store.setJSON(key, { ...data, _cached_at: Date.now() });
    console.log('[leadership-background] STORED:', key);
  } catch (e) {
    console.log('[leadership-background] cacheSet error:', e.message);
  }
}

async function cacheDelete(key) {
  try {
    const store = await getBlobStore();
    if (!store) return;
    await store.delete(key);
  } catch (e) {
    console.log('[leadership-background] cacheDelete error:', e.message);
  }
}

// Same verification logic as leadership.js/mcp.js — kept in sync across all
// three files. See either of those for the full "Tom Wayne" / "Sonata Bank"
// false-positive/false-negative history behind this exact implementation.
function experienceMatchesCompany(experience, companyLinkedInUrl) {
  if (!companyLinkedInUrl) return true;
  const slug = companyLinkedInUrl.split('/company/')[1]?.split('/')[0] || '';
  const stopWords = new Set(['the', 'bank', 'of', 'na', 'national', 'association', 'inc', 'corp', 'corporation', 'company', 'llc', 'group', 'financial', 'trust', 'and', 'co', 'bancorp', 'bankshares']);
  const hyphenWords = slug.replace(/-/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  const concatenatedSlug = slug.replace(/-/g, '').toLowerCase();
  if (!hyphenWords.length && concatenatedSlug.length <= 3) return true;
  if (!experience) return false;
  const expLower = experience.toLowerCase();
  const expNoSpaces = expLower.replace(/[\s,]+/g, '');
  const hyphenMatch = hyphenWords.some(w => expLower.includes(w));
  const concatMatch = concatenatedSlug.length > 3 && expNoSpaces.includes(concatenatedSlug);
  return hyphenMatch || concatMatch;
}

// Generous version — up to ~90s across both attempts (14s + 1.5s delay + 75s
// retry ceiling), vs. the synchronous version's tight ~24s total budget. No
// deadline-vs-overall-ceiling math needed here since there's no shared 26s
// ceiling to protect against — this function has its own full ~15min budget.
async function findCompanyLinkedInUrl(bankName, city, state) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) return null;
  const q = `"${bankName}" ${city} ${state} linkedin company page`;

  const doSerpCall = async (timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      return { ok: false, reason: e.name === 'AbortError' ? `timeout (>${timeoutMs}ms)` : e.message };
    }
  };

  let result = await doSerpCall(20000);
  if (!result.ok && !result.reason.includes('timeout')) {
    console.log('[leadership-background] SERP attempt 1 failed:', result.reason, '- retrying once (generous budget, no ceiling pressure)');
    await new Promise(r => setTimeout(r, 2000));
    result = await doSerpCall(20000);
  }
  if (!result.ok) {
    console.log('[leadership-background] SERP giving up:', result.reason);
    return null;
  }
  return result.url;
}

// Same trigger + poll + download pattern as the synchronous version, just
// with a much longer per-person deadline (3 min instead of racing whatever
// was left of a ~24s shared budget).
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
      await new Promise(r => setTimeout(r, 3000));
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
      const candidates = Array.isArray(arr) ? arr : [];
      const match = candidates.find(c => c?.url && experienceMatchesCompany(c.experience, companyUrl));
      if (!match && candidates.length) {
        console.log('[leadership-background] REJECTED all', candidates.length, 'candidate(s) for', fullName, ':', candidates.map(c => `${c?.name} (${c?.experience})`).join(' | '));
        return null;
      }
      return match?.url || null;
    }
    console.log('[leadership-background] ran out of time budget polling for', fullName);
    return null;
  } catch (e) {
    console.log('[leadership-background] person lookup failed for', fullName, ':', e.message);
    return null;
  }
}

async function fetchLeadershipFromClaude(bankName, city, state, webAddr) {
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

If this bank's name is generic or shared with unrelated banks elsewhere in the country (e.g. "Security Bank," "First National Bank," "Community Bank"), take extra care to confirm any person you find is tied to THIS specific bank in ${city}, ${state} — not a similarly-named institution somewhere else. Search results mentioning the wrong state or an unrelated holding company are not a match.

For each person, also try a quick web search for their personal LinkedIn profile (e.g. "{name} {bank name} linkedin"). Only include a linkedin_url if a real search result explicitly connects that exact person to this exact bank (e.g. the result text itself says something like "Experience: ${bankName}" or an announcement names them in that role at this bank) — never guess, infer from a common name, or supply a URL you're not directly citing from a search result. Omit the field entirely if you don't have that level of confidence; a missing LinkedIn URL costs nothing, a wrong one could mean contacting the wrong person.

Return ONLY a JSON array (no markdown, no explanation):
[{"name":"Full Name","title":"Their actual title as published","role_category":"ceo|president|cio_cto|coo","source":"URL or public record","linkedin_url":"https://linkedin.com/in/... (omit if not confidently verified)"}]

Max 4 people, one per role above. Only include people you are highly confident about based on search results. If you found no relevant information at all, return [].`;

  // 90s — this is the whole point of this file existing. The synchronous
  // path is stuck at 19s (see functions/leadership.js / functions/mcp.js for
  // why that ceiling can't move), which isn't enough for genuinely noisy
  // searches (generic bank names competing against unrelated same-named
  // institutions elsewhere). A background function has no shared ~26s
  // ceiling to protect, so this can just... wait.
  const claudeController = new AbortController();
  const claudeTimer = setTimeout(() => claudeController.abort(), 90000);

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: claudeController.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Claude API timeout (>90s) — even the generous background budget wasn\'t enough for this search.');
    throw new Error(`Claude API network error: ${e.message}`);
  } finally {
    clearTimeout(claudeTimer);
  }

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
  return people;
}

exports.handler = async (event) => {
  const started = Date.now();
  let cert;
  try {
    const body = JSON.parse(event.body || '{}');
    cert = body.cert;
    const { name, city, state, webAddr } = body;
    if (!cert || !name) {
      console.log('[leadership-background] missing cert/name in trigger payload — aborting');
      return { statusCode: 202, body: '' };
    }

    console.log('[leadership-background] starting enrichment for', cert, name, city, state);

    const cacheKey = `leadership-${cert}`;
    const pendingKey = `leadership-pending-${cert}`;

    const [rawPeople, companyLinkedInUrl] = await Promise.all([
      fetchLeadershipFromClaude(name, city, state, webAddr),
      findCompanyLinkedInUrl(name, city, state),
    ]);

    const claudeCandidateUrls = rawPeople.map(p => p.linkedin_url || null);
    let people = rawPeople.map(p => ({ ...p, linkedin_url: null, linkedin_source: null }));

    if (companyLinkedInUrl && people.length) {
      const priorityIdx = people
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => PRIORITY_ROLES.has(p.role_category));

      // Full patience now — 3 minutes per person, run concurrently (Bright
      // Data handles concurrent snapshot jobs fine; this is the same
      // assumption the bulk trigger_linkedin_match/check_linkedin_match
      // workflow already relies on).
      const deadline = Date.now() + 3 * 60 * 1000;
      const results = await Promise.allSettled(
        priorityIdx.map(({ p }) => lookupLinkedInProfile(companyLinkedInUrl, p.name, deadline))
      );
      priorityIdx.forEach(({ i }, j) => {
        const verified = results[j].status === 'fulfilled' ? results[j].value : null;
        if (verified) {
          people[i].linkedin_url = verified;
          people[i].linkedin_source = 'brightdata_verified';
        } else if (claudeCandidateUrls[i]) {
          people[i].linkedin_url = claudeCandidateUrls[i];
          people[i].linkedin_source = 'ai_search_unverified';
        }
      });
    } else {
      people = people.map((p, i) => {
        const claudeUrl = claudeCandidateUrls[i];
        return { ...p, linkedin_url: claudeUrl || null, linkedin_source: claudeUrl ? 'ai_search_unverified' : null };
      });
    }

    await cacheSet(cacheKey, { people, company_linkedin_url: companyLinkedInUrl });
    await cacheDelete(pendingKey);
    console.log('[leadership-background] DONE for', cert, 'in', Math.round((Date.now() - started) / 1000), 's —', people.length, 'people,', people.filter(p => p.linkedin_source === 'brightdata_verified').length, 'verified LinkedIn');
  } catch (e) {
    console.log('[leadership-background] FAILED for', cert, ':', e.message);
    // Fail soft into the cache too — an empty result with an error note
    // unblocks the pending state so callers don't wait forever, rather than
    // leaving cert stuck in "pending" indefinitely.
    if (cert) {
      await cacheSet(`leadership-${cert}`, { people: [], company_linkedin_url: null, error: e.message }).catch(() => {});
      await cacheDelete(`leadership-pending-${cert}`).catch(() => {});
    }
  }

  return { statusCode: 202, body: '' };
};
