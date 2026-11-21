// Weekly trigger for seo-lkg-backfill-background (scheduled functions are
// capped at 30s; the backfill itself runs as a 15-minute background function).
exports.handler = async () => {
  const base = process.env.URL || 'https://vaultbot.ai';
  const r = await fetch(`${base}/.netlify/functions/seo-lkg-backfill-background`, { method: 'POST' }).catch(e => ({ status: e.message }));
  console.log(`[seo-lkg-schedule] triggered backfill: ${r.status}`);
  return { statusCode: 200 };
};
