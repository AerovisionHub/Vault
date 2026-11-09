# Search regression harness: real index.html search + live FDIC + NCUA proxy emulation.
# Serve the repo at http://127.0.0.1:8080 (SPA fallback to index.html) in the SAME shell call, then run this.
# The CU pool is SYNTHETIC but NCUA-shaped: names as FOICU stores them (charter suffix usually dropped), approximate assets — it reproduces ranking pressure, not NCUA data.
import asyncio, re, json, sys
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
CUS = [  # id, NCUA-style name (FOICU drops most charter suffixes, as real data does), city, state, assets($), charter type
 ('5536','NAVY FEDERAL CREDIT UNION','Vienna','VA',180e9,'Federal CU'),
 ('24694','AMERICA FIRST','Riverdale','UT',20e9,'Federal CU'),
 ('68534','AMERICAN AIRLINES','Fort Worth','TX',11e9,'Federal CU'),
 ('23279','MICHIGAN STATE UNIVERSITY','East Lansing','MI',8e9,'Federal CU'),
 ('19914','TINKER','Tinker AFB','OK',6e9,'Federal CU'),
 ('5621','AMERICAN HERITAGE','Philadelphia','PA',5e9,'Federal CU'),
 ('67712','AMERICAN EAGLE FINANCIAL','East Hartford','CT',2.3e9,'State CU'),
 ('61003','BANK-FUND STAFF','Washington','DC',1.5e9,'Federal CU'),
 ('66310','AMERICAN FIRST','La Habra','CA',1.2e9,'State CU'),
 ('7016','OKLAHOMA CENTRAL','Tulsa','OK',1.0e9,'State CU'),
 ('24051','HERITAGE','Newburgh','IN',0.9e9,'Federal CU'),
 ('2219','HERITAGE FAMILY','Rutland','VT',0.6e9,'State CU'),
 ('5302','HERITAGE FINANCIAL','Middletown','NY',0.4e9,'State CU'),
 ('61010','HERITAGE VALLEY','York','PA',0.3e9,'Federal CU'),
 ('9999','SAPULPA COMMUNITY','Sapulpa','OK',0.05e9,'State CU'),
]
def fz(q,t):  # port of functions/ncua.js fuzzyScore(query, target)
    q=q.lower(); t=t.lower()
    if t==q: return 100
    if t.startswith(q): return 90
    if q in t: return 80
    words=t.split(); ac=''.join(w[0] for w in words if w)
    if ac==q: return 85
    if ac.startswith(q): return 75
    qw=[w for w in q.split() if len(w)>1]; m=[w for w in qw if w in t]
    if qw and len(m)==len(qw): return 70
    if m: return 50+len(m)/len(qw)*20
    qi=0
    for ch in t:
        if qi<len(q) and ch==q[qi]: qi+=1
    if qi==len(q): return 30+int(len(q)/len(t)*20)
    return 0
TRADE_NAMES = {'23279': ['MSUFCU']}
async def ncua(route):
    # Same matching as functions/ncua.js: name or trade name (-3); numeric query hoists the exact charter.
    qs=parse_qs(urlparse(route.request.url).query); q=(qs.get('q',[''])[0]); st=qs.get('state',[None])[0]; lim=int(qs.get('limit',['20'])[0])
    pool=[c for c in CUS if not st or c[3]==st]
    def score(c): return max([fz(q,c[1])]+[fz(q,t)-3 for t in TRADE_NAMES.get(c[0],[])])
    sc=sorted([(score(c),c) for c in pool if score(c)>=30], key=lambda x:(-x[0],-x[1][4]))
    if q.isdigit():
        hit=[c for c in CUS if c[0]==q]
        if hit: sc=[(100,hit[0])]+sc
    res=[{'id':c[0],'name':c[1],'city':c[2],'state':c[3],'assets':c[4],'members':50000,'type':c[5],'tradeNames':TRADE_NAMES.get(c[0],[]),
          'loans':c[4]*0.7,'shares':c[4]*0.85,'netWorth':c[4]*0.105,'netWorthRatio':10.5,'netIncomeYtd':c[4]*0.004,'delinquentLoans':c[4]*0.7*0.006,'allowance':c[4]*0.7*0.012,
          'asOf':'2026-06-30'} for _,c in sc][:lim]
    await route.fulfill(status=200, content_type='application/json', body=json.dumps({'results':res,'totalResultCount':len(sc),'asOf':'2026-06-30'}))
CASES = [  # query, expected id, must be within top N
 ('American Heritage Bank','4190',1), ('American Heritage Oklahoma','4190',1), ('American Heritage OK','4190',1),
 ('American Heritage Sapulpa','4190',1), ('Heritage Sapulpa','4190',3), ('american heritage','4190',3),
 ('American Heritage Credit Union','5621',1),
 ('First Fidelity Bank','23473',5), ('Sutton Bank','5962',5), ('MidFirst Bank','4063',5), ('Triad Bank','24677',5),
 ('Citizens Bank','17211',5), ('Bank of the Plains','18118',5), ('Wells Fargo','3511',5),
 ('First National Bank Oklahoma','4211',5), ('First National Bank of Oklahoma','4211',1), ('JPMorgan Chase','628',5), ('Fidelity Bank','30895',5),
 ('Bank of Oklahoma','4214',1), ('bank of oklahoma','4214',1), ('Bank of Albuquerque','4214',1), ('Chase','628',1), ('Chase Manhattan','628',1), ('Bank of Texas','4214',3),
 ('Navy Federal Credit Union','5536',1), ('Heritage Valley Federal Credit Union','61010',1), ('Oklahoma Central Credit Union','7016',1),
 ('Legend Bank','3108',1), ('Legend Bank Bowie','3108',1), ('MSUFCU','23279',1), ('msufcu','23279',1), ('Navy Federal','5536',1), ('Tinker','19914',1),
]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); fails=0; rows=[]
        for q,exp,topn in CASES:
            pg=await b.new_page()
            await pg.route(re.compile(r'.*(googletagmanager|google-analytics|rss2json|vaultbot\.ai|cdnjs).*'), lambda r: r.abort())
            await pg.route(re.compile(r'.*/\.netlify/functions/ncua.*'), ncua)
            await pg.goto('http://127.0.0.1:8080/', wait_until='domcontentloaded'); await pg.wait_for_timeout(500)
            await pg.evaluate("q => performSearch(q)", q)
            res=await pg.evaluate("() => state.results.map(r => [String(r.id), r.name, r.state])")
            pos=next((i+1 for i,r in enumerate(res) if r[0]==exp), None); ok=pos is not None and pos<=topn; fails+= not ok
            rows.append(f"{'PASS' if ok else 'FAIL'} {q:34s} want #{exp:>5} in top {topn} -> {('#'+str(pos)) if pos else 'missing':8s} of {len(res):2d} | top: {res[0][1][:34] if res else '-'}")
            await pg.close(); await asyncio.sleep(0.4)
        print('\n'.join(rows)); print(f'\n{len(CASES)-fails}/{len(CASES)} passed'); await b.close()
if __name__=="__main__": asyncio.run(main())
