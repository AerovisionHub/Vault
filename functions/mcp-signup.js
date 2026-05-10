// MCP signup with email validation — disposable email blocking + MX record check
// Forwards valid submissions to Netlify Forms for permanent storage

const dns = require('dns').promises;
const https = require('https');

// Common disposable email domains (curated list — major offenders)
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
  } catch (e) {
    return false;
  }
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

  const { name, email, company, role, use_case, source } = body;

  // Layer 1: Required fields
  if (!name || !email) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Name and email required' }) };
  }

  // Layer 2: Format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  const domain = email.split('@')[1].toLowerCase();

  // Layer 3: Disposable email blocking
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Please use your work email — disposable email addresses are not accepted.' }),
    };
  }

  // Layer 4: MX record check — verifies the domain can actually receive email
  const hasMX = await checkMXRecord(domain);
  if (!hasMX) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `The domain "${domain}" does not appear to accept email. Please check the address.` }),
    };
  }

  // Submit to Netlify Forms
  const result = await postFormSubmission({
    name: name.slice(0, 200),
    email: email.slice(0, 200),
    company: (company || '').slice(0, 200),
    role: (role || '').slice(0, 100),
    use_case: (use_case || '').slice(0, 1000),
    source: (source || '').slice(0, 100),
  });

  console.log('MCP signup validated:', JSON.stringify({ email, company, role }));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ ok: true, message: 'Signup recorded.' }),
  };
};
