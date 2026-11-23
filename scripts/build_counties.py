"""Builds /counties.html: every U.S. county with at least one bank branch,
grouped by state, each linking to its county hub (/banks-in-{county}-county-{st}).

Run yearly after the FDIC Summary of Deposits refresh (June data lands ~Sept):
    python3 scripts/build_counties.py
One FDIC call (SOD aggregated by county FIPS). Slugs use the same rule as
functions/hub.js (lowercase, runs of non-alphanumerics -> "-"), so every link
resolves to a real hub page. The page is static on purpose: ~3,200 crawlable
links that give every county hub an internal path, with no runtime FDIC load.
"""
import json, re, sys, urllib.request, collections, os
sys.path.insert(0, os.path.dirname(__file__))
from site_chrome import page, esc

STATES = {'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California','CO':'Colorado','CT':'Connecticut','DE':'Delaware','DC':'District of Columbia','FL':'Florida','GA':'Georgia','HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa','KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming','PR':'Puerto Rico'}
YEAR = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
url = f'https://api.fdic.gov/banks/sod?filters=YEAR:{YEAR}&agg_by=STCNTYBR&agg_term_fields=CNTYNAMB,STALPBR&agg_sum_fields=DEPSUMBR&agg_limit=10000&limit=0'
rows = json.load(urllib.request.urlopen(url, timeout=60))['data']
by_state = collections.defaultdict(list)
for r in rows:
    d = r['data']
    name = next((k[len('count_CNTYNAMB_'):] for k in d if k.startswith('count_CNTYNAMB_')), None)
    st = next((k[len('count_STALPBR_'):] for k in d if k.startswith('count_STALPBR_')), None)
    if not name or st not in STATES: continue
    slug = re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', name.lower()))
    by_state[st].append((name, slug, d.get('count', 0), d.get('sum_DEPSUMBR', 0)))
total = sum(len(v) for v in by_state.values())
assert total > 3000, f'only {total} counties — FDIC response looks wrong, not writing'

def money(k):
    v = k * 1000
    return f'${v/1e9:.1f}B' if v >= 1e9 else f'${v/1e6:.0f}M'

blocks = []
index = []
for st in sorted(by_state, key=lambda a: STATES[a]):
    cs = sorted(by_state[st])
    lis = ''.join(f'<li><a href="/banks-in-{c[1]}-county-{st.lower()}" data-s="{st}" data-m="{c[2]} branches · {money(c[3])}">{esc(c[0])}</a></li>' for c in cs)
    stslug = STATES[st].lower().replace(' ', '-')
    blocks.append(f'<details class="vds-state" id="{st.lower()}"><summary><h2>{esc(STATES[st])}</h2><span>{len(cs)} {'county' if len(cs) == 1 else 'counties'}</span></summary>'
                  f'<ul><li><a href="/banks-in-{stslug}"><strong>All banks in {esc(STATES[st])}</strong></a></li>{lis}</ul></details>')

body = f'''<section class="vds-hero"><div class="vds-wrap">
<nav class="vds-crumbs" aria-label="Breadcrumb"><a href="/">Vault</a><span aria-hidden="true">/</span><span>County markets</span></nav>
<h1>Pick your county</h1>
<p>See every bank with a branch in your county: deposit market share, who’s gaining or losing share, branch counts and four years of trend, from FDIC Summary of Deposits filings. {total:,} counties across all 50 states, DC and Puerto Rico.</p>
<div style="margin-top:24px"><label for="cf" class="vds-caption" style="display:block;margin-bottom:8px;color:#b9bddb">Find a county</label>
<input id="cf" class="vds-filter" type="search" placeholder="Type a county, e.g. Tulsa or Davidson" autocomplete="off">
<div class="vds-hits" id="hits" role="list"></div></div>
</div></section>
<section class="vds-section vds-paper"><div class="vds-wrap">
<h2>Browse by state</h2>
<div class="vds-states">{''.join(blocks)}</div>
<p class="vds-caption" style="margin-top:24px">Source: FDIC Summary of Deposits, June 30, {YEAR}. Counties listed have at least one FDIC-insured bank branch.</p>
</div></section>
<script>
(function(){{
  var I=[].map.call(document.querySelectorAll('.vds-state a[data-s]'),function(a){{return [a.textContent,a.dataset.s,a.getAttribute('href'),a.dataset.m];}});
  var f=document.getElementById('cf'), h=document.getElementById('hits');
  function norm(s){{return s.toLowerCase().replace(/\\s+county$/,'').trim();}}
  function show(){{
    var q=norm(f.value); h.innerHTML='';
    if(q.length<2) return;
    var m=I.filter(function(c){{return c[0].toLowerCase().indexOf(q)===0;}}).concat(I.filter(function(c){{var n=c[0].toLowerCase();return n.indexOf(q)>0;}})).slice(0,8);
    m.forEach(function(c){{var a=document.createElement('a');a.href=c[2];a.setAttribute('role','listitem');a.textContent=c[0]+' County, '+c[1];var s=document.createElement('span');s.textContent=c[3];a.appendChild(s);h.appendChild(a);}});
    if(!m.length){{var p=document.createElement('div');p.className='vds-caption';p.style.color='#b9bddb';p.textContent='No county with a bank branch matches that name.';h.appendChild(p);}}
  }}
  f.addEventListener('input',show);
  f.addEventListener('keydown',function(e){{if(e.key==='Enter'){{var a=h.querySelector('a');if(a)location.href=a.href;}}}});
}})();
</script>'''
html = page('Banks by County — Deposit Market Share for Every U.S. County | Vault',
            f'Pick any U.S. county to see every bank with a branch there, deposit market share, branch counts and trends from FDIC data. {total:,} counties, free.',
            'https://vaultbot.ai/counties', body,
            jsonld={'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Banks by county', 'url': 'https://vaultbot.ai/counties'})
out = os.path.join(os.path.dirname(__file__), '..', 'counties.html')
open(out, 'w').write(html)
print(f'wrote counties.html: {total} counties, {len(by_state)} states, {len(html)//1024} KB')
