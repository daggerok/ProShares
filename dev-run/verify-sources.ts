/**
 * TEMPORARY verification script (dev only, deleted before delivery).
 *
 * Compares the generated feed against the live ProShares fund pages:
 *  - the "Exposure Weight" column of the rendered holdings table vs the Weight
 *    the updater wrote for the same position;
 *  - the published expense-ratio text (footnote markers) and distribution
 *    frequency block;
 *  - the official performance file's blank tenors for the youngest funds.
 *
 * Run by .github/workflows/verify.yml and reported in dev-run/verify-report.txt.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://www.proshares.com';
const SAMPLE: Array<[string, string]> = [
  ['NOBL', 'strategic'],
  ['TQQQ', 'leveraged-and-inverse'],
  ['AGQ', 'leveraged-and-inverse'],
  ['IGHG', 'strategic'],
  ['SH', 'leveraged-and-inverse'],
  ['SMDD', 'leveraged-and-inverse'],
  ['RINF', 'strategic'],
  ['BITO', 'strategic'],
  ['UCO', 'leveraged-and-inverse'],
  ['TOLZ', 'strategic'],
  ['EZJ', 'leveraged-and-inverse'],
  ['SPCF', 'strategic'],
  ['ACQQ', 'leveraged-and-inverse'],
];

const lines: string[] = [];
const log = (line = '') => lines.push(line);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const clean = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

async function get(url: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; ProShares-feed-verifier)' } });
    if (response.ok) return response.text();
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(`fetch failed: ${url}`);
}

type Cell = { weight: number | null; name: string; value: string };

function renderedHoldings(html: string): Cell[] {
  const start = html.indexOf('id="holdings"');
  if (start < 0) return [];
  const table = html.slice(start, html.indexOf('</table>', start));
  const headerRow = /<thead[\s\S]*?<\/thead>/i.exec(table)?.[0] || '';
  const headers = [...headerRow.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => clean(match[1]).toLowerCase());
  const weightColumn = headers.findIndex(header => header.includes('exposure weight'));
  const descriptionColumn = headers.findIndex(header => header.includes('description'));
  const cells: Cell[] = [];
  for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cellsHtml = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => clean(match[1]));
    if (cellsHtml.length < 3) continue;
    const weightText = cellsHtml[weightColumn >= 0 ? weightColumn : 0];
    const weight = weightText.includes('%') ? Number(weightText.replace(/[^\d.-]/g, '')) : null;
    cells.push({
      weight: Number.isFinite(weight) ? weight : null,
      name: cellsHtml[descriptionColumn >= 0 ? descriptionColumn : 2],
      value: weightText,
    });
  }
  return cells;
}

async function feedRows(ticker: string): Promise<Cell[]> {
  const directory = path.join('api', 'proshares', 'funds', ticker, 'holdings');
  let pages: string[] = [];
  try {
    pages = await readdir(directory);
  } catch {
    return [];
  }
  const rows: Cell[] = [];
  for (const page of pages.sort()) {
    const data = JSON.parse(await readFile(path.join(directory, page), 'utf8'));
    for (const row of data.rows) {
      const weight = String(row.Weight ?? '').includes('—') || row.Weight === '' ? null : Number(row.Weight);
      rows.push({ weight: Number.isFinite(weight) ? (weight as number) : null, name: String(row.Name || ''), value: String(row.Weight ?? '') });
    }
  }
  return rows;
}

const normalize = (name: string) => name.replace(/[^A-Z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

for (const [ticker, audience] of SAMPLE) {
  const url = `${SITE}/our-etfs/${audience === 'strategic' ? 'strategic' : 'leveraged-and-inverse'}/${ticker.toLowerCase()}`;
  log(`=== ${ticker} (${url})`);
  let html = '';
  try {
    html = await get(url);
  } catch (error) {
    log(`  FETCH FAILED: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  await sleep(1200);

  const rendered = renderedHoldings(html);
  const feed = await feedRows(ticker);
  const feedByName = new Map(feed.map(row => [normalize(row.name), row]));
  let matched = 0;
  let mismatched = 0;
  const examples: string[] = [];
  for (const row of rendered) {
    const ours = feedByName.get(normalize(row.name));
    if (!ours) continue;
    const mine = ours.weight === null ? null : Number(ours.weight);
    const theirs = row.weight === null ? null : Number(row.weight);
    if (mine === null && theirs === null) {
      matched++;
      continue;
    }
    if (mine !== null && theirs !== null && Math.abs(mine - theirs) < 0.005) {
      matched++;
      continue;
    }
    mismatched++;
    if (examples.length < 5) {
      examples.push(`    ${row.name.slice(0, 34)}: page ${row.value || '—'} vs feed ${ours.value || '—'}`);
    }
  }
  log(`  rendered rows ${rendered.length} · feed rows ${feed.length} · matched ${matched} · mismatched ${mismatched}`);
  for (const example of examples) log(example);

  const gross = /Gross Expense Ratio[\s\S]{0,200}?about-fund__list-value[^>]*>([^<]*)</i.exec(html);
  const net = /Net Expense Ratio[\s\S]{0,200}?about-fund__list-value[^>]*>([^<]*)</i.exec(html);
  const single = /id="snapshot-expenseRatio"[^>]*>([^<]*)</i.exec(html);
  const frequency = /id="snapshot-distributions"[^>]*>([^<]*)</i.exec(html)
    || /id="distributions-distributionFrequency"[^>]*>([^<]*)</i.exec(html);
  log(`  expense ratio: gross ${gross ? clean(gross[1]) : '—'} / net ${net ? clean(net[1]) : '—'} / single ${single ? clean(single[1]) : '—'}`);
  const footnoteIndex = html.search(/expense ratio[\s\S]{0,400}?\*/i);
  if (footnoteIndex >= 0) {
    const footnote = clean(html.slice(footnoteIndex, footnoteIndex + 600));
    log(`  footnote context: ${footnote.slice(0, 220)}`);
  }
  log(`  frequency block: ${frequency ? clean(frequency[1]) : '—'}`);
  const yieldText = /id="distributions-12MonthYield"[^>]*>([^<]*)</i.exec(html);
  log(`  12-month yield block: ${yieldText ? clean(yieldText[1]) : '— (element absent)'}`);
  log();
}

log('=== official performance file: blank tenors for the youngest funds');
const performance = await get('https://accounts.profunds.com/etfdata/etf_performance.csv');
const header = performance.split(/\r?\n/, 1)[0];
log(`  header: ${header}`);
for (const line of performance.split(/\r?\n/)) {
  if (/^(Name|Fund Name),/.test(line)) continue;
  if (/,(ACQQ|ACRT|ACSP|SPCF|EQQQ|SKHU),/.test(line) && /,NAV,MONTH,/.test(line)) log(`  ${line}`);
}

await writeFile('dev-run/verify-report.txt', `${lines.join('\n')}\n`, 'utf8');
console.log(lines.join('\n'));
