const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Simple HTTPS fetch — returns parsed JSON
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'VaultBot/1.0 (vaultbot.ai)' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return get(res.headers.location, redirects + 1);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch(e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

// ── Route handlers ────────────────────────────────────────────────────────────

// GET /functions/hmda?action=search&q=CERT_OR_NAME&year=2023
// Looks up a bank's LEI from FFIEC by CERT number or name
async function searchInstitution(q, year = '2023') {
  const url = `https://ffiec.cfpb.gov/api/public/institutions/search?q=${encodeURIComponent(q)}&year=${year}`;
  const data = await fetchJSON(url);
  return data;
}

// GET /functions/hmda?action=filing&lei=LEI&year=2023
// Gets filing summary for an institution
async function getFiling(lei, year = '2023') {
  const url = `https://ffiec.cfpb.gov/api/public/institutions/${lei}/filings/${year}`;
  const data = await fetchJSON(url);
  return data;
}

// GET /functions/hmda?action=aggregate&lei=LEI&year=2023
// Gets aggregate loan data for an institution — origination counts by loan type/purpose
async function getAggregate(lei, year = '2023') {
  // HMDA aggregate report: actions taken × loan purpose breakdown
  const url = `https://ffiec.cfpb.gov/api/public/reports/disclosure/${year}/${lei}/1/1/actions_taken.json`;
  try {
    const data = await fetchJSON(url);
    return data;
  } catch(e) {
    // Fallback: try the nationwide aggregate filtered by LEI
    const url2 = `https://api.consumerfinance.gov/data/hmda/aggregations?as_of_year=${year}&action_taken=1&lei=${lei}&_summary_fields=loan_purpose,loan_type,action_taken&_limit=50`;
    const data2 = await fetchJSON(url2);
    return data2;
  }
}

// GET /functions/hmda?action=snapshot&lei=LEI&year=2023
// Gets snapshot summary — total originations, avg loan amount
async function getSnapshot(lei, year = '2023') {
  const url = `https://ffiec.cfpb.gov/api/public/snapshot/nationwide/${year}/aggregate?lei=${lei}`;
  const data = await fetchJSON(url);
  return data;
}

// GET /functions/hmda?action=lender_summary&lei=LEI&year=2023
// Combines filing + aggregate into a clean summary object for Vault
async function getLenderSummary(lei, year = '2023') {
  const results = await Promise.allSettled([
    getFiling(lei, year),
    getAggregate(lei, year),
    getSnapshot(lei, year),
  ]);

  const filing   = results[0].status === 'fulfilled' ? results[0].value : null;
  const aggregate = results[1].status === 'fulfilled' ? results[1].value : null;
  const snapshot  = results[2].status === 'fulfilled' ? results[2].value : null;

  // Parse origination counts from aggregate
  let totalOriginations = 0;
  let purchaseCount     = 0;
  let refiCount         = 0;
  let homeImpCount      = 0;
  let avgLoanAmount     = null;
  let approvalRate      = null;

  if (aggregate) {
    // Try FFIEC disclosure format first
    if (Array.isArray(aggregate)) {
      aggregate.forEach(row => {
        const count = parseInt(row.count || row.loan_count || 0);
        const purpose = row.loan_purpose || row.loanPurpose;
        totalOriginations += count;
        if (purpose === '1' || purpose === 1) purchaseCount += count;
        if (purpose === '31' || purpose === '32' || purpose === 2) refiCount += count;
        if (purpose === '2' || purpose === 3) homeImpCount += count;
      });
    }
    // Try CFPB aggregations format
    if (aggregate.aggregations) {
      aggregate.aggregations.forEach(row => {
        const count = parseInt(row.count || 0);
        totalOriginations += count;
      });
    }
  }

  if (snapshot) {
    avgLoanAmount = snapshot.avg_loan_amount || snapshot.averageLoanAmount || null;
    const approved = snapshot.total_originated || snapshot.totalOriginated || 0;
    const applied  = snapshot.total_applications || snapshot.totalApplications || 0;
    if (applied > 0) approvalRate = Math.round((approved / applied) * 100);
  }

  return {
    lei,
    year,
    filing_status: filing ? 'filed' : 'not_found',
    total_originations: totalOriginations || null,
    purchase_originations: purchaseCount || null,
    refi_originations: refiCount || null,
    home_improvement: homeImpCount || null,
    avg_loan_amount: avgLoanAmount,
    approval_rate_pct: approvalRate,
    raw: { filing, aggregate, snapshot },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const p = event.queryStringParameters || {};
  const action = p.action || 'search';
  const year   = p.year   || '2023';

  try {
    let result;

    switch (action) {
      case 'search':
        if (!p.q) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'q param required' }) };
        result = await searchInstitution(p.q, year);
        break;

      case 'filing':
        if (!p.lei) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lei param required' }) };
        result = await getFiling(p.lei, year);
        break;

      case 'aggregate':
        if (!p.lei) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lei param required' }) };
        result = await getAggregate(p.lei, year);
        break;

      case 'snapshot':
        if (!p.lei) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lei param required' }) };
        result = await getSnapshot(p.lei, year);
        break;

      case 'lender_summary':
        if (!p.lei) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lei param required' }) };
        result = await getLenderSummary(p.lei, year);
        break;

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(result),
    };

  } catch(e) {
    console.error('HMDA proxy error:', e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
