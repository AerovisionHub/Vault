// Nightly trigger for seo-snapshot-background (scheduled functions are capped
// at 30s; the snapshot itself runs as a background function, 15 min budget).
exports.handler = async () => {
  const base = process.env.URL || 'https://vaultbot.ai';
  const r = await fetch(`${base}/.netlify/functions/seo-snapshot-background`, { method: 'POST' }).catch(e => ({ status: e.message }));
  console.log(`[seo-snapshot-schedule] triggered: ${r.status}`);
  return { statusCode: 200 };
};
