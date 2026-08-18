const https = require('https');
const zlib = require('zlib');

let cuCache = null;
let lastFoicuHeaders = null; // diagnostic: real column names from the most recent FOICU.txt load
let lastZipFileList = null;  // diagnostic: every file name found in the most recent quarterly ZIP
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

// Walks the same local-file-header structure as extractFromZip, but
// collects every filename instead of extracting one target. Diagnostic
// tool: the quarterly bundle likely contains more files than just the two
// (FOICU.txt, FS220.txt) currently extracted -- if charter date isn't in
// FOICU.txt under any name tried so far, it may live in a different file
// in the same ZIP that's never been looked at.
function listZipFiles(buf) {
  const names = [];
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const fnLen = buf.readUInt16LE(offset + 26, true);
    const extraLen = buf.readUInt16LE(offset + 28, true);
    const fn = buf.slice(offset + 30, offset + 30 + fnLen).toString('utf8');
    const compSize = buf.readUInt32LE(offset + 18, true);
    const dataOffset = offset + 30 + fnLen + extraLen;
    names.push(fn);
    offset = dataOffset + compSize;
  }
  return names;
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

// Detects the charter-date column in FOICU.txt by scanning actual headers
// for a plausible name, rather than hardcoding a guessed field name. NCUA's
// public documentation doesn't clearly pin down this exact column name (it's
// buried in internal AIRES/5300 schema references, not a clean published
// data dictionary for FOICU.txt specifically) — guessing wrong here risks
// silently showing incorrect charter dates rather than failing loudly.
// Logs whatever it finds so a real field-name mismatch is visible in
// function logs rather than silently wrong, matching the same
// verify-don't-guess approach already used above for FS220's member-count
// field (ACCT_083, confirmed via logging before trusting it).
function detectCharterDateField(headers) {
  // Confirmed via live data (2026-08-11): FOICU.txt has no CHARTER_DATE or
  // CHTR_DT-style field at all -- the real field is YEAR_OPENED, which
  // doesn't contain "charter" or "chtr" as a substring and genuinely could
  // not have been found by pattern-matching alone. YEAR_OPENED gives
  // year-only precision, not a full date -- reflected in the 'year' mode
  // returned below.
  if (headers.includes('YEAR_OPENED')) {
    console.log('[ncua-charters] using confirmed real field: YEAR_OPENED (year-only precision)');
    return { field: 'YEAR_OPENED', mode: 'year' };
  }
  // Fallback pattern-match, kept in case NCUA renames/adds a proper dated
  // field in a future quarter's file.
  const candidates = headers.filter(h => {
    const up = h.toUpperCase();
    const hasCharterWord = up.includes('CHARTER') || up.includes('CHTR');
    const hasDateWord = up.includes('DATE') || up.includes('DT') || up.includes('_DT');
    return hasCharterWord && hasDateWord;
  });
  if (candidates.length) {
    console.log('[ncua-charters] charter date field candidates found:', candidates.join(', '), '- using:', candidates[0]);
    return { field: candidates[0], mode: 'date' };
  }
  console.log('[ncua-charters] NO charter date or YEAR_OPENED field found in FOICU.txt headers:', headers.join(', '));
  return null;
}

// Parses whatever date format NCUA actually uses (commonly MM/DD/YYYY per
// their own AIRES layout spec) into a normalized {iso, year} pair. Returns
// null on anything that doesn't parse cleanly rather than guessing.
function parseCharterDate(raw, mode = 'date') {
  if (!raw) return null;
  const s = String(raw).trim();
  if (mode === 'year') {
    // YEAR_OPENED is a bare year (e.g. "1987") -- no month/day precision
    // available, so iso stays null and only charterYear is usable.
    const y = s.match(/^(\d{4})$/);
    if (!y) return null;
    const year = parseInt(y[1], 10);
    if (year < 1900 || year > new Date().getFullYear()) return null; // sanity guard against garbage/placeholder values
    return { iso: null, year };
  }
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, mm, dd, yyyy] = mdy;
    return { iso: `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`, year: parseInt(yyyy, 10) };
  }
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    const [, yyyy, mm, dd] = ymd;
    return { iso: `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`, year: parseInt(yyyy, 10) };
  }
  const yyyymmdd = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmdd) {
    const [, yyyy, mm, dd] = yyyymmdd;
    return { iso: `${yyyy}-${mm}-${dd}`, year: parseInt(yyyy, 10) };
  }
  return null;
}

async function loadCUData() {
  if (cuCache && (Date.now() - cacheTimestamp) < CACHE_TTL) return cuCache;

  const zipBuf = await fetchBuffer(BULK_URL);

  // Parse FOICU.txt — profile data (name, city, state, type)
  const foicuBuf = extractFromZip(zipBuf, 'FOICU.txt');
  if (!foicuBuf) throw new Error('FOICU.txt not found');
  const profiles = parseCSVtoMap(foicuBuf, 'CU_NUMBER');

  // Detect the charter date field from the real header row rather than
  // assuming a name — see detectCharterDateField's comment for why.
  const foicuHeaderLine = foicuBuf.toString('latin1').split('\n')[0].replace('\r', '');
  const foicuHeaders = parseCSVLine(foicuHeaderLine);
  const charterDateField = detectCharterDateField(foicuHeaders);
  lastFoicuHeaders = foicuHeaders;
  lastZipFileList = listZipFiles(zipBuf);

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
      const charterDate = charterDateField ? parseCharterDate(p[charterDateField.field], charterDateField.mode) : null;
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
        charterDate: charterDate?.iso || null,
        charterYear: charterDate?.year || null,
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
  const newCharters = params.newCharters === '1';
  const year = params.year ? parseInt(params.year, 10) : null;
  const debug = params.debug === '1';

  // Debug mode: confirms whether the charter-date field was actually found
  // in this quarter's real FOICU.txt, rather than trusting the detection
  // silently. Check this after any NCUA data-file schema change (NCUA does
  // occasionally rename columns between reporting cycles).
  if (debug) {
    try {
      const allCUs = await loadCUData();
      const withDate = allCUs.filter(cu => cu.charterYear);
      const sample = withDate.slice(0, 5).map(cu => ({ name: cu.name, charterDate: cu.charterDate, charterYear: cu.charterYear }));
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          total_cus: allCUs.length,
          cus_with_charter_date: withDate.length,
          charter_date_field_detected: withDate.length > 0,
          sample,
          // Diagnostic: real column names and every file in the quarterly
          // ZIP, so a missing charter-date field can be reasoned about from
          // actual data rather than guessed a third time.
          foicu_headers: lastFoicuHeaders,
          zip_file_list: lastZipFileList,
        }),
      };
    } catch (e) {
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
    }
  }

  // New charters mode — mirrors get_recent_charters for FDIC banks. Only
  // returns real data if the charter-date field was actually detected in
  // this quarter's file (see detectCharterDateField) — if NCUA doesn't
  // expose it or renamed the column, this returns an honest empty result
  // with an explanatory note rather than fabricating dates.
  if (newCharters) {
    try {
      const allCUs = await loadCUData();
      const withDates = allCUs.filter(cu => cu.charterYear);
      if (!withDates.length) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            results: [], totalResultCount: 0,
            note: 'Charter date field not found in the current NCUA data file -- this feature needs a schema check, not necessarily zero new charters.',
          }),
        };
      }
      let pool = withDates;
      if (year) pool = pool.filter(cu => cu.charterYear === year);
      if (state) pool = pool.filter(cu => cu.state === state);
      pool.sort((a, b) => (b.charterDate || '').localeCompare(a.charterDate || ''));
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ results: pool.slice(0, limit), totalResultCount: pool.length }),
      };
    } catch (e) {
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: e.message, results: [], totalResultCount: 0 }) };
    }
  }

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
