// Backfills the last-known-good (LKG) store the /bank/* edge prerender falls
// back to when FDIC throttles it (see institution-seo.js, 2026-11-12).
//
// Why (2026-11-21): the LKG fallback only covers pages that have rendered
// successfully at least once. Crawl load roughly tripled on Nov 20 (Googlebot
// plus Exa, Meta, ShapBot), and 7.3% of institution renders were 503s:
// 1,060 in 34 hours, 510 of them to Googlebot, versus 206 saved by the
// fallback. This seeds every active bank in one pass from four bulk FDIC
// queries (about 20 seconds of FDIC time in total) instead of ~8 calls per
// page during a crawl.
//
// Writes { found, x: null } and skips keys whose metadata says complete, so it never overwrites a complete
// copy the edge saved (that one also has peers/footprint). The edge renders a
// backfilled copy as a full 200 page minus the enrichment tables, with a 1h
// CDN cache, and the next good render replaces it.
//
// Safe to expose: public data only, idempotent, and a 6-hour guard stops
// repeat triggers from hammering FDIC. Runs weekly via seo-lkg-schedule.js.

const FDIC_BASE = 'https://api.fdic.gov/banks';
const STORE = 'vault-seo-lkg';
const GUARD_KEY = '_backfill-lastrun';
const GUARD_MS = 6 * 60 * 60 * 1000;

async function getStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({
    name: STORE,
    siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN,
  });
}

async function fdic(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${FDIC_BASE}${path}`);
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.data)) return j;
      }
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 2000 * (i + 1)));
  }
  throw new Error(`FDIC failed: ${path.slice(0, 80)}`);
}

// Quarter-end YYYYMMDD, n quarters before the given one.
function quarterBack(repdte, n) {
  let y = Number(repdte.slice(0, 4)), q = Math.ceil(Number(repdte.slice(4, 6)) / 3) - n;
  while (q < 1) { q += 4; y -= 1; }
  const mm = q * 3, dd = mm === 3 || mm === 12 ? 31 : 30;
  return `${y}${String(mm).padStart(2, '0')}${dd}`;
}

async function run() {
  const t0 = Date.now();
  const store = await getStore();

  const guard = await store.get(GUARD_KEY, { type: 'json' }).catch(() => null);
  if (guard?.at && Date.now() - guard.at < GUARD_MS) {
    console.log(`[seo-lkg-backfill] skipped: last run ${new Date(guard.at).toISOString()}`);
    return;
  }
  await store.setJSON(GUARD_KEY, { at: Date.now(), status: 'running' });

  // Latest filed quarter, then the 8-quarter window the edge renders.
  const latest = (await fdic('/financials?filters=CERT%3A628&fields=REPDTE&limit=1&sort_by=REPDTE&sort_order=DESC')).data[0].data.REPDTE;
  const start = quarterBack(latest, 7);

  // Same field lists as getBank() in institution-seo.js, so the saved copy is
  // indistinguishable from one the edge saved itself.
  const inst = (await fdic('/institutions?filters=ACTIVE%3A1&fields=CERT,NAME,CITY,STALP,STNAME,ACTIVE,ESTYMD,WEBADDR,OFFDOM&limit=10000'))
    .data.map(r => r.data).filter(Boolean);

  const hist = new Map();
  for (let offset = 0; ; offset += 10000) {
    const page = await fdic(`/financials?filters=REPDTE%3A%5B${start}%20TO%20${latest}%5D&fields=CERT,REPDTE,ASSET,DEP,LNLSNET,EQ,NETINC,ROA,ROE,NIMY,RBC1AAJ,NCLNLSR,LNLSDEPR,NUMEMP&limit=10000&offset=${offset}&sort_by=CERT&sort_order=ASC`);
    for (const r of page.data) {
      const d = r.data; if (!d) continue;
      const k = String(d.CERT);
      if (!hist.has(k)) hist.set(k, []);
      hist.get(k).push(d);
    }
    if (page.data.length < 10000) break;
  }

  let written = 0, kept = 0, failed = 0;
  const queue = inst.slice();
  async function worker() {
    while (queue.length) {
      const b = queue.shift();
      const history = (hist.get(String(b.CERT)) || []).sort((a, c) => String(c.REPDTE).localeCompare(String(a.REPDTE))).slice(0, 8);
      const found = { kind: 'bank', ...b, latest: history[0] || {}, history };
      try {
        // Never replace a complete copy the edge saved (it has peers and
        // footprint). Blobs v9 ignores onlyIfNew, so check metadata.
        const meta = await store.getMetadata(`bank-${b.CERT}`).catch(() => null);
        if (meta?.metadata?.complete) { kept++; continue; }
        await store.setJSON(`bank-${b.CERT}`, { savedAt: new Date().toISOString(), source: 'backfill', found, x: null }, { metadata: { complete: false } });
        written++;
      } catch (e) { failed++; }
    }
  }
  await Promise.all(Array.from({ length: 25 }, worker));

  const summary = { at: Date.now(), status: 'done', latest, banks: inst.length, written, kept, failed, secs: Math.round((Date.now() - t0) / 1000) };
  await store.setJSON(GUARD_KEY, summary);
  console.log(`[seo-lkg-backfill] ${JSON.stringify(summary)}`);
}

exports.run = run; // for tests
exports.handler = async () => {
  try { await run(); } catch (e) { console.log(`[seo-lkg-backfill] failed: ${e.message}`); }
  return { statusCode: 202 };
};
