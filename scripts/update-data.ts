#!/usr/bin/env bun
/// <reference types="bun" />
// Control defaults live in scripts/update-data.config.json; see resolveControls() and runtimeControls().
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

/**
 * @file ProShares static feed updater.
 *
 * Zero runtime dependencies: `node:fs/promises` + global `fetch` only, run with
 * Bun. Writes the deterministic `api/proshares/**` tree the browser app reads.
 *
 * Source ladder (see README "Data sources"):
 *   (a) official finder pages ........................ fund universe, name,
 *       /our-etfs/find-proshares-etfs ................ asset class, marketing
 *       /our-etfs/find-leveraged-and-inverse-etfs .... category, geared
 *                                                      strategy, index
 *   (b) official fund page ........................... CUSIP, expense ratio,
 *                                                      NAV, market price, 12M
 *                                                      yield, declared
 *                                                      frequency, exposures,
 *                                                      characteristics
 *   (c) official daily holdings file ................. every position of every
 *       accounts.profunds.com/etfdata/psdlyhld.csv     fund (SEDOL ids)
 *   (d) official NAV history file .................... daily NAV, shares
 *       …/ByFund/<TICKER>-historical_nav.csv           outstanding, net assets
 *   (e) official performance file .................... NAV + market price total
 *       …/etfdata/etf_performance.csv                  returns, month- and
 *                                                      quarter-end
 *   (f) official splits file ......................... split history (the
 *       …/etfdata/etf_splits.csv                       published NAV history is
 *                                                      not split-adjusted)
 *   (g) official distribution summary JSON ........... full distribution history
 *       /api/distributionsummary?fund=T&year=YYYY
 *   (h) Nasdaq Trader symbol directory ............... listing exchange
 *                                                      (Overview only)
 *
 * Every block is official and machine readable; there is no scraping of
 * documents, no headless browser and no third-party data vendor. A source that
 * fails leaves the previously published files untouched, so a partial run can
 * never empty the site.
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.join(REPO_ROOT, 'api', 'proshares');

export const PROSHARES_SITE = 'https://www.proshares.com';
export const PROSHARES_DATA_HOST = 'https://accounts.profunds.com/etfdata';
export const STRATEGIC_FINDER_URL = `${PROSHARES_SITE}/our-etfs/find-proshares-etfs`;
export const GEARED_FINDER_URL = `${PROSHARES_SITE}/our-etfs/find-leveraged-and-inverse-etfs`;
export const HOLDINGS_ALL_URL = `${PROSHARES_DATA_HOST}/psdlyhld.csv`;
export const NAV_HISTORY_ALL_URL = `${PROSHARES_DATA_HOST}/historical_nav.csv`;
export const PERFORMANCE_URL = `${PROSHARES_DATA_HOST}/etf_performance.csv`;
export const SPLITS_URL = `${PROSHARES_DATA_HOST}/etf_splits.csv`;
export const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
export const NASDAQ_OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';
export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Text, number and date helpers (shared semantics with the sibling updaters)
// ---------------------------------------------------------------------------

export function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#039;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&reg;': '®',
  '&trade;': '™',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&deg;': '°',
};

export function decodeEntities(value: string): string {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-zA-Z#0-9]+;/g, entity => ENTITIES[entity.toLowerCase()] ?? entity);
}

export function stripTags(fragment: string): string {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Stored fund/security names keep no ® / ™ trailers and collapse whitespace. */
export function normalizeName(value: unknown): string {
  return cleanText(value).replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
}

/** "2.97E8" -> "297057744"; provider placeholders ("--", "N/A") -> "". */
export function normalizeNumberText(value: unknown): string {
  const text = cleanText(value).replace(/[$,%]/g, '').replace(/^\+/, '');
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (['-', '--', '—', '–', 'n/a', 'na', 'none', 'null', 'nan'].includes(lowered)) return '';
  if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) {
    const numeric = Number(text);
    // Provider denormal sentinels (SSGA-style 5e-324) are noise, not values.
    if (!Number.isFinite(numeric) || (numeric !== 0 && Math.abs(numeric) < 1e-290)) return '';
    return numeric.toFixed(0);
  }
  return text;
}

export function numberOrNull(value: unknown): number | null {
  const text = normalizeNumberText(value).replace(/,/g, '');
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  // Provider denormal sentinels (SSGA-style) are noise, not measurements.
  if (parsed !== 0 && Math.abs(parsed) < 1e-290) return null;
  return parsed;
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatPercentText(value: number | null, digits = 2): string {
  return value === null || value === undefined ? '—' : `${round(value, digits).toFixed(digits)}%`;
}

export function formatMoneyText(value: number | null): string {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${round(value / 1e12, 2).toFixed(2)}T`;
  if (abs >= 1e9) return `$${round(value / 1e9, 2).toFixed(2)}B`;
  if (abs >= 1e6) return `$${round(value / 1e6, 2).toFixed(2)}M`;
  return `$${round(value, 2).toFixed(2)}`;
}

export function formatAumDisplay(value: number | null): string {
  if (value === null || value === undefined) return '—';
  if (Math.abs(value) >= 1e9) return `$${round(value / 1e9, 2).toFixed(2)} B`;
  return `$${round(value / 1e6, 2).toFixed(2)} M`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_INDEX: Record<string, number> = MONTHS.reduce((acc, month, index) => {
  acc[month.toLowerCase()] = index + 1;
  return acc;
}, {} as Record<string, number>);

/** US "9/18/2026" or "09/18/2026" -> "Sep 18 2026" (the shared display format). */
export function formatUsDate(raw: unknown): string {
  const text = cleanText(raw);
  // The finder pages print 10/09/2013, the fund pages 10/9/13.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (us) {
    const month = MONTHS[Number(us[1]) - 1];
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    if (month) return `${month} ${us[2].padStart(2, '0')} ${year}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const month = MONTHS[Number(iso[2]) - 1];
    if (month) return `${month} ${iso[3]} ${iso[1]}`;
  }
  const dashed = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (dashed) {
    const month = MONTHS[MONTH_INDEX[dashed[2].toLowerCase()] - 1];
    if (month) return `${month} ${dashed[1].padStart(2, '0')} ${dashed[3]}`;
  }
  return text || '—';
}

/** Any accepted date form -> "YYYY-MM-DD", for sorting and provenance. */
export function toIsoDate(raw: unknown): string {
  const text = cleanText(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  // "Sep 18 2026" (the shared display format the feed stores) and other calendar texts, never through the local time zone.
  return calendarIso(text) ?? text;
}

/** Epoch milliseconds of a calendar date (UTC midnight, shared calendar-dates block), NaN when the text is no date. */
export function calendarEpoch(raw: unknown): number {
  const iso = calendarIso(raw);
  return iso ? Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : NaN;
}

/** Sorts "Sep 18 2026"-style display dates chronologically. */
export function compareDisplayDates(a: string, b: string): number {
  return calendarEpoch(a) - calendarEpoch(b);
}

/** ProShares security names are published upper-case; keep them as published. */
export function normalizeSecurityName(value: unknown): string {
  return cleanText(value).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// CSV reader (quotes, CRLF, BOM, preamble) — same semantics as the siblings
// ---------------------------------------------------------------------------

export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let current = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    if (char === '\n') {
      cells.push(current.trim());
      records.push(cells);
      cells = [];
      current = '';
      continue;
    }
    if (char === '\r') continue;
    current += char;
  }
  cells.push(current.trim());
  records.push(cells);
  return records.filter(record => record.some(cell => cell !== ''));
}

export function parseCsvLine(text: string): string[] {
  return parseCsvRecords(String(text ?? '').replace(/\r?\n/g, ' '))[0] || [];
}

/** Maps a header row onto column indexes with normalized (punctuation-free) names. */
export function headerIndex(header: string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((cell, index) => {
    const key = cleanText(cell).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

export function cellAt(row: string[], index: Map<string, number>, ...names: string[]): string {
  for (const name of names) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const position = index.get(key);
    if (position === undefined) continue;
    const value = cleanText(row[position]);
    if (value !== '') return value;
  }
  return '';
}

/**
 * Throws when a column the parser reads is missing from the header row. A renamed column would otherwise turn every value of
 * it into null for every fund while the file still downloads; failing the file keeps the published funds instead.
 * Each entry lists the accepted spellings of one column.
 */
export function requireHeaders(index: Map<string, number>, file: string, columns: string[][]): void {
  const missing = columns.filter(names => !names.some(name => index.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''))));
  if (missing.length) throw new Error(`${file}: missing column${missing.length > 1 ? 's' : ''} ${missing.map(names => `"${names[0]}"`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Configuration (identical env surface to the sibling updaters)
// ---------------------------------------------------------------------------

type Range = { min?: number; max?: number };
type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

export type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  historyRange: string;
  distributionYears: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  category: string;
  aumRange?: Range;
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    const value = env[key];
    if (value !== undefined) return String(value).trim();
  }
  return '';
}

export function parsePositiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(cleanText(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInt(raw: string, fallback: number): number {
  const text = cleanText(raw);
  if (text === '') return fallback;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseNonNegativeFloat(raw: string, fallback: number): number {
  const text = cleanText(raw);
  if (text === '') return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseBoolean(raw: string, fallback = false): boolean {
  const text = cleanText(raw).toLowerCase();
  if (text === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

/** AUM bounds accept plain amounts, K/M/B/T suffixes or a nano..large preset. */
export function parseAumBound(bound: string): { value?: number; preset?: AumPreset } {
  const text = cleanText(bound).replace(/[$,\s]/g, '').toLowerCase();
  if (text === '') return {};
  if (text in AUM_PRESET_BOUNDS) return { preset: text as AumPreset };
  const match = /^(-?\d+(?:\.\d+)?)([kmbt])?$/.exec(text);
  if (!match) throw new Error(`Invalid AUM bound "${bound}": use an amount (optionally with K/M/B/T) or a nano/micro/small/mid/large preset`);
  const amount = Number(match[1]) * (match[2] ? AMOUNT_SUFFIXES[match[2].toUpperCase()] : 1);
  if (!Number.isFinite(amount)) throw new Error(`Invalid AUM bound "${bound}"`);
  return { value: amount };
}

/**
 * Strict `min:max` parsing: exactly one colon, '' or ':' mean no restriction,
 * '$' and '%' are optional, and a min above the max is a usage error.
 */
export function parseRange(raw: string, label: string): Range | undefined {
  const text = cleanText(raw);
  if (text === '') return undefined;
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`Invalid ${label} range "${raw}": use min:max (a single colon; '' or ':' means no restriction)`);
  const [rawMin, rawMax] = parts.map(part => part.replace(/[$%\s,]/g, ''));
  const min = rawMin === '' ? undefined : Number(rawMin);
  const max = rawMax === '' ? undefined : Number(rawMax);
  if (min !== undefined && !Number.isFinite(min)) throw new Error(`Invalid ${label} minimum "${rawMin}"`);
  if (max !== undefined && !Number.isFinite(max)) throw new Error(`Invalid ${label} maximum "${rawMax}"`);
  if (min !== undefined && max !== undefined && min > max) throw new Error(`Invalid ${label} range "${raw}": minimum is above maximum`);
  return { min, max };
}

export function parseAumRange(raw: string): Range | undefined {
  const text = cleanText(raw);
  if (text === '') return undefined;
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`Invalid AUM range "${raw}": use min:max (a single colon; '' or ':' means no restriction)`);
  const lower = parseAumBound(parts[0]);
  const upper = parseAumBound(parts[1]);
  const min = lower.preset ? AUM_PRESET_BOUNDS[lower.preset].min : lower.value;
  const max = upper.preset ? AUM_PRESET_BOUNDS[upper.preset].max : upper.value;
  if (min !== undefined && max !== undefined && min > max) throw new Error(`Invalid AUM range "${raw}": minimum is above maximum`);
  return { min, max };
}

export function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const raw = envValue(env, `${prefix}_${period}`);
    if (raw === '') continue;
    const parsed = parseRange(raw, `${prefix}_${period}`);
    if (parsed && (parsed.min !== undefined || parsed.max !== undefined)) ranges[period] = parsed;
  }
  return ranges;
}

export function matchesRange(value: number | null | undefined, range: Range | undefined): boolean {
  if (!range || (range.min === undefined && range.max === undefined)) return true;
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/** A young fund without the requested tenor passes a return filter (nothing is invented). */
export function matchesReturnRange(value: number | null | undefined, range: Range | undefined): boolean {
  if (!range) return true;
  if (value === null || value === undefined || !Number.isFinite(value)) return true;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

export const USAGE = `
ProShares static feed updater (api/proshares/**).

Usage:
  ./scripts/update-data.ts [options]        # defaults: scripts/update-data.config.json; environment overrides

Precedence: config file < advanced JSON (workflow) < nonblank workflow inputs < environment

Environment variables
  MAX_FETCHES            0            Funds to process. 0 = full pass over the
                                      catalog; a positive value resumes after the
                                      cursor in api/proshares/update-state.json.
  TICKERS                ""           Space/comma separated ticker allowlist.
                                      ANDed with the other filters.
  CATEGORY               ""           Substring match on the ProShares asset class
                                      (Equity, Fixed Income, Commodity, ...).
  AUM                    ":"          Net-asset range min:max. Accepts plain
                                      amounts, K/M/B/T suffixes and the presets
                                      nano (<$10M), micro ($10M-$300M),
                                      small ($300M-$2B), mid ($2B-$10B),
                                      large (>=$10B).
  TER                    ":"          Expense-ratio range in % (min:max).
  DIVIDEND_YIELD         ":"          Official 12-Month Yield or computed indicated
                                      yield range in %, matching the feed.
  SEC_YIELD              ":"          Published SEC 30-Day Yield range in %;
                                      only funds whose pages publish a value
                                      match an active bound. ":" accepts all.
  PERFORMANCE_YTD|1Y|3Y|5Y|10Y  ""    Annualized-return ranges (min:max).
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y ""    Cumulative-return ranges (min:max).
  CONCURRENCY            3            Parallel fund workers.
  REQUEST_SLEEP          2            Seconds between outgoing request starts.
  MAX_RETRIES            3            Retries after the initial request
                                      (408/425/429/403/5xx); at least 1.
  HOLDINGS_PAGE_SIZE     250          Rows per generated holdings JSON page.
  HISTORY_PAGE_SIZE      1000         Rows per generated history JSON page
                                      (alias HISTORICAL_PAGE_SIZE).
  HISTORY_RANGE          max          NAV-history window: max | 20y | 10y | 5y.
  DISTRIBUTION_YEARS     10           Calendar years of distribution history
                                      per fund (the endpoint is year-scoped).
                                      A fund with published distributions
                                      re-reads only the current and previous
                                      year (older rows are kept); a full walk
                                      runs when nothing is published or the
                                      published refreshedAt is 90+ days old.
  STORE_RAW_DOWNLOADS    ""           Keep one raw sample of each source under
                                      api/proshares/raw (1/true/yes/on).
  VERBOSE                ""           Print per-fund retry and fallback notices
                                      (1/true/yes/on).
  USE_SYSTEM_CA          auto         TLS trust store: auto restarts the updater
                                      once with Bun's --use-system-ca when a
                                      request fails with an untrusted-certificate
                                      error; true always uses the system CA
                                      store; false never restarts.

Examples
  MAX_FETCHES=10 ./scripts/update-data.ts
  TICKERS="NOBL TQQQ IGHG" ./scripts/update-data.ts
  CATEGORY=Commodity AUM="300M:" ./scripts/update-data.ts
  DISTRIBUTION_YEARS=20 HISTORY_RANGE=5y ./scripts/update-data.ts
`;

/** Ticker list: any entry that is not a plain ticker is an error, never silently dropped or widened to all funds. */
export function parseTickers(raw: string): string[] {
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  for (const token of tokens) if (!/^[A-Za-z0-9.-]{1,10}$/.test(token)) throw new Error(`TICKERS: invalid ticker "${token}"`);
  return tokens.map(token => token.toUpperCase());
}

export function readConfig(env: Record<string, string | undefined> = Bun.env as Record<string, string | undefined>): UpdaterConfig {
  const config: UpdaterConfig = {
    concurrency: Math.max(1, parsePositiveInt(envValue(env, 'CONCURRENCY'), 3)),
    requestSleep: parseNonNegativeFloat(envValue(env, 'REQUEST_SLEEP'), 1.5),
    maxFetches: parseNonNegativeInt(envValue(env, 'MAX_FETCHES'), 0),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), 250),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), 1000),
    historyRange: envValue(env, 'HISTORY_RANGE') || 'max',
    distributionYears: Math.max(0, parseNonNegativeInt(envValue(env, 'DISTRIBUTION_YEARS'), 10)),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS')),
    maxRetries: parseNonNegativeInt(envValue(env, 'MAX_RETRIES'), 3),
    tickers: parseTickers(envValue(env, 'TICKERS', ['PROSHARES_TICKERS'])),
    category: envValue(env, 'CATEGORY'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
  };
  const aum = envValue(env, 'AUM', ['AUM_RANGE']);
  config.aumRange = aum === '' && envValue(env, 'AUM') === '' && envValue(env, 'AUM_RANGE') === '' ? undefined : parseAumRange(aum === '' ? ':' : aum);
  const ter = envValue(env, 'TER', ['EXPENSE_RATIO', 'TER_RANGE']);
  config.terRange = ter === '' ? undefined : parseRange(ter, 'TER');
  const dividendYield = envValue(env, 'DIVIDEND_YIELD');
  config.dividendYieldRange = dividendYield === '' ? undefined : parseRange(dividendYield, 'DIVIDEND_YIELD');
  const secYield = envValue(env, 'SEC_YIELD');
  config.secYieldRange = secYield === '' ? undefined : parseRange(secYield, 'SEC_YIELD');
  return config;
}

// File defaults and explicit overrides: allowlisted scalar controls only, so
// GitHub Actions can resolve them without interpolating user input into bash.
// Precedence: config file < advanced JSON < nonblank inputs < environment.
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'TICKERS',
  'CATEGORY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'DISTRIBUTION_YEARS', 'MAX_RETRIES',
  'STORE_RAW_DOWNLOADS', 'VERBOSE', 'USE_SYSTEM_CA',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap(prefix => ['YTD', '1Y', '3Y', '5Y', '10Y'].map(period => `${prefix}_${period}`)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

// Legacy environment aliases that keep working; the canonical name wins when both are set.
const CONTROL_ALIASES: Record<string, string[]> = {
  TICKERS: ['PROSHARES_TICKERS'],
  HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'],
  AUM: ['AUM_RANGE'],
  TER: ['EXPENSE_RATIO', 'TER_RANGE'],
};

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const name = [key, ...(CONTROL_ALIASES[key] ?? [])].find(candidate => env[candidate] !== undefined);
    if (name !== undefined) apply({ [key]: env[name] });
  }
  const integerMin: Record<string, number> = { MAX_FETCHES: 0, MAX_RETRIES: 1, DISTRIBUTION_YEARS: 0, CONCURRENCY: 1, HOLDINGS_PAGE_SIZE: 1, HISTORY_PAGE_SIZE: 1 };
  for (const [key, min] of Object.entries(integerMin)) {
    const value = result[key];
    if (value === undefined || value.trim() === '') continue;
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP?.trim() && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['STORE_RAW_DOWNLOADS', 'VERBOSE']) {
    if (result[key]?.trim() && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key].trim())) throw new Error(`${key}: expected boolean`);
  }
  if (result.USE_SYSTEM_CA !== undefined) {
    const mode = result.USE_SYSTEM_CA.trim().toLowerCase();
    if (!['auto', 'true', 'false'].includes(mode)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
    result.USE_SYSTEM_CA = mode;
  }
  if (result.HISTORY_RANGE) historyRangeDays(result.HISTORY_RANGE);
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const file: unknown = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8'));
  return resolveControls(file, {}, {}, env);
}

// ---------------------------------------------------------------------------
// HTTP layer: polite pacing, bounded retries, optional raw-sample capture
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 45_000;
const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One pacing lane per concurrent worker. A single shared gate capped total
// throughput at one request per REQUEST_SLEEP no matter how high CONCURRENCY
// was set; CONCURRENCY workers now each get their own paced lane, so
// concurrency actually multiplies throughput as documented instead of only
// overlapping wait time. Resized lazily from config.concurrency since this
// function already receives config on every call.
let requestLanes: number[] = [0];

export async function paceRequests(config: UpdaterConfig): Promise<void> {
  const gap = Math.max(0, config.requestSleep) * 1000;
  const laneCount = Math.max(1, config.concurrency);
  if (requestLanes.length !== laneCount) requestLanes = new Array(laneCount).fill(0);
  let lane = 0;
  for (let i = 1; i < requestLanes.length; i++) if (requestLanes[i] < requestLanes[lane]) lane = i;
  // Reserve the slot synchronously, before any await, so concurrent callers never pick the same lane.
  const now = Date.now();
  const start = Math.max(now, requestLanes[lane] + gap);
  requestLanes[lane] = start;
  const wait = start - now;
  if (wait > 0) await sleep(wait);
}

export function browserHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

export function jsonHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

const rawSamples = new Map<string, string>();

export function recordRawSample(name: string, content: string): void {
  if (!rawSamples.has(name)) rawSamples.set(name, content);
}

export function rawSampleNames(): string[] {
  return [...rawSamples.keys()].sort();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchText(
  url: string,
  headers: Record<string, string>,
  config: UpdaterConfig,
  label = url,
  rawName = '',
): Promise<string> {
  let lastError = '';
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    await paceRequests(config);
    let httpFailureStatus: number | null = null;
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok) {
        const text = await response.text();
        if (config.storeRawDownloads && rawName) recordRawSample(rawName, text);
        return text;
      }
      httpFailureStatus = response.status;
      lastError = `HTTP ${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    // A 4xx not in the retry list is permanent. A terminal 5xx/network error
    // must fail immediately too: never log a phantom retry or sleep again.
    if (httpFailureStatus !== null && !RETRY_STATUS.has(httpFailureStatus)) throw new Error(`${label}: ${lastError}`);
    // 403 is retried once at most (a WAF denial rarely clears), other transient failures up to MAX_RETRIES
    if (attempt === config.maxRetries || (httpFailureStatus === 403 && attempt >= 1)) throw new Error(`${label}: ${lastError}`);
    const backoff = Math.min(30_000, 15_000 * (attempt + 1));
    outputNote(formatRetry(label, lastError, Math.round(backoff / 1000), attempt + 1, config.maxRetries));
    await sleep(backoff);
  }
  throw new Error(`${label}: ${lastError}`);
}

// ---------------------------------------------------------------------------
// (a) Fund universe — the two official finder pages
// ---------------------------------------------------------------------------

export type CatalogFund = {
  ticker: string;
  name: string;
  slug: string;
  kind: 'strategic' | 'geared';
  fundPage: string;
  assetClass: string;
  marketingCategory: string;
  strategy: string;
  dailyObjective: string;
  benchmark: string;
  benchmarkTicker: string;
  netAssetsText: string;
  netAssetsValue: number | null;
  inceptionDateText: string;
};

function finderRows(html: string): { rowHtml: string; href: string; ticker: string }[] {
  const rows: { rowHtml: string; href: string; ticker: string }[] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(html))) {
    const rowHtml = match[1];
    const link = /<a[^>]+href="(\/our-etfs\/(?:strategic|leveraged-and-inverse)\/[a-z0-9-]+)"[^>]*>([^<]*)<\/a>/i.exec(rowHtml);
    if (!link) continue;
    const ticker = cleanText(link[2]).toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(ticker)) continue;
    rows.push({ rowHtml, href: link[1], ticker });
  }
  return rows;
}

/**
 * Parses one server-rendered finder table. The strategic page carries
 * `Ticker | Fund Name | Category | Asset Class | Net Assets | Inception Date`
 * and the geared page `Ticker | Fund Name | Fund Type | Daily Objective |
 * Asset Class | Net Assets | Index/Benchmark`; both end with a hidden
 * `td_category` cell holding the marketing category.
 */
export function parseFinderCatalogPage(html: string, kind: 'strategic' | 'geared'): CatalogFund[] {
  const funds: CatalogFund[] = [];
  for (const { rowHtml, href, ticker } of finderRows(html)) {
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => stripTags(cell[1]));
    const hidden = /<td[^>]*class="[^"]*td_category[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    const marketingCategory = hidden ? stripTags(hidden[1]) : '';
    const slug = href.split('/').pop() || ticker.toLowerCase();
    if (kind === 'strategic') {
      funds.push({
        ticker,
        name: normalizeName(cells[1] || ticker),
        slug,
        kind,
        fundPage: `${PROSHARES_SITE}${href}`,
        marketingCategory: marketingCategory || cleanText(cells[2]),
        assetClass: cleanText(cells[3]),
        strategy: '',
        dailyObjective: '',
        benchmark: '',
        benchmarkTicker: '',
        netAssetsText: cleanText(cells[4]),
        netAssetsValue: numberOrNull(cells[4]),
        inceptionDateText: formatUsDate(cells[5]),
      });
      continue;
    }
    const objective = cleanText(cells[3]).replace(/\s+/g, '').replace(/^\+-/, '-').replace(/^(\d)/, '+$1');
    const benchmarkCell = /<td[^>]*class="[^"]*benchmark[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    const symbolMatch = /<td[^>]*class="[^"]*benchmark[^"]*"[^>]*data-symbol="([^"]*)"/i.exec(rowHtml);
    const benchmark = cleanText(benchmarkCell ? stripTags(benchmarkCell[1]) : cells[6]);
    funds.push({
      ticker,
      name: normalizeName(cells[1] || ticker),
      slug,
      kind,
      fundPage: `${PROSHARES_SITE}${href}`,
      marketingCategory,
      assetClass: cleanText(cells[4]),
      strategy: cleanText(cells[2]),
      dailyObjective: objective,
      benchmark,
      benchmarkTicker: cleanText(symbolMatch ? symbolMatch[1] : ''),
      netAssetsText: cleanText(cells[5]),
      netAssetsValue: numberOrNull(cells[5]),
      inceptionDateText: '',
    });
  }
  return funds;
}

// ---------------------------------------------------------------------------
// (b) Official fund page
// ---------------------------------------------------------------------------

export type FundPageData = {
  cusip: string;
  expenseRatio: number | null;
  expenseRatioText: string;
  expenseRatioFootnote: string;
  grossExpenseRatio: number | null;
  grossExpenseRatioText: string;
  netExpenseRatio: number | null;
  netExpenseRatioText: string;
  inceptionDate: string;
  netAssetsText: string;
  netAssetsValue: number | null;
  nav: number | null;
  navText: string;
  marketPrice: number | null;
  marketPriceText: string;
  priceAsOf: string;
  distributionFrequency: string;
  twelveMonthYield: number | null;
  twelveMonthYieldText: string;
  sec30DayYield: number | null;
  sec30DayYieldText: string;
  distributionsAsOf: string;
  distributionsNote?: string;
  characteristics: Record<string, string>;
  characteristicsAsOf: string;
  indexStats: Record<string, string>;
  indexAsOf: string;
  exposures: { label: string; rows: Record<string, unknown>[] }[];
  returns: {
    monthEnd: Record<string, number | null> & { asOfDate?: string; inceptionDate?: string };
    quarterEnd: Record<string, number | null> & { asOfDate?: string; inceptionDate?: string };
  };
};

export function extractIdText(html: string, id: string): string {
  const pattern = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)<`, 'i');
  const match = pattern.exec(html);
  return match ? stripTags(match[1]) : '';
}

function listItems(html: string, containerId: string): Record<string, string> {
  const start = html.search(new RegExp(`id="${containerId}"`, 'i'));
  if (start < 0) return {};
  const fragment = html.slice(start, start + 12_000);
  const items: Record<string, string> = {};
  const pattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment))) {
    const itemHtml = match[1];
    const labelMatch = /class="[^"]*about-fund__list-label[^"]*"[^>]*>([\s\S]*?)<\//i.exec(itemHtml);
    const valueMatch = /class="[^"]*about-fund__list-value[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(itemHtml);
    const label = cleanText(stripTags(labelMatch ? labelMatch[1] : ''));
    if (!label) continue;
    items[label] = valueMatch ? cleanText(stripTags(valueMatch[1])) : '';
  }
  return items;
}

const RETURN_TENOR_KEYS: Record<string, string> = {
  '1m': 'mo1',
  '3m': 'mo3',
  '6m': 'mo6',
  ytd: 'ytd',
  '1y': 'yr1',
  '3y': 'yr3',
  '5y': 'yr5',
  '10y': 'yr10',
  'since inception': 'sinceInception',
};
const RETURN_TENOR_KEYS_BY_INDEX = [...Object.values(RETURN_TENOR_KEYS), 'inceptionDate'];

function parseReturnTables(html: string): FundPageData['returns'] {
  const labels = [...html.matchAll(/(Month-End|Quarter-End) Total Returns as of (\d{1,2}\/\d{1,2}\/\d{4})/gi)].map(match => ({
    period: match[1].toLowerCase().startsWith('month') ? 'monthEnd' : 'quarterEnd',
    asOf: formatUsDate(match[2]),
  }));
  const tables = [...html.matchAll(/<table[^>]*id="total-return-table"[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  const result: FundPageData['returns'] = { monthEnd: {}, quarterEnd: {} };
  tables.forEach((table, index) => {
    const label = labels[index] || (index === 0 ? { period: 'monthEnd', asOf: '' } : { period: 'quarterEnd', asOf: '' });
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(cell => cleanText(stripTags(cell[1])));
    // The site prints Fund + Index, 1m … Inception Date. Map by header label so
    // a changed column set cannot silently shift the tenors.
    let tenorColumns = headers
      .map((header, columnIndex) => ({ key: RETURN_TENOR_KEYS[header.toLowerCase()], columnIndex }))
      .filter(entry => entry.key !== undefined && entry.key !== 'inceptionDateLabel');
    let inceptionColumn = headers.findIndex(header => header.toLowerCase() === 'inception date');
    if (!tenorColumns.length) {
      tenorColumns = RETURN_TENOR_KEYS_BY_INDEX.map((key, index) => ({ key, columnIndex: index + 1 }));
      inceptionColumn = RETURN_TENOR_KEYS_BY_INDEX.length + 1;
    }
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    const target: Record<string, number | null | string> = result[label.period as 'monthEnd' | 'quarterEnd'];
    target.asOfDate = label.asOf;
    while ((rowMatch = rowPattern.exec(table))) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cleanText(stripTags(cell[1])));
      if (cells.length < 3) continue;
      const rowLabel = cells[0].toLowerCase();
      if (!/(nav|market price)\s*$/.test(rowLabel)) continue;
      if (rowLabel.includes('market') && target.marketPrice) continue;
      if (rowLabel.includes('nav') && target.nav) continue;
      const basis = rowLabel.includes('market') ? 'marketPrice' : 'nav';
      (target as Record<string, unknown>)[basis] = null;
      for (const { key, columnIndex } of tenorColumns) {
        if (!key) continue;
        (target as Record<string, number | null>)[`${basis === 'nav' ? '' : 'mp'}${key}`] = numberOrNull(cells[columnIndex]);
      }
      if (inceptionColumn >= 0) (target as Record<string, unknown>).inceptionDate = formatUsDate(cells[inceptionColumn]);
    }
  });
  return result;
}

function parseExposures(html: string): { label: string; rows: Record<string, unknown>[] }[] {
  const exposures: { label: string; rows: Record<string, unknown>[] }[] = [];
  const pattern = /"label":\s*"([^"]+)",\s*"tableData":\s*(\[[\s\S]*?\n\s*\])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const label = cleanText(match[1]);
    try {
      const rows = JSON.parse(match[2].replace(/,\s*([\]}])/g, '$1')) as Record<string, unknown>[];
      if (Array.isArray(rows) && rows.length) exposures.push({ label, rows });
    } catch {
      // A malformed exposure block is simply skipped: it is descriptive only.
    }
  }
  return exposures;
}

export function parseFundPage(html: string): FundPageData {
  const snapshot = listItems(html, 'aboutthefund');
  const characteristics: Record<string, string> = {};
  const characteristicIds: Record<string, string> = {
    numberOfHoldings: 'Number of Holdings',
    priceEarningsRatio: 'Price/Earnings Ratio',
    priceBookRatio: 'Price/Book Ratio',
    avgMarketCap: 'Avg. Market Cap',
    weightedAverageYieldMaturity: 'Weighted Average Yield to Maturity',
    weightedaverageyieldtomaturity: 'Weighted Average Yield to Maturity',
  };
  for (const [id, label] of Object.entries(characteristicIds)) {
    const value = extractIdText(html, `characteristics-${id}`);
    if (value) characteristics[label] = value;
  }
  const navText = extractIdText(html, 'price-nav');
  const marketPriceText = extractIdText(html, 'price-marketPrice');
  const netAssetsText = extractIdText(html, 'snapshot-netAssets');
  // Equity and bond pages publish one ratio ("Expense Ratio"); the geared pages
  // publish two ("Gross Expense Ratio" / "Net Expense Ratio").
  const grossExpenseRatioText = extractIdText(html, 'snapshot-grossExpenseRatio') || cleanText(snapshot['Gross Expense Ratio'] || '');
  const netExpenseRatioText = extractIdText(html, 'snapshot-netExpenseRatio') || cleanText(snapshot['Net Expense Ratio'] || '');
  const expenseRatioText = extractIdText(html, 'snapshot-expenseRatio')
    || netExpenseRatioText
    || cleanText(snapshot['Expense Ratio'] || '');
  const twelveMonthYieldText = extractIdText(html, 'distributions-12MonthYield');
  // Present on some strategic fund pages, including equity and bond funds;
  // geared pages can omit this id even when they pay distributions.
  const sec30DayYieldText = extractIdText(html, 'distributions-sec30DayYield');
  const sec30DayYield = ratioValue(sec30DayYieldText);
  const indexStats: Record<string, string> = {};
  const indexStart = html.search(/id="index"/i);
  if (indexStart >= 0) {
    const fragment = html.slice(indexStart, indexStart + 14_000);
    const pattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(fragment))) {
      const text = cleanText(stripTags(match[1]));
      const split = /^(.*?)\s*(\$?[\d,]+(?:\.\d+)?\s*(?:billion|million|%)?)$/i.exec(text);
      if (split) indexStats[cleanText(split[1])] = cleanText(split[2]);
    }
  }
  return {
    cusip: extractIdText(html, 'snapshot-cusip') || cleanText(snapshot.CUSIP || ''),
    expenseRatio: ratioValue(expenseRatioText),
    expenseRatioText: cleanRatioText(expenseRatioText) || '—',
    expenseRatioFootnote: /[*\u2020\u2021\u00b0]\s*$/.test(expenseRatioText) ? expenseRatioText.trim().slice(-1) : '',
    // A single published ratio is both gross and net (no waiver is published).
    grossExpenseRatio: ratioValue(grossExpenseRatioText || netExpenseRatioText || expenseRatioText),
    grossExpenseRatioText: cleanRatioText(grossExpenseRatioText || netExpenseRatioText || expenseRatioText) || '—',
    netExpenseRatio: ratioValue(netExpenseRatioText || expenseRatioText),
    netExpenseRatioText: cleanRatioText(netExpenseRatioText || expenseRatioText) || '—',
    inceptionDate: formatUsDate(extractIdText(html, 'snapshot-inceptionDate') || snapshot['Inception Date'] || ''),
    netAssetsText: netAssetsText || cleanText(snapshot['Net Assets'] || ''),
    netAssetsValue: numberOrNull(netAssetsText || snapshot['Net Assets'] || ''),
    nav: numberOrNull(navText),
    navText: navText || '—',
    marketPrice: numberOrNull(marketPriceText),
    marketPriceText: marketPriceText || '—',
    priceAsOf: formatUsDate((extractIdText(html, 'price-asOfDate') || '').replace(/^as of\s*/i, '')),
    distributionFrequency: extractIdText(html, 'distributions-distributionFrequency') || extractIdText(html, 'snapshot-distributions'),
    twelveMonthYield: ratioValue(twelveMonthYieldText),
    twelveMonthYieldText: twelveMonthYieldText || '—',
    sec30DayYield,
    sec30DayYieldText: sec30DayYield === null ? '—' : sec30DayYieldText,
    distributionsAsOf: formatUsDate((extractIdText(html, 'distributions-asOfDate') || '').replace(/^as of\s*/i, '')),
    // The fund page states this itself when a fund never distributed.
    distributionsNote: /This fund has not made any distributions\s*\./i.test(html) ? 'This fund has not made any distributions.' : '',
    characteristics,
    characteristicsAsOf: formatUsDate((extractIdText(html, 'characteristics-asOfDate') || '').replace(/^as of\s*/i, '')),
    indexStats,
    indexAsOf: formatUsDate((extractIdText(html, 'index-asOfDate') || '').replace(/^as of\s*/i, '')),
    exposures: parseExposures(html),
    returns: parseReturnTables(html),
  };
}

// ---------------------------------------------------------------------------
// (c) Official daily holdings file (psdlyhld.csv)
// ---------------------------------------------------------------------------

export type HoldingsRow = {
  name: string;
  ticker: string;
  identifier: string;
  coupon: string;
  maturity: string;
  shares: string;
  exposure: string;
  marketValue: string;
};

export type HoldingsFile = {
  asOf: string;
  asOfIso: string;
  funds: Map<string, { name: string; rows: HoldingsRow[] }>;
};

/**
 * The file starts with a preamble (`PORTFOLIO HOLDINGS INFORMATION`,
 * `AS OF <date>`, a blank line) and then the real header. Non-equity positions
 * carry an empty Security Ticker and a SEDOL identifier; futures and swaps an
 * empty Market Value and a filled Exposure Value.
 */
export function parseHoldingsFile(text: string): HoldingsFile {
  const records = parseCsvRecords(text);
  let asOf = '';
  let headerPosition = -1;
  for (let i = 0; i < records.length; i++) {
    const first = cleanText(records[i][0] || '');
    if (!asOf && /^as of\b/i.test(first)) asOf = formatUsDate(first.replace(/^as of\s*/i, ''));
    if (cleanText(records[i][0] || '').toLowerCase() === 'fund ticker') {
      headerPosition = i;
      break;
    }
  }
  if (headerPosition < 0) throw new Error('holdings file: no "Fund Ticker" header row found');
  const index = headerIndex(records[headerPosition]);
  requireHeaders(index, 'holdings file', [
    ['Fund Ticker'], ['Fund Name'], ['Security Ticker'], ['Security Sedol', 'Security SEDOL'], ['Security Description'], ['Coupon'],
    ['Maturity Date'], ['Shares/Contracts', 'Shares Contracts'], ['Exposure Value (Notional + G/L)', 'Exposure Value'], ['Market Value'],
  ]);
  const funds = new Map<string, { name: string; rows: HoldingsRow[] }>();
  for (let i = headerPosition + 1; i < records.length; i++) {
    const row = records[i];
    const ticker = cleanText(cellAt(row, index, 'Fund Ticker')).toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(ticker)) continue;
    const name = normalizeName(cellAt(row, index, 'Fund Name'));
    const holding: HoldingsRow = {
      name: normalizeSecurityName(cellAt(row, index, 'Security Description')),
      ticker: cleanText(cellAt(row, index, 'Security Ticker')),
      identifier: cleanText(cellAt(row, index, 'Security Sedol', 'Security SEDOL')),
      coupon: cleanText(cellAt(row, index, 'Coupon')),
      maturity: cellAt(row, index, 'Maturity Date'),
      shares: cleanText(cellAt(row, index, 'Shares/Contracts', 'Shares Contracts')),
      exposure: cleanText(cellAt(row, index, 'Exposure Value (Notional + G/L)', 'Exposure Value')),
      marketValue: cleanText(cellAt(row, index, 'Market Value')),
    };
    const bucket = funds.get(ticker) || { name, rows: [] };
    if (!bucket.name && name) bucket.name = name;
    bucket.rows.push(holding);
    funds.set(ticker, bucket);
  }
  return { asOf, asOfIso: toIsoDate(asOf), funds };
}

/**
 * The holdings file carries no weight column, so the updater reproduces the
 * "Exposure Weight" column the fund pages render: the position value (market
 * value, or notional exposure for futures and swaps) divided by the fund's
 * total net assets as reported in that same official file — the sum of its
 * market values, which includes the "Net Other Assets (Liabilities)" line.
 * Verified against the live fund pages: TQQQ NVDA 3.11% and the Barclays swap
 * 29.64%, AGQ Silver DEC26 77.04%, NOBL BDX 1.73%, IGHG Morgan Stanley 1.62%.
 * Cash and payable lines carry no weight on the fund pages and stay blank.
 */
/**
 * The fund pages mark a ratio with a footnote marker when a fee waiver
 * applies ("1.17%*"). The marker is kept in the verbatim display strings and
 * stripped before parsing, so the value is still a number.
 */
export function ratioValue(raw: unknown): number | null {
  return numberOrNull(cleanText(raw).replace(/[*\u2020\u2021\u00b0]/g, ''));
}

/** Removes the fund page's footnote markers from a display string. */
export function cleanRatioText(raw: unknown): string {
  return cleanText(raw).replace(/\s*[*\u2020\u2021\u00b0]\s*$/, '');
}

export function holdingWeight(row: HoldingsRow, totalNetAssets: number): string {
  if (isWeightlessRow(row)) return '—';
  const value = numberOrNull(row.marketValue) ?? numberOrNull(row.exposure);
  if (value === null || !totalNetAssets) return '—';
  return round((value / totalNetAssets) * 100, 10).toFixed(10);
}

/** The "Net Other Assets (Liabilities)" / "Net Other Assets / Cash" line. */
export function isOtherAssetsRow(row: HoldingsRow): boolean {
  return /net\s+other\s+assets/i.test(row.name);
}

/**
 * Rows the fund pages render without a weight: the residual net-other-assets
 * line and its cash equivalents (Treasury bills and the ProShares money-market
 * fund it holds). Every other position — equities, bonds, futures and swaps —
 * carries the page's own number.
 */
export function isWeightlessRow(row: HoldingsRow): boolean {
  return isOtherAssetsRow(row)
    || /^treasury\s+bill/i.test(row.name)
    || /genius\s+mny\s+mkt/i.test(row.name);
}

/** Total net assets a holdings file implies: the sum of its market values. */
export function holdingsNetAssets(rows: HoldingsRow[]): number {
  return rows.reduce((sum, row) => sum + (numberOrNull(row.marketValue) ?? 0), 0);
}

/** Funds whose holdings legitimately fail a holdingsGuard check (futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
// Per fund, from the guard run over every published sheet of 2026-10-23 (173 funds: 23 pass every check, 150 fail one or both of
// these two). The sum check of a leveraged or inverse fund is relaxed by its catalog objective (isGearedObjective), not by this
// table, so a newly launched geared fund is published without an entry here; every other fund gets every check unless it is
// listed. The column and row-count checks stay on for all.
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
// numeric: a few swap or futures lines next to cash lines that carry no weight by design (Net Other Assets, Treasury bills, the
// money market fund), so fewer than 80% of the rows have one (geared and inverse swap funds, autocallable, crypto, VIX and oil
// futures funds)
for (const tickers of [
  'ACQQ ACRT ACSP AGQ BETE BETH BITI BITO BOIL DOG DUG DXD EET EETH EEV EFO EFZ EPV EUM EUO EWV EZJ GLL KOLD KRYP',
  'OILK PSQ PST QID QQDN REK RWM SCO SDD SDOW SDS SETH SH SJB SLON SPXU SQQQ SRS SRTY TBF TBT TBX UBT UCO UGL UJB',
  'ULE UPV UST UXRP VIXM VIXY XPP YCL YCS ZSL',
]) for (const ticker of tickers.split(' ')) HOLDINGS_GUARD_RELAX[ticker] = ['numeric'];
// sum: hedged funds (HDG, HYHG, IGHG) net their short futures out, option-income funds
for (const tickers of [
  'FB HDG HYHG IGHG IQQQ ISPY ITWO QB RB',
]) for (const ticker of tickers.split(' ')) HOLDINGS_GUARD_RELAX[ticker] = ['sum'];
// numeric and sum: VIX futures funds outside the geared catalog (SVXY, UVXY), RINF and the money market fund IQMM (only Treasury
// bills, no weights)
for (const tickers of [
  'IQMM RINF SVXY UVXY',
]) for (const ticker of tickers.split(' ')) HOLDINGS_GUARD_RELAX[ticker] = ['numeric', 'sum'];
/** SEC 497 of 2026-09-28 (Plan of Liquidation): October 12, 2026 is each fund's last full day of trading, distribution on October 27, 2026. */
const LIQUIDATION_2026_10_12 = 'https://www.sec.gov/Archives/edgar/data/1174610/000117461026001069/f46317d1.htm';
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [
  { ticker: 'ANEW', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'CLIX', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'CTEX', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'DAT', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'MAKX', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'OND', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'SUPL', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'TINT', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
  { ticker: 'VERS', closed: '2026-10-12', source: LIQUIDATION_2026_10_12 },
];

/** True for a leveraged or inverse daily objective from the geared finder page (+2x, -1x, -3x); +1x and blank are not geared. */
export function isGearedObjective(dailyObjective: string): boolean {
  const match = /^([+-]?)(\d+(?:\.\d+)?)x$/i.exec(cleanText(dailyObjective).replace(/\s+/g, ''));
  if (!match) return false;
  return match[1] === '-' || Number(match[2]) > 1;
}

/** The checks the holdings guard skips for one fund: its table entry plus 'sum' when the catalog marks it leveraged or inverse. */
export function holdingsGuardRelax(ticker: string, dailyObjective = ''): string[] {
  const relax = HOLDINGS_GUARD_RELAX[ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [];
  return isGearedObjective(dailyObjective) && !relax.includes('sum') ? [...relax, 'sum'] : relax;
}

export function holdingsHeaders(rows: HoldingsRow[]): string[] {
  const headers = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held'];
  if (rows.some(row => row.exposure !== '')) headers.push('Exposure Value');
  if (rows.some(row => row.coupon !== '')) headers.push('Coupon');
  if (rows.some(row => row.maturity !== '')) headers.push('Maturity Date');
  return headers;
}

/** Words that say nothing about which company a name means. */
const NAME_FILLER = new Set(['INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC', 'SA', 'AG', 'NV', 'SE', 'SPA', 'ASA', 'AB', 'OYJ', 'GROUP',
  'HOLDING', 'HOLDINGS', 'THE', 'AND', 'COMMON', 'STOCK', 'SHARES', 'SHARE', 'CLASS', 'CL', 'ORDINARY', 'REG', 'ADR', 'ADS', 'SPON', 'SP', 'AMERICAN',
  'AMERICA', 'INTERNATIONAL', 'GLOBAL', 'NATIONAL', 'UNITED', 'FIRST', 'GENERAL', 'DEPOSITARY', 'REPRESENTING', 'EACH', 'ONE']);

function nameWords(name: string): string[] {
  return cleanText(name).toUpperCase().replace(/&/g, ' ').replace(/[^A-Z0-9 ]+/g, '').split(/\s+/).filter(word => word && !NAME_FILLER.has(word));
}

/**
 * Does a U.S. symbol directory name describe the same company as a holdings name? A shared word of three or more letters
 * (HUNT (JB) TRANSPRT = J.B. Hunt Transport), one name starting with the other (HP INC, 3M CO, AT&T INC), or the
 * ticker made of the name's initials (GENERAL ELECTRIC = GE, INTL BUSINESS MACHINES = IBM).
 */
export function sameCompanyName(holding: string, listed: string, ticker: string): boolean {
  const a = nameWords(holding), b = nameWords(listed);
  if (a.some(word => word.length >= 3 && b.indexOf(word) >= 0)) return true;
  const compactA = a.join(''), compactB = b.join('');
  if (compactA.length >= 2 && compactB.length >= 2 && (compactA.startsWith(compactB) || compactB.startsWith(compactA))) return true;
  const initials = cleanText(holding).toUpperCase().replace(/&/g, ' ').replace(/[^A-Z0-9 ]+/g, '').split(/\s+/)
    .filter(word => word && !['INC', 'CORP', 'CO', 'LTD', 'PLC', 'THE', 'AND'].includes(word)).map(word => word.charAt(0)).join('');
  return initials.length >= 2 && initials === ticker.toUpperCase();
}

/**
 * The published ticker of a holdings row (PS-1). The ProShares file gives the local exchange code with no exchange (EFAD
 * lists TEL for Telenor, NEM for Nemetschek, which are TE Connectivity and Newmont in U.S. funds), so a bare ticker is kept
 * only for a U.S. listing: a ticker the Nasdaq Trader symbol directory lists, held under a North American SEDOL (starts with 2)
 * or under a name of the same company. Swaps, futures, currency contracts and debt rows get '-'. Without the directory (it
 * failed this run) the file's ticker is kept as before.
 */
export function holdingTicker(row: HoldingsRow, usListings: ReadonlyMap<string, string> | null): string {
  const ticker = cleanText(row.ticker);
  if (!ticker || row.exposure !== '' || row.coupon !== '' || row.maturity !== '') return '-';
  if (!usListings) return ticker;
  const listed = usListings.get(ticker.toUpperCase().replace(/[/ ]/g, '.'));
  if (listed === undefined) return '-';
  return /^2[0-9A-Z]{6}$/.test(cleanText(row.identifier)) || sameCompanyName(row.name, listed, ticker) ? ticker : '-';
}

export function holdingsRowsForCsv(rows: HoldingsRow[], headers: string[], usListings: ReadonlyMap<string, string> | null = null): Record<string, string>[] {
  const totalNetAssets = holdingsNetAssets(rows);
  return rows.map(row => {
    const value: Record<string, string> = {
      Name: row.name || '—',
      Ticker: holdingTicker(row, usListings),
      Identifier: row.identifier || '—',
      Weight: holdingWeight(row, totalNetAssets),
      'Market Value': row.marketValue || '—',
      'Shares Held': row.shares || '—',
    };
    if (headers.includes('Exposure Value')) value['Exposure Value'] = row.exposure || '—';
    if (headers.includes('Coupon')) value.Coupon = row.coupon || '—';
    if (headers.includes('Maturity Date')) value['Maturity Date'] = row.maturity || '—';
    return value;
  });
}

// ---------------------------------------------------------------------------
// (d) Official NAV history file (ByFund/<TICKER>-historical_nav.csv)
// ---------------------------------------------------------------------------

export type NavRow = {
  date: string;
  nav: number | null;
  sharesOutstanding: number | null;
  netAssets: number | null;
};

export function holdingsUrl(ticker: string): string {
  return `${PROSHARES_DATA_HOST}/ByFund/${ticker}-psdlyhld.csv`;
}

export function navHistoryUrl(ticker: string): string {
  return `${PROSHARES_DATA_HOST}/ByFund/${ticker}-historical_nav.csv`;
}

/** NAV rows per ticker of a NAV history file (the per-fund file and the all-funds file share one layout), in file order. */
export function parseNavHistoryAll(text: string): Map<string, NavRow[]> {
  const records = parseCsvRecords(text);
  const map = new Map<string, NavRow[]>();
  if (!records.length) return map;
  const index = headerIndex(records[0]);
  requireHeaders(index, 'NAV history file', [
    ['Date'], ['Ticker'], ['NAV'], ['Shares Outstanding (000)', 'Shares Outstanding 000'], ['Assets Under Management', 'AUM'],
  ]);
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const ticker = cleanText(cellAt(row, index, 'Ticker')).toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(ticker)) continue;
    const date = formatUsDate(cellAt(row, index, 'Date'));
    if (!date || date === '—') continue;
    const sharesText = cellAt(row, index, 'Shares Outstanding (000)', 'Shares Outstanding 000');
    const shares = numberOrNull(sharesText);
    const list = map.get(ticker) || [];
    list.push({
      date,
      nav: numberOrNull(cellAt(row, index, 'NAV')),
      // The file publishes shares outstanding in thousands.
      sharesOutstanding: shares === null ? null : round(shares * 1000, 0),
      netAssets: numberOrNull(cellAt(row, index, 'Assets Under Management', 'AUM')),
    });
    map.set(ticker, list);
  }
  return map;
}

export function parseNavHistoryFile(text: string, ticker: string): NavRow[] {
  return parseNavHistoryAll(text).get(ticker) || [];
}

/**
 * The bulk NAV file is only a fallback for the per-fund file. For a fund that already publishes history it is used only when it
 * reaches back at least as far as the published history (`publishedFirst`, the first date of history page 1); a shorter slice
 * would rewrite the history pages without their oldest years. Returns the reason to keep the fund, or null.
 */
export function navFallbackProblem(rows: NavRow[], publishedFirst: string | null): string | null {
  if (!rows.length || !publishedFirst) return null;
  const first = rows.reduce((oldest, row) => (compareDisplayDates(row.date, oldest) < 0 ? row.date : oldest), rows[0].date);
  return compareDisplayDates(first, publishedFirst) > 0 ? `bulk NAV history starts ${first}, after the published ${publishedFirst}` : null;
}

/** Rows of the first published page of a sheet block from meta.json (`history`, `holdings`); [] when there is none or it is unreadable. */
export async function firstPublishedRows(directory: string, block: unknown): Promise<Record<string, unknown>[]> {
  const page = (block as { pages?: unknown } | null | undefined)?.pages;
  const first = Array.isArray(page) ? page[0] : undefined;
  if (typeof first !== 'string' || !first) return [];
  try {
    const rows = JSON.parse(await readFile(path.join(directory, first), 'utf8')).rows;
    return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
  } catch {
    return [];
  }
}

/** True when at least one holdings row carries a numeric Weight (cash-only funds such as IQMM publish none at all). */
export function hasNumericWeight(rows: ReadonlyArray<Record<string, unknown>>): boolean {
  return rows.some(row => numberOrNull(row.Weight) !== null);
}

const RETURN_METRIC_KEYS = ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'siAnn'];

/**
 * Value sets a fresh row would turn from published numbers into all-null: the expense ratio (a renamed `snapshot-expenseRatio`
 * id) and the official returns (a renamed performance column, a fund missing from the file). Honest nulls stay possible for a
 * fund that never had the value; the caller keeps a fund that would lose one.
 */
export function lostValueSets(previous: Record<string, any>, next: Record<string, any>): string[] {
  const lost: string[] = [];
  if (numberOrNull(previous.terValue) !== null && numberOrNull(next.terValue) === null) lost.push('expense ratio');
  const returns = (row: Record<string, any>): (number | null)[] => RETURN_METRIC_KEYS.map(key => numberOrNull(row.metrics?.[key]));
  if (returns(previous).some(value => value !== null) && returns(next).every(value => value === null)) lost.push('returns');
  return lost;
}

export function historyRangeDays(range: string): number | null {
  const text = cleanText(range).toLowerCase();
  if (!text || text === 'max' || text === 'all' || text === '0') return null;
  const match = /^(\d+)\s*(y|yr|year|years|m|mo|month|months|d|day|days)?$/.exec(text);
  if (!match) throw new Error(`Invalid HISTORY_RANGE "${range}": use max, <N>y, <N>m or <N>d`);
  const amount = Number(match[1]);
  if (amount <= 0) throw new Error(`Invalid HISTORY_RANGE "${range}": the window must be at least 1 (use max for everything)`);
  const unit = (match[2] || 'y').toLowerCase();
  if (unit.startsWith('y')) return amount * 365;
  if (unit.startsWith('m') && unit !== 'max') return amount * 30;
  return amount;
}

export function applyHistoryRange(rows: NavRow[], range: string): NavRow[] {
  const days = historyRangeDays(range);
  if (!days) return rows;
  const newest = rows[rows.length - 1];
  if (!newest) return rows;
  const cutoff = calendarEpoch(newest.date) - days * 86_400_000;
  return rows.filter(row => calendarEpoch(row.date) >= cutoff);
}

/**
 * HISTORY_RANGE shortens what a run refreshes, never the published history (Q29, as First-Trust FT-4): published rows dated
 * before the window's first day are kept in front of it. The join is honest only when the published history has that first
 * day with the same NAV (the history file has no market price); otherwise (a gap, a revised or split-adjusted NAV) it returns
 * null and the caller keeps the fund as published. Rows come back in the published text, so an unchanged run writes nothing.
 */
export function withOlderNavRows(windowRows: NavRow[], published: ReadonlyArray<Record<string, unknown>>): NavRow[] | null {
  const first = windowRows[0];
  if (!first) return windowRows;
  const dated = published.filter(row => Number.isFinite(calendarEpoch(row.Date)));
  const older = dated.filter(row => compareDisplayDates(cleanText(row.Date), first.date) < 0);
  if (!older.length) return windowRows;
  const joint = dated.find(row => cleanText(row.Date) === first.date);
  const nav = joint ? numberOrNull(joint.NAV) : null;
  if (!joint || nav === null || first.nav === null || Math.abs(nav - first.nav) > 1e-9) return null;
  return older
    .sort((a, b) => compareDisplayDates(cleanText(a.Date), cleanText(b.Date)))
    .map(row => ({
      date: cleanText(row.Date),
      nav: numberOrNull(row.NAV),
      sharesOutstanding: numberOrNull(row['Shares Outstanding']),
      netAssets: numberOrNull(row['Total Net Assets']),
    }))
    .concat(windowRows);
}

/** Every row of a published sheet block, pages in order; null when a listed page is unreadable (the caller keeps the fund). */
export async function publishedSheetRows(directory: string, block: unknown): Promise<Record<string, unknown>[] | null> {
  const pages = (block as { pages?: unknown } | null | undefined)?.pages;
  if (!Array.isArray(pages)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const page of pages) {
    try {
      const pageRows = JSON.parse(await readFile(path.join(directory, String(page)), 'utf8')).rows;
      if (!Array.isArray(pageRows)) return null;
      pageRows.forEach((row: unknown) => { if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>); });
    } catch {
      return null;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// (e) Official performance file (etf_performance.csv)
// ---------------------------------------------------------------------------

export type PerformanceRow = {
  basis: 'NAV' | 'MARKET';
  period: 'MONTH' | 'QUARTER';
  asOfDate: string;
  inceptionDate: string;
  mo1: number | null;
  mo3: number | null;
  mo6: number | null;
  ytd: number | null;
  yr1: number | null;
  yr3: number | null;
  yr5: number | null;
  yr10: number | null;
  sinceInception: number | null;
};

export function parsePerformanceFile(text: string): Map<string, PerformanceRow> {
  const records = parseCsvRecords(text);
  const map = new Map<string, PerformanceRow>();
  if (!records.length) return map;
  const index = headerIndex(records[0]);
  requireHeaders(index, 'performance file', [
    ['Fund Symbol'], ['Return Type'], ['Data Period'], ['Return Effective Date'], ['Inception Date'],
    ['1-Month Return', '1 Month Return'], ['3-Month Return', '3 Month Return'], ['6-Month Return', '6 Month Return'],
    ['Year-To-Date Return', 'Year To Date Return'], ['1-Year Return', '1 Year Return'], ['3-Year Return', '3 Year Return'],
    ['5-Year Return', '5 Year Return'], ['10-Year Return', '10 Year Return'], ['Return Since Inception'],
  ]);
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const symbol = cleanText(cellAt(row, index, 'Fund Symbol')).toUpperCase();
    const basis = cleanText(cellAt(row, index, 'Return Type')).toUpperCase();
    const period = cleanText(cellAt(row, index, 'Data Period')).toUpperCase();
    if (!symbol || !['NAV', 'MARKET'].includes(basis) || !['MONTH', 'QUARTER'].includes(period)) continue;
    map.set(`${symbol}|${basis}|${period}`, {
      basis: basis as 'NAV' | 'MARKET',
      period: period as 'MONTH' | 'QUARTER',
      asOfDate: formatUsDate(cellAt(row, index, 'Return Effective Date')),
      inceptionDate: formatUsDate(cellAt(row, index, 'Inception Date')),
      mo1: numberOrNull(cellAt(row, index, '1-Month Return', '1 Month Return')),
      mo3: numberOrNull(cellAt(row, index, '3-Month Return', '3 Month Return')),
      mo6: numberOrNull(cellAt(row, index, '6-Month Return', '6 Month Return')),
      ytd: numberOrNull(cellAt(row, index, 'Year-To-Date Return', 'Year To Date Return')),
      yr1: numberOrNull(cellAt(row, index, '1-Year Return', '1 Year Return')),
      yr3: numberOrNull(cellAt(row, index, '3-Year Return', '3 Year Return')),
      yr5: numberOrNull(cellAt(row, index, '5-Year Return', '5 Year Return')),
      yr10: numberOrNull(cellAt(row, index, '10-Year Return', '10 Year Return')),
      sinceInception: numberOrNull(cellAt(row, index, 'Return Since Inception')),
    });
  }
  return map;
}

/** ProShares publishes annualized tenors; the cumulative twin is derived. */
export function cumulativeFromAnnualized(annualized: number | null, years: number): number | null {
  if (annualized === null || !Number.isFinite(annualized)) return null;
  const factor = (1 + annualized / 100) ** years;
  if (!Number.isFinite(factor)) return null;
  return round((factor - 1) * 100, 4);
}

// ---------------------------------------------------------------------------
// (f) Official splits file
// ---------------------------------------------------------------------------

export type SplitRow = { date: string; splitType: string; ratio: number | null; preSplitCusip: string; postSplitCusip: string };

export function parseSplitsFile(text: string): Map<string, SplitRow[]> {
  const records = parseCsvRecords(text);
  const map = new Map<string, SplitRow[]>();
  if (!records.length) return map;
  const index = headerIndex(records[0]);
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const symbol = cleanText(cellAt(row, index, 'Symbol')).toUpperCase();
    if (!symbol) continue;
    const list = map.get(symbol) || [];
    list.push({
      date: formatUsDate(cellAt(row, index, 'Date of Split')),
      splitType: cleanText(cellAt(row, index, 'Split Type')),
      ratio: numberOrNull(cellAt(row, index, 'Ratio')),
      preSplitCusip: cleanText(cellAt(row, index, 'Pre Split Cusip')),
      postSplitCusip: cleanText(cellAt(row, index, 'Post Split Cusip')),
    });
    map.set(symbol, list);
  }
  for (const list of map.values()) list.sort((a, b) => compareDisplayDates(b.date, a.date));
  return map;
}

// ---------------------------------------------------------------------------
// (g) Official distribution summary JSON
// ---------------------------------------------------------------------------

export type DistributionRow = {
  exDate: string;
  recordDate: string;
  payableDate: string;
  dividend: number | null;
  shortTermCapGains: number | null;
  longTermCapGains: number | null;
  returnOfCapital: number | null;
  special: number | null;
  other: number | null;
};

export function distributionSummaryUrl(ticker: string, year: number): string {
  return `${PROSHARES_SITE}/api/distributionsummary?fund=${encodeURIComponent(ticker)}&year=${year}`;
}

/**
 * The endpoint answers `[]` (HTTP 200, JSON) for a year without payouts, also before inception (checked live 2026-10-26: COIA,
 * launched 2025, asked for 2015). An empty body is an empty year too. Anything else that is not a JSON array (an HTML block
 * page, an error object) throws, so the year counts as failed and the published rows are kept instead of dropped.
 */
export function parseDistributionSummary(text: string): DistributionRow[] {
  const body = String(text ?? '').trim();
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`distribution summary is not JSON: ${cleanText(stripTags(body)).slice(0, 60) || 'markup only'}`);
  }
  if (!Array.isArray(parsed)) throw new Error('distribution summary is not a JSON array');
  return parsed
    .map(entry => {
      const record = entry as Record<string, unknown>;
      return {
        exDate: formatUsDate(record.ExDate),
        recordDate: formatUsDate(record.RecordDate),
        payableDate: formatUsDate(record.PayableDate),
        dividend: numberOrNull(record.Dividend ?? record.CashDividendPerShare),
        shortTermCapGains: numberOrNull(record.ShortTermCapGains),
        longTermCapGains: numberOrNull(record.LongTermCapGains),
        returnOfCapital: numberOrNull(record.ReturnOfCapital),
        special: numberOrNull(record.SpecialPerShare),
        other: numberOrNull(record.OtherPerShare),
      } satisfies DistributionRow;
    })
    .filter(row => row.exDate !== '—' || row.dividend !== null)
    .sort((a, b) => compareDisplayDates(a.exDate, b.exDate));
}

export const DISTRIBUTION_HEADERS = [
  'Ex-Date',
  'Record Date',
  'Payable Date',
  'Dividend',
  'ST Cap Gains',
  'LT Cap Gains',
  'Return of Capital',
];

function moneyCell(value: number | null): string {
  return value === null ? '—' : value.toFixed(6);
}

function dateCell(value: string): string {
  if (!value || value === '—') return '—';
  const iso = calendarIso(value);
  if (!iso) return value;
  return `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
}

export function distributionRowsForCsv(rows: DistributionRow[]): Record<string, string>[] {
  return rows.map(row => ({
    'Ex-Date': dateCell(row.exDate),
    'Record Date': dateCell(row.recordDate),
    'Payable Date': dateCell(row.payableDate),
    Dividend: moneyCell(row.dividend),
    'ST Cap Gains': moneyCell(row.shortTermCapGains),
    'LT Cap Gains': moneyCell(row.longTermCapGains),
    'Return of Capital': moneyCell(row.returnOfCapital),
  }));
}

// Older distribution years are immutable history. A fund that already publishes distributions re-reads only the
// current and the previous calendar year; the older published rows are kept and merged. A full walk of every year
// happens when nothing is published yet, when a published row cannot be read back, or when the published
// `distributions.refreshedAt` is older than DISTRIBUTION_REFRESH_DAYS plus a per-ticker stagger of up to
// DISTRIBUTION_REFRESH_STAGGER_DAYS (so the funds do not all refresh in the same run).
export const DISTRIBUTION_REFRESH_DAYS = 90;
export const DISTRIBUTION_REFRESH_STAGGER_DAYS = 30;

/** Published CSV rows (`26-Dec-2017`, `0.212820`, `—`) back to DistributionRow; null when any row is unreadable. */
export function readPublishedDistributions(rows: unknown): DistributionRow[] | null {
  if (!Array.isArray(rows)) return null;
  const money = (cell: unknown): number | null => (cell === '—' || cell === undefined || cell === null ? null : numberOrNull(cell));
  const out: DistributionRow[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const exDate = formatUsDate(row?.['Ex-Date']);
    if (exDate === '—' || Number.isNaN(calendarEpoch(exDate))) return null;
    out.push({
      exDate,
      recordDate: formatUsDate(row['Record Date']),
      payableDate: formatUsDate(row['Payable Date']),
      dividend: money(row.Dividend),
      shortTermCapGains: money(row['ST Cap Gains']),
      longTermCapGains: money(row['LT Cap Gains']),
      returnOfCapital: money(row['Return of Capital']),
      special: null,
      other: null,
    });
  }
  return out;
}

export function distributionRefreshDue(ticker: string, refreshedAt: unknown, now: Date): boolean {
  const refreshed = typeof refreshedAt === 'string' ? Date.parse(`${refreshedAt.slice(0, 10)}T00:00:00Z`) : NaN;
  if (Number.isNaN(refreshed)) return false; // unknown stamp on a published feed: backfilled by the caller, not a reason for a full walk
  const stagger = [...ticker].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % DISTRIBUTION_REFRESH_STAGGER_DAYS, 0);
  return now.getTime() - refreshed >= (DISTRIBUTION_REFRESH_DAYS + stagger) * 86_400_000;
}

export type DistributionFetch = { rows: DistributionRow[]; failed: boolean; full: boolean; requests: number; refreshedAt: string | null };

/**
 * Distribution history of one fund. `published` is the previous meta.distributions block (rows + refreshedAt) or null.
 * Full walk: every year down to DISTRIBUTION_YEARS, stopping after two empty years. Recent mode: current and previous
 * year from the endpoint. In both modes the published rows older than the last year asked are merged back.
 */
export async function fetchDistributions(
  ticker: string,
  config: UpdaterConfig,
  published: { rows?: unknown; refreshedAt?: unknown } | null,
  now: Date = new Date(),
): Promise<DistributionFetch> {
  const currentYear = now.getUTCFullYear();
  const today = now.toISOString().slice(0, 10);
  const kept = published ? readPublishedDistributions(published.rows) : null;
  const previousStamp = typeof published?.refreshedAt === 'string' && published.refreshedAt ? published.refreshedAt : null;
  const recent = Boolean(kept && kept.length > 0 && !distributionRefreshDue(ticker, previousStamp, now));
  const span = recent ? Math.min(1, config.distributionYears) : config.distributionYears;
  const rows: DistributionRow[] = [];
  let failed = false;
  let requests = 0;
  let emptyYears = 0;
  let lastYear = currentYear;
  for (let year = currentYear; year >= currentYear - span; year--) {
    lastYear = year;
    requests++;
    try {
      const text = await fetchText(
        distributionSummaryUrl(ticker, year),
        jsonHeaders(),
        config,
        `${ticker} distributions ${year}`,
        rows.length === 0 && year === currentYear ? `distributions-${ticker}-${year}.json` : '',
      );
      const parsed = parseDistributionSummary(text);
      if (parsed.length) {
        emptyYears = 0;
        rows.push(...parsed);
      } else {
        emptyYears++;
      }
    } catch (error) {
      outputNote(`${ticker}: distributions ${year} failed - ${errorMessage(error)}`);
      failed = true;
      emptyYears++;
    }
    if (!recent && emptyYears >= 2) break;
  }
  // Published years older than the last year asked are history the endpoint was not asked about: kept in both modes (a full
  // walk stops after two empty years, so a fund that paid only years ago would otherwise lose its whole table).
  if (kept) {
    const oldest = currentYear - config.distributionYears;
    for (const row of kept) {
      const year = Number((calendarIso(row.exDate) ?? '').slice(0, 4));
      if (year < lastYear && year >= oldest) rows.push(row);
    }
  }
  rows.sort((a, b) => compareDisplayDates(a.exDate, b.exDate));
  // The stamp moves only with a full walk; a recent-only run keeps it, or backfills it once for a feed built by full walks.
  const refreshedAt = recent ? previousStamp ?? today : failed ? previousStamp : today;
  return { rows, failed, full: !recent, requests, refreshedAt };
}

const FREQUENCY_PAYMENTS: Record<string, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  'semi-annual': 2,
  semiannually: 2,
  'semi-annually': 2,
  semiannual: 2,
  annual: 1,
  annually: 1,
};

export function normalizeDistributionFrequency(label: unknown): string {
  const raw = cleanText(label);
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
  if (!normalized) return '—';
  if (normalized === 'weekly') return 'Weekly';
  if (normalized === 'monthly') return 'Monthly';
  if (normalized === 'quarterly') return 'Quarterly';
  if (['semi-annual', 'semi-annually', 'semiannual'].includes(normalized)) return 'Semi-annually';
  if (['annual', 'annually'].includes(normalized)) return 'Annually';
  if (normalized === 'none') return 'None';
  if (normalized === 'irregular') return 'Irregular';
  if (normalized === 'unknown') return 'Unknown';
  return raw;
}

export function paymentsPerYear(frequency: string): number | null {
  return FREQUENCY_PAYMENTS[cleanText(frequency).toLowerCase()] ?? null;
}

/** Indicated yield: latest distribution x payments per year / NAV (labelled). */
export function indicatedYield(latest: number | null, frequency: string, nav: number | null): number | null {
  if (latest === null || nav === null || nav <= 0) return null;
  const payments = paymentsPerYear(frequency);
  if (!payments) return null;
  return round(((latest * payments) / nav) * 100, 4);
}

/** Same published-or-indicated basis for the feed AND its DIVIDEND_YIELD filter. */
export function resolveDividendYield(published: number | null, latest: number | null, frequency: string, nav: number | null): { indicated: number | null; effective: number | null } {
  const indicated = indicatedYield(latest, frequency, nav);
  return { indicated, effective: published ?? indicated };
}

// ---------------------------------------------------------------------------
// (h) Nasdaq Trader symbol directory (listing exchange, Overview only)
// ---------------------------------------------------------------------------

export function parseSymbolDirectory(text: string, exchangeByCode: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.split('|');
    if (cells.length < 3) continue;
    const ticker = cleanText(cells[0]).toUpperCase();
    if (!ticker || ticker === 'ACT SYMBOL' || ticker.startsWith('File Creation Time')) continue;
    const exchange = exchangeByCode[cleanText(cells[2]).toUpperCase()] || cleanText(cells[2]);
    if (exchange && !map.has(ticker)) map.set(ticker, exchange);
  }
  return map;
}

/** Security names of a Nasdaq Trader symbol directory file (nasdaqlisted.txt or otherlisted.txt): ticker -> name, CQS dots kept. */
export function parseSymbolNames(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.split('|');
    if (cells.length < 3) continue;
    const ticker = cleanText(cells[0]).toUpperCase();
    if (!ticker || ticker === 'ACT SYMBOL' || ticker === 'SYMBOL' || ticker.startsWith('FILE CREATION TIME')) continue;
    if (!map.has(ticker)) map.set(ticker, cleanText(cells[1]));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Deterministic writes (content-compare before touching a file)
// ---------------------------------------------------------------------------

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

export async function writeIfChanged(file: string, contents: string): Promise<'written' | 'unchanged'> {
  if (existsSync(file)) {
    const previous = await readFile(file, 'utf8');
    if (previous === contents) return 'unchanged';
  }
  await atomicWrite(file, contents);
  return 'written';
}

/** tmp file + rename, so a killed run never leaves a truncated JSON file. */
export async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, file);
}

// catalogReadAt/generatedAt are freshly stamped every run, so a raw text
// comparison (writeIfChanged) would rewrite a fund's meta.json on every run
// even when its actual data is identical. catalogReadAt lives nested inside
// meta.source, not at the top level, so the exclusion has to recurse — same
// as outputStable() already does for the console's unchanged/updated label.
export function samePublishedContent(previous: string, value: unknown): boolean {
  const withoutRunTimestamp = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(withoutRunTimestamp);
    if (!item || typeof item !== 'object') return item;
    const { generatedAt, catalogReadAt, savedAt, ...content } = item as Record<string, unknown>;
    return Object.fromEntries(Object.entries(content).map(([key, val]) => [key, withoutRunTimestamp(val)]));
  };
  try {
    return JSON.stringify(withoutRunTimestamp(JSON.parse(previous))) === JSON.stringify(withoutRunTimestamp(value));
  } catch { return false; }
}

export async function writeJsonIfChanged(file: string, value: unknown): Promise<'written' | 'unchanged'> {
  const text = serialize(value);
  if (existsSync(file)) {
    const previous = await readFile(file, 'utf8');
    if (previous === text || samePublishedContent(previous, value)) return 'unchanged';
  }
  await atomicWrite(file, text);
  return 'written';
}

export function pageName(page: number): string {
  return `${String(page).padStart(3, '0')}.json`;
}

export type SheetWriteResult = { manifest: { pages: string[]; pageSize: number; totalRows: number }; written: number; removed: number };

/**
 * Writes `holdings/001.json…` pages only when their bytes change and removes
 * pages the current row count no longer needs, so an unchanged run leaves the
 * working tree alone.
 */
export async function writeSheetPages(
  fundDirectory: string,
  sheet: 'holdings' | 'history',
  ticker: string,
  headers: string[],
  rows: Record<string, string>[],
  pageSize: number,
  prune = true,
): Promise<SheetWriteResult> {
  const directory = path.join(fundDirectory, sheet);
  const pageCount = Math.max(0, Math.ceil(rows.length / pageSize));
  let written = 0;
  let removed = 0;
  const pages: string[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    const envelope = {
      ticker,
      page,
      pageSize,
      totalRows: rows.length,
      headers,
      rows: slice,
    };
    const relative = `./${sheet}/${pageName(page)}`;
    const result = await writeIfChanged(path.join(directory, pageName(page)), serialize(envelope));
    if (result === 'written') written++;
    pages.push(relative);
  }
  if (prune) removed = await pruneSheetPages(directory, pageCount);
  return { manifest: { pages, pageSize, totalRows: rows.length }, written, removed };
}

/** Removes pages beyond the current page count; called only after the new meta.json is written. */
export async function pruneSheetPages(directory: string, pageCount: number): Promise<number> {
  let removed = 0;
  if (!existsSync(directory)) return removed;
  for (const file of await readdir(directory)) {
    const match = /^(\d{3})\.json$/.exec(file);
    if (!match) continue;
    if (Number(match[1]) <= pageCount) continue;
    await rm(path.join(directory, file));
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Feed assembly
// ---------------------------------------------------------------------------

export type FundArtifacts = {
  entry: Record<string, unknown>;
  meta: Record<string, unknown>;
  holdingsHeaders: string[];
  holdingsRows: Record<string, string>[];
  historyHeaders: string[];
  historyRows: Record<string, string>[];
  changed: boolean;
};

function documentsFor(ticker: string): Record<string, string> {
  const lower = ticker.toLowerCase();
  const viewer = (label: string) => `${PROSHARES_SITE}/regulatory-document-viewer-page?ticker=${ticker}&document-label=${label}`;
  return {
    factSheet: `${PROSHARES_SITE}/globalassets/proshares/fact-sheet/prosharesfactsheet${lower}.pdf`,
    fundProfile: `${PROSHARES_SITE}/globalassets/proshares/fund-profile/proshares_profile_${lower}.pdf`,
    summaryProspectus: viewer('summary-prospectus'),
    statutoryProspectus: viewer('statutory-prospectus'),
    sai: viewer('statement-of-additional-information'),
    annualReport: viewer('annual-report'),
    semiAnnualReport: viewer('semi-annual-report'),
  };
}

function performanceBlock(row: PerformanceRow | undefined): Record<string, unknown> {
  if (!row) {
    return { asOfDate: '—', mo1: null, qtd: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
  }
  const block: Record<string, unknown> = {
    asOfDate: row.asOfDate || '—',
    inceptionDate: row.inceptionDate || '—',
    mo1: row.mo1,
    mo3: row.mo3,
    mo6: row.mo6,
    ytd: row.ytd,
    yr1: row.yr1,
    yr3: row.yr3,
    yr5: row.yr5,
    yr10: row.yr10,
    sinceInception: row.sinceInception,
    mo1Text: formatPercentText(row.mo1),
    ytdText: formatPercentText(row.ytd),
    yr1Text: formatPercentText(row.yr1),
    yr3Text: formatPercentText(row.yr3),
    yr5Text: formatPercentText(row.yr5),
    yr10Text: formatPercentText(row.yr10),
    sinceInceptionText: formatPercentText(row.sinceInception),
  };
  return block;
}

/**
 * A horizon is published only when the fund is at least that old at the table date (a young fund must show null,
 * never a placeholder 0): the shared calendar-anniversary rule (fundAgeAtLeast, inclusive). Unknown inception or table
 * date keeps the provider value.
 */
export function tenorAvailable(row: PerformanceRow | undefined, years: number): boolean {
  return Boolean(row) && fundAgeAtLeast(row?.inceptionDate, row?.asOfDate, years);
}

/** ISO date of the official month-end performance table row (not the NAV date), or null when unknown. */
export function performanceAsOfIso(row: PerformanceRow | undefined): string | null {
  const iso = toIsoDate(row?.asOfDate && row.asOfDate !== '—' ? row.asOfDate : '');
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

export function buildFeed(inputs: {
  fund: CatalogFund;
  page: FundPageData;
  performanceNavMonth: PerformanceRow | undefined;
  performanceMarketMonth: PerformanceRow | undefined;
  performanceNavQuarter: PerformanceRow | undefined;
  performanceMarketQuarter: PerformanceRow | undefined;
  navRows: NavRow[];
  holdingsRows: HoldingsRow[];
  holdingsAsOf: string;
  holdingsSourceLabel: string;
  distributions: DistributionRow[];
  distributionsRefreshedAt?: string | null;
  exchange: string;
  exchangeSource: string;
  /** U.S. listings of the Nasdaq Trader symbol directory (ticker -> name), null when it failed this run. */
  usListings?: ReadonlyMap<string, string> | null;
  splits: SplitRow[];
  config: UpdaterConfig;
  catalogReadAt: string;
}): FundArtifacts {
  const {
    fund, page, performanceNavMonth, performanceNavQuarter, performanceMarketMonth, performanceMarketQuarter,
    navRows, holdingsRows, holdingsAsOf, holdingsSourceLabel, distributions, distributionsRefreshedAt, exchange, exchangeSource, splits, config, catalogReadAt,
  } = inputs;

  const orderedNavRows = [...navRows].sort((a, b) => compareDisplayDates(a.date, b.date));
  const latest = orderedNavRows.length ? orderedNavRows[orderedNavRows.length - 1] : null;
  const netAssets = latest?.netAssets ?? page.netAssetsValue ?? fund.netAssetsValue ?? null;
  const nav = numberOrNull(page.navText) ?? latest?.nav ?? null;
  const marketPrice = page.marketPrice ?? null;
  const premiumDiscountValue = nav && marketPrice ? round(((marketPrice - nav) / nav) * 100, 4) : null;
  const asOfDate = page.priceAsOf && page.priceAsOf !== '—' ? page.priceAsOf : latest?.date || '—';
  const frequency = normalizeDistributionFrequency(page.distributionFrequency);
  const latestDistribution = distributions.length ? distributions[distributions.length - 1] : null;
  const payments = paymentsPerYear(frequency);
  // The Yield the site publishes: the official 12-Month Yield where ProShares
  // prints one (strategic pages), otherwise the indicated yield computed from
  // the latest official distribution. Funds that never distributed keep '—'.
  const publishedYield = page.twelveMonthYield;
  const { indicated, effective: effectiveYield } = resolveDividendYield(publishedYield, latestDistribution?.dividend ?? null, frequency, nav);
  const effectiveYieldBasis = publishedYield !== null
    ? 'official ProShares 12-Month Yield (page distributions block)'
    : indicated !== null
      ? 'indicated yield computed by the updater from the latest official distribution (ProShares publishes no 12-Month Yield for this fund)'
      : distributions.length
        ? payments === null
          ? 'not published by ProShares; official distributions exist but no payment frequency is published (cannot annualize without guessing)'
          : 'not published by ProShares; no usable recent dividend amount to annualize (data limitation)'
        : 'not published by ProShares and no distributions yet (data limitation)';
  const secYieldKind = page.sec30DayYield === null
    ? 'not published on this fund page (data limitation)'
    : 'official ProShares SEC 30-Day Yield (page distributions block)';
  const holdingsCsvHeaders = holdingsHeaders(holdingsRows);
  const holdingsCsvRows = holdingsRowsForCsv(holdingsRows, holdingsCsvHeaders, inputs.usListings ?? null);

  const historyHeaders = ['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets'];
  const historyRows = orderedNavRows.map(row => ({
    Date: row.date,
    NAV: row.nav === null ? '—' : String(row.nav),
    'Shares Outstanding': row.sharesOutstanding === null ? '—' : String(row.sharesOutstanding),
    'Total Net Assets': row.netAssets === null ? '—' : String(row.netAssets),
  }));

  const distributionCsvRows = distributionRowsForCsv(distributions);
  const navMonth = performanceBlock(performanceNavMonth);
  const navQuarter = performanceBlock(performanceNavQuarter);
  const marketMonth = performanceBlock(performanceMarketMonth);
  const marketQuarter = performanceBlock(performanceMarketQuarter);

  const tenor = (value: number | null | undefined, years: number): number | null => (tenorAvailable(performanceNavMonth, years) ? value ?? null : null);
  const metrics = {
    ytd: performanceNavMonth?.ytd ?? null,
    tr1y: tenor(performanceNavMonth?.yr1, 1),
    tr3y: cumulativeFromAnnualized(tenor(performanceNavMonth?.yr3, 3), 3),
    tr5y: cumulativeFromAnnualized(tenor(performanceNavMonth?.yr5, 5), 5),
    tr10y: cumulativeFromAnnualized(tenor(performanceNavMonth?.yr10, 10), 10),
    cagr3y: tenor(performanceNavMonth?.yr3, 3),
    cagr5y: tenor(performanceNavMonth?.yr5, 5),
    cagr10y: tenor(performanceNavMonth?.yr10, 10),
    siAnn: tenorAvailable(performanceNavMonth, 1) ? performanceNavMonth?.sinceInception ?? null : null,
    dividendYield: effectiveYield,
    dividendYieldText: formatPercentText(effectiveYield),
    dividendYieldBasis: dividendYieldBasisCode(publishedYield, indicated),
    dividendYieldBasisText: effectiveYieldBasis,
    dividendYieldComputed: publishedYield === null && indicated !== null,
    secYield: page.sec30DayYield,
    secYieldText: page.sec30DayYieldText,
    secYieldKind,
    returnsBasis: 'official ProShares performance file (etf_performance.csv, NAV total return, month-end)',
    performanceAsOf: performanceAsOfIso(performanceNavMonth),
  };

  const entry: Record<string, unknown> = {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.assetClass || 'ETF',
    marketingCategory: fund.marketingCategory,
    strategy: fund.strategy,
    dailyObjective: fund.dailyObjective,
    benchmark: fund.benchmark,
    fundPage: fund.fundPage,
    dataFile: `./funds/${fund.ticker}/meta.json`,
    cusip: page.cusip || null,
    isin: null,
    ter: page.netExpenseRatioText || page.expenseRatioText || '—',
    terValue: page.netExpenseRatio ?? page.expenseRatio,
    terGross: page.grossExpenseRatioText || page.netExpenseRatioText || page.expenseRatioText || '—',
    terGrossValue: page.grossExpenseRatio ?? page.netExpenseRatio ?? page.expenseRatio,
    terNet: page.netExpenseRatioText || page.expenseRatioText || '—',
    terNetValue: page.netExpenseRatio ?? page.expenseRatio,
    nav: nav === null ? '—' : `$${nav.toFixed(2)}`,
    navValue: nav,
    aum: formatAumDisplay(netAssets),
    aumValue: netAssets,
    asOfDate,
    netAssetsAsOf: latest?.netAssets != null ? latest.date : page.priceAsOf || '—',
    inceptionDate: page.inceptionDate || fund.inceptionDateText || '—',
    exchange: exchange || '—',
    closePrice: marketPrice === null ? '—' : `$${marketPrice.toFixed(2)}`,
    closePriceValue: marketPrice,
    premiumDiscount: premiumDiscountValue === null ? '—' : `${premiumDiscountValue.toFixed(2)}%`,
    premiumDiscountValue,
    distributions: {
      frequency: frequency === '—' ? '—' : frequency,
      note: page.distributionsNote || null,
      exDate: latestDistribution?.exDate && latestDistribution.exDate !== '—' ? latestDistribution.exDate : '—',
      dividend: latestDistribution?.dividend === null || latestDistribution?.dividend === undefined
        ? '—'
        : latestDistribution.dividend.toFixed(4),
    },
    distributionFrequency: frequency,
    returns: {
      monthEnd: { ...navMonth, marketPrice: marketMonth },
      quarterEnd: { ...navQuarter, marketPrice: marketQuarter },
    },
    metrics,
    holdings: holdingsCsvRows.length,
    history: historyRows.length,
  };

  const meta: Record<string, unknown> = {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.assetClass || 'ETF',
    categoryPath: [fund.assetClass, fund.marketingCategory || fund.strategy].filter(Boolean).join(' > '),
    source: {
      fundPage: fund.fundPage,
      fundFinder: fund.kind === 'strategic' ? STRATEGIC_FINDER_URL : GEARED_FINDER_URL,
      holdingsDownload: `${PROSHARES_DATA_HOST}/ByFund/${fund.ticker}-psdlyhld.csv`,
      holdingsAll: HOLDINGS_ALL_URL,
      historyDownload: navHistoryUrl(fund.ticker),
      historyAll: NAV_HISTORY_ALL_URL,
      performanceFile: PERFORMANCE_URL,
      splitsFile: SPLITS_URL,
      distributionsApi: distributionSummaryUrl(fund.ticker, new Date().getUTCFullYear()),
      exchangeSource,
      holdingsSource: holdingsSourceLabel,
      historySource: `official ProShares NAV history file (ByFund/${fund.ticker}-historical_nav.csv)`,
      provider: 'ProShares public fund pages and the official ProShares/ProFunds data host',
      catalogReadAt,
      secYield: secYieldKind,
    },
    identifiers: {
      cusip: page.cusip || null,
      isin: null,
      indexTicker: fund.benchmarkTicker || null,
      indexName: fund.benchmark || null,
      sedolNote: 'positions identify by SEDOL (Security Sedol) in the official holdings file',
    },
    expenseRatio: {
      display: page.netExpenseRatioText || page.expenseRatioText || '—',
      value: page.netExpenseRatio ?? page.expenseRatio,
      gross: { display: page.grossExpenseRatioText || '—', value: page.grossExpenseRatio },
      net: { display: page.netExpenseRatioText || '—', value: page.netExpenseRatio },
      footnote: page.expenseRatioFootnote || null,
      note: page.grossExpenseRatio !== null && page.grossExpenseRatio !== page.netExpenseRatio
        ? 'ProShares publishes a gross and a net expense ratio for this fund; the feed headline is the net ratio'
        : 'ProShares publishes a single expense ratio for this fund',
    },
    nav: { display: nav === null ? '—' : `$${nav.toFixed(2)}`, value: nav, asOfDate },
    marketPrice: { display: marketPrice === null ? '—' : `$${marketPrice.toFixed(2)}`, value: marketPrice, asOfDate },
    premiumDiscount: {
      display: premiumDiscountValue === null ? '—' : `${premiumDiscountValue.toFixed(2)}%`,
      value: premiumDiscountValue,
      computed: true,
      formula: '(market price − NAV) / NAV',
    },
    aum: {
      display: formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate: latest?.netAssets != null ? latest.date : page.priceAsOf || '—',
      source: latest?.netAssets != null ? 'official ProShares NAV history file (Assets Under Management); display and value share this one source and date' : 'fund page Net Assets (the NAV history file had no value)',
    },
    yields: {
      dividendYield: page.twelveMonthYield,
      dividendYieldText: page.twelveMonthYieldText,
      dividendYieldKind: 'official ProShares 12-Month Yield (sum of the last 12 months of dividends / the last month\'s NAV plus capital-gain distributions)',
      effectiveYield,
      effectiveYieldText: formatPercentText(effectiveYield),
      effectiveYieldBasis,
      effectiveYieldBasisCode: dividendYieldBasisCode(publishedYield, indicated),
      effectiveYieldComputed: publishedYield === null && indicated !== null,
      distributionYield: null,
      distributionYieldText: null,
      yield12M: page.twelveMonthYield,
      yield12MText: page.twelveMonthYieldText,
      indicatedYield: indicated,
      indicatedYieldText: formatPercentText(indicated),
      secYield: page.sec30DayYield,
      secYieldText: page.sec30DayYieldText,
      secYieldKind,
    },
    returns: {
      derivedFrom: 'official ProShares performance file (etf_performance.csv); cumulative tenors derived as (1 + annualized)^n − 1; market-price basis kept alongside',
      monthEnd: { ...navMonth, marketPrice: marketMonth },
      quarterEnd: { ...navQuarter, marketPrice: marketQuarter },
    },
    distributions: {
      frequency,
      paymentsPerYear: payments,
      headers: DISTRIBUTION_HEADERS,
      rows: distributionCsvRows,
      ...(distributionsRefreshedAt ? { refreshedAt: distributionsRefreshedAt } : {}),
      asOfDate: page.distributionsAsOf || '—',
      source: `${PROSHARES_SITE}/api/distributionsummary (official, year-scoped)`,
    },
    holdings: {
      pageSize: config.holdingsPageSize,
      totalRows: holdingsCsvRows.length,
      asOfDate: holdingsAsOf || '—',
      asOf: holdingsAsOf ? toIsoDate(holdingsAsOf) : '—',
      headers: holdingsCsvHeaders,
      source: holdingsSourceLabel,
      weightNote: 'Weight reproduces the fund page weight column: the position value (market value, or notional exposure for futures and swaps) divided by the fund total net assets in the same official file. The residual Net Other Assets line and its cash equivalents (Treasury bills, the ProShares money-market fund) carry no weight on the fund pages and stay blank.',
    },
    history: {
      pageSize: config.historyPageSize,
      totalRows: historyRows.length,
      asOf: latest?.date || '—',
      asOfDate: latest?.date || '—',
      headers: historyHeaders,
      source: `official ProShares NAV history file (ByFund/${fund.ticker}-historical_nav.csv)`,
    },
    officialMetrics: {
      characteristics: page.characteristics,
      characteristicsAsOf: page.characteristicsAsOf,
      index: page.indexStats,
      indexAsOf: page.indexAsOf,
      geared: { strategy: fund.strategy, dailyObjective: fund.dailyObjective, benchmark: fund.benchmark },
      splits,
      exposures: fund.ticker ? page.exposures : [],
    },
    documents: documentsFor(fund.ticker),
  };

  return {
    entry,
    meta,
    holdingsHeaders: holdingsCsvHeaders,
    holdingsRows: holdingsCsvRows,
    historyHeaders,
    historyRows,
    changed: false,
  };
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

type Stats = { updated: number; unchanged: number; skipped: number; failed: number; filtered: number };

/** Stable catalog position, even when concurrent workers finish out of order. */
export function progressLabel(ticker: string, position: number, total: number): string {
  return `[${String(position).padStart(Math.max(3, String(total).length) + 1)}/${total}] ${ticker}`;
}

export function formatElapsed(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

export function formatRetry(label: string, error: string, backoffSeconds: number, attempt: number, maxRetries: number): string {
  return `[retry] ${label} → ${error}, backoff ${backoffSeconds}s (attempt ${attempt}/${maxRetries})`;
}

/** Presentation only: never alter the entry/metadata written to the static feed. */
export function formatFundProgress(label: string, entry: Record<string, unknown>, changed: boolean, milliseconds: number): string {
  const visible = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value !== '—';
  const metrics = entry.metrics as Record<string, unknown> | undefined;
  const fields: string[] = [];
  if (visible(entry.nav)) fields.push(`NAV ${entry.nav}`);
  const aum = numberOrNull(entry.aumValue);
  if (aum !== null) fields.push(`AUM ${formatMoneyText(aum)}`);
  if (visible(entry.ter)) fields.push(`TER ${entry.ter}`);
  if (visible(metrics?.dividendYieldText)) fields.push(`DivYld ${metrics.dividendYieldText}`);
  if (visible(entry.distributionFrequency) && entry.distributionFrequency !== '00 - None') {
    fields.push(`Freq ${entry.distributionFrequency}`);
  }
  fields.push(`holdings ${entry.holdings ?? 0}`, `history ${entry.history ?? 0}`, formatElapsed(milliseconds));
  return `${label} ok${changed ? '' : ' (unchanged)'} · ${fields.join(' · ')}`;
}

const EXCHANGE_CODES: Record<string, string> = {
  A: 'NYSE American',
  N: 'NYSE',
  P: 'NYSE Arca',
  Z: 'Cboe BZX',
  V: 'IEX',
  Q: 'Nasdaq',
  G: 'Nasdaq',
  S: 'Nasdaq',
};

export async function readPreviousIndex(): Promise<{ generatedAt: string; funds: Record<string, Record<string, unknown>> }> {
  const indexFile = path.join(API_ROOT, 'index.json');
  if (!existsSync(indexFile)) return { generatedAt: '', funds: {} };
  try {
    const parsed = JSON.parse(await readFile(indexFile, 'utf8')) as Record<string, unknown>;
    const funds: Record<string, Record<string, unknown>> = {};
    for (const fund of (parsed.funds as Record<string, unknown>[]) || []) {
      if (fund && typeof fund.ticker === 'string') funds[fund.ticker] = fund.metrics && typeof fund.metrics === 'object' ? { ...fund, metrics: migrateYieldBasis(fund.metrics as Record<string, any>) } : fund;
    }
    return { generatedAt: String(parsed.generatedAt || ''), funds };
  } catch {
    return { generatedAt: '', funds: {} };
  }
}

/** Identity of the catalog-level selection a cursor belongs to (a cursor from another selection is ignored). */
export function cursorScope(config: Pick<UpdaterConfig, 'tickers' | 'category' | 'aumRange'>): string {
  return JSON.stringify({ tickers: [...config.tickers].sort(), category: config.category.toLowerCase(), aum: config.aumRange ?? null });
}

export type DividendYieldBasis = 'official-trailing-12m' | 'official-distribution-rate' | 'official-other' | 'computed-trailing-12m' | 'indicated';

/** Short code for the definition behind dividendYield; null exactly when there is no yield. */
export function dividendYieldBasisCode(published: number | null, indicated: number | null): DividendYieldBasis | null {
  if (published !== null) return 'official-trailing-12m'; // the page 12-Month Yield
  return indicated !== null ? 'indicated' : null;
}

/**
 * Rows written before the code existed held the free text under dividendYieldBasis. Moves it to
 * dividendYieldBasisText and derives the code from it, so a kept row never pairs a yield with a wrong code.
 */
export function migrateYieldBasis(metrics: Record<string, any>): Record<string, any> {
  const raw = metrics.dividendYieldBasis;
  const codes: readonly string[] = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'];
  const text = typeof metrics.dividendYieldBasisText === 'string' ? metrics.dividendYieldBasisText : typeof raw === 'string' && !codes.includes(raw) ? raw : null;
  let code: string | null = typeof raw === 'string' && codes.includes(raw) ? raw : null;
  if (code === null && numberOrNull(metrics.dividendYield) !== null) {
    const t = String(text ?? '');
    code = t.startsWith('official ProShares 12-Month Yield') ? 'official-trailing-12m'
      : t.startsWith('indicated yield computed') || metrics.dividendYieldComputed === true ? 'indicated'
      : 'official-other';
  }
  if (numberOrNull(metrics.dividendYield) === null) code = null;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'dividendYieldBasisText') continue;
    out[key] = key === 'dividendYieldBasis' ? code : value;
    if (key === 'dividendYieldBasis') out.dividendYieldBasisText = text;
  }
  if (!('dividendYieldBasis' in metrics)) Object.assign(out, { dividendYieldBasis: code, dividendYieldBasisText: text });
  return out;
}

/** Index row rebuilt from a published meta.json, for funds that have files but no index row. */
export function rowFromMeta(meta: Record<string, any>): Record<string, unknown> {
  const ticker = String(meta.ticker);
  const monthEnd = meta.returns?.monthEnd ?? {};
  const num = (value: unknown): number | null => numberOrNull(value);
  const total = (value: unknown, years: number): number | null => cumulativeFromAnnualized(num(value), years);
  const geared = meta.officialMetrics?.geared ?? {};
  const asOf = toIsoDate(monthEnd.asOfDate && monthEnd.asOfDate !== '—' ? monthEnd.asOfDate : '');
  return {
    ticker,
    name: meta.name,
    category: meta.category || 'ETF',
    marketingCategory: String(meta.categoryPath || '').split(' > ')[1] || '',
    strategy: geared.strategy || '',
    dailyObjective: geared.dailyObjective || '',
    benchmark: geared.benchmark || '',
    fundPage: meta.source?.fundPage,
    dataFile: `./funds/${ticker}/meta.json`,
    cusip: meta.identifiers?.cusip || null,
    isin: null,
    ter: meta.expenseRatio?.display ?? '—',
    terValue: num(meta.expenseRatio?.value),
    terGross: meta.expenseRatio?.gross?.display ?? '—',
    terGrossValue: num(meta.expenseRatio?.gross?.value),
    terNet: meta.expenseRatio?.net?.display ?? '—',
    terNetValue: num(meta.expenseRatio?.net?.value),
    nav: meta.nav?.display ?? '—',
    navValue: num(meta.nav?.value),
    aum: meta.aum?.display ?? '—',
    aumValue: num(meta.aum?.value),
    asOfDate: meta.nav?.asOfDate ?? '—',
    netAssetsAsOf: meta.aum?.asOfDate ?? '—',
    inceptionDate: monthEnd.inceptionDate ?? '—',
    exchange: meta.source?.exchangeSource ?? '—',
    closePrice: meta.marketPrice?.display ?? '—',
    closePriceValue: num(meta.marketPrice?.value),
    premiumDiscount: meta.premiumDiscount?.display ?? '—',
    premiumDiscountValue: num(meta.premiumDiscount?.value),
    distributions: { frequency: meta.distributions?.frequency ?? '—', note: meta.distributions?.note ?? null, exDate: meta.distributions?.rows?.[meta.distributions.rows.length - 1]?.['Ex-Date'] ?? '—', dividend: '—' },
    distributionFrequency: meta.distributions?.frequency ?? '—',
    returns: meta.returns,
    metrics: migrateYieldBasis({
      ytd: num(monthEnd.ytd), tr1y: num(monthEnd.yr1), tr3y: total(monthEnd.yr3, 3), tr5y: total(monthEnd.yr5, 5), tr10y: total(monthEnd.yr10, 10),
      cagr3y: num(monthEnd.yr3), cagr5y: num(monthEnd.yr5), cagr10y: num(monthEnd.yr10), siAnn: num(monthEnd.sinceInception),
      dividendYield: num(meta.yields?.effectiveYield), dividendYieldText: meta.yields?.effectiveYieldText ?? '—',
      dividendYieldBasis: meta.yields?.effectiveYieldBasisCode ?? null, dividendYieldBasisText: meta.yields?.effectiveYieldBasis ?? null, dividendYieldComputed: meta.yields?.effectiveYieldComputed ?? null,
      secYield: num(meta.yields?.secYield), secYieldText: meta.yields?.secYieldText ?? '—', secYieldKind: meta.yields?.secYieldKind ?? null,
      returnsBasis: 'official ProShares performance file (etf_performance.csv, NAV total return, month-end)',
      performanceAsOf: /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null,
    }),
    holdings: num(meta.holdings?.totalRows) ?? 0,
    history: num(meta.history?.totalRows) ?? 0,
  };
}

/**
 * Index row of a catalog fund without published data (new, and its first read failed or its holdings failed the guard):
 * catalog fields only, `dataFile: null`, holdings and history 0, the full metrics key set with nulls.
 */
export function catalogOnlyRow(fund: CatalogFund): Record<string, unknown> {
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.assetClass || 'ETF',
    marketingCategory: fund.marketingCategory,
    strategy: fund.strategy,
    dailyObjective: fund.dailyObjective,
    benchmark: fund.benchmark,
    fundPage: fund.fundPage,
    dataFile: null,
    cusip: null,
    isin: null,
    ter: '—', terValue: null, terGross: '—', terGrossValue: null, terNet: '—', terNetValue: null,
    nav: '—', navValue: null,
    aum: formatAumDisplay(fund.netAssetsValue), aumValue: fund.netAssetsValue,
    asOfDate: '—', netAssetsAsOf: '—',
    inceptionDate: fund.inceptionDateText || '—',
    exchange: '—',
    closePrice: '—', closePriceValue: null, premiumDiscount: '—', premiumDiscountValue: null,
    distributions: { frequency: '—', note: null, exDate: '—', dividend: '—' },
    distributionFrequency: '—',
    returns: {},
    metrics: {
      ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null,
      dividendYield: null, dividendYieldText: '—', dividendYieldBasis: null, dividendYieldBasisText: null, dividendYieldComputed: null,
      secYield: null, secYieldText: '—', secYieldKind: null,
      returnsBasis: 'no published data yet: official ProShares performance file (etf_performance.csv) once the fund is read',
      performanceAsOf: null,
    },
    holdings: 0,
    history: 0,
  };
}

/** Funds with a published meta.json that the index does not list (rows rebuilt offline). */
export async function readMissingRows(listed: Set<string>): Promise<Record<string, Record<string, unknown>>> {
  const rows: Record<string, Record<string, unknown>> = {};
  const root = path.join(API_ROOT, 'funds');
  if (!existsSync(root)) return rows;
  for (const dir of (await readdir(root)).sort()) {
    if (listed.has(dir)) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(root, dir, 'meta.json'), 'utf8')) as Record<string, any>;
      if (meta?.ticker === dir) rows[dir] = rowFromMeta(meta);
    } catch { /* no meta.json: not a published fund */ }
  }
  return rows;
}

export async function readCursor(scope: string | null = null): Promise<string | null> {
  const file = path.join(API_ROOT, 'update-state.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (scope !== null && parsed.scope !== scope) return null;
    return parsed.cursor ? String(parsed.cursor) : null;
  } catch {
    return null;
  }
}

/** Batch of at most `maxFetches` funds that continues after `cursor` and wraps around the sorted list. */
export function selectBatch<T extends { ticker: string }>(candidates: T[], maxFetches: number, cursor: string | null): T[] {
  if (maxFetches <= 0) return candidates;
  const sorted = [...candidates].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const after = cursor ? sorted.filter(fund => fund.ticker.localeCompare(cursor) > 0) : sorted;
  const ordered = cursor ? [...after, ...sorted.filter(fund => fund.ticker.localeCompare(cursor) <= 0)] : sorted;
  return ordered.slice(0, maxFetches);
}

/**
 * ISO date a published index row is refreshed up to (the latest of its dated fields),
 * or null when the fund has no published data yet.
 */
export function publishedAsOf(row: Record<string, unknown> | null | undefined): string | null {
  if (!row || row.dataFile === null) return null;
  const metrics = row.metrics as Record<string, unknown> | undefined;
  const dates = [row.asOfDate, row.netAssetsAsOf, metrics?.performanceAsOf]
    .map(value => toIsoDate(value))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value));
  return dates.length ? dates.sort()[dates.length - 1] : null;
}

/**
 * Run order of an unbounded run: funds without published data first, then the stalest
 * published as-of, ties alphabetical. A run cut short by the soft deadline therefore
 * leaves the freshest funds for last, and the next run starts where this one stopped.
 */
export function stalestFirst<T extends { ticker: string }>(funds: T[], published: Record<string, Record<string, unknown>>): T[] {
  const key = (fund: T): string => publishedAsOf(published[fund.ticker]) ?? '';
  return [...funds].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.ticker.localeCompare(b.ticker)));
}

/** One line for the log and the step summary: what a deadline-truncated run left behind. */
export function deadlineSummary(attempted: number, total: number, remaining: Array<{ ticker: string }>, published: Record<string, Record<string, unknown>>): string {
  const ordered = stalestFirst(remaining, published);
  const oldest = ordered.length ? `${publishedAsOf(published[ordered[0].ticker]) ?? 'never published'} (${ordered[0].ticker})` : 'none';
  return `${attempted} of ${total} funds refreshed, ${remaining.length} keep their published files, oldest remaining published as-of: ${oldest}`;
}

/** Soft deadline: the run stops taking new funds well before the 30 minute workflow timeout. */
export const SOFT_DEADLINE_MS = 25 * 60_000;

async function writeRawSamples(config: UpdaterConfig): Promise<void> {
  if (!config.storeRawDownloads) return;
  for (const [name, content] of rawSamples) {
    await writeIfChanged(path.join(API_ROOT, 'raw', name), content);
  }
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>, stopAt = Infinity): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      if (Date.now() >= stopAt) return;
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadCatalogs(config: UpdaterConfig, stats: Stats): Promise<{ funds: CatalogFund[]; catalogReadAt: string }> {
  const catalogReadAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pages: { url: string; kind: 'strategic' | 'geared' }[] = [
    { url: STRATEGIC_FINDER_URL, kind: 'strategic' },
    { url: GEARED_FINDER_URL, kind: 'geared' },
  ];
  const funds: CatalogFund[] = [];
  for (const page of pages) {
    try {
      const html = await fetchText(page.url, browserHeaders(), config, `${page.kind} finder page`, `finder-${page.kind}.html`);
      const parsed = parseFinderCatalogPage(html, page.kind);
      if (!parsed.length) throw new Error(`no fund rows found on ${page.url}`);
      funds.push(...parsed);
      console.log(`[ catalog  ] ${parsed.length} ${page.kind} funds from ${page.url}`);
    } catch (error) {
      console.error(`[ catalog  ] ${page.kind} finder page failed — ${errorMessage(error)}`);
      stats.failed++;
    }
  }
  const unique = new Map<string, CatalogFund>();
  for (const fund of funds) if (!unique.has(fund.ticker)) unique.set(fund.ticker, fund);
  return { funds: [...unique.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)), catalogReadAt };
}

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

export async function main(config?: UpdaterConfig): Promise<void> {
  if (!config) {
    const controls = await runtimeControls();
    if (controls.VERBOSE !== undefined) process.env.VERBOSE = controls.VERBOSE;
    installSystemCa(controls.USE_SYSTEM_CA);
    config = readConfig(controls);
  }
  outputPrintConfig('ProShares', config);
  const runStartedAt = Date.now();
  const stopAt = runStartedAt + SOFT_DEADLINE_MS;
  await mkdir(path.join(API_ROOT, 'funds'), { recursive: true });
  const stats: Stats = { updated: 0, unchanged: 0, skipped: 0, failed: 0, filtered: 0 };
  const previousIndex = await readPreviousIndex();
  const previousFunds = previousIndex.funds;
  // The index must list every fund that has a meta.json, even when an earlier run shrank it.
  for (const [ticker, row] of Object.entries(await readMissingRows(new Set(Object.keys(previousFunds))))) previousFunds[ticker] = row;
  // The published rows as they were before this run (Q28 compares the final index with them).
  const previousRows = Object.values(previousFunds).slice();

  // --- catalog --------------------------------------------------------------
  const loaded = await loadCatalogs(config, stats);
  let catalog: CatalogFund[] = loaded.funds;
  const catalogReadAt = loaded.catalogReadAt;
  const catalogSource = catalog.length ? 'ProShares strategic + geared finder pages' : 'previously published index';
  // Q27: the live catalog (null when only the published feed is known); a TICKERS entry outside it and the published funds
  // (closed ones included) stops the run before any other request
  const live = catalog.length ? catalog.map(fund => fund.ticker) : null;
  assertKnownTickers(config.tickers.length ? config.tickers : null, knownTickers(live, previousRows), 'the ProShares catalog or published feed');
  if (!catalog.length) {
    const fallback = Object.values(previousFunds).map(fund => ({
      ticker: String(fund.ticker),
      name: String(fund.name || fund.ticker),
      slug: String(fund.ticker).toLowerCase(),
      kind: 'strategic' as const,
      fundPage: String(fund.fundPage || ''),
      assetClass: String(fund.category || 'ETF'),
      marketingCategory: String(fund.marketingCategory || ''),
      strategy: String(fund.strategy || ''),
      dailyObjective: String(fund.dailyObjective || ''),
      benchmark: String(fund.benchmark || ''),
      benchmarkTicker: String(fund.benchmarkTicker || ''),
      netAssetsText: String(fund.aum || ''),
      netAssetsValue: numberOrNull(fund.aumValue),
      inceptionDateText: String(fund.inceptionDate || ''),
    }));
    if (!fallback.length) throw new Error('catalog unavailable and no previously published index.json to fall back to');
    console.warn(`[ catalog  ] falling back to the previously published catalog (${fallback.length} funds)`);
    catalog = fallback;
  }

  // --- bulk official files --------------------------------------------------
  let holdingsFile: HoldingsFile = { asOf: '', asOfIso: '', funds: new Map() };
  let performance = new Map<string, PerformanceRow>();
  let splits = new Map<string, SplitRow[]>();
  let navHistoryAll: Map<string, NavRow[]> = new Map();
  let navHistoryAllLoaded = false;
  let exchanges = new Map<string, string>();
  let usListings: Map<string, string> | null = null;
  let exchangeSource = '—';

  try {
    const text = await fetchText(HOLDINGS_ALL_URL, browserHeaders(), config, 'holdings file', 'psdlyhld.csv');
    holdingsFile = parseHoldingsFile(text);
    console.log(`[ holdings ] ${holdingsFile.funds.size} funds as of ${holdingsFile.asOf} from ${HOLDINGS_ALL_URL}`);
  } catch (error) {
    console.error(`[ holdings ] holdings file failed — ${errorMessage(error)}`);
    stats.failed++;
  }
  try {
    const text = await fetchText(PERFORMANCE_URL, browserHeaders(), config, 'performance file', 'etf_performance.csv');
    performance = parsePerformanceFile(text);
    console.log(`[ perf     ] ${performance.size} rows from ${PERFORMANCE_URL}`);
  } catch (error) {
    console.error(`[ perf     ] performance file failed — ${errorMessage(error)}`);
    stats.failed++;
  }
  try {
    const text = await fetchText(SPLITS_URL, browserHeaders(), config, 'splits file', 'etf_splits.csv');
    splits = parseSplitsFile(text);
    console.log(`[ splits   ] ${splits.size} symbols from ${SPLITS_URL}`);
  } catch (error) {
    console.error(`[ splits   ] splits file failed — ${errorMessage(error)}`);
    stats.failed++;
  }
  {
    try {
      const [listed, other] = await Promise.all([
        fetchText(NASDAQ_LISTED_URL, browserHeaders(), config, 'nasdaqlisted symbol directory', 'nasdaq-nasdaqlisted.txt').catch(() => ''),
        fetchText(NASDAQ_OTHER_LISTED_URL, browserHeaders(), config, 'otherlisted symbol directory', 'nasdaq-otherlisted.txt').catch(() => ''),
      ]);
      const merged = new Map<string, string>();
      for (const [ticker, exchange] of parseSymbolDirectory(other, EXCHANGE_CODES)) merged.set(ticker, exchange);
      for (const [ticker, exchange] of parseSymbolDirectory(listed, { ...EXCHANGE_CODES, Q: 'Nasdaq' })) merged.set(ticker, exchange);
      if (merged.size) {
        exchanges = merged;
        // both files answered: their names tell a U.S. listing from a local exchange code (holdingTicker)
        if (listed && other) usListings = new Map(Array.from(parseSymbolNames(other)).concat(Array.from(parseSymbolNames(listed))));
        exchangeSource = 'Nasdaq Trader symbol directory (nasdaqlisted.txt + otherlisted.txt)';
        console.log(`[ exchange ] ${exchanges.size} symbols resolved`);
      }
    } catch (error) {
      console.error(`[ exchange ] symbol directory failed — ${errorMessage(error)}`);
    }
  }

  console.log(`[ catalog  ] ${catalog.length} ProShares ETFs (${catalogSource})`);

  const loadNavHistoryAll = async (): Promise<Map<string, NavRow[]>> => {
    if (!navHistoryAllLoaded) {
      navHistoryAllLoaded = true;
      try {
        const text = await fetchText(NAV_HISTORY_ALL_URL, browserHeaders(), config, 'NAV history file', 'historical_nav.csv');
        navHistoryAll = parseNavHistoryAll(text);
      } catch (error) {
        outputNote(`[ history  ] bulk NAV history failed — ${errorMessage(error)}`);
      }
    }
    return navHistoryAll;
  };

  // --- candidate selection (catalog-level filters, then the bounded cursor) --
  const catalogFiltersActive = Boolean(config.tickers.length || config.category || config.aumRange);
  // A closed fund leaves the queue here, before the batch: it is never fetched, guarded or reported and spends no MAX_FETCHES budget.
  let candidates = withoutClosedFunds(catalog.filter(fund => {
    if (config.tickers.length && !config.tickers.includes(fund.ticker)) return false;
    if (config.category && !(fund.assetClass || '').toLowerCase().includes(config.category.toLowerCase())) return false;
    if (config.aumRange && !matchesRange(fund.netAssetsValue, config.aumRange)) return false;
    return true;
  }), fund => fund.ticker, CLOSED_FUNDS);
  const beforeBatch = candidates.length;
  // A TICKERS run is a one-off selection: it never reads, writes or deletes the batch cursor.
  const useCursor = config.tickers.length === 0;
  const scope = cursorScope(config);
  const cursor = config.maxFetches > 0 && useCursor ? await readCursor(scope) : null;
  // A bounded run walks the alphabetical cursor; an unbounded run goes stalest first.
  candidates = config.maxFetches > 0 ? selectBatch(candidates, config.maxFetches, cursor) : stalestFirst(candidates, previousFunds);
  stats.skipped += beforeBatch - candidates.length;
  let fundFailures = 0;
  const completed: string[] = [];
  outputPrintFilter(beforeBatch, catalog.length, outputHasOutputFilters({ ...config, tickers: [] }));
  const output = outputCreateReporter(API_ROOT, candidates.length);

  // --- per-fund processing --------------------------------------------------
  const results = await mapWithConcurrency(candidates, config.concurrency, async (fund, index) => {
    completed.push(fund.ticker);
    const before = await output.before(fund.ticker);
    const startedAt = Date.now();
    const directory = path.join(API_ROOT, 'funds', fund.ticker);
    // A catalog-only row (dataFile null) is not published data: the fund is still new.
    const previousRow = previousFunds[fund.ticker];
    const previous = previousRow && previousRow.dataFile !== null ? previousRow : undefined;
    try {
      const page = parseFundPage(await fetchText(fund.fundPage, browserHeaders(), config, `${fund.ticker} fund page`, `fund-${fund.ticker}.html`));

      // Filter checks that need published fund-page values.
      if (config.terRange && !matchesRange(page.expenseRatio, config.terRange)) {
        stats.filtered++;
        await output.result(fund.ticker, before, 'skipped', 'data filter');
        return;
      }
      if (config.secYieldRange && !matchesRange(page.sec30DayYield, config.secYieldRange)) {
        stats.filtered++;
        await output.result(fund.ticker, before, 'skipped', 'data filter');
        return;
      }

      const performanceNavMonth = performance.get(`${fund.ticker}|NAV|MONTH`);
      if (
        config.performanceRanges['1Y'] && !matchesReturnRange(performanceNavMonth?.yr1, config.performanceRanges['1Y']) ||
        config.performanceRanges['3Y'] && !matchesReturnRange(performanceNavMonth?.yr3, config.performanceRanges['3Y']) ||
        config.performanceRanges['5Y'] && !matchesReturnRange(performanceNavMonth?.yr5, config.performanceRanges['5Y']) ||
        config.performanceRanges['10Y'] && !matchesReturnRange(performanceNavMonth?.yr10, config.performanceRanges['10Y']) ||
        config.performanceRanges.YTD && !matchesReturnRange(performanceNavMonth?.ytd, config.performanceRanges.YTD)
      ) {
        stats.filtered++;
        await output.result(fund.ticker, before, 'skipped', 'data filter');
        return;
      }
      if (
        config.totalReturnRanges['1Y'] && !matchesReturnRange(performanceNavMonth?.yr1, config.totalReturnRanges['1Y']) ||
        config.totalReturnRanges['3Y'] && !matchesReturnRange(cumulativeFromAnnualized(performanceNavMonth?.yr3 ?? null, 3), config.totalReturnRanges['3Y']) ||
        config.totalReturnRanges['5Y'] && !matchesReturnRange(cumulativeFromAnnualized(performanceNavMonth?.yr5 ?? null, 5), config.totalReturnRanges['5Y']) ||
        config.totalReturnRanges['10Y'] && !matchesReturnRange(cumulativeFromAnnualized(performanceNavMonth?.yr10 ?? null, 10), config.totalReturnRanges['10Y']) ||
        config.totalReturnRanges.YTD && !matchesReturnRange(performanceNavMonth?.ytd, config.totalReturnRanges.YTD)
      ) {
        stats.filtered++;
        await output.result(fund.ticker, before, 'skipped', 'data filter');
        return;
      }

      let previousMeta: Record<string, any> | null = null;
      if (previous) {
        try {
          previousMeta = JSON.parse(await readFile(path.join(directory, 'meta.json'), 'utf8'));
        } catch {
          previousMeta = null;
        }
      }

      // NAV history: the per-fund file reaches inception and is preferred; the bulk slice is the fallback (it reached SSO's
      // June 2006 inception on 2026-10-26, older notes said it starts in 2011), used for a published fund only when it reaches
      // back as far as the published history.
      let navRows: NavRow[] = [];
      let navProblem: string | null = null;
      try {
        const text = await fetchText(navHistoryUrl(fund.ticker), browserHeaders(), config, `${fund.ticker} NAV history`, '');
        navRows = parseNavHistoryFile(text, fund.ticker);
      } catch (error) {
        outputNote(`${fund.ticker}: per-fund NAV history failed (${errorMessage(error)}); using the bulk file`);
      }
      if (!navRows.length) {
        const bulk = await loadNavHistoryAll();
        navRows = bulk.get(fund.ticker) || [];
        if (previousMeta && Number(previous?.history || 0) > 0) {
          const firstPage = await firstPublishedRows(directory, previousMeta.history);
          navProblem = navFallbackProblem(navRows, firstPage.length ? cleanText(firstPage[0].Date) || null : null);
        }
      }
      navRows.sort((a, b) => compareDisplayDates(a.date, b.date));
      navRows = applyHistoryRange(navRows, config.historyRange);
      // a window refreshes its own days and keeps the published older rows, only when it joins them on its first day (Q29)
      if (historyRangeDays(config.historyRange) && navRows.length && previousMeta && Number(previous?.history || 0) > 0) {
        const published = await publishedSheetRows(directory, previousMeta.history);
        const joined = published ? withOlderNavRows(navRows, published) : null;
        if (joined) navRows = joined;
        else navProblem = navProblem || `HISTORY_RANGE=${config.historyRange} window does not join the published NAV history on ${navRows[0].date}`;
      }

      // Distribution history (official endpoint): current + previous year when rows are already published.
      let distributions: DistributionRow[] = [];
      let distributionsFailed = false;
      let distributionsRefreshedAt: string | null = null;
      const publishedBlock: Record<string, any> | null = previousMeta?.distributions ?? null;
      const fetched = await fetchDistributions(fund.ticker, config, publishedBlock);
      distributions = fetched.rows;
      distributionsFailed = fetched.failed;
      distributionsRefreshedAt = fetched.refreshedAt;

      // DIVIDEND_YIELD filters the same official-or-indicated value the feed
      // writes. An unpublished 12-Month Yield can still have a real indicated
      // yield, but that value is only known after fetching official payouts.
      if (config.dividendYieldRange) {
        const nav = numberOrNull(page.navText) ?? navRows[navRows.length - 1]?.nav ?? null;
        const latestDividend = distributions[distributions.length - 1]?.dividend ?? null;
        const effective = resolveDividendYield(page.twelveMonthYield, latestDividend, normalizeDistributionFrequency(page.distributionFrequency), nav).effective;
        if (!matchesRange(effective, config.dividendYieldRange)) {
          stats.filtered++;
          await output.result(fund.ticker, before, 'skipped', 'data filter');
          return;
        }
      }

      // The per-fund download is what the fund page itself offers and the only
      // official file that keeps the SEDOL identifiers for equity positions;
      // the all-funds file is the fallback when it is unavailable.
      let holdings = holdingsFile.funds.get(fund.ticker);
      let holdingsAsOf = holdingsFile.asOf;
      let holdingsSourceLabel = `official ProShares daily holdings file (psdlyhld.csv, as of ${holdingsFile.asOf || '—'})`;
      try {
        const text = await fetchText(
          holdingsUrl(fund.ticker),
          browserHeaders(),
          config,
          `${fund.ticker} holdings file`,
          `${fund.ticker}-psdlyhld.csv`,
        );
        const perFund = parseHoldingsFile(text);
        const bucket = perFund.funds.get(fund.ticker);
        if (bucket && bucket.rows.length) {
          holdings = bucket;
          holdingsAsOf = perFund.asOf || holdingsAsOf;
          holdingsSourceLabel = `official ProShares daily holdings download (ByFund/${fund.ticker}-psdlyhld.csv, as of ${perFund.asOf || '—'})`;
        }
      } catch (error) {
        outputNote(`${fund.ticker}: per-fund holdings download failed — ${errorMessage(error)} · using the all-funds file`);
      }
      // Fund-level consistency: when a required source failed for an already published fund, keep its previous
      // complete state instead of publishing fresh columns next to stale ones.
      if (previous) {
        if (!performance.size) throw new Error('performance file unavailable - kept the published fund');
        if (!navRows.length && Number(previous.history || 0) > 0) throw new Error('NAV history unavailable - kept the published fund');
        if (navProblem) throw new Error(`${navProblem} - kept the published fund`);
        if (distributionsFailed) throw new Error('distribution history unavailable - kept the published fund');
        if (!(holdings && holdings.rows.length) && Number(previous.holdings || 0) > 0) throw new Error('holdings unavailable - kept the published fund');
      }
      // A new fund that no source answered (a block page answered with HTTP 200 and every file without the fund) is never
      // published as an empty meta.json: it fails and keeps a catalog-only index row.
      const pageAnswered = Boolean(page.cusip || page.nav !== null || page.marketPrice !== null || page.expenseRatio !== null || page.netAssetsValue !== null);
      if (!previousMeta && !pageAnswered && !performanceNavMonth && !navRows.length && !(holdings && holdings.rows.length) && !distributions.length) {
        throw new Error('no source answered; no data published for this fund yet');
      }
      const splitRows = splits.get(fund.ticker) || [];
      const artifacts = buildFeed({
        fund,
        page,
        performanceNavMonth,
        performanceMarketMonth: performance.get(`${fund.ticker}|MARKET|MONTH`),
        performanceNavQuarter: performance.get(`${fund.ticker}|NAV|QUARTER`),
        performanceMarketQuarter: performance.get(`${fund.ticker}|MARKET|QUARTER`),
        navRows,
        holdingsRows: holdings ? holdings.rows : [],
        holdingsAsOf,
        holdingsSourceLabel,
        distributions,
        distributionsRefreshedAt,
        exchange: exchanges.get(fund.ticker) || '',
        exchangeSource: exchanges.get(fund.ticker) ? exchangeSource : '—',
        usListings,
        splits: splitRows,
        config,
        catalogReadAt,
      });
      // A freshly downloaded holdings sheet (per-fund or all-funds file) that looks broken never replaces the published one:
      // the fund keeps its previous complete state and is counted as failed.
      // No relax lets an all-non-numeric weight sheet replace a published sheet with numeric weights (Q24).
      const publishedRows = holdings && previousMeta ? await firstPublishedRows(directory, previousMeta.holdings) : [];
      const publishedWeights = publishedRows.length ? holdingsWeightCount(Object.keys(publishedRows[0]), publishedRows) : null;
      const holdingsProblem = holdings ? holdingsGuard(artifacts.holdingsHeaders, artifacts.holdingsRows, numberOrNull(previous?.holdings), holdingsGuardRelax(fund.ticker, fund.dailyObjective), publishedWeights) : null;
      if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${previous ? 'kept the published fund' : 'no data published for this fund yet'}`);
      // A renamed page id or column empties a whole value set while every source still answers: never publish that over good data.
      if (previous) {
        const lost = lostValueSets(previous, artifacts.entry);
        if (
          artifacts.holdingsRows.length && !hasNumericWeight(artifacts.holdingsRows) &&
          hasNumericWeight(await firstPublishedRows(directory, previousMeta?.holdings))
        ) lost.push('holdings weights');
        if (lost.length) throw new Error(`${lost.join(', ')} turned all-null (renamed page id or column?) - kept the published fund`);
      }

      await mkdir(directory, { recursive: true });
      const holdingsWrite = await writeSheetPages(directory, 'holdings', fund.ticker, artifacts.holdingsHeaders, artifacts.holdingsRows, config.holdingsPageSize, false);
      const historyWrite = await writeSheetPages(directory, 'history', fund.ticker, artifacts.historyHeaders, artifacts.historyRows, config.historyPageSize, false);
      const meta = {
        ...artifacts.meta,
        holdings: { ...(artifacts.meta.holdings as Record<string, unknown>), ...holdingsWrite.manifest },
        history: { ...(artifacts.meta.history as Record<string, unknown>), ...historyWrite.manifest },
      };
      const metaResult = await writeJsonIfChanged(path.join(directory, 'meta.json'), meta);
      holdingsWrite.removed = await pruneSheetPages(path.join(directory, 'holdings'), holdingsWrite.manifest.pages.length);
      historyWrite.removed = await pruneSheetPages(path.join(directory, 'history'), historyWrite.manifest.pages.length);
      artifacts.changed = metaResult === 'written' || holdingsWrite.written > 0 || historyWrite.written > 0 || holdingsWrite.removed > 0 || historyWrite.removed > 0;
      if (artifacts.changed) stats.updated++;
      else stats.unchanged++;
      previousFunds[fund.ticker] = artifacts.entry;
      await output.result(fund.ticker, before);
    } catch (error) {
      stats.failed++;
      fundFailures++;
      await output.result(fund.ticker, before, 'failed', errorMessage(error));
      // A new fund whose source failed or whose holdings the guard rejected is still listed, catalog fields only.
      if (!previousFunds[fund.ticker]) previousFunds[fund.ticker] = previous ?? catalogOnlyRow(fund);
    }
  }, stopAt);
  if (completed.length < candidates.length) {
    const doneTickers = new Set(completed);
    const line = `soft deadline reached: ${deadlineSummary(completed.length, candidates.length, candidates.filter(fund => !doneTickers.has(fund.ticker)), previousFunds)}; the next run starts with them`;
    console.warn(`[ deadline ] ${line}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`, 'utf8');
  }

  // --- index.json -----------------------------------------------------------
  const indexFile = path.join(API_ROOT, 'index.json');
  // A catalog-only row the live catalog no longer lists (an old mistyped TICKERS entry) is dropped; rows with data stay.
  const funds = markClosedFunds(withoutStalePlaceholders(Object.values(previousFunds), live).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))), CLOSED_FUNDS);
  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + Number(fund.holdings || 0), 0),
    history: funds.reduce((sum, fund) => sum + Number(fund.history || 0), 0),
  };
  const index = {
    // generatedAt and catalogReadAt are stamps: writeJsonIfChanged ignores them, so an unchanged feed leaves the file untouched.
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      provider: 'ProShares Trust / ProShare Advisors LLC (US ETFs and geared ETFs)',
      market: 'us',
      site: PROSHARES_SITE,
      catalog: STRATEGIC_FINDER_URL,
      catalogGeared: GEARED_FINDER_URL,
      catalogNote: 'Server-rendered ProShares finder tables: asset class, marketing category, geared strategy, index/benchmark and net assets.',
      fundPages: `${PROSHARES_SITE}/our-etfs/strategic/<ticker> and ${PROSHARES_SITE}/our-etfs/leveraged-and-inverse/<ticker>`,
      holdings: HOLDINGS_ALL_URL,
      holdingsPerFund: `${PROSHARES_DATA_HOST}/ByFund/<TICKER>-psdlyhld.csv`,
      history: `${PROSHARES_DATA_HOST}/ByFund/<TICKER>-historical_nav.csv`,
      historyAll: NAV_HISTORY_ALL_URL,
      performance: PERFORMANCE_URL,
      splits: SPLITS_URL,
      distributions: `${PROSHARES_SITE}/api/distributionsummary?fund=<TICKER>&year=<YYYY>`,
      exchange: exchangeSource,
      catalogReadAt,
    },
    counts,
    funds,
  };
  await writeJsonIfChanged(indexFile, index);
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(previousRows, funds));
  for (const line of newFunds) console.log(line);
  if (newFunds.length && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8');

  // --- cursor & raw samples -------------------------------------------------
  const stateFile = path.join(API_ROOT, 'update-state.json');
  if (useCursor) {
    const lastDone = candidates.filter(fund => completed.includes(fund.ticker)).pop();
    if (config.maxFetches > 0 && lastDone) {
      await writeJsonIfChanged(stateFile, { scope, cursor: lastDone.ticker, savedAt: new Date().toISOString() });
    } else if (config.maxFetches === 0 && existsSync(stateFile)) {
      await rm(stateFile);
    }
  }
  await writeRawSamples(config);

  if (stats.failed > 0) console.warn(`[ failed   ] ${stats.failed} step(s) failed; previously published files were kept for those funds`);
  console.log(output.summary(runStartedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  if (candidates.length > 0 && fundFailures === completed.length) process.exitCode = 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE.trim());
    process.exit(0);
  }
  main().catch(error => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
