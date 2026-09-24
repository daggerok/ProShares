#!/usr/bin/env python3
"""Show short raw HTML excerpts around official ProShares distribution-yield fields.

Run locally with a saved product page, or from probe.yml (`/tmp/body` is the
just-fetched page). This is only diagnostic; the updater parses the page itself.
"""
from pathlib import Path
import re
import sys

html = Path(sys.argv[1]).read_text(encoding='utf-8', errors='replace')
print(f'HTML bytes: {len(html.encode("utf-8"))}')
pattern = re.compile(r'SEC\s*30[- ]Day\s*Yield|12-Month\s*Yield|Weighted Average Yield to|distributions-[\w-]*yield', re.I)
matches = list(pattern.finditer(html))
print(f'Yield mentions: {len(matches)}')
for match in matches[:14]:
    print(f'{match.start()}: {html[max(0, match.start()-240):match.end()+440]!r}')

# Ids are more useful than text when deciding which HTML element to parse.
ids = list(dict.fromkeys(re.findall(r'''\bid\s*=\s*["'](distributions-[^"']+)["']''', html, re.I)))
print(f'Distribution element ids: {ids[:30]}')
for element_id in ids[:16]:
    found = re.search(r'''\bid\s*=\s*["']''' + re.escape(element_id) + r'''["']''', html, re.I)
    if found:
        print(f'{element_id}: {html[max(0, found.start()-150):found.end()+240]!r}')
