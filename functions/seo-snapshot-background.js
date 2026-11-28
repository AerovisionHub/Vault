// Nightly data snapshot (2026-11-29). Replaces the weekly LKG backfill.
//
// Why: every Search Console problem since Nov 12 had one root cause. Bank, CU,
// hub and sitemap pages called FDIC/NCUA live while Google was crawling, FDIC
// throttled the bursts, and degraded output (503, 404, partial sitemap) went
// out. Since Nov 22, about 1 in 7 bank-page renders hit a failed FDIC call and
// was only rescued by a saved copy.
//
// What this does, once a night (~2:30 AM Central), from about 15 bulk calls:
//   1. FDIC roster (all active banks) + 8 quarters of financials + the latest
//      Summary of Deposits year (every branch).
//   2. Computes, offline, exactly what enrichBank() in institution-seo.js
//      computes per request: same-state size-band peers, deposit footprint by
//      county, HQ-county market share.
//   3. NCUA full roster (all=1&full=1 on our own proxy).
//   4. Writes bank-{cert} and cu-{id} blobs (store vault-seo-lkg, the same
//      store and keys the edge function already uses) tagged source:'snapshot'.
//      The edge function now reads these FIRST and only calls FDIC if one is
//      missing or older than 72 hours.
//   5. Rewrites the cached sitemap from the same rosters, and prunes blobs for
//      institutions that are no longer in the active rosters.
//   6. Records _snapshot-meta, which seo-health-background.js checks.
//
// Safety: nothing is written unless the rosters pass sanity floors (>=3,800
// banks, >=3,800 CUs, and >=95% of the previous snapshot), so a throttled or
// partial pull can never overwrite good data or trigger pruning.

const FDIC = 'https://api.fdic.gov/banks';
const SOD = `${FDIC}/sod`;
const LKG_STORE = 'vault-seo-lkg';
const SITEMAP_STORE = 'vault-sitemap-cache';
const GUARD_MS = 4 * 60 * 60 * 1000;
const ASSET_BUCKETS = [0, 50e3, 100e3, 250e3, 500e3, 1e6, 3e6, 10e6, 50e6, 1e10]; // keep in sync with institution-seo.js

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mkStore(name) {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN });
}

async function fdic(f, url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await f(url);
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.data)) return j; }
    } catch (e) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  throw new Error(`FDIC failed after retries: ${url.slice(0, 110)}`);
}

function assetBucket(asset) { // identical to institution-seo.js
  for (let i = 0; i < ASSET_BUCKETS.length - 1; i++) if (asset < ASSET_BUCKETS[i + 1]) return { lo: ASSET_BUCKETS[i], hi: ASSET_BUCKETS[i + 1] };
  return { lo: ASSET_BUCKETS[ASSET_BUCKETS.length - 2], hi: ASSET_BUCKETS[ASSET_BUCKETS.length - 1] };
}
function quarterBack(repdte, n) {
  let y = Number(repdte.slice(0, 4)), q = Math.ceil(Number(repdte.slice(4, 6)) / 3) - n;
  while (q < 1) { q += 4; y -= 1; }
  const mm = q * 3, dd = mm === 3 || mm === 12 ? 31 : 30;
  return `${y}${String(mm).padStart(2, '0')}${dd}`;
}

// ── pulls ────────────────────────────────────────────────────────────────
async function pullBanks(f) {
  const inst = (await fdic(f, `${FDIC}/institutions?filters=ACTIVE%3A1&fields=CERT,NAME,CITY,STALP,STNAME,ACTIVE,ESTYMD,WEBADDR,OFFDOM,ASSET,REPDTE&limit=10000&sort_by=CERT&sort_order=ASC`)).data.map(r => r.data).filter(Boolean);
  const latest = (await fdic(f, `${FDIC}/financials?filters=CERT%3A628&fields=REPDTE&limit=1&sort_by=REPDTE&sort_order=DESC`)).data[0].data.REPDTE;
  const start = quarterBack(latest, 7);
  const fin = new Map();
  for (let off = 0; ; off += 10000) {
    const page = await fdic(f, `${FDIC}/financials?filters=REPDTE%3A%5B${start}%20TO%20${latest}%5D&fields=CERT,REPDTE,ASSET,DEP,LNLSNET,EQ,NETINC,ROA,ROE,NIMY,RBC1AAJ,NCLNLSR,LNLSDEPR,NUMEMP&limit=10000&offset=${off}&sort_by=CERT&sort_order=ASC`);
    for (const r of page.data) { const d = r.data; if (!d) continue; const k = String(d.CERT); if (!fin.has(k)) fin.set(k, []); fin.get(k).push(d); }
    if (page.data.length < 10000) break;
  }
  for (const rows of fin.values()) rows.sort((a, b) => String(b.REPDTE).localeCompare(String(a.REPDTE)));
  return { inst, fin, latest };
}

async function pullSOD(f) {
  const y = (await fdic(f, `${SOD}?fields=YEAR&limit=1&sort_by=YEAR&sort_order=DESC`)).data[0].data.YEAR;
  const rows = [];
  for (let off = 0; ; off += 10000) {
    const page = await fdic(f, `${SOD}?filters=YEAR%3A${y}&fields=CERT,CNTYNAMB,STALPBR,DEPSUMBR,MAINOFF,YEAR&limit=10000&offset=${off}&sort_by=UNINUMBR&sort_order=ASC`);
    for (const r of page.data) if (r.data) rows.push(r.data);
    if (page.data.length < 10000) break;
  }
  return { year: y, rows };
}

// ── offline enrichment (mirrors enrichBank in institution-seo.js) ──────────
function buildContext(inst, fin, sod) {
  const pools = new Map(); // `${st}|${lo}` -> banks sorted by ASSET desc
  for (const b of inst) {
    const a = Number(b.ASSET); const st = String(b.STALP || '').toUpperCase();
    if (!(a > 0) || !st) continue;
    const { lo } = assetBucket(a); const k = `${st}|${lo}`;
    if (!pools.has(k)) pools.set(k, []); pools.get(k).push(b);
  }
  for (const arr of pools.values()) arr.sort((a, b) => Number(b.ASSET) - Number(a.ASSET));

  const byCert = new Map(), byCounty = new Map();
  for (const r of sod.rows) {
    const c = String(r.CERT); if (!byCert.has(c)) byCert.set(c, []); byCert.get(c).push(r);
    const ck = `${r.CNTYNAMB}|${r.STALPBR}`; if (!byCounty.has(ck)) byCounty.set(ck, new Map());
    const m = byCounty.get(ck); m.set(c, (m.get(c) || 0) + (Number(r.DEPSUMBR) || 0));
  }
  return { pools, fin, sodByCert: byCert, sodByCounty: byCounty, year: sod.year };
}

function enrich(b, ctx) {
  const x = { complete: true };
  const asset = Number(b.latest?.ASSET), st = String(b.STALP || '').toUpperCase();
  if (asset > 0 && st) {
    const { lo, hi } = assetBucket(asset);
    const pool = (ctx.pools.get(`${st}|${lo}`) || []).slice(0, 100); // live query: limit=100 sorted by ASSET desc
    const list = pool.filter(p => String(p.CERT) !== String(b.CERT)).map(p => {
      const f0 = ctx.fin.get(String(p.CERT))?.[0] || {};
      const fin = {}; for (const k of ['CERT', 'REPDTE', 'ROA', 'RBC1AAJ', 'NCLNLSR', 'NIMY', 'LNLSDEPR']) if (f0[k] !== undefined) fin[k] = f0[k];
      return { NAME: p.NAME, CERT: p.CERT, CITY: p.CITY, STALP: p.STALP, ASSET: p.ASSET, fin };
    });
    x.peers = { lo, hi, list }; // band text is derived at render time (fmtUSD lives in the edge file)
  }
  const rows = ctx.sodByCert.get(String(b.CERT)) || [];
  if (rows.length) {
    const byCounty = new Map();
    for (const r of rows) {
      const k = `${r.CNTYNAMB}|${r.STALPBR}`;
      const e = byCounty.get(k) || { county: r.CNTYNAMB, st: r.STALPBR, dep: 0, branches: 0, hq: false };
      e.dep += Number(r.DEPSUMBR) || 0; e.branches += 1; if (Number(r.MAINOFF) === 1) e.hq = true;
      byCounty.set(k, e);
    }
    const counties = [...byCounty.values()].filter(c => c.county).sort((a, c) => c.dep - a.dep);
    x.footprint = { year: ctx.year, counties, branches: rows.length };
    const hq = counties.find(c => c.hq) || counties[0];
    const tot = hq && ctx.sodByCounty.get(`${hq.county}|${hq.st}`);
    if (tot) {
      const ranked = [...tot.entries()].sort((a, c) => c[1] - a[1]);
      const sum = ranked.reduce((s, [, v]) => s + v, 0);
      const idx = ranked.findIndex(([c]) => c === String(b.CERT));
      if (sum > 0 && idx >= 0) x.hqShare = { county: hq.county, st: hq.st, year: ctx.year, share: ranked[idx][1] / sum * 100, rank: idx + 1, of: ranked.length };
    }
  }
  return x;
}

// ── main ────────────────────────────────────────────────────────────────
async function run(deps = {}) {
  const t0 = Date.now();
  const f = deps.fetch || fetch;
  const store = deps.store || await mkStore(LKG_STORE);
  const sitemapStore = deps.sitemapStore === undefined ? await mkStore(SITEMAP_STORE) : deps.sitemapStore;
  const base = deps.base || process.env.URL || 'https://vaultbot.ai';
  const log = deps.log || console.log;

  const guard = await store.get('_snapshot-lastrun', { type: 'json' }).catch(() => null);
  if (!deps.force && guard?.at && Date.now() - guard.at < (guard.status === 'running' ? 30 * 60 * 1000 : GUARD_MS)) { log(`[seo-snapshot] skipped: last run ${new Date(guard.at).toISOString()} (${guard.status})`); return { skipped: true }; }
  await store.setJSON('_snapshot-lastrun', { at: Date.now(), status: 'running' });
  const prevMeta = await store.get('_snapshot-meta', { type: 'json' }).catch(() => null);

  const fail = async (why) => {
    const meta = { ...(prevMeta || {}), lastAttemptAt: Date.now(), lastAttemptOk: false, lastError: why };
    // Keep the previous good snapshot's numbers and builtAt: an aborted run must not look fresh.
    await store.setJSON('_snapshot-meta', prevMeta ? meta : { builtAt: 0, ok: false, banks: 0, cus: 0, lastError: why });
    await store.setJSON('_snapshot-lastrun', { at: Date.now(), status: 'failed', why });
    log(`[seo-snapshot] ABORTED, nothing written: ${why}`);
    return { aborted: why };
  };

  let bankData, sod, cuRes;
  try {
    bankData = await pullBanks(f); log(`[seo-snapshot] banks ${bankData.inst.length}, financial rows for ${bankData.fin.size} CERTs, latest ${bankData.latest}`);
    sod = await pullSOD(f); log(`[seo-snapshot] SOD ${sod.year}: ${sod.rows.length} branches`);
    const r = await f(`${base}/.netlify/functions/ncua?all=1&full=1&limit=6000`);
    if (!r.ok) throw new Error(`ncua proxy HTTP ${r.status}`);
    cuRes = await r.json();
    if (!Array.isArray(cuRes.results)) throw new Error('ncua proxy returned no results');
  } catch (e) { return fail(e.message); }

  const { inst, fin, latest } = bankData;
  const cus = cuRes.results;
  const pb = prevMeta?.banks || 0, pc = prevMeta?.cus || 0;
  if (inst.length < Math.max(3800, Math.floor(pb * 0.95)) || cus.length < Math.max(3800, Math.floor(pc * 0.95)))
    return fail(`roster below floor: ${inst.length} banks (prev ${pb}), ${cus.length} CUs (prev ${pc})`);
  if (sod.rows.length < 50000) return fail(`SOD suspiciously small: ${sod.rows.length} rows`);

  const ctx = buildContext(inst, fin, sod);
  const now = new Date().toISOString();
  const writes = [];
  let completeBanks = 0;
  for (const i of inst) {
    const history = (fin.get(String(i.CERT)) || []).slice(0, 8);
    const found = { kind: 'bank', CERT: i.CERT, NAME: i.NAME, CITY: i.CITY, STALP: i.STALP, STNAME: i.STNAME, ACTIVE: i.ACTIVE, ESTYMD: i.ESTYMD, WEBADDR: i.WEBADDR, OFFDOM: i.OFFDOM, latest: history[0] || {}, history };
    const x = enrich(found, ctx);
    if (x.peers && x.footprint) completeBanks++;
    writes.push([`bank-${i.CERT}`, { savedAt: now, source: 'snapshot', found, x }]);
  }
  for (const c of cus) writes.push([`cu-${c.id}`, { savedAt: now, source: 'snapshot', found: { kind: 'cu', ...c, asOf: c.asOf || cuRes.asOf || null, raw: true } }]);

  let written = 0, failed = 0, i = 0;
  await Promise.all(Array.from({ length: 20 }, async () => {
    while (i < writes.length) {
      const [k, v] = writes[i++];
      let ok = false;
      for (let t = 0; t < 2 && !ok; t++) { try { await store.setJSON(k, v, { metadata: { complete: true } }); ok = true; } catch (e) { await sleep(300); } }
      ok ? written++ : failed++;
    }
  }));
  log(`[seo-snapshot] wrote ${written}/${writes.length} blobs (${failed} failed), ${completeBanks} banks fully enriched`);

  // Prune pages for institutions that left the active rosters (merged, closed). Only after a sane, complete run.
  let pruned = 0;
  if (failed === 0 && store.list) {
    const keep = new Set(writes.map(w => w[0]));
    for (const prefix of ['bank-', 'cu-']) {
      const listed = await store.list({ prefix }).catch(() => null);
      for (const b of (listed?.blobs || [])) if (!keep.has(b.key)) { try { await store.delete(b.key); pruned++; } catch { /* next night */ } }
    }
  }

  // Sitemap from the same rosters: zero extra upstream calls.
  let sitemapWritten = false;
  if (sitemapStore && failed === 0) {
    try {
      const { buildPartsFrom } = deps.buildPartsFrom ? { buildPartsFrom: deps.buildPartsFrom } : require('./sitemap.js');
      const built = buildPartsFrom(inst.map(b => ({ CERT: b.CERT, NAME: b.NAME, CITY: b.CITY, STALP: b.STALP, REPDTE: b.REPDTE })), cus.map(c => ({ id: c.id, name: c.name, city: c.city, state: c.state })));
      await sitemapStore.setJSON('sitemap-v2', { ...built, _at: Date.now() });
      sitemapWritten = true;
    } catch (e) { log(`[seo-snapshot] sitemap write failed: ${e.message}`); }
  }

  // Hub slugs for the nightly warmer: every county with a branch, same slug rule as hub.js countySlugOf().
  const slugOf = c => String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const countySlugs = new Set();
  for (const r of sod.rows) if (r.CNTYNAMB && r.STALPBR) countySlugs.add(`banks-in-${slugOf(r.CNTYNAMB)}-county-${String(r.STALPBR).toLowerCase()}`);
  const hubSlugs = [...countySlugs].sort();
  try { await store.setJSON('hub-slugs', { builtAt: Date.now(), counties: hubSlugs }); } catch (e) { log(`[seo-snapshot] hub-slugs write failed: ${e.message}`); }

  const meta = {
    builtAt: Date.now(), ok: failed === 0, banks: inst.length, cus: cus.length, complete: completeBanks, failed, pruned, sitemapWritten, hubs: hubSlugs.length,
    sodYear: sod.year, sodRows: sod.rows.length, financialsThrough: latest, secs: Math.round((Date.now() - t0) / 1000), version: 1,
  };
  await store.setJSON('_snapshot-meta', meta);
  await store.setJSON('_snapshot-lastrun', { at: Date.now(), status: 'done' });
  log(`[seo-snapshot] ${JSON.stringify(meta)}`);
  return meta;
}

exports.run = run;
exports.enrich = enrich; exports.buildContext = buildContext; exports.pullBanks = pullBanks; exports.pullSOD = pullSOD; // for tests
exports.handler = async () => {
  try { await run(); } catch (e) { console.log(`[seo-snapshot] crashed: ${e.message}`); }
  return { statusCode: 202 };
};
