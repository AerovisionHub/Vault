const https = require('https');
const zlib = require('zlib');

let cuCache = null;
let cacheTimestamp = 0; 
const CACHE_TTL = 60 * 60 * 1000;
const BULK_URL = 'https://ncua.gov/files/publications/analysis/call-report-data-2025-12.zip';

// CU_TYPE codes from NCUA data dictionary
const CU_TYPE_MAP = {
  '1': 'Federal CU', '2': 'State CU', '3': 'Federal Savings Bank',
  '4': 'State Savings Bank', '5': 'FICU', '6': 'Corporate CU', '7': 'Corporate FCU'
};

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return get(res.headers.location, redirects + 1);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}