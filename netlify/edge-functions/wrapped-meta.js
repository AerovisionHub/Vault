// Fixes the actual, confirmed root cause of "LinkedIn opens but doesn't
// create the post": the static index.html served for EVERY route
// (including /wrapped/{cert}) carries the SAME baked-in meta tags —
// og:url literally says "https://vaultbot.ai" (the homepage), not the
// real /wrapped/{cert} URL being shared. LinkedIn's crawler fetches the
// shared URL, reads a contradicting og:url inside the page, and — per
// multiple independently confirmed reports of this exact symptom with
// LinkedIn's share-offsite endpoint — can fail to populate the composer
// at all rather than just showing a generic preview.
//
// Client-side JS (setPageMeta in index.html) already updates these tags
// correctly for a real browser tab, but that's invisible to a
// non-JS-executing crawler bot, which only ever sees the raw HTML this
// function is rewriting.
//
// Deliberately uses plain string/regex replacement rather than the
// HTMLRewriter API some Netlify edge function examples use -- I could
// not fully confirm HTMLRewriter is available without an explicit import
// in this runtime without a live test, and getting that wrong would
// throw on every single /wrapped/* request (a much worse outcome than
// today, where at least the page loads). Plain string methods are
// guaranteed available in any JS runtime, and a non-matching regex
// silently no-ops rather than crashing -- worst case behavior is
// unchanged, not broken.
//
// Scope, deliberately kept small: this fixes the URL mismatch and adds a
// personalized TITLE/DESCRIPTION. It does NOT generate a personalized
// preview IMAGE -- that's a separate, larger effort (real server-side
// image rendering) and isn't needed to fix the reported bug, which was
// about the post failing to populate at all, not about the artwork.
export default async (request, context) => {
  const response = await context.next();

  const url = new URL(request.url);
  const match = url.pathname.match(/^\/wrapped\/(\d+)$/);
  if (!match) return response; // shouldn't happen given the config path below, but safe fallback

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response; // nothing to rewrite on a non-HTML response

  const cert = match[1];
  const canonicalUrl = `https://vaultbot.ai/wrapped/${cert}`;

  // Best-effort personalization, short timeout so a slow/failed FDIC call
  // never makes a real visitor wait on this. If it fails, the page still
  // gets the (much more important) URL fix below, just with a
  // generic-but-honest title instead of the bank's name.
  let title = 'Vault Wrapped — Bank Performance Report';
  let description = 'See how any U.S. bank or credit union stacks up against its peers — lending score, capital ratio, and growth, generated free from public FDIC data.';
  try {
    const fdicController = new AbortController();
    const fdicTimer = setTimeout(() => fdicController.abort(), 3000);
    const fdicResp = await fetch(
      `https://banks.data.fdic.gov/api/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP&limit=1`,
      { signal: fdicController.signal }
    );
    clearTimeout(fdicTimer);
    if (fdicResp.ok) {
      const fdicData = await fdicResp.json();
      const inst = fdicData?.data?.[0]?.data;
      if (inst?.NAME) {
        title = `${inst.NAME} — Vault Wrapped`;
        description = `See how ${inst.NAME} (${inst.CITY}, ${inst.STALP}) stacks up against its peers — lending score, capital ratio, and growth, generated free from public FDIC data.`;
      }
    }
  } catch (e) {
    // Fail soft -- generic title/description above already apply, and the
    // URL fix below still happens regardless.
  }

  // Escape a value for safe insertion inside an HTML attribute (double-quoted).
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const t = escAttr(title);
  const d = escAttr(description);
  const u = escAttr(canonicalUrl);

  let html = await response.text();

  // Each replacement targets the exact tag confirmed present in the
  // current source. A non-matching pattern just leaves that one tag
  // unchanged rather than throwing.
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`);
  html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`);
  html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);

  return new Response(html, {
    status: response.status,
    headers: response.headers,
  });
};

export const config = {
  path: '/wrapped/*',
};
