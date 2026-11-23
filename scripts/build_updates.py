"""Builds /updates.html, the public archive of Vault newsletters.
Add a post to POSTS (newest first) after each send, then run:
    python3 scripts/build_updates.py
Only list emails that have actually gone out."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from site_chrome import page

POSTS = [
    {
        'date': '2026-11-11', 'label': 'November 11, 2026',
        'title': 'You’re one of Vault’s first 50',
        'html': '''<p>The first Vault newsletter went to the first 50 people who signed up for the Vault MCP. Lee recorded a <a href="https://www.loom.com/share/110ab19b41ac46f69c2caf90cb5d31c2" target="_blank" rel="noopener">1:44 video hello</a> on why Vault exists: free bank and credit union data, from public filings, shaped by the people who use it.</p>
<p>What was new:</p>
<ul>
<li><strong>Branch-level activity.</strong> Every branch and its deposits, with county market share.</li>
<li><strong>History that goes back decades, not two years.</strong> Call-report financials to 1992 and branch history to 1994.</li>
<li><strong>Credit unions in the MCP.</strong> Search now covers banks and credit unions, with a new credit union profile tool. 18 tools in total.</li>
</ul>
<p>The ask was simple: reply with the one thing you wish Vault did. Those replies are shaping what ships next, including a Microsoft Copilot listing that’s in progress.</p>''',
    },
]

posts = ''.join(f'''<article class="vds-post" id="{p['date']}"><time datetime="{p['date']}">{p['label']}</time><h2>{p['title']}</h2>{p['html']}</article>''' for p in POSTS)
body = f'''<section class="vds-hero"><div class="vds-wrap vds-narrow">
<nav class="vds-crumbs" aria-label="Breadcrumb"><a href="/">Vault</a><span aria-hidden="true">/</span><span>Updates</span></nav>
<h1>Vault updates</h1>
<p>What shipped, in the order it shipped. One short email when something new lands.</p>
<form id="nf" style="margin-top:24px;display:flex;gap:8px;flex-wrap:wrap;max-width:560px" novalidate>
<label for="ne" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Email</label>
<input id="ne" class="vds-filter" style="flex:1;min-width:220px;height:48px" type="email" placeholder="you@bank.com" autocomplete="email">
<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px">
<button class="vds-btn vds-btn--p vds-btn--lg" type="submit">Subscribe</button>
<span id="nm" role="status" style="flex-basis:100%;font-size:14px;color:#a3a8d4">We’ll send a confirmation link first. Unsubscribe anytime.</span>
</form>
</div></section>
<section class="vds-section vds-paper"><div class="vds-wrap vds-narrow">{posts}</div></section>
<script>
document.getElementById('nf').addEventListener('submit',async function(e){{
  e.preventDefault();var f=e.target,m=document.getElementById('nm'),em=document.getElementById('ne').value.trim(),b=f.querySelector('button');
  if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)){{m.style.color='#ff8a80';m.textContent='Enter a full email address.';return;}}
  b.disabled=true;m.style.color='#a3a8d4';m.textContent='Sending…';
  try{{var r=await fetch('/.netlify/functions/newsletter-signup',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{email:em,website:f.website.value,source:'updates'}})}});var d=await r.json().catch(function(){{return {{}}}});
    if(r.ok&&d.ok){{m.style.color='#5ee0a0';m.textContent='Check your inbox for a confirmation link.';f.reset();}}else{{m.style.color='#ff8a80';m.textContent=d.error||'That didn’t go through. Please try again.';}}
  }}catch(x){{m.style.color='#ff8a80';m.textContent='That didn’t go through. Please try again.';}}
  b.disabled=false;
}});
</script>'''
html = page('Vault Updates — What’s New in Vault', 'The archive of Vault newsletters: new bank and credit union data, MCP tools and features, in the order they shipped.',
            'https://vaultbot.ai/updates', body,
            jsonld={'@context': 'https://schema.org', '@type': 'Blog', 'name': 'Vault updates', 'url': 'https://vaultbot.ai/updates'})
open(os.path.join(os.path.dirname(__file__), '..', 'updates.html'), 'w').write(html)
print('wrote updates.html,', len(POSTS), 'post(s)')
