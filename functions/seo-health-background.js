// Daily self-check for the things that keep generating Search Console emails
// (2026-11-26). Runs as a background function (15 min budget) triggered by
// seo-health-schedule.js. Emails lee@goidentify.com ONLY when something is
// failing (plus a one-line "recovered" when it clears). Result is kept in
// Blobs and readable at /.netlify/functions/seo-health.
//
// What it can see: the site itself (sitemap integrity vs FDIC/NCUA, a sample of
// live pages, the analytics tag, Blobs, the data snapshot). What it cannot see:
// whether Search Console / Google Analytics links were changed in Google's UI.
//
// Every check returns { name, level: 'ok'|'warn'|'fail', detail }. Only 'fail'
// sends mail; 'warn' is recorded for the status page.

const STORE = 'vault-seo-health';
const BASE = 'https://vaultbot.ai';
const FDIC = 'https://api.fdic.gov/banks';
const GA_ID = 'G-GE8WSX77C1';
const ALERT_TO = 'lee@goidentify.com';
const REMIND_MS = 3 * 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; VaultHealthCheck/1.0; +https://vaultbot.ai)';

// Big, stable counties for hub probes (slug rule: banks-in-{county}-county-{st}).
const HUB_COUNTIES = ['harris-county-tx', 'cook-county-il', 'los-angeles-county-ca', 'maricopa-county-az', 'king-county-wa',
  'travis-county-tx', 'bexar-county-tx', 'dallas-county-tx', 'wayne-county-mi', 'miami-dade-county-fl', 'mclennan-county-tx',
  'tulsa-county-ok', 'oklahoma-county-ok', 'franklin-county-oh', 'hennepin-county-mn'];
const HUB_STATES = ['texas', 'oklahoma', 'ohio', 'florida', 'minnesota', 'california', 'new-york', 'georgia'];
const CORE_PAGES = ['/', '/industry', '/lenders', '/charters', '/about'];

let fast = false; // tests only
const sleep = ms => (fast ? Promise.resolve() : new Promise(r => setTimeout(r, ms)));
const words = html => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

function seeded(seed) { // mulberry32: different sample each day, reproducible within a day
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function pick(arr, n, rnd) { const a = arr.slice(), out = []; while (a.length && out.length < n) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; }

async function getStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE, siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN });
}
async function getOtherStore(name) {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN });
}

async function http(fetchFn, url, { ms = 30000, text = true } = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); const t0 = Date.now();
  try {
    const r = await fetchFn(url, { signal: c.signal, headers: { 'User-Agent': UA } });
    const body = text ? await r.text() : null;
    return { status: r.status, body, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, body: '', ms: Date.now() - t0, err: e.message }; } finally { clearTimeout(t); }
}
async function httpRetry(fetchFn, url, opts) { // one retry after a pause: a single blip is not an incident
  let r = await http(fetchFn, url, opts);
  if (r.status !== 200) { await sleep(opts?.retryWait ?? 6000); r = await http(fetchFn, url, opts); }
  return r;
}

// ── checks ────────────────────────────────────────────────────────────────
async function checkSitemap(f, prev) {
  const out = []; const m = {};
  const idx = await httpRetry(f, `${BASE}/sitemap.xml`);
  const kids = (idx.body.match(/<loc>([^<]+)<\/loc>/g) || []).map(x => x.replace(/<\/?loc>/g, ''));
  if (idx.status !== 200 || kids.length < 50) {
    out.push({ name: 'sitemap_index', level: 'fail', detail: `HTTP ${idx.status}, ${kids.length} child sitemaps (expect 50+)` });
    return { out, m, urls: [] };
  }
  out.push({ name: 'sitemap_index', level: 'ok', detail: `${kids.length} child sitemaps` });

  const urls = []; const bad = []; let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < kids.length) {
      const u = kids[i++]; const r = await httpRetry(f, u, { retryWait: 3000 });
      if (r.status !== 200) { bad.push(`${u.split('/').pop()} (${r.status})`); continue; }
      for (const x of (r.body.match(/<loc>([^<]+)<\/loc>/g) || [])) urls.push(x.replace(/<\/?loc>/g, ''));
    }
  }));
  if (bad.length) out.push({ name: 'sitemap_children', level: 'fail', detail: `children not 200: ${bad.slice(0, 6).join(', ')}` });
  else out.push({ name: 'sitemap_children', level: 'ok', detail: `all ${kids.length} return 200` });

  const nb = urls.filter(u => u.includes('/bank/')).length, nc = urls.filter(u => u.includes('/cu/')).length;
  m.sitemapUrls = urls.length; m.sitemapBanks = nb; m.sitemapCUs = nc;

  const fd = await http(f, `${FDIC}/institutions?filters=ACTIVE%3A1&fields=CERT&limit=1`, { ms: 20000 });
  const nc2 = await http(f, `${BASE}/.netlify/functions/ncua?all=1&limit=1`, { ms: 20000 });
  let fdTotal = null, ncTotal = null;
  try { fdTotal = JSON.parse(fd.body).meta.total; } catch { /* informational */ }
  try { ncTotal = JSON.parse(nc2.body).totalResultCount; } catch { /* informational */ }
  m.fdicActive = fdTotal; m.ncuaTotal = ncTotal; m.fdicMs = fd.ms;
  const within = (got, want) => want && Math.abs(got - want) / want <= 0.02;
  if (fdTotal) out.push({ name: 'sitemap_banks_vs_fdic', level: within(nb, fdTotal) ? 'ok' : 'fail', detail: `${nb} bank URLs vs ${fdTotal} active at FDIC (tolerance 2%)` });
  else out.push({ name: 'sitemap_banks_vs_fdic', level: 'warn', detail: 'FDIC count unavailable' });
  if (ncTotal) out.push({ name: 'sitemap_cus_vs_ncua', level: within(nc, ncTotal) ? 'ok' : 'fail', detail: `${nc} CU URLs vs ${ncTotal} at NCUA (tolerance 2%)` });
  else out.push({ name: 'sitemap_cus_vs_ncua', level: 'warn', detail: 'NCUA count unavailable' });
  // Baseline is the last HEALTHY total, not yesterday's: a broken sitemap must not become tomorrow's normal.
  const base = prev?.metrics?.goodSitemapUrls || prev?.metrics?.sitemapUrls;
  if (base) {
    const drop = (base - urls.length) / base;
    out.push({ name: 'sitemap_day_over_day', level: drop > 0.03 ? 'fail' : 'ok', detail: `${urls.length} URLs vs ${base} last healthy (${(-drop * 100).toFixed(1)}%)` });
  }
  m.goodSitemapUrls = out.some(c => c.level === 'fail') ? base : urls.length;
  return { out, m, urls };
}

async function probe(f, kind, url, rules) {
  const r = await httpRetry(f, url);
  const res = { kind, url: url.replace(BASE, ''), status: r.status, ms: r.ms, problems: [] };
  if (r.status !== 200) { res.problems.push(`HTTP ${r.status}`); return res; }
  const b = r.body;
  const region = rules.region === 'main' ? (b.match(/<main[\s\S]*?<\/main>/) || [b])[0] : (b.match(/<div id="seo-prerender">([\s\S]*?)<\/div>\s*<script>/) || [0, b])[1];
  res.words = words(region);
  if (res.words < rules.minWords) res.problems.push(`${res.words} words (min ${rules.minWords})`);
  const robots = (b.match(/<meta name="robots" content="([^"]*)"/) || [0, ''])[1];
  if (/noindex/i.test(robots)) res.problems.push('noindex');
  if (rules.selfCanonical) { const can = (b.match(/<link rel="canonical" href="([^"]*)"/) || [0, ''])[1]; if (can !== url) res.problems.push(`canonical -> ${can.replace(BASE, '') || 'missing'}`); }
  res.ga = b.includes(GA_ID);
  return res;
}

async function checkPages(f, urls, rnd) {
  const banks = pick(urls.filter(u => u.includes('/bank/')), 10, rnd);
  const cus = pick(urls.filter(u => u.includes('/cu/')), 8, rnd);
  const jobs = [
    ...banks.map(u => ['bank', u, { region: 'prerender', minWords: 350, selfCanonical: true }]),
    ...cus.map(u => ['cu', u, { region: 'prerender', minWords: 350, selfCanonical: true }]),
    ...pick(HUB_COUNTIES, 5, rnd).map(s => ['county_hub', `${BASE}/banks-in-${s}`, { region: 'main', minWords: 200, selfCanonical: true }]),
    ...pick(HUB_STATES, 3, rnd).map(s => ['state_hub', `${BASE}/banks-in-${s}`, { region: 'main', minWords: 200, selfCanonical: true }]),
    ...CORE_PAGES.map(p => ['core', `${BASE}${p === '/' ? '' : p}`, { region: 'prerender', minWords: 50, selfCanonical: false }]),
  ];
  const results = [];
  for (const [k, u, rules] of jobs) { results.push(await probe(f, k, u, rules)); await sleep(1000); }
  const out = [];
  for (const kind of ['bank', 'cu', 'county_hub', 'state_hub', 'core']) {
    const rs = results.filter(r => r.kind === kind); const bad = rs.filter(r => r.problems.length);
    out.push({ name: `pages_${kind}`, level: bad.length ? 'fail' : 'ok', detail: bad.length ? bad.slice(0, 4).map(r => `${r.url}: ${r.problems.join('; ')}`).join(' | ') : `${rs.length} sampled, all healthy` });
  }
  const ms = results.map(r => r.ms).sort((a, b) => a - b); const p95 = ms[Math.floor(ms.length * 0.95)] || 0;
  out.push({ name: 'page_latency_p95', level: p95 > 6000 ? 'warn' : 'ok', detail: `${p95} ms over ${results.length} pages` });
  return { out, results, m: { probes: results.length, p95ms: p95 } };
}

function checkAnalytics(results) {
  const out = [];
  const spa = results.filter(r => r.kind === 'core' || r.kind === 'bank' || r.kind === 'cu');
  const missing = spa.filter(r => !r.ga);
  out.push({ name: 'ga_tag_spa_pages', level: missing.length ? 'fail' : 'ok', detail: missing.length ? `GA tag missing on ${missing.slice(0, 4).map(r => r.url).join(', ')}` : `${GA_ID} present on all ${spa.length} sampled app pages` });
  const hubs = results.filter(r => r.kind === 'county_hub' || r.kind === 'state_hub');
  const hubMissing = hubs.filter(r => !r.ga);
  // Known gap (2026-11-26): hub pages never carried the tag. Recorded as a warning until Lee decides.
  out.push({ name: 'ga_tag_hub_pages', level: hubMissing.length ? 'warn' : 'ok', detail: hubMissing.length ? `GA tag absent on ${hubMissing.length}/${hubs.length} sampled hub pages (traffic to ~3,100 hubs is unmeasured)` : 'present on hub pages' });
  return out;
}

async function checkInfra(f, store, otherStore) {
  const out = [];
  try {
    const k = `probe-${Date.now()}`; await store.setJSON(k, { ok: 1 }); const v = await store.get(k, { type: 'json' });
    out.push({ name: 'blobs_read_write', level: v?.ok === 1 ? 'ok' : 'fail', detail: v?.ok === 1 ? 'write + read ok' : 'read-back mismatch' });
    await store.delete?.(k);
  } catch (e) { out.push({ name: 'blobs_read_write', level: 'fail', detail: e.message }); }
  try {
    const lkg = await otherStore('vault-seo-lkg');
    const meta = lkg ? await lkg.get('_snapshot-meta', { type: 'json' }) : null;
    if (meta) {
      const ageH = meta.builtAt ? (Date.now() - meta.builtAt) / 3.6e6 : Infinity;
      const bad = !meta.ok || ageH > 36 || meta.banks < 4000 || meta.cus < 4000 || meta.failed > 0;
      out.push({ name: 'data_snapshot', level: bad ? 'fail' : 'ok', detail: `built ${Number.isFinite(ageH) ? ageH.toFixed(1) + 'h ago' : 'never'}, ${meta.banks} banks (${meta.complete} fully enriched), ${meta.cus} CUs, ${meta.failed ?? 0} write failures${meta.lastError ? `, last error: ${meta.lastError}` : ''}` });
    } else {
      out.push({ name: 'data_snapshot', level: 'warn', detail: 'no nightly snapshot recorded yet' });
    }
  } catch (e) { out.push({ name: 'data_snapshot', level: 'warn', detail: `could not read: ${e.message}` }); }
  try {
    const lkg = await otherStore('vault-seo-lkg'); const w = lkg ? await lkg.get('_hub-warm-meta', { type: 'json' }) : null;
    if (!w) out.push({ name: 'hub_prewarm', level: 'warn', detail: 'hub pre-warm has not run yet' });
    else {
      const ageD = (Date.now() - w.at) / 864e5;
      const level = ageD > 3 ? 'fail' : (w.aborted || (w.estCycleNights && w.estCycleNights > 6)) ? 'warn' : 'ok';
      out.push({ name: 'hub_prewarm', level, detail: `${ageD.toFixed(1)}d ago: ${w.ok} ok, ${w.failed} failed, ${w.notFound || 0} not found${w.notFoundSlugs?.length ? ` (${w.notFoundSlugs.slice(0, 4).join(', ')})` : ''} of ${w.processed}${w.aborted ? `, stopped early (${w.aborted})` : ''}; full cycle ~${w.estCycleNights} nights; ${w.cycles} cycles completed` });
    }
  } catch (e) { out.push({ name: 'hub_prewarm', level: 'warn', detail: `could not read: ${e.message}` }); }
  const rb = await http(f, `${BASE}/robots.txt`);
  out.push({ name: 'robots_txt', level: rb.status === 200 && /Sitemap:\s*https:\/\/vaultbot\.ai\/sitemap\.xml/i.test(rb.body) ? 'ok' : 'fail', detail: `HTTP ${rb.status}${/Sitemap:/i.test(rb.body) ? '' : ', no Sitemap line'}` });
  return out;
}

// ── alerting ──────────────────────────────────────────────────────────────
async function sendEmail(f, apiKey, subject, text) {
  const r = await f('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Vault MCP <mcp@vaultbot.ai>', to: [ALERT_TO], subject, text }),
  });
  return r.status;
}

async function run(deps = {}) {
  fast = !!deps.fast;
  const f = deps.fetch || fetch;
  const store = deps.store || await getStore();
  const other = deps.otherStore || getOtherStore;
  const now = deps.now || Date.now();
  const mail = deps.sendEmail || ((s, t) => (process.env.RESEND_API_KEY ? sendEmail(f, process.env.RESEND_API_KEY, s, t) : Promise.resolve('no RESEND_API_KEY')));
  const prev = await store.get('last', { type: 'json' }).catch(() => null);
  if (!deps.force && prev?.at && now - prev.at < 30 * 60 * 1000) { console.log('[seo-health] skipped: ran <30 min ago'); return prev; }

  const d = new Date(now); const rnd = seeded(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
  const sm = await checkSitemap(f, prev);
  const pg = await checkPages(f, sm.urls, rnd);
  const checks = [...sm.out, ...pg.out, ...checkAnalytics(pg.results), ...await checkInfra(f, store, other)];
  const fails = checks.filter(c => c.level === 'fail'), warns = checks.filter(c => c.level === 'warn');
  const names = fails.map(c => c.name).sort(), key = names.join(',');
  const rec = { at: now, ok: !fails.length, failures: fails, warnings: warns, checks, metrics: { ...sm.m, ...pg.m }, alert: prev?.alert || null };

  if (fails.length) {
    // Mail on: first failure, a NEW failing check, or a reminder after 3 days. A failure set that only
    // shrinks (partial recovery) is not news.
    const known = prev?.alert?.names || [], fresh = names.filter(n => !known.includes(n));
    const stale = prev?.alert && now - prev.alert.at > REMIND_MS;
    if (!prev?.alert || fresh.length || stale) {
      const body = `Vault site health: ${fails.length} check(s) failing at ${d.toISOString().slice(0, 16)}Z\n\n` +
        fails.map(c => `- ${c.name}: ${c.detail}`).join('\n') +
        (warns.length ? `\n\nWarnings (no action needed yet):\n${warns.map(c => `- ${c.name}: ${c.detail}`).join('\n')}` : '') +
        `\n\nFull status: ${BASE}/.netlify/functions/seo-health\nNote: this checks the site only. It cannot see changes to Search Console or Google Analytics links.`;
      rec.alert = { key, names, at: now, status: await mail(`Vault site health: ${fails.length} failing (${fails.map(c => c.name).slice(0, 3).join(', ')})`, body) };
    } else rec.alert = { ...prev.alert, names, key };
  } else if (prev?.alert) {
    await mail('Vault site health: recovered', `All checks passing as of ${d.toISOString().slice(0, 16)}Z. Earlier alert: ${prev.alert.key}.\n${BASE}/.netlify/functions/seo-health`);
    rec.alert = null;
  }
  await store.setJSON('last', rec);
  console.log(`[seo-health] ${rec.ok ? 'OK' : 'FAIL'} ${checks.length} checks, ${fails.length} failing, ${warns.length} warnings`);
  return rec;
}

exports.run = run;
exports.handler = async () => {
  try { await run(); } catch (e) { console.log(`[seo-health] crashed: ${e.message}`); }
  return { statusCode: 202 };
};
