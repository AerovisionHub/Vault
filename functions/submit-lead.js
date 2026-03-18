// Netlify Function — handles form submissions and stores them
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const params = new URLSearchParams(event.body);
    const lead = {
      name: params.get('name') || '',
      email: params.get('email') || '',
      institution: params.get('institution') || '',
      role: params.get('role') || '',
      feedback: params.get('feedback') || '',
      ts: new Date().toISOString(),
      source: 'vaultbot.ai/about',
    };

    // Log to Netlify function logs (visible in Netlify dashboard)
    console.log('NEW LEAD SUBMISSION:', JSON.stringify(lead));

    // Return success
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('Lead submission error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
