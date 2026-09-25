/** Presentation only: no requests, writes, filtering, or changes to updater state. */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Names are the canonical environment knobs, not internal parser properties. */
export function configEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : clean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
export function printConfig(brand: string, config: Record<string, any>): void {
  console.log(`[ config ] ${brand} updater:\n${configEntries(config).map(([key, value]) => `            ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE/i.test(key) ? '<redacted>' : clean(value)}`).join('\n')}`);
}
export function hasOutputFilters(config: Record<string, any>): boolean {
  return configEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
export function printFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, stable(value[key])]));
  return value;
}
export function contentKey(value: unknown): string { return JSON.stringify(stable(value)) ?? 'null'; }
export async function inspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = join(root instanceof URL ? fileURLToPath(root) : root, 'funds', ticker);
  const hash = createHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(join(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await readFile(join(path, entry.name), 'utf8').catch(() => '');
        hash.update(join(path.slice(dir.length), entry.name));
        try { hash.update(contentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await readFile(join(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const count = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const scalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
export function money(value: any): string {
  const raw = scalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return clean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
export function fundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  const detail = [
    `port=${clean(data.portId ?? data.portfolioId)}`,
    `history=${clean(count(data.history ?? data.historyCount))}`,
    `(official=${clean(data.officialHistoryCount)} yahoo=${clean(data.yahooHistoryCount)})`,
    `holdings=${clean(count(data.holdings ?? data.holdingsCount))}`,
    `divs=${clean(count(data.worksheets?.Distributions ?? data.distributions))}`,
    `netAssets=${money(data.netAssets ?? data.aum)}`,
    `total=${money(data.totalFundNetAssets ?? data.totalNetAssets)}`,
    `div=${clean(scalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield))}`,
    `sec=${clean(scalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield))}`,
    `wp=${clean(data.workplaceRaw)}`,
  ].join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${clean(ticker).padEnd(5)} ${status.padEnd(9)} ${detail}${reason ? ` reason=${clean(reason)}` : ''}`;
}
export function createReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => inspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await inspectFund(root, ticker);
      console.log(fundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
}
