# Search regression harness: real index.html search + live FDIC + NCUA proxy emulation.
# Serve the repo at http://127.0.0.1:8080 (SPA fallback to index.html) in the SAME shell call, then run this.
# The CU pool is SYNTHETIC (real CU names, approximate assets) — it reproduces ranking pressure, not NCUA data.
import asyncio, re, json, sys
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
CUS = [  # id, name, city, state, assets($)
 ('5536','Navy Federal Credit Union','Vienna','VA',180e9),
 ('24694','America First Federal Credit Union','Riverdale','UT',20e9),
 ('68534','American Airlines Federal Credit Union','Fort Worth','TX',11e9),
 ('65428','Michigan State University Federal Credit Union','East Lansing','MI',8e9),
 ('19914','Tinker Federal Credit Union','Tinker AFB','OK',6e9),
 ('60431','American Heritage Federal Credit Union','Philadelphia','PA',5e9),
 ('67712','American Eagle Financial Credit Union','East Hartford','CT',2.3e9),
 ('61003','Bank-Fund Staff Federal Credit Union','Washington','DC',1.5e9),
 ('66310','American First Credit Union','La Habra','CA',1.2e9),
 ('7016','Oklahoma Central Credit Union','Tulsa','OK',1.0e9),
 ('24051','Heritage Federal Credit Union','Newburgh','IN',0.9e9),
 ('2219','Heritage Family Credit Union','Rutland','VT',0.6e9),
 ('5302','Heritage Financial Credit Union','Middletown','NY',0.4e9),
 ('61010','Heritage Valley Federal Credit Union','York','PA',0.3e9),
 ('9999','Sapulpa Community Credit Union','Sapulpa','OK',0.05e9),
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
async def ncua(route):
    qs=parse_qs(urlparse(route.request.url).query); q=(qs.get('q',[''])[0]); st=qs.get('state',[None])[0]; lim=int(qs.get('limit',['20'])[0])
    pool=[c for c in CUS if not st or c[3]==st]
    sc=sorted([(fz(q,c[1]),c) for c in pool if fz(q,c[1])>=30], key=lambda x:(-x[0],-x[1][4]))
    res=[{'id':c[0],'name':c[1],'city':c[2],'state':c[3],'assets':c[4],'members':0,'type':'FCU'} for _,c in sc][:lim]
    await route.fulfill(status=200, content_type='application/json', body=json.dumps({'results':res,'totalResultCount':len(sc)}))
CASES = [  # query, expected id, must be within top N
 ('American Heritage Bank','4190',1), ('American Heritage Oklahoma','4190',1), ('American Heritage OK','4190',1),
 ('American Heritage Sapulpa','4190',1), ('Heritage Sapulpa','4190',3), ('american heritage','4190',3),
 ('American Heritage Credit Union','60431',1),
 ('First Fidelity Bank','23473',5), ('Sutton Bank','5962',5), ('MidFirst Bank','4063',5), ('Triad Bank','24677',5),
 ('Citizens Bank','17211',5), ('Bank of the Plains','18118',5), ('Wells Fargo','3511',5),
 ('First National Bank Oklahoma','4211',5), ('First National Bank of Oklahoma','4211',1), ('JPMorgan Chase','628',5), ('Fidelity Bank','30895',5),
 ('Legend Bank','3108',1), ('Legend Bank Bowie','3108',1), ('MSUFCU','65428',1), ('Navy Federal','5536',1), ('Tinker','19914',1),
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
