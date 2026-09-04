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

// Verifies a candidate company LinkedIn URL actually resembles the bank
// being searched for, using the same distinctive-word-overlap technique as
// experienceMatchesCompany, just applied in the opposite direction (does
// the SLUG resemble the BANK NAME, rather than does a person's experience
// text resemble the slug). Found via a real false-positive: searching for
// "Bank of Hydro" (a tiny Oklahoma bank with little online presence)
// returned linkedin.com/company/north-valley-bank as the top "linkedin.com
// /company/" link in the SERP results — completely unrelated, but nothing
// checked before this fix. That's a serious failure mode: every downstream
// person-verification step trusts this URL as ground truth, so a wrong
// company URL silently corrupts everything built on top of it, not just
// the company link itself.
function companyUrlMatchesBankName(companyUrl, bankName, city) {
  if (!companyUrl || !bankName) return false;
  const slug = companyUrl.split('/company/')[1]?.split('/')[0] || '';
  const stopWords = new Set(['the', 'bank', 'of', 'na', 'national', 'association', 'inc', 'corp', 'corporation', 'company', 'llc', 'group', 'financial', 'trust', 'and', 'co', 'bancorp', 'bankshares']);
  const slugWords = slug.replace(/-/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  const slugConcatenated = slug.replace(/-/g, '').toLowerCase();
  const nameWords = bankName.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  if (!nameWords.length) return true; // bank name is entirely generic/stopwords -- nothing distinctive to check against, allow through
  if (!slugWords.length && slugConcatenated.length <= 3) return false; // slug itself has nothing distinctive either -- can't verify, reject rather than risk a coincidental match
  const nameMatch = nameWords.some(w => slugWords.includes(w) || slugConcatenated.includes(w));
  if (nameMatch) return true;
  // Bank names commonly get abbreviated to initials in real LinkedIn slugs
  // (confirmed live: "Security Bank" of Tulsa's real slug is "sbtulsa" --
  // "SB" + city, not the spelled-out name at all). The bank-name-word check
  // above would wrongly REJECT this true match, so also accept if the slug
  // contains the city name -- abbreviated slugs consistently keep that even
  // when the bank name itself is compressed to initials.
  const cityWord = (city || '').toLowerCase().replace(/[^a-z]/g, '');
  if (cityWord.length > 2 && slugConcatenated.includes(cityWord)) return true;
  // Some slugs are pure initials (e.g. "fnbok" = First National Bank + OK) --
  // build an acronym from the bank name's words (excluding only true filler
  // words, keeping "national"/"bank"/etc since those commonly contribute
  // real initials) and accept if the slug starts with it.
  const fillers = new Set(['of', 'the', 'and']);
  const initials = bankName.toLowerCase().split(/\s+/).filter(w => w.length && !fillers.has(w)).map(w => w[0]).join('');
  if (initials.length >= 2 && slugConcatenated.startsWith(initials)) return true;
  return false;
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
      // Check EVERY "linkedin.com/company/" candidate, not just the first —
      // same principle as the person-matching fix (v1.11.3): the top-ranked
      // result isn't always the right one, and blindly trusting it is
      // exactly what let north-valley-bank through for "Bank of Hydro."
      const candidates = organic.filter(o => (o.link || '').includes('linkedin.com/company/'));
      const verified = candidates.find(o => companyUrlMatchesBankName(o.link, bankName, city));
      if (candidates.length && !verified) {
        console.log('[leadership-background] REJECTED all', candidates.length, 'company URL candidate(s) for', bankName, ':', candidates.map(o => o.link).join(' | '));
      }
      return { ok: true, url: verified ? verified.link : null };
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

const BRIGHTDATA_PROFILE_DATASET_ID = 'gd_l1viktl72bvl7bjuj0'; // Bright Data "LinkedIn People Profiles" — collect-by-URL, real structured data (not a search snippet)

// Independently verifies a candidate LinkedIn URL that Claude's web search
// proposed, by actually scraping that exact profile and checking its REAL
// structured data — not trusting Claude's interpretation of a truncated
// search-result snippet.
//
// WHY THIS EXISTS: caught live. Claude's web-search fallback proposed
// https://www.linkedin.com/in/eric-bohne-63159411/ for the real Chairman of
// Security Bank (a 50-year banking veteran per the bank's own news page).
// The search snippet did contain "Experience: Security Bank Tulsa Okla",
// which passed the text-match bar — but the actual profile had 5
// connections and a generic "Owner, [Company Name]" title with no real
// bio, sitting alongside a batch of similarly-patterned unrelated people in
// entirely different states (Cincinnati OH, Amarillo TX, Atlanta, Baton
// Rouge). That's the signature of an auto-generated directory/spam
// listing, not a real executive's profile — and the search-snippet text
// alone can't distinguish the two. A real scrape can: it exposes the
// connection count and the ACTUAL experience array to check against,
// instead of whatever fragment Google's snippet happened to surface.
//
// Conservative on purpose, same philosophy as experienceMatchesCompany: a
// missed real match (false negative — we just don't get a LinkedIn URL for
// this person) costs far less than confidently handing Lee a wrong one for
// outreach.
async function verifyLinkedInProfileByUrl(profileUrl, companyLinkedInUrl, deadlineMs) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey || !profileUrl) return { verified: false, reason: 'missing api key or url' };

  try {
    const triggerResp = await fetch(`https://api.brightdata.com/datasets/v3/trigger?dataset_id=${BRIGHTDATA_PROFILE_DATASET_ID}&include_errors=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify([{ url: profileUrl }]),
    });
    if (!triggerResp.ok) return { verified: false, reason: `trigger HTTP ${triggerResp.status}` };
    const { snapshot_id } = await triggerResp.json();
    if (!snapshot_id) return { verified: false, reason: 'no snapshot_id returned' };

    while (Date.now() < deadlineMs) {
      await new Promise(r => setTimeout(r, 3000));
      const progResp = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snapshot_id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!progResp.ok) return { verified: false, reason: `progress HTTP ${progResp.status}` };
      const prog = await progResp.json();
      if (prog.status === 'failed') return { verified: false, reason: 'scrape failed' };
      if (prog.status !== 'ready') continue;

      const dlResp = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshot_id}?format=json`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!dlResp.ok) return { verified: false, reason: `download HTTP ${dlResp.status}` };
      const arr = await dlResp.json();
      const profile = Array.isArray(arr) ? arr[0] : arr;
      if (!profile || !profile.name) return { verified: false, reason: 'empty or malformed profile — likely an invalid/removed URL' };

      // Build a text blob from the REAL experience array (not a search
      // snippet) to run through the same company-match check used for
      // Bright-Data-sourced candidates.
      const expText = Array.isArray(profile.experience)
        ? profile.experience.map(e => `${e.company || e.company_name || ''} ${e.title || e.position || ''}`).join(' | ')
        : (profile.experience || profile.current_company?.name || profile.position || '');
      const textMatches = experienceMatchesCompany(expText, companyLinkedInUrl);

      // Spam/directory-listing heuristic — the exact signal that would have
      // caught the Eric Bohne false positive. Field name isn't fully
      // confirmed against live data (checking a few plausible variants),
      // so this only rejects on a CONFIRMED low number, never on a missing
      // field (missing data is not itself suspicious).
      const connectionsRaw = profile.connections ?? profile.connections_count ?? profile.followers ?? profile.follower_count;
      const suspiciouslyThin = typeof connectionsRaw === 'number' && connectionsRaw > 0 && connectionsRaw < 20;

      if (!textMatches) {
        console.log('[leadership-background] SCRAPE-VERIFY rejected (no company match):', profile.name, '| experience:', expText.slice(0, 200));
        return { verified: false, reason: 'real experience data does not mention the company' };
      }
      if (suspiciouslyThin) {
        console.log('[leadership-background] SCRAPE-VERIFY rejected (thin profile):', profile.name, '| connections:', connectionsRaw);
        return { verified: false, reason: `only ${connectionsRaw} connections — likely a directory/spam listing, not a real executive profile` };
      }

      return { verified: true, profile };
    }
    return { verified: false, reason: 'timed out waiting for scrape' };
  } catch (e) {
    return { verified: false, reason: e.message };
  }
}

async function fetchLeadershipFromClaude(bankName, city, state, webAddr) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the server.');

  const domainHint = webAddr
    ? `The bank's own website is ${webAddr.replace(/^https?:\/\//i, '').split('/')[0]} — check it as a starting point, but don't stop there if it doesn't yield clear names. Bank "leadership" or "about us" pages are frequently JS-rendered or image-based bio grids with no crawlable name text, so a real, current leadership team can exist on a site that returns nothing useful from a web search of it. If the bank's own site doesn't clearly name people, actively search local business news coverage (e.g. "${bankName} names new CEO", "${bankName} names president", "${bankName} CEO") and the bank's LinkedIn company page/posts — these frequently name executives (leadership announcements, promotions, hires) even when the bank's own website doesn't surface them. `
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

// Resolves one person's LinkedIn URL, trying the cheaper/faster path first
// and only spending a second Bright Data call if it's actually needed:
//   1. Bright Data name-search match, verified against real experience data
//      (existing path) -- if this succeeds, done, no further spend.
//   2. Only if that fails AND Claude's web search proposed a candidate:
//      independently verify THAT specific candidate via a real profile
//      scrape (not the search snippet Claude saw) before trusting it at
//      all. This is what replaces the old "just trust Claude's candidate"
//      behavior that produced a real false positive (see
//      verifyLinkedInProfileByUrl's comment for the full story).
// Either path succeeding returns a URL + honest source tag; both failing
// returns null — same graceful degradation as always, just never an
// unverified guess presented as usable data.
async function resolvePersonLinkedIn(companyLinkedInUrl, fullName, claudeCandidateUrl, deadline) {
  if (companyLinkedInUrl) {
    const verified = await lookupLinkedInProfile(companyLinkedInUrl, fullName, deadline);
    if (verified) return { url: verified, source: 'brightdata_verified' };
  }
  if (claudeCandidateUrl) {
    const scrapeDeadline = Math.min(deadline, Date.now() + 90000);
    const result = await verifyLinkedInProfileByUrl(claudeCandidateUrl, companyLinkedInUrl, scrapeDeadline);
    if (result.verified) return { url: claudeCandidateUrl, source: 'ai_search_scrape_verified' };
    console.log('[leadership-background] AI candidate for', fullName, 'failed scrape verification:', result.reason);
  }
  return { url: null, source: null };
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

    const priorityIdx = people
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => PRIORITY_ROLES.has(p.role_category));

    // Full patience now — 3 minutes per person for the primary path, run
    // concurrently across people (Bright Data handles concurrent snapshot
    // jobs fine — same assumption the bulk trigger/check workflow relies
    // on). Each person's own scrape-verification fallback (if needed) adds
    // up to another 90s on top, but only for that one person, only if the
    // primary path actually failed.
    const deadline = Date.now() + 3 * 60 * 1000;
    const results = await Promise.allSettled(
      priorityIdx.map(({ p, i }) => resolvePersonLinkedIn(companyLinkedInUrl, p.name, claudeCandidateUrls[i], deadline))
    );
    priorityIdx.forEach(({ i }, j) => {
      const outcome = results[j].status === 'fulfilled' ? results[j].value : { url: null, source: null };
      people[i].linkedin_url = outcome.url;
      people[i].linkedin_source = outcome.source;
    });

    await cacheSet(cacheKey, { people, company_linkedin_url: companyLinkedInUrl });
    await cacheDelete(pendingKey);
    console.log('[leadership-background] DONE for', cert, 'in', Math.round((Date.now() - started) / 1000), 's —', people.length, 'people,',
      people.filter(p => p.linkedin_source === 'brightdata_verified').length, 'brightdata_verified,',
      people.filter(p => p.linkedin_source === 'ai_search_scrape_verified').length, 'ai_search_scrape_verified');
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
