const https = require('https');

// ---- Hardening (2026-10-10): scanner probe exposed unescaped HTML in the lead
// notification email + browser-only validation. Everything user-supplied is now
// sanitized, validated and length-capped server-side before any email is built.

const LIMITS = { name: 100, email: 150, institution: 150, role: 60, feedback: 2000 };
const EMAIL_RE = /^[^\s@<>"'`;,()\[\]\\]+@[^\s@<>"'`;,()\[\]\\]+\.[^\s@<>"'`;,()\[\]\\]{2,}$/;
const ALLOWED_ORIGIN = 'https://vaultbot.ai';

// Best-effort per-IP throttle (in-memory, per warm function instance).
const HITS = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;
function throttled(ip) {
  const now = Date.now();
  const recent = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 500) { for (const [k, v] of HITS) if (!v.some(t => now - t < WINDOW_MS)) HITS.delete(k); }
  return recent.length > MAX_HITS;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Strip control chars, trim, cap length. Single-line fields also lose CR/LF/tab
// (they feed the email subject); feedback keeps newlines.
function clean(v, max, multiline) {
  let out = String(v == null ? '' : v);
  out = multiline
    ? out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    : out.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ');
  return out.trim().slice(0, max);
}

function sanitizeLead(params) {
  const lead = {
    name:        clean(params.get('name'), LIMITS.name),
    email:       clean(params.get('email'), LIMITS.email),
    institution: clean(params.get('institution'), LIMITS.institution),
    role:        clean(params.get('role'), LIMITS.role),
    feedback:    clean(params.get('feedback'), LIMITS.feedback, true),
    ts:          new Date().toISOString(),
    source:      'vaultbot.ai/about',
  };
  if (!lead.name || !EMAIL_RE.test(lead.email)) return { ok: false, lead };
  return { ok: true, lead };
}

function renderEmail(lead) {
  const e = {
    name: esc(lead.name), email: esc(lead.email),
    institution: esc(lead.institution), role: esc(lead.role), feedback: esc(lead.feedback),
  };
  return `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="color:#1a1a2e;margin-bottom:4px;">New Lead from vaultbot.ai</h2>
          <p style="color:#666;font-size:13px;margin-bottom:24px;">Submitted ${new Date(lead.ts).toLocaleString('en-US', {timeZone:'America/Chicago'})}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;width:130px;">Name</td>
              <td style="padding:10px 0;font-weight:600;">${e.name}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;">Email</td>
              <td style="padding:10px 0;"><a href="mailto:${e.email}" style="color:#1d83ec;">${e.email}</a></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;">Institution</td>
              <td style="padding:10px 0;">${e.institution || '—'}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;">Role</td>
              <td style="padding:10px 0;">${e.role || '—'}</td>
            </tr>
            ${lead.feedback ? `
            <tr>
              <td style="padding:10px 0;color:#666;vertical-align:top;">Feedback</td>
              <td style="padding:10px 0;">${e.feedback}</td>
            </tr>` : ''}
          </table>
          <div style="margin-top:24px;padding:16px;background:#f0f7ff;border-radius:8px;font-size:13px;color:#555;">
            Source: vaultbot.ai/about
          </div>
        </div>
      `;
}

// Send email via Resend API
function sendEmail(lead) {
  return new Promise((resolve) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { resolve({ skipped: true }); return; }

    const body = JSON.stringify({
      from: 'Vault Leads <leads@vaultbot.ai>',
      to: ['lee@goidentify.com'],
      subject: `New Vault Lead: ${lead.name} — ${lead.institution || 'Unknown Institution'}`.slice(0, 200),
      html: renderEmail(lead),
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

const CORS = { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Vary': 'Origin' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' } };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const h = event.headers || {};
    const ip = h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (throttled(ip)) {
      console.log('LEAD REJECTED (rate limit):', ip);
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ ok: false, error: 'rate_limited' }) };
    }

    const params = new URLSearchParams((event.body || '').slice(0, 20000));
    const { ok, lead } = sanitizeLead(params);
    if (!ok) {
      // Invalid / bot traffic: no email, no storage. Log a short trace only.
      console.log('LEAD REJECTED (invalid):', ip, JSON.stringify({ name: lead.name.slice(0, 30), email: lead.email.slice(0, 30) }));
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'invalid' }) };
    }

    // Log to Netlify function logs
    console.log('NEW LEAD:', JSON.stringify(lead));

    // Send email notification via Resend
    const emailResult = await sendEmail(lead);
    console.log('Email result:', JSON.stringify(emailResult));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('Lead submission error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

exports._internals = { esc, clean, sanitizeLead, renderEmail, EMAIL_RE };
