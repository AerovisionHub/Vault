// Every SPA section route (/industry, /lenders, /charters, /ma, /compare) was
// served the same index.html, and therefore:
//   - the same <title> and meta description as the homepage
//   - <link rel="canonical" href="https://vaultbot.ai"> — pointing at the HOMEPAGE
//   - an <h1> of "Institution Comparison" regardless of the page
//
// The canonical is the damaging one. A canonical tag is a declaration that
// this URL is a duplicate of another, so Google was being told, on every one
// of these pages, to drop it and consolidate on the homepage. Unique titles
// would not have helped while that tag was still there.
//
// This gives each route its own metadata and a real crawlable intro. Same
// approach as institution-seo.js: plain string replacement, non-matching
// patterns no-op rather than throw, identical output for bots and humans.

const PAGES = {
  '/industry': {
    title: 'US Banking Industry Analytics — Charters, Branches & Deposit Trends | Vault',
    desc: 'Track US banking industry trends: bank and credit union charter counts, branch openings and closures, and total deposit growth over time, from FDIC and NCUA data. Free, no login.',
    h1: 'US Banking Industry Analytics',
    intro: 'Vault tracks structural change across the US banking industry using public FDIC and NCUA filings. Charter counts show how many institutions remain as consolidation continues, branch counts show the pace of physical footprint reduction, and deposit totals show where balances are concentrating. Each series is drawn from regulatory filings rather than survey data or estimates, and is annotated with the events that moved it. These are the aggregates behind individual bank performance: a bank losing deposit share in a growing market is a different story from one holding share in a shrinking one, and the industry view is what separates the two.',
  },
  '/lenders': {
    title: 'Find a Lender — Bank Lending Rankings by State & ZIP | Vault',
    desc: 'Rank US banks by lending activity using a composite score built from loan concentration and capital strength. Filter by state and ZIP code. Free FDIC data, no login.',
    h1: 'Find a Lender',
    intro: 'Find a Lender ranks FDIC-insured banks by a composite lending score combining loan concentration and capital strength, so the institutions most actively deploying capital into loans surface first. Results filter by state and by three-digit ZIP prefix, which matters because lending appetite is intensely local: a bank with a conservative national profile may be the most aggressive lender in one market. The score is computed from reported call report figures, not from advertised rates or marketing claims, so it reflects what a bank actually did rather than what it says it will do.',
  },
  '/charters': {
    title: 'New Bank Charters — De Novo Banks & Credit Unions | Vault',
    desc: 'Track newly chartered US banks and credit unions, with establishment dates, locations and related news. Free FDIC and NCUA charter data, updated continuously.',
    h1: 'New Bank and Credit Union Charters',
    intro: 'New charters are the clearest signal of where capital believes banking opportunity exists. Vault tracks de novo banks and newly chartered credit unions as they appear in FDIC and NCUA records, with establishment dates, headquarters locations and related news coverage for each. De novo formation nearly stopped after 2010 and has returned unevenly since, concentrated in specific states and specific business models. Watching which charters are granted, where, and by whom is a leading indicator of both regulatory posture and where founders see underserved markets.',
  },
  '/ma': {
    title: 'Bank Mergers & Acquisitions — US M&A Activity Tracker | Vault',
    desc: 'Track US bank mergers and acquisitions from FDIC records, including acquired-institution history. Search by acquirer or acquired bank. Free, no login.',
    h1: 'Bank Mergers and Acquisitions',
    intro: 'Vault tracks US bank merger and acquisition activity from FDIC institution history records, covering both surviving and acquired institutions. Searching an acquired bank by name returns its merger record rather than an empty result, which matters because an institution that no longer exists is often exactly the one being researched. Consolidation has reduced the number of US banks by more than half since the 1990s, and the pattern of who acquires whom, in which markets, and at what size is the clearest available map of where scale is being assembled.',
  },
  '/compare': {
    title: 'Compare Banks Side by Side — Peer Benchmarking Tool | Vault',
    desc: 'Compare any US banks or credit unions side by side on assets, deposits, loans, ROA, ROE and capital ratios. Benchmark against asset-range peers. Free FDIC and NCUA data.',
    h1: 'Compare Banks and Credit Unions',
    intro: 'Compare any combination of US banks and credit unions side by side on the metrics that determine financial condition: total assets, deposits, net loans, return on assets, return on equity, net interest margin and capital ratios. Comparison is most useful against asset-range peers rather than geographic neighbours, because a $400 million bank and a $40 billion bank face different capital rules, cost structures and competitive pressures regardless of whether they operate on the same street. Every figure comes from quarterly regulatory filings and can be exported to CSV or PDF.',
  },
  '/mcp': {
    title: 'Vault MCP Server — Free Bank Data for AI Agents | Vault',
    desc: 'Connect Claude, ChatGPT or any MCP client to free FDIC and NCUA bank data. 17 tools covering financials, deposit market share, demographics and HMDA lending. No sign-in.',
    h1: 'Vault MCP Server',
    intro: 'Vault runs a public Model Context Protocol server that gives AI agents direct access to US bank and credit union data with no authentication. It exposes tools for institution search, bank and credit union profiles, peer and industry metrics, lender rankings, asset quality, loan mix, brokered deposits, branch data, county deposit market share, county demographics from Census ACS, HMDA mortgage lending, leadership lookup, new charters and merger history. Agents get structured JSON with explicit source attribution and stated coverage limits, which is more reliable than scraping rendered pages.',
  },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default async (request, context) => {
  const response = await context.next();

  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;

  const url = new URL(request.url);
  const key = url.pathname.replace(/\/+$/, '') || '/';
  const page = PAGES[key];
  if (!page) return response;

  const t = esc(page.title);
  const d = esc(page.desc);
  const u = esc(`${url.origin}${key}`);

  let html = await response.text();

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`);
  html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`);
  // The fix that matters most: stop declaring the homepage as this page's
  // canonical, which was telling Google to drop every one of these routes.
  html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`);

  const block = `
<div id="seo-prerender">
  <h1>${esc(page.h1)}</h1>
  <p>${esc(page.intro)}</p>
</div>
<script>(function(){var e=document.getElementById('seo-prerender');if(e&&e.parentNode)e.parentNode.removeChild(e);})();</script>`;

  if (html.includes('<header>')) {
    html = html.replace('<header>', `${block}\n<header>`);
  } else {
    html = html.replace('</body>', `${block}\n</body>`);
  }

  const headers = new Headers(response.headers);
  headers.set('netlify-cdn-cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return new Response(html, { status: response.status, headers });
};

export const config = {
  path: ['/industry', '/lenders', '/charters', '/ma', '/compare', '/mcp'],
};
