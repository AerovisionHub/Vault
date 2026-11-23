"""Fails if the header/footer copies in functions/ drift from scripts/site_chrome.py."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from site_chrome import HEADER, FOOTER
root = os.path.join(os.path.dirname(__file__), '..')
bad = 0
for f in ('functions/hub.js', 'functions/newsletter-signup.js'):
    src = open(os.path.join(root, f)).read()
    for name, val in (('HEADER', HEADER), ('FOOTER', FOOTER)):
        if f"const {name} = '{val}';" not in src:
            print('DRIFT', f, name); bad += 1
print('chrome copies in sync' if not bad else f'{bad} drifted'); sys.exit(1 if bad else 0)
