// Nightly hub pre-warmer (2026-11-29). State and county hub pages are built
// from several live FDIC/Census calls and cached for 7 days; this walks the
// full list (~3,200 pages) in a rolling window so crawlers always hit a cache
// instead of triggering a live rebuild against a throttling FDIC.
//
// Pace: 2 workers, 400 ms between requests, 12 minute budget (about 500-700
// pages a night, so a full cycle takes roughly 5 nights, inside the 7-day
// cache window). Circuit breaker: if 8 of the last 20 requests fail it stops
// for the night rather than hammer FDIC. Progress is a cursor in Blobs.
// Uses /<hub>?warm=1, which only rebuilds copies older than 2 days.

const STORE = 'vault-seo-lkg';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (compatible; VaultHubWarm/1.0; +https://vaultbot.ai)';

async function mkStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE, siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN });
}

async function run(deps = {}) {
  const f = deps.fetch || fetch;
  const store = deps.store || await mkStore();
  const base = deps.base || process.env.URL || 'https://vaultbot.ai';
  const log = deps.log || console.log;
  const budgetMs = deps.budgetMs ?? 12 * 60 * 1000;
  const gap = deps.gapMs ?? 400;
  const retryWait = deps.retryWaitMs ?? 4000;
  const t0 = Date.now();

  const rec = await store.get('hub-slugs', { type: 'json' }).catch(() => null);
  if (!rec?.counties?.length) { log('[hub-warm] no hub-slugs yet (snapshot has not run)'); return { skipped: 'no slug list' }; }
  const { ABBR } = require('./sitemap.js');
  const list = [...Object.values(ABBR).map(s => `banks-in-${s}`), ...rec.counties];
  const cur = (await store.get('_hub-warm-cursor', { type: 'json' }).catch(() => null)) || { i: 0, cycles: 0 };
  let next = cur.i % list.length, taken = 0;
  const startIdx = next;
  const stats = { ok: 0, notFound: 0, failed: 0 };
  const recent = []; let aborted = null;

  async function fetchOnce(slug) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 40000);
    try { const r = await f(`${base}/${slug}?warm=1`, { signal: c.signal, headers: { 'User-Agent': UA } }); await r.text(); return r.status; }
    catch (e) { return 0; } finally { clearTimeout(t); }
  }
  async function worker() {
    while (!aborted && taken < list.length && Date.now() - t0 < budgetMs) {
      const idx = next; next = (next + 1) % list.length; taken++;
      let st = await fetchOnce(list[idx]);
      if (st !== 200 && st !== 404) { await sleep(retryWait); st = await fetchOnce(list[idx]); }
      const good = st === 200 || st === 404;
      if (st === 200) stats.ok++; else if (st === 404) stats.notFound++; else stats.failed++;
      recent.push(good ? 0 : 1); if (recent.length > 20) recent.shift();
      if (recent.length >= 12 && recent.reduce((a, b) => a + b, 0) >= 8) aborted = 'circuit breaker: 8 of the last 20 requests failed (FDIC likely throttling)';
      await sleep(gap);
    }
  }
  await Promise.all([worker(), worker()]);

  const wrapped = startIdx + taken >= list.length;
  const meta = {
    at: Date.now(), total: list.length, processed: taken, ...stats, aborted, cursor: next, wrappedCycle: wrapped,
    cycles: (cur.cycles || 0) + (wrapped ? 1 : 0), secs: Math.round((Date.now() - t0) / 1000),
    estCycleNights: taken ? Math.ceil(list.length / taken) : null,
  };
  await store.setJSON('_hub-warm-cursor', { i: next, cycles: meta.cycles });
  await store.setJSON('_hub-warm-meta', meta);
  log(`[hub-warm] ${JSON.stringify(meta)}`);
  return meta;
}

exports.run = run;
exports.handler = async () => {
  try { await run(); } catch (e) { console.log(`[hub-warm] crashed: ${e.message}`); }
  return { statusCode: 202 };
};
