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

function extractFromZip(buf, targetFile) {
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const fnLen = buf.readUInt16LE(offset + 26, true);
    const extraLen = buf.readUInt16LE(offset + 28, true);
    const fn = buf.slice(offset + 30, offset + 30 + fnLen).toString('utf8');
    const compSize = buf.readUInt32LE(offset + 18, true);
    const method = buf.readUInt16LE(offset + 8, true);
    const dataOffset = offset + 30 + fnLen + extraLen;
    if (fn === targetFile) {
      const compData = buf.slice(dataOffset, dataOffset + compSize);
      return method === 0 ? compData : zlib.inflateRawSync(compData);
    }
    offset = dataOffset + compSize;
  }
  return null;
}

function parseCSVLine(line) {
  const vals = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { vals.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  vals.push(cur.trim());
  return vals;
}

function parseCSVtoMap(buf, keyField) {
  const text = buf.toString('latin1');
  const lines = text.split('\n');
  if (lines.length < 2) return {};
  const headers = parseCSVLine(lines[0].replace('\r', ''));
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace('\r', '');
    if (!line.trim()) continue;
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
    if (obj[keyField]) map[obj[keyField]] = obj;
  }
  return map;
}

async function loadCUData() {
  if (cuCache && (Date.now() - cacheTimestamp) < CACHE_TTL) return cuCache;

  const zipBuf = await fetchBuffer(BULK_URL);

  // Parse FOICU.txt — profile data (name, city, state, type)
  const foicuBuf = extractFromZip(zipBuf, 'FOICU.txt');
  if (!foicuBuf) throw new Error('FOICU.txt not found');
  const profiles = parseCSVtoMap(foicuBuf, 'CU_NUMBER');

  // Parse FS220.txt — financial data (assets, members, shares, loans)
  // FS220 headers include: CU_NUMBER, ACCT_010 (total assets), ACCT_730 (members)
  const fs220Buf = extractFromZip(zipBuf, 'FS220.txt');
  const financials = fs220Buf ? parseCSVtoMap(fs220Buf, 'CU_NUMBER') : {};
  // Log FS220 headers to confirm field names
  if (fs220Buf) {
    const firstLine = fs220Buf.toString('latin1').split('\n')[0];
      const sample = Object.values(financials)[0];
    if (sample) console.log('FS220 sample:', JSON.stringify(sample).slice(0, 300));
  }

  // Join profiles + financials on CU_NUMBER
  cuCache = Object.values(profiles)
    .filter(p => p.CU_NAME)
    .map(p => {
      const fin = financials[p.CU_NUMBER] || {};
      // ACCT_010 = total assets in $thousands, ACCT_730 = number of members
      const assets = Math.round(parseFloat(fin.ACCT_010 || '0')); // ACCT_010 already in dollars
      // Log full FS220 row for OneAZ on first load to find member field
      if (p.CU_NUMBER === '61315' && fin) {
        console.log('OneAZ FULL FS220:', JSON.stringify(fin).slice(0, 3000));
      }
      // NCUA 5300 call report: ACCT_731 = total members (most reliable)
      // Fallbacks: ACCT_730, ACCT_084 (potential members - too high), ACCT_083
      const members = parseInt(fin.ACCT_083 || '0', 10); // ACCT_083 = total members (confirmed from FS220 Q4 2025)
      return {
        id:      p.CU_NUMBER,
        name:    p.CU_NAME,
        city:    p.CITY,
        state:   p.STATE,
        zip:     p.ZIP_CODE,
        assets,
        members,
        type:    CU_TYPE_MAP[p.CU_TYPE] || p.CU_TYPE,
        charter: p.CU_NUMBER,
        website: p.STREET ? '' : '', // FOICU has no website field
      };
    });

  cacheTimestamp = Date.now();
  const oneaz = cuCache.find(cu => cu.id === '61315');
  if (oneaz) console.log('OneAZ result:', JSON.stringify(oneaz));

  return cuCache;
}

// Lightweight fuzzy scorer — no external deps
function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 80;
  // Acronym match: "navy federal" matches "NFCU" and vice versa
  const words = t.split(/\s+/);
  const acronym = words.map(w => w[0] || '').join('');
  if (acronym === q) return 85;
  if (acronym.startsWith(q)) return 75;
  // Word-by-word match
  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  const matchedWords = qWords.filter(w => t.includes(w));
  if (matchedWords.length === qWords.length) return 70;
  if (matchedWords.length > 0) return 50 + (matchedWords.length / qWords.length) * 20;
  // Character-level fuzzy: check if all chars in query appear in order in target
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 30 + Math.floor((q.length / t.length) * 20);
  return 0;
}

exports.handler = async function(event, context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const params = event.queryStringParameters || {};
  const q = (params.q || '').toLowerCase().trim();
  const limit = Math.min(parseInt(params.limit || '20', 10), 200);
  const minAssets = params.minAssets ? parseInt(params.minAssets, 10) : null;
  const maxAssets = params.maxAssets ? parseInt(params.maxAssets, 10) : null;
  const state = params.state ? params.state.toUpperCase() : null;

  if (!q && !minAssets) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ results: [], totalResultCount: 0 }) };
  }

  try {
    const allCUs = await loadCUData();

    // Asset range filter (for peers)
    let pool = allCUs;
    if (minAssets !== null) pool = pool.filter(cu => cu.assets >= minAssets && cu.assets <= maxAssets);
    if (state) pool = pool.filter(cu => cu.state === state);

    // Text search with fuzzy scoring
    let matched;
    if (q) {
      const scored = pool
        .map(cu => ({ cu, score: fuzzyScore(q, cu.name) }))
        .filter(({ score }) => score >= 30);
      scored.sort((a, b) => b.score !== a.score ? b.score - a.score : (b.cu.assets || 0) - (a.cu.assets || 0));
      matched = scored.map(({ cu }) => cu);
    } else {
      // Asset range only — sort by assets desc
      matched = pool.sort((a, b) => (b.assets || 0) - (a.assets || 0));
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ results: matched.slice(0, limit), totalResultCount: matched.length })
    };
  } catch(e) {
    console.error('NCUA error:', e.message);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: e.message, results: [], totalResultCount: 0 }) };
  }
};
