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
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#0f1240;border:1px solid rgba(77,184,255,0.18);border-radius:16px;overflow:hidden;">
      <!-- Top accent bar -->
      <tr><td style="height:3px;background:linear-gradient(90deg,#4db8ff 0%,#b06ef3 100%);padding:0;line-height:0;font-size:0;">&nbsp;</td></tr>
      <!-- Header -->
      <tr><td style="padding:36px 36px 8px;text-align:left;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:38px;font-weight:600;letter-spacing:-1.5px;color:#fff;line-height:1;margin:0;">Vault<span style="color:#4db8ff">.</span></div>
        <div style="font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#4db8ff;letter-spacing:0.18em;text-transform:uppercase;margin-top:8px;font-weight:600;">⚡ MCP Install Guide</div>
      </td></tr>
      <!-- Greeting -->
      <tr><td style="padding:20px 36px 8px;">
        <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:30px;color:#fff;margin:0 0 14px;line-height:1.15;letter-spacing:-0.8px;font-weight:600;">Welcome, ${user.name?.split(' ')[0] || 'there'}.</h1>
        <p style="font-size:15px;color:#c8cfe6;line-height:1.65;margin:0 0 8px;">
          You're all set. Vault MCP is the first banking intelligence Model Context Protocol server — it gives any AI agent live access to FDIC data on 4,500+ banks.
        </p>
        <p style="font-size:15px;color:#c8cfe6;line-height:1.65;margin:0 0 8px;">
          Setup takes about 2 minutes. Here's what you need.
        </p>
      </td></tr>
      <!-- Config block -->
      <tr><td style="padding:24px 36px 0;">
        <div style="font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#4db8ff;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:10px;font-weight:600;">→ Your config</div>
        <div style="background:#070926;border:1px solid rgba(77,184,255,0.2);border-radius:10px;padding:18px 20px;font-family:ui-monospace,'SF Mono','JetBrains Mono',Monaco,monospace;font-size:12px;color:#a8c4e8;line-height:1.7;">
<span style="color:#7e8bb0;">{</span><br>
&nbsp;&nbsp;<span style="color:#b06ef3;">"mcpServers"</span>: <span style="color:#7e8bb0;">{</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#b06ef3;">"vault-banking"</span>: <span style="color:#7e8bb0;">{</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#4db8ff;">"command"</span>: <span style="color:#a8c4e8;">"npx"</span>,<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#4db8ff;">"args"</span>: <span style="color:#7e8bb0;">[</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#a8c4e8;">"-y"</span>,<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#a8c4e8;">"mcp-remote"</span>,<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#a8c4e8;">"https://vaultbot.ai/.netlify/functions/mcp"</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#7e8bb0;">]</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#7e8bb0;">}</span><br>
&nbsp;&nbsp;<span style="color:#7e8bb0;">}</span><br>
<span style="color:#7e8bb0;">}</span>
        </div>
      </td></tr>
      <!-- Prerequisites -->
      <tr><td style="padding:30px 36px 0;">
        <div style="font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#b06ef3;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:14px;font-weight:600;">→ Before you start</div>
        <div style="background:rgba(176,110,243,0.06);border:1px solid rgba(176,110,243,0.2);border-radius:8px;padding:14px 18px;color:#c8cfe6;font-size:13px;line-height:1.65;">
          Vault MCP requires <strong style="color:#fff;">Node.js 18 or higher</strong> on your machine. Most developer Macs already have it.<br>
          Quick check: open Terminal, run <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">node --version</code>. If you see <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">v18</code> or higher, you're set.<br>
          Don't have Node? Download it from <a href="https://nodejs.org" style="color:#4db8ff;text-decoration:none;font-weight:600;">nodejs.org</a> (LTS version, 2 min install).
        </div>
      </td></tr>
      <!-- Steps -->
      <tr><td style="padding:30px 36px 0;">
        <div style="font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#4db8ff;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:14px;font-weight:600;">→ Quick install</div>
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="padding:8px 0;color:#c8cfe6;font-size:14px;line-height:1.6;">
            <span style="color:#4db8ff;font-family:ui-monospace,monospace;font-weight:700;">01</span> &nbsp;&nbsp;Open <strong style="color:#fff;">Claude Desktop → Settings → Developer → Edit Config</strong>
          </td></tr>
          <tr><td style="padding:8px 0;color:#c8cfe6;font-size:14px;line-height:1.6;">
            <span style="color:#4db8ff;font-family:ui-monospace,monospace;font-weight:700;">02</span> &nbsp;&nbsp;Add the config above to your <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">mcpServers</code>
          </td></tr>
          <tr><td style="padding:8px 0;color:#c8cfe6;font-size:14px;line-height:1.6;">
            <span style="color:#4db8ff;font-family:ui-monospace,monospace;font-weight:700;">03</span> &nbsp;&nbsp;Quit Claude Desktop completely <span style="color:#7e8bb0;">(⌘Q)</span>, reopen
          </td></tr>
          <tr><td style="padding:8px 0;color:#c8cfe6;font-size:14px;line-height:1.6;">
            <span style="color:#4db8ff;font-family:ui-monospace,monospace;font-weight:700;">04</span> &nbsp;&nbsp;Click the tools icon — <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">vault-banking</code> appears with 10 tools
          </td></tr>
        </table>
      </td></tr>
      <!-- Try prompts -->
      <tr><td style="padding:30px 36px 0;">
        <div style="font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#4db8ff;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:14px;font-weight:600;">→ Try these</div>
        <div style="color:#c8cfe6;font-size:14px;line-height:2;">
          <span style="color:#7e8bb0;">"</span>What's the latest financial data for Sutton Bank?<span style="color:#7e8bb0;">"</span><br>
          <span style="color:#7e8bb0;">"</span>Show me bank mergers from 2025<span style="color:#7e8bb0;">"</span><br>
          <span style="color:#7e8bb0;">"</span>Compare U.S. banking industry 2024 vs 2025<span style="color:#7e8bb0;">"</span><br>
          <span style="color:#7e8bb0;">"</span>Find top community lenders in Oklahoma<span style="color:#7e8bb0;">"</span>
        </div>
      </td></tr>
      <!-- Troubleshooting -->
      <tr><td style="padding:30px 36px 0;">
        <div style="font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#4db8ff;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:14px;font-weight:600;">→ Troubleshooting</div>
        <div style="color:#c8cfe6;font-size:13px;line-height:1.65;">
          <strong style="color:#fff;">Seeing <code style="background:rgba(248,113,113,0.12);padding:2px 6px;border-radius:4px;font-size:12px;color:#f87171;">spawn npx ENOENT</code> or "Server disconnected"?</strong><br>
          Claude can't find <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">npx</code> in its PATH. Open Terminal, run <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">which npx</code>, and replace <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">"command": "npx"</code> in your config with the full path it prints (e.g. <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">"/usr/local/bin/npx"</code>). Save, fully quit Claude (⌘Q), reopen.
          <br><br>
          <strong style="color:#fff;">Still stuck?</strong> Reply to this email with the contents of your <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">mcp-server-vault-banking.log</code> file (found in <code style="background:rgba(77,184,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px;color:#4db8ff;">~/Library/Logs/Claude/</code>) and I'll personally help debug.
        </div>
      </td></tr>
      <!-- CTAs -->
      <tr><td style="padding:36px 36px 28px;text-align:center;">
        <a href="https://vaultbot.ai/mcp" style="display:inline-block;padding:13px 26px;background:#4db8ff;color:#0f1240;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700;letter-spacing:0.04em;margin:0 4px 10px;font-family:-apple-system,sans-serif;">View documentation →</a>
        <a href="https://vaultbot.ai" style="display:inline-block;padding:13px 26px;background:transparent;border:1px solid rgba(77,184,255,0.4);color:#4db8ff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;letter-spacing:0.04em;margin:0 4px 10px;font-family:-apple-system,sans-serif;">Explore Vault</a>
      </td></tr>
      <!-- iDENTIFY tie-in -->
      <tr><td style="padding:24px 36px;background:rgba(176,110,243,0.06);border-top:1px solid rgba(255,255,255,0.06);">
        <div style="font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#b06ef3;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:10px;font-weight:600;">// Want more?</div>
        <div style="font-size:14px;color:#c8cfe6;line-height:1.65;">
          Vault MCP exposes <em style="color:#fff;">public</em> FDIC data. The same architecture pointed at <strong style="color:#fff;">your</strong> core banking data is what we build at
          <a href="https://goidentify.com" style="color:#4db8ff;text-decoration:none;font-weight:600;">iDENTIFY</a> — banking data infrastructure for community banks, sponsor banks, credit unions, and fintechs.
        </div>
        <div style="font-size:13px;color:#8b95b3;line-height:1.6;margin-top:12px;">
          Reply to this email or write me at <a href="mailto:lee@goidentify.com" style="color:#4db8ff;text-decoration:none;">lee@goidentify.com</a>.
        </div>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:18px 36px;text-align:center;font-family:ui-monospace,'SF Mono',Monaco,monospace;font-size:10px;color:#5e6788;letter-spacing:0.06em;border-top:1px solid rgba(255,255,255,0.04);">
        Built by iDENTIFY &nbsp;·&nbsp; Free banking intelligence &nbsp;·&nbsp; <a href="https://vaultbot.ai" style="color:#5e6788;text-decoration:none;">vaultbot.ai</a>
      </td></tr>
      <!-- Bottom accent bar -->
      <tr><td style="height:3px;background:linear-gradient(90deg,#b06ef3 0%,#4db8ff 100%);padding:0;line-height:0;font-size:0;">&nbsp;</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    const body = JSON.stringify({
      from: 'Vault MCP <mcp@vaultbot.ai>',
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
