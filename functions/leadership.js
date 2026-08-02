// Vault — Leadership Lookup (server-side)
// Replaces the old client-side call to api.anthropic.com, which had no auth header
// and was almost certainly failing silently in production (401/CORS on every request).
// This function:
//   1. Runs the Claude + web_search lookup server-side, where ANTHROPIC_API_KEY can
//      live safely (never exposed to the browser).
//   2. Caches results in Netlify Blobs, 30-day TTL — leadership changes far less often
//      than quarterly financials, and this turns "pay per page view" into "pay once
//      per bank per month," same spirit as the FDIC caching layer in functions/mcp.js.

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

async function fetchLeadershipFromClaude(bankName, city, state, webAddr) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on the server.');

  const domainHint = webAddr
    ? `Focus your search on the bank's own website: ${webAddr.replace(/^https?:\/\//i, '').split('/')[0]}. `
    : '';
  const prompt = `You are a financial research assistant. ${domainHint}Find the current executive leadership for "${bankName}" in ${city}, ${state} — a US bank.

Return ONLY a JSON array (no markdown, no explanation):
[{"name":"Full Name","title":"Title","source":"URL or public record"}]

Include CEO, President, CFO, COO if known. Max 5 people. Only include people you are highly confident about. If uncertain, return [].`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 24000);
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Claude API timeout (>24s).');
    throw new Error(`Claude API network error: ${e.message}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Claude API returned HTTP ${resp.status}. ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();
  if (!clean || clean === '[]') return [];
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.log('[vault-leadership] failed to parse Claude response as JSON:', clean.slice(0, 150));
    return [];
  }
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
  const cert = (params.cert || '').trim();
  const name = (params.name || '').trim();
  const city = (params.city || '').trim();
  const state = (params.state || '').trim();
  const webAddr = (params.webAddr || '').trim() || null;

  if (!cert || !name) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Required params "cert" and "name" missing.' }),
    };
  }

  const cacheKey = `leadership-${cert}`;

  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          people: cached.people || [],
          _cache: { hit: true, age_hours: Math.round((Date.now() - cached._cached_at) / 3600000) },
        }),
      };
    }

    const people = await fetchLeadershipFromClaude(name, city, state, webAddr);
    await cacheSet(cacheKey, { people });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ people, _cache: { hit: false, stored_at: new Date().toISOString() } }),
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
