// Nightly trigger for seo-hub-warm-background (runs ~90 min after the snapshot).
exports.handler = async () => {
  const base = process.env.URL || 'https://vaultbot.ai';
  const r = await fetch(`${base}/.netlify/functions/seo-hub-warm-background`, { method: 'POST' }).catch(e => ({ status: e.message }));
  console.log(`[seo-hub-warm-schedule] triggered: ${r.status}`);
  return { statusCode: 200 };
};
