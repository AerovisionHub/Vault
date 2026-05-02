const https = require('https');

// Send email via Resend API
function sendEmail(lead) {
  return new Promise((resolve) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { resolve({ skipped: true }); return; }

    const body = JSON.stringify({
      from: 'Vault Leads <leads@vaultbot.ai>',
      to: ['lee@goidentify.com'],
      subject: `New Vault Lead: ${lead.name} — ${lead.institution || 'Unknown Institution'}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="color:#1a1a2e;margin-bottom:4px;">New Lead from vaultbot.ai</h2>
          <p style="color:#666;font-size:13px;margin-bottom:24px;">Submitted ${new Date(lead.ts).toLocaleString('en-US', {timeZone:'America/Chicago'})}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;width:130px;">Name</td>
              <td style="padding:10px 0;font-weight:600;">${lead.name}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;">Email</td>
              <td style="padding:10px 0;"><a href="mailto:${lead.email}" style="color:#1d83ec;">${lead.email}</a></td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;">Institution</td>
              <td style="padding:10px 0;">${lead.institution || '—'}</td>
            </tr>
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:10px 0;color:#666;">Role</td>
              <td style="padding:10px 0;">${lead.role || '—'}</td>
            </tr>
            ${lead.feedback ? `
            <tr>
              <td style="padding:10px 0;color:#666;vertical-align:top;">Feedback</td>
              <td style="padding:10px 0;">${lead.feedback}</td>
            </tr>` : ''}
          </table>
          <div style="margin-top:24px;padding:16px;background:#f0f7ff;border-radius:8px;font-size:13px;color:#555;">
            Source: vaultbot.ai/about
          </div>
        </div>
      `,
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const params = new URLSearchParams(event.body);
    const lead = {
      name:        params.get('name')        || '',
      email:       params.get('email')       || '',
      institution: params.get('institution') || '',
      role:        params.get('role')        || '',
      feedback:    params.get('feedback')    || '',
      ts:          new Date().toISOString(),
      source:      'vaultbot.ai/about',
    };

    // Log to Netlify function logs
    console.log('NEW LEAD:', JSON.stringify(lead));

    // Send email notification via Resend
    const emailResult = await sendEmail(lead);
    console.log('Email result:', JSON.stringify(emailResult));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ ok: true, email: emailResult }),
    };
  } catch (err) {
    console.error('Lead submission error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
