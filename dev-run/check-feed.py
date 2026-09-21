#!/usr/bin/env python3
"""Feed sanity checker for api/proshares (run after a data refresh).

Reports empty/null cells, page-count mismatches, weight sums and provenance gaps
so the chunk report can quote exact numbers.
"""
import json
import os
import sys
from collections import Counter, defaultdict

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api', 'proshares')

index = json.load(open(os.path.join(ROOT, 'index.json')))
funds = index['funds']
print(f"funds={len(funds)} counts={index['counts']} generatedAt={index['generatedAt']}")

ENTRY_FIELDS = [
    'ticker', 'name', 'category', 'ter', 'terValue', 'terGross', 'terNet', 'nav', 'navValue',
    'aum', 'aumValue', 'asOfDate', 'inceptionDate', 'exchange', 'closePrice', 'closePriceValue',
    'premiumDiscount', 'premiumDiscountValue', 'distributionFrequency', 'holdings', 'history',
]
missing = defaultdict(list)
for f in funds:
    for field in ENTRY_FIELDS:
        value = f.get(field)
        if value is None or value == '' or value == '—':
            missing[field].append(f['ticker'])
print('\nempty index-entry cells (field -> funds, cap 12):')
for field in ENTRY_FIELDS:
    if missing[field]:
        print(f"  {field}: {len(missing[field])} {missing[field][:12]}")

print('\nmetric gaps (funds with null):')
for key in ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr10y', 'dividendYield', 'secYield']:
    n = [f['ticker'] for f in funds if f['metrics'].get(key) is None]
    print(f"  {key}: {len(n)} {n[:12]}")
print('\nmonth-end block gaps:')
for key in ['mo1', 'mo3', 'mo6', 'ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception']:
    n = [f['ticker'] for f in funds if f['returns']['monthEnd'].get(key) is None]
    print(f"  me.{key}: {len(n)} {n[:12]}")

print('\nreturns quarter-end missing:',
      sum(1 for f in funds if not f['returns']['quarterEnd'].get('asOfDate') or f['returns']['quarterEnd']['asOfDate'] == '—'))

# per-fund artifacts
problems = []
weight_sums = []
category_counter = Counter()
for f in funds:
    ticker = f['ticker']
    category_counter[f['category']] += 1
    meta_path = os.path.join(ROOT, 'funds', ticker, 'meta.json')
    if not os.path.exists(meta_path):
        problems.append(f"{ticker}: meta.json missing")
        continue
    meta = json.load(open(meta_path))
    for key in ['ticker', 'name', 'category', 'source', 'identifiers', 'expenseRatio', 'nav',
                'marketPrice', 'premiumDiscount', 'aum', 'yields', 'returns', 'distributions',
                'holdings', 'history', 'officialMetrics', 'documents']:
        if key not in meta:
            problems.append(f"{ticker}: meta.{key} missing")
    holdings = meta.get('holdings', {})
    pages = holdings.get('pages') or []
    rows_total = 0
    weight_sum = 0.0
    for page in pages:
        path = os.path.join(ROOT, 'funds', ticker, page.split('/')[-2], page.split('/')[-1])
        if not os.path.exists(path):
            problems.append(f"{ticker}: holdings page missing {path}")
            continue
        data = json.load(open(path))
        rows_total += len(data['rows'])
        for row in data['rows']:
            if row.get('Weight') not in (None, '', '—'):
                weight_sum += float(row['Weight'])
    if rows_total != holdings.get('totalRows'):
        problems.append(f"{ticker}: holdings totalRows {holdings.get('totalRows')} != pages {rows_total}")
    weight_sums.append((ticker, weight_sum))
    hist = meta.get('history', {})
    hrows = 0
    for page in hist.get('pages') or []:
        path = os.path.join(ROOT, 'funds', ticker, page.split('/')[-2], page.split('/')[-1])
        if not os.path.exists(path):
            problems.append(f"{ticker}: history page missing {path}")
            continue
        hrows += len(json.load(open(path))['rows'])
    if hrows != hist.get('totalRows'):
        problems.append(f"{ticker}: history totalRows {hist.get('totalRows')} != pages {hrows}")
    if hrows != f['history']:
        problems.append(f"{ticker}: index.history {f['history']} != pages {hrows}")
    if rows_total != f['holdings']:
        problems.append(f"{ticker}: index.holdings {f['holdings']} != pages {rows_total}")

print(f"\ncategories: {dict(category_counter)}")
print(f"problems: {len(problems)}")
for p in problems[:30]:
    print('  -', p)
lo = sorted(weight_sums, key=lambda item: item[1])[:6]
hi = sorted(weight_sums, key=lambda item: item[1])[-6:]
print('weight sums lowest:', [(t, round(w, 2)) for t, w in lo])
print('weight sums highest:', [(t, round(w, 2)) for t, w in hi])
out_of_range = [(t, round(w, 2)) for t, w in weight_sums if w and not (40 <= w <= 220)]
print('weight sums outside 40-220%:', len(out_of_range), out_of_range[:12])
sys.exit(1 if problems else 0)
