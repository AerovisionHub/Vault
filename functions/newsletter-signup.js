// Newsletter signup from the website (2026-11-23).
// POST {email, website, source} → validate → send a confirmation email.
// GET  ?e=&t=&s=              → verify the signed link → add to the Resend
//                                "Vault Members" audience → small HTML page.
//
// Double opt-in on purpose: a public form that adds addresses straight to the
// list lets anyone sign up someone else, and every complaint from that hurts
// vaultbot.ai's sending reputation for the whole newsletter. Nothing is stored
// until the person clicks the link; the link is an HMAC of the address and a
// timestamp, so no database is needed.
//
// List rules match mcp-signup.js: lookup-then-create (Resend's create call
// upserts and would re-subscribe someone who opted out), iDENTIFY addresses
// never added.

const crypto = require('crypto');
const dns = require('dns').promises;
const https = require('https');

const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID || '2451698a-5fbc-4f93-a666-ac8d253d812b';
const LINK_TTL_MS = 7 * 24 * 3600 * 1000;
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'yopmail.com', '10minutemail.com', 'temp-mail.org', 'tempmail.com', 'trashmail.com', 'maildrop.cc', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'throwaway.email']);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const json = (code, obj) => ({ statusCode: code, headers: CORS, body: JSON.stringify(obj) });

function secret() {
  return crypto.createHash('sha256').update('vault-news:' + (process.env.RESEND_API_KEY || '')).digest();
}
function sign(email, t) {
  return crypto.createHmac('sha256', secret()).update(`${email}|${t}`).digest('base64url');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resend(method, path, payload) {
  return new Promise((resolve) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return resolve({ error: 'No RESEND_API_KEY' });
    const body = payload ? JSON.stringify(payload) : null;
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = https.request({ hostname: 'api.resend.com', path, method, timeout: 5000, headers }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 300) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function page(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Vault</title>
<style>body{margin:0;background:#0f1240;color:#fff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
main{max-width:480px;display:flex;flex-direction:column;gap:16px}.w{font-family:Georgia,serif;font-size:26px}.w span{color:#3b82f6}h1{margin:0;font-size:28px;line-height:34px;letter-spacing:-.02em}p{margin:0;color:#b9bddb;line-height:1.6}
a.b{display:inline-flex;align-items:center;height:48px;padding:0 24px;border-radius:8px;background:#4db8ff;color:#0f1240;font-weight:600;text-decoration:none;align-self:flex-start}</style></head>
<body><main><div class="w">Vault<span>.</span></div><h1>${esc(title)}</h1><p>${text}</p><a class="b" href="/">Back to Vault</a></main></body></html>`;
}
const html = (code, title, text) => ({ statusCode: code, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: page(title, text) });

async function confirm(q) {
  const email = String(q.e || '').trim().toLowerCase();
  const t = parseInt(q.t, 10);
  if (!email || !t || !q.s || !safeEqual(q.s, sign(email, t))) {
    return html(400, 'That link didn’t work', 'It may have been copied incompletely. Sign up again on vaultbot.ai and use the newest email.');
  }
  if (Date.now() - t > LINK_TTL_MS) {
    return html(410, 'That link expired', 'Confirmation links last 7 days. Sign up again on vaultbot.ai and we’ll send a fresh one.');
  }
  const base = `/audiences/${AUDIENCE_ID}/contacts`;
  const found = await resend('GET', `${base}/${encodeURIComponent(email)}`);
  if (found.status === 200) {
    console.log('[newsletter] confirm: already on list');
    return html(200, 'You’re already on the list', 'This address is already in Vault’s list, so nothing changed. If you unsubscribed earlier and want back in, reply to any Vault email.');
  }
  if (found.status !== 404) {
    console.log('[newsletter] confirm: lookup failed', found.status || found.error);
    return html(503, 'Something went wrong on our end', 'We couldn’t reach our email provider. Please try the link again in a few minutes.');
  }
  const made = await resend('POST', base, { email, first_name: '', last_name: '' });
  console.log('[newsletter] confirm: create', made.status || made.error);
  if (made.status >= 200 && made.status < 300) {
    return html(200, 'You’re in', 'Thanks for subscribing. You’ll get one short email when something ships. Reply anytime with what you want Vault to do next.');
  }
  return html(503, 'Something went wrong on our end', 'We couldn’t add you just now. Please try the link again in a few minutes.');
}

async function request(body, host) {
  const email = String(body.email || '').trim().toLowerCase();
  if (body.website) return json(200, { ok: true }); // honeypot: pretend success, do nothing
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json(400, { error: 'Enter a full email address.' });
  const domain = email.split('@')[1];
  if (DISPOSABLE.has(domain)) return json(400, { error: 'Please use a permanent email address.' });
  let mx = false;
  try { mx = (await dns.resolveMx(domain)).length > 0; } catch { mx = false; }
  if (!mx) return json(400, { error: `“${domain}” doesn’t seem to accept email. Check the address?` });
  if (/@goidentify\.com$/.test(email)) return json(200, { ok: true }); // team stays off the list, quietly

  const t = Date.now();
  const origin = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '') ? `http://${host}` : 'https://vaultbot.ai';
  const link = `${origin}/.netlify/functions/newsletter-signup?e=${encodeURIComponent(email)}&t=${t}&s=${sign(email, t)}`;
  const sent = await resend('POST', '/emails', {
    from: 'Lee from Vault <mcp@vaultbot.ai>',
    to: [email],
    subject: 'Confirm your Vault updates',
    html: `<div style="font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f1240">
<div style="font-family:Georgia,serif;font-size:24px;margin-bottom:24px">Vault<span style="color:#3b82f6">.</span></div>
<p style="font-size:16px;line-height:1.6;margin:0 0 16px">One click and you’re on the list for Vault updates: a short email when something ships.</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#0f1240;color:#fff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:8px">Confirm my email</a></p>
<p style="font-size:13px;line-height:1.6;color:#62668a;margin:0">If you didn’t ask for this, ignore this email and nothing happens. The link expires in 7 days.</p>
<p style="font-size:12px;line-height:1.6;color:#62668a;margin:24px 0 0">iDENTIFY, 110 S Hartford Ave, STE 2509, Tulsa, OK 74120</p></div>`,
    text: `Confirm your Vault updates: ${link}\n\nIf you didn't ask for this, ignore this email. The link expires in 7 days.\n\niDENTIFY, 110 S Hartford Ave, STE 2509, Tulsa, OK 74120`,
  });
  console.log('[newsletter] request: confirm email', sent.status || sent.error, body.source || '');
  if (!(sent.status >= 200 && sent.status < 300)) return json(502, { error: 'We couldn’t send the confirmation email. Please try again in a minute.' });
  return json(200, { ok: true });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod === 'GET') return confirm(event.queryStringParameters || {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  return request(body, (event.headers || {}).host);
};

// Exposed for offline tests only.
exports._sign = sign;
