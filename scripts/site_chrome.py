"""Shared header/footer for Vault's static pages (Design System v1).

Single source for the build scripts in this folder. functions/hub.js and
functions/newsletter-signup.js carry byte-identical copies of HEADER/FOOTER
(Netlify would treat a shared module in functions/ as its own endpoint);
scripts/check_chrome.py fails if any copy drifts.
"""
MENU_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'
LINKS = '<a href="/">Search</a><a href="/industry">Industry</a><a href="/lenders">Lenders</a><a href="/counties">Counties</a><a href="/ma">M&amp;A</a><a href="/charters">New charters</a><a href="/about">About</a>'
HEADER = ('<header class="vds-h"><div class="vds-in"><a class="vds-logo" href="/">Vault<span>.</span></a>'
          '<nav class="vds-nav" aria-label="Main">' + LINKS + '</nav>'
          '<a class="vds-btn vds-btn--p vds-btn--sm" href="/mcp">Connect MCP</a>'
          '<details class="vds-menu"><summary aria-label="Menu">' + MENU_SVG + '</summary><div>' + LINKS + '<a href="/mcp">Connect MCP</a></div></details>'
          '</div></header>')
FOOTER = '<footer class="v-footer-wrap"><div class="v-foot"><div class="v-foot-top"><div class="v-foot-brand"><a href="/" class="vds-logo">Vault<span>.</span></a><span>Free bank and credit union intelligence from public FDIC, NCUA, HMDA and Census data.</span></div><nav class="v-foot-cols" aria-label="Footer"><div><b>Explore</b><a href="/">Search</a><a href="/industry">Industry</a><a href="/lenders">Find a lender</a><a href="/counties">County markets</a><a href="/ma">M&amp;A</a><a href="/charters">New charters</a></div><div><b>MCP</b><a href="/mcp/setup">Connect</a><a href="/mcp">All 18 tools</a><a href="/mcp/stats">Usage stats</a></div><div><b>Vault</b><a href="/about">About</a><a href="/updates">Updates</a><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></nav></div><div class="v-foot-legal"><span>Data: FDIC BankFind, FDIC Summary of Deposits, NCUA 5300, CFPB HMDA, U.S. Census.</span><span>© 2026 Built by <a href="https://goidentify.com" target="_blank" rel="noopener">iDENTIFY</a> in Tulsa, OK.</span></div></div></footer>'

def esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

def page(title, desc, canonical, body, extra_head='', jsonld=None):
    import json
    ld = f'<script type="application/ld+json">{json.dumps(jsonld)}</script>\n' if jsonld else ''
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{esc(canonical)}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:image" content="https://vaultbot.ai/og-image.png?v=4">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0f1240">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/vault-ds.css">
{ld}{extra_head}</head>
<body>
{HEADER}
{body}
{FOOTER}
</body>
</html>
'''
