// Daily trigger for seo-health-background (scheduled functions are capped at
// 30s; the check itself runs as a background function with a 15 minute budget).
exports.handler = async () => {
  const base = process.env.URL || 'https://vaultbot.ai';
  const r = await fetch(`${base}/.netlify/functions/seo-health-background`, { method: 'POST' }).catch(e => ({ status: e.message }));
  console.log(`[seo-health-schedule] triggered: ${r.status}`);
  return { statusCode: 200 };
};
