# Copy the shared relevance block verbatim from index.html into functions/mcp.js
import sys
ui=open('/home/claude/repo/index.html').read(); m=open('/home/claude/repo/functions/mcp.js').read()
def grab_fn(name):
    i=ui.index(f"function {name}("); k=ui.index('{',i); d=0
    for p in range(k,len(ui)):
        if ui[p]=='{': d+=1
        elif ui[p]=='}':
            d-=1
            if d==0: return ui[i:p+1]
def grab_const(name):
    i=ui.index(f"const {name} ="); j=ui.index(";\n",i); return ui[i:j+1]
names=['STATE_NAME_TO_CODE','VALID_STATE_CODES','fuzzyScore','SEARCH_STOP','SEARCH_COMMON','titleCase','parseSearchLocation','searchRelevance']
if 'FDIC_ALIAS_FIELDS' in ui: names+=['FDIC_ALIAS_FIELDS','institutionRelevance','fdicAliasUrls','cuRelevance']
parts=[grab_fn(n) if n[0].islower() else grab_const(n) for n in names]
hdr="// ── Search relevance — VERBATIM COPY of index.html (2026-11-09). Keep both in sync:\n// the website and the MCP must rank the same query the same way.\n"
END="// ── end of verbatim search block ──\n"
if hdr in m:
    s=m.index(hdr)
    e=m.index(END,s)+len(END) if END in m[s:] else m.index("// ── Credit unions in search_institutions", s)
else:
    s=e=m.index("async function searchInstitutions(args) {")
m=m[:s]+hdr+"\n\n".join(parts)+"\n"+END+"\n"+m[e:]
open('/home/claude/repo/functions/mcp.js','w').write(m); print('synced', len(names), 'pieces')
