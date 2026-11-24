# Builder for the homepage feature-card previews (V_MINI in index.html).
# Edit the data here, run build() with the live CSS vars, and paste the JSON into V_MINI.
# Mini previews for the 6 homepage feature cards. Real data, pulled 2026-11-24:
# FDIC call reports (Q2 2026), FDIC SOD, Vault MCP get_lender_rankings / get_ma_activity / get_recent_charters.
QA=[1708249,1679821,1772002,1896162,1945151,1971682,2072897,2241430]
SOD=[2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,4,4,3,3,3,3,4,4,4,5,5,5,6,6,7,6,6,7]
def build(V):
    # V maps role -> CSS var expression
    ink, sub, viz, viz2, track, panel = V['ink'], V['sub'], V['viz'], V['viz2'], V['track'], V['panel']
    def head(big, cap):
        return (f'<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px">'
                f'<b style="font:600 16px/20px Inter,sans-serif;color:{ink};font-variant-numeric:tabular-nums;white-space:nowrap">{big}</b>'
                f'<span style="font:400 12px/16px Inter,sans-serif;color:{sub};text-align:right;white-space:nowrap">{cap}</span></div>')
    def wrap(inner): return f'<div aria-hidden="true" style="background:{panel};border-radius:8px;padding:12px 14px;height:128px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between">{inner}</div>'
    def rows(items, mx, fmt):
        out=''
        for name,val,hl in items:
            out+=(f'<div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 40px;align-items:center;gap:8px;font:400 12px/16px Inter,sans-serif;color:{sub}">'
                  f'<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;{"color:"+ink+";font-weight:600" if hl else ""}">{name}</span>'
                  f'<span style="height:6px;border-radius:999px;background:{track};overflow:hidden;display:block"><span style="display:block;height:100%;width:{val/mx*100:.0f}%;border-radius:999px;background:{viz if hl else viz2}"></span></span>'
                  f'<span style="text-align:right;font-variant-numeric:tabular-nums;color:{ink}">{fmt(val)}</span></div>')
        return f'<div style="display:flex;flex-direction:column;gap:6px">{out}</div>'
    def cols(items, mx, h=34):
        bars=''.join(f'<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px"><span style="font:600 11px/14px Inter,sans-serif;color:{ink};font-variant-numeric:tabular-nums">{v}</span>'
                     f'<span style="width:100%;max-width:28px;height:{max(4,round(v/mx*h))}px;border-radius:3px 3px 0 0;background:{viz if last else viz2}"></span>'
                     f'<span style="font:400 11px/14px Inter,sans-serif;color:{sub}">{lab}</span></div>' for lab,v,last in items)
        return f'<div style="display:flex;align-items:flex-end;gap:10px;height:{h+36}px">{bars}</div>'
    # 1 sparkline (SVG, stretched; non-scaling stroke)
    lo,hi=1500000,2300000
    pts=' '.join(f'{i/7*100:.1f},{40-(v-lo)/(hi-lo)*40:.1f}' for i,v in enumerate(QA))
    spark=(f'<svg viewBox="0 0 100 40" preserveAspectRatio="none" style="width:100%;height:44px;display:block">'
           f'<polygon points="0,40 {pts} 100,40" style="fill:{viz};opacity:.14"/>'
           f'<polyline points="{pts}" fill="none" style="stroke:{viz};stroke-width:2" vector-effect="non-scaling-stroke"/></svg>')
    m1=wrap(head('$2.24B','Regent Bank assets, +31%')+spark)
    m2=wrap(head('Net interest margin','Tulsa area, Q2 2026')+rows([('Regent',4.38,True),('Arvest',4.06,False),('BOKF',2.92,False)],4.5,lambda v:f'{v:.2f}%'))
    br=''.join(f'<span style="flex:1;height:{c/7*40:.0f}px;border-radius:2px 2px 0 0;background:{viz if i==len(SOD)-1 else viz2}"></span>' for i,c in enumerate(SOD))
    m3=wrap(head('2 → 7 branches','Regent Bank, 1994 → 2026')+f'<div style="display:flex;align-items:flex-end;gap:2px;height:44px">{br}</div>')
    m4=wrap(head('Lending score','Oklahoma, commercial')+rows([('FNB Broken Arrow',87.6,True),('First Bank Owasso',84.1,False),('Bank of Hydro',83.6,False)],100,lambda v:f'{v:.1f}'))
    m5=wrap(head('112 deals','Bank M&amp;A, 2026 to date')+cols([('2023',69,False),('2024',59,False),('2025',108,False),('2026',112,True)],112))
    m6=wrap(head('9 new banks','De novo charters, 2026')+cols([('2023',6,False),('2024',6,False),('2025',4,False),('2026',9,True)],9))
    return [m1,m2,m3,m4,m5,m6]
