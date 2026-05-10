// MCP signup — validates email, captures lead, sends branded welcome email with config
// Layers: format check → disposable email block → MX record check → hCaptcha (optional) → submit + email

const dns = require('dns').promises;
const https = require('https');

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', 'guerrillamail.com', 'guerrillamail.org',
  'mailinator.com', 'mailinator.net', 'maildrop.cc', 'mintemail.com', 'tempinbox.com',
  'throwaway.email', 'trashmail.com', 'yopmail.com', 'temp-mail.org', 'tempmail.com',
  'fakeinbox.com', 'getairmail.com', 'spambox.us', 'temporary-mail.net', 'tempr.email',
  'sharklasers.com', 'guerrillamail.de', 'pokemail.net', 'spam4.me', 'grr.la',
  'inboxbear.com', 'tmpmail.org', 'tmpeml.com', 'mohmal.com', 'tempail.com',
  'dispostable.com', 'mvrht.net', 'mytemp.email', 'instant-mail.de', 'nada.email',
  'getnada.com', 'inboxalias.com', 'crazymail.online', 'jetable.org', 'cool.fr.nf',
  'jnxjn.com', 'tmail.ws', 'haltospam.com', 'incognitomail.com',
]);

async function checkMXRecord(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch { return false; }
}

async function verifyCaptcha(token) {
  if (!token) return false;
  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret) return true; // If hCaptcha not configured, skip check (graceful fallback)

  return new Promise((resolve) => {
    const body = `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`;
    const req = https.request({
      hostname: 'hcaptcha.com',
      path: '/siteverify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).success === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

function postFormSubmission(fields) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({ 'form-name': 'mcp-signup', ...fields }).toString();
    const req = https.request({
      hostname: 'vaultbot.ai',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Vault-MCP-Signup/1.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

function sendWelcomeEmail(user) {
  return new Promise((resolve) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { resolve({ skipped: true, reason: 'No RESEND_API_KEY' }); return; }

    const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f1240;font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif;color:#fff;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f1240;">
  <tr><td align="center" style="padding:40px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:linear-gradient(180deg,#1a1060 0%,#2d1080 100%);border-radius:16px;overflow:hidden;">
      <tr><td style="padding:36px 32px 24px;text-align:left;">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:36px;font-weight:600;letter-spacing:-1px;color:#fff;line-height:1;margin:0;">Vault<span style="color:#4db8ff">.</span></div>
        <div style="font-family:ui-monospace,monospace;font-size:10px;color:#8b95b3;letter-spacing:0.15em;text-transform:uppercase;margin-top:6px;">⚡ Vault MCP — You're in</div>
      </td></tr>
      <tr><td style="padding:0 32px 28px;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;color:#fff;margin:0 0 12px;line-height:1.2;letter-spacing:-0.5px;">Hi ${user.name?.split(' ')[0] || 'there'} 👋</h1>
        <p style="font-size:15px;color:#c8cfe6;line-height:1.6;margin:0 0 16px;">
          Thanks for signing up to use Vault MCP — the first banking intelligence Model Context Protocol server.
          Here's everything you need to get started.
        </p>
      </td></tr>
      <tr><td style="padding:0 32px;">
        <div style="background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:20px;font-family:ui-monospace,'JetBrains Mono',Monaco,monospace;font-size:12px;color:#d6deeb;line-height:1.7;overflow-x:auto;">
{<br>
&nbsp;&nbsp;"mcpServers": {<br>
&nbsp;&nbsp;&nbsp;&nbsp;"vault-banking": {<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"command": "npx",<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"args": [<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"-y",<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"mcp-remote",<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"https://vaultbot.ai/.netlify/functions/mcp"<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;]<br>
&nbsp;&nbsp;&nbsp;&nbsp;}<br>
&nbsp;&nbsp;}<br>
}
        </div>
      </td></tr>
      <tr><td style="padding:24px 32px 8px;">
        <div style="font-family:ui-monospace,monospace;font-size:11px;color:#4db8ff;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">Quick install — Claude Desktop</div>
        <ol style="margin:0;padding-left:22px;color:#c8cfe6;font-size:14px;line-height:1.8;">
          <li>Open <strong style="color:#fff;">Claude Desktop → Settings → Developer → Edit Config</strong></li>
          <li>Add the snippet above to your <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-size:12px;">mcpServers</code></li>
          <li>Quit Claude Desktop completely (⌘Q on Mac), then reopen</li>
          <li>Click the tools icon — you'll see <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-size:12px;">vault-banking</code> with 6 tools</li>
        </ol>
      </td></tr>
      <tr><td style="padding:24px 32px 8px;">
        <div style="font-family:ui-monospace,monospace;font-size:11px;color:#4db8ff;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">Try these prompts</div>
        <ul style="margin:0;padding-left:0;list-style:none;color:#c8cfe6;font-size:14px;line-height:1.9;">
          <li>→ "What's the latest financial data for Sutton Bank?"</li>
          <li>→ "Show me bank mergers from 2025"</li>
          <li>→ "Compare U.S. banking industry 2024 vs 2025"</li>
          <li>→ "Find top community lenders in Oklahoma"</li>
        </ul>
      </td></tr>
      <tr><td style="padding:32px;text-align:center;">
        <a href="https://vaultbot.ai/mcp" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#4db8ff,#b06ef3);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600;margin:0 4px 8px;">View documentation</a>
        <a href="https://vaultbot.ai" style="display:inline-block;padding:14px 28px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600;margin:0 4px 8px;">Explore Vault</a>
      </td></tr>
      <tr><td style="padding:24px 32px;background:rgba(0,0,0,0.25);border-top:1px solid rgba(255,255,255,0.08);">
        <div style="font-size:13px;color:#c8cfe6;line-height:1.7;">
          <strong style="color:#fff;">Want to do more with banking + AI?</strong><br>
          Vault MCP exposes <em>public</em> FDIC data. The same architecture pointed at YOUR core banking data is what we build at
          <a href="https://goidentify.com" style="color:#4db8ff;text-decoration:none;font-weight:600;">iDENTIFY</a> — banking data infrastructure for community banks, sponsor banks, credit unions, and fintechs.
          <br><br>
          Reply to this email or ping <a href="mailto:lee@goidentify.com" style="color:#4db8ff;">lee@goidentify.com</a> to chat.
        </div>
      </td></tr>
      <tr><td style="padding:18px 32px;text-align:center;font-family:ui-monospace,monospace;font-size:10px;color:#8b95b3;">
        Built by iDENTIFY · Free banking intelligence · vaultbot.ai
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    const body = JSON.stringify({
      from: 'Vault MCP <onboarding@resend.dev>',
      to: [user.email],
      bcc: ['lee@goidentify.com'],
      subject: '⚡ Your Vault MCP install guide — ready to use',
      html,
      reply_to: 'lee@goidentify.com',
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
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'POST required' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { name, email, company, role, use_case, source, captcha_token } = body;

  if (!name || !email) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Name and email required' }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  const domain = email.split('@')[1].toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Please use your work email — disposable email addresses are not accepted.' }) };
  }

  // hCaptcha verification (only enforced if HCAPTCHA_SECRET env var is set)
  if (process.env.HCAPTCHA_SECRET) {
    const captchaOk = await verifyCaptcha(captcha_token);
    if (!captchaOk) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Captcha verification failed. Please try again.' }) };
    }
  }

  const hasMX = await checkMXRecord(domain);
  if (!hasMX) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `The domain "${domain}" does not appear to accept email. Please check the address.` }) };
  }

  // Submit to Netlify Forms (best effort — signup succeeds even if this fails)
  let formSubmitOk = false;
  try {
    const formResult = await postFormSubmission({
      name: name.slice(0, 200),
      email: email.slice(0, 200),
      company: (company || '').slice(0, 200),
      role: (role || '').slice(0, 100),
      use_case: (use_case || '').slice(0, 1000),
      source: (source || '').slice(0, 100),
    });
    formSubmitOk = true;
    console.log('Netlify Form submission:', JSON.stringify(formResult));
  } catch (e) {
    console.error('Form submit error:', e.message);
  }

  // Send welcome email — best effort, don't fail the whole signup if email fails
  let emailResult = { skipped: true };
  try {
    emailResult = await sendWelcomeEmail({ name, email, company, role });
    console.log('Email result:', JSON.stringify(emailResult));
  } catch (e) {
    console.error('Email send error:', e.message);
    emailResult = { error: e.message };
  }

  console.log('MCP signup completed:', JSON.stringify({
    email, company,
    formSubmitOk,
    emailStatus: emailResult.status || (emailResult.skipped ? 'skipped' : emailResult.error || 'unknown'),
  }));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ok: true,
      emailSent: emailResult.status === 200,
      message: 'Signup recorded.',
    }),
  };
};
