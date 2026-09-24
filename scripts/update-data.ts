#!/usr/bin/env bun
/// <reference types="bun" />
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
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  // "Sep 18 2026" (the shared display format the feed stores).
  const display = /^([A-Za-z]{3}) (\d{1,2}) (\d{4})$/.exec(text);
  if (display) {
    const month = MONTH_INDEX[display[1].toLowerCase()];
    if (month) return `${display[3]}-${String(month).padStart(2, '0')}-${display[2].padStart(2, '0')}`;
  }
  return text;
}

/** Sorts "Sep 18 2026"-style display dates chronologically. */
export function compareDisplayDates(a: string, b: string): number {
  return Date.parse(`${a} UTC`) - Date.parse(`${b} UTC`);
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
  audienceType: string;
  secUa: string;
  skipProShares: boolean;
  offlineSeed: boolean;
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
    ranges[period] = parseRange(raw, `${prefix}_${period}`);
  }
  return ranges;
}

export function matchesRange(value: number | null | undefined, range: Range | undefined): boolean {
  if (!range) return true;
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
  ./scripts/update-data.ts [options]        # options come from the environment

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
  DIVIDEND_YIELD         ":"          Official 12-month yield range in %.
  SEC_YIELD              ":"          Kept for parity with the sibling sites:
                                      ProShares publishes no 30-day SEC yield, so
                                      any bound matches no fund.
  PERFORMANCE_YTD|1Y|3Y|5Y|10Y  ""    Annualized-return ranges (min:max).
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y ""    Cumulative-return ranges (min:max).
  CONCURRENCY            3            Parallel fund workers.
  REQUEST_SLEEP          1.5          Seconds between outgoing request starts.
  MAX_RETRIES            3            Retries after the initial request
                                      (408/425/429/403/5xx).
  HOLDINGS_PAGE_SIZE     250          Rows per generated holdings JSON page.
  HISTORY_PAGE_SIZE      1000         Rows per generated history JSON page
                                      (alias HISTORICAL_PAGE_SIZE).
  HISTORY_RANGE          max          NAV-history window: max | 20y | 10y | 5y.
  DISTRIBUTION_YEARS     10           Calendar years of distribution history
                                      fetched per fund (the endpoint is
                                      year-scoped); a year column is skipped
                                      after two empty years.
  SKIP_PROSHARES         ""           Rebuild the feed from the previous catalog
                                      and the bulk official files only.
  STORE_RAW_DOWNLOADS    ""           Keep one raw sample of each source under
                                      api/proshares/raw (1/true/yes/on).
  OFFLINE_SEED           ""           Replay the previously published catalog and
                                      api/proshares/raw samples instead of
                                      fetching (1/true/yes/on).

Examples
  MAX_FETCHES=10 ./scripts/update-data.ts
  TICKERS="NOBL TQQQ IGHG" ./scripts/update-data.ts
  CATEGORY=Commodity AUM="300M:" ./scripts/update-data.ts
  DISTRIBUTION_YEARS=20 HISTORY_RANGE=5y ./scripts/update-data.ts
`;

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
    tickers: envValue(env, 'TICKERS', ['PROSHARES_TICKERS'])
      .split(/[\s,]+/)
      .map(ticker => ticker.replace(/[^A-Za-z0-9]/g, '').toUpperCase())
      .filter(Boolean),
    category: envValue(env, 'CATEGORY'),
    audienceType: envValue(env, 'AUDIENCE_TYPE'),
    secUa: envValue(env, 'SEC_UA'),
    skipProShares: parseBoolean(envValue(env, 'SKIP_PROSHARES', ['SKIP_PROSHARES_ETF'])),
    offlineSeed: parseBoolean(envValue(env, 'OFFLINE_SEED')),
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
  if (config.audienceType && !['Investor', 'Advisor'].includes(config.audienceType)) {
    throw new Error(`Invalid AUDIENCE_TYPE "${config.audienceType}": use Investor or Advisor`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// HTTP layer: polite pacing, bounded retries, optional raw-sample capture
// ---------------------------------------------------------------------------

const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let lastRequestStartedAt = 0;

export async function paceRequests(config: UpdaterConfig): Promise<void> {
  const gap = Math.max(0, config.requestSleep) * 1000;
  const now = Date.now();
  const wait = lastRequestStartedAt + gap - now;
  if (wait > 0) await sleep(wait);
  lastRequestStartedAt = Date.now();
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
    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        const text = await response.text();
        if (config.storeRawDownloads && rawName) recordRawSample(rawName, text);
        return text;
      }
      lastError = `HTTP ${response.status} ${response.statusText}`;
      if (!RETRY_STATUS.has(response.status)) throw new Error(`${label}: ${lastError}`);
    } catch (error) {
      const message = errorMessage(error);
      lastError = message;
      if (/^HTTP \d+/.test(message) && !RETRY_STATUS.has(Number(message.slice(5, 8)))) throw error;
      if (attempt === config.maxRetries) throw new Error(`${label}: ${message}`);
    }
    const backoff = 15_000 * (attempt + 1);
    console.warn(formatRetry(label, lastError, Math.round(backoff / 1000), attempt + 1, config.maxRetries));
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

export function holdingsHeaders(rows: HoldingsRow[]): string[] {
  const headers = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held'];
  if (rows.some(row => row.exposure !== '')) headers.push('Exposure Value');
  if (rows.some(row => row.coupon !== '')) headers.push('Coupon');
  if (rows.some(row => row.maturity !== '')) headers.push('Maturity Date');
  return headers;
}

export function holdingsRowsForCsv(rows: HoldingsRow[], headers: string[]): Record<string, string>[] {
  const totalNetAssets = holdingsNetAssets(rows);
  return rows.map(row => {
    const value: Record<string, string> = {
      Name: row.name || '—',
      Ticker: row.ticker || '-',
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

export function parseNavHistoryFile(text: string, ticker: string): NavRow[] {
  const records = parseCsvRecords(text);
  if (!records.length) return [];
  const index = headerIndex(records[0]);
  const rows: NavRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    if (cleanText(cellAt(row, index, 'Ticker')).toUpperCase() !== ticker) continue;
    const date = formatUsDate(cellAt(row, index, 'Date'));
    if (!date || date === '—') continue;
    const sharesText = cellAt(row, index, 'Shares Outstanding (000)', 'Shares Outstanding 000');
    const shares = numberOrNull(sharesText);
    rows.push({
      date,
      nav: numberOrNull(cellAt(row, index, 'NAV')),
      // The file publishes shares outstanding in thousands.
      sharesOutstanding: shares === null ? null : round(shares * 1000, 0),
      netAssets: numberOrNull(cellAt(row, index, 'Assets Under Management', 'AUM')),
    });
  }
  return rows;
}

export function historyRangeDays(range: string): number | null {
  const text = cleanText(range).toLowerCase();
  if (!text || text === 'max' || text === 'all' || text === '0') return null;
  const match = /^(\d+)\s*(y|yr|year|years|m|mo|month|months|d|day|days)?$/.exec(text);
  if (!match) throw new Error(`Invalid HISTORY_RANGE "${range}": use max, <N>y, <N>m or <N>d`);
  const amount = Number(match[1]);
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
  const cutoff = Date.parse(`${newest.date} UTC`) - days * 86_400_000;
  return rows.filter(row => Date.parse(`${row.date} UTC`) >= cutoff);
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

export function parseDistributionSummary(text: string): DistributionRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
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
  const parsed = new Date(`${value} UTC`);
  if (Number.isNaN(parsed.getTime())) return value;
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = MONTHS[parsed.getUTCMonth()];
  return `${day}-${month}-${parsed.getUTCFullYear()}`;
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

const FREQUENCY_PAYMENTS: Record<string, number> = {
  monthly: 12,
  quarterly: 4,
  'semi-annual': 2,
  semiannually: 2,
  'semi-annually': 2,
  semiannual: 2,
  annual: 1,
  annually: 1,
  irregular: 1,
};

export function normalizeDistributionFrequency(label: unknown): string {
  const raw = cleanText(label);
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
  if (!normalized) return '—';
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
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
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
  if (existsSync(directory)) {
    for (const file of await readdir(directory)) {
      const match = /^(\d{3})\.json$/.exec(file);
      if (!match) continue;
      if (Number(match[1]) <= pageCount) continue;
      await rm(path.join(directory, file));
      removed++;
    }
  }
  return { manifest: { pages, pageSize, totalRows: rows.length }, written, removed };
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
  exchange: string;
  exchangeSource: string;
  splits: SplitRow[];
  config: UpdaterConfig;
  catalogReadAt: string;
}): FundArtifacts {
  const {
    fund, page, performanceNavMonth, performanceNavQuarter, performanceMarketMonth, performanceMarketQuarter,
    navRows, holdingsRows, holdingsAsOf, holdingsSourceLabel, distributions, exchange, exchangeSource, splits, config, catalogReadAt,
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
  const indicated = indicatedYield(latestDistribution?.dividend ?? null, frequency, nav);
  // The Yield the site publishes: the official 12-Month Yield where ProShares
  // prints one (strategic pages), otherwise the indicated yield computed from
  // the latest official distribution. Funds that never distributed keep '—'.
  const publishedYield = page.twelveMonthYield;
  const effectiveYield = publishedYield ?? indicated;
  const effectiveYieldBasis = publishedYield !== null
    ? 'official ProShares 12-Month Yield (page distributions block)'
    : indicated !== null
      ? 'indicated yield computed by the updater from the latest official distribution (ProShares publishes no 12-Month Yield for this fund)'
      : 'not published by ProShares and no distributions yet (data limitation)';
  const holdingsCsvHeaders = holdingsHeaders(holdingsRows);
  const holdingsCsvRows = holdingsRowsForCsv(holdingsRows, holdingsCsvHeaders);

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

  const metrics = {
    ytd: performanceNavMonth?.ytd ?? null,
    tr1y: performanceNavMonth?.yr1 ?? null,
    tr3y: cumulativeFromAnnualized(performanceNavMonth?.yr3 ?? null, 3),
    tr5y: cumulativeFromAnnualized(performanceNavMonth?.yr5 ?? null, 5),
    tr10y: cumulativeFromAnnualized(performanceNavMonth?.yr10 ?? null, 10),
    cagr3y: performanceNavMonth?.yr3 ?? null,
    cagr5y: performanceNavMonth?.yr5 ?? null,
    cagr10y: performanceNavMonth?.yr10 ?? null,
    siAnn: performanceNavMonth?.sinceInception ?? null,
    dividendYield: effectiveYield,
    dividendYieldText: formatPercentText(effectiveYield),
    dividendYieldBasis: effectiveYieldBasis,
    dividendYieldComputed: publishedYield === null && indicated !== null,
    secYield: null,
    secYieldText: '—',
    returnsBasis: 'official ProShares performance file (etf_performance.csv, NAV total return, month-end)',
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
    aum: page.netAssetsText || formatAumDisplay(netAssets),
    aumValue: netAssets,
    asOfDate,
    netAssetsAsOf: latest?.date || page.priceAsOf || '—',
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
      secYield: 'not published by ProShares for its ETFs',
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
      display: page.netAssetsText || formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate: latest?.date || page.priceAsOf || '—',
      source: 'official ProShares NAV history file (Assets Under Management)',
    },
    yields: {
      dividendYield: page.twelveMonthYield,
      dividendYieldText: page.twelveMonthYieldText,
      dividendYieldKind: 'official ProShares 12-Month Yield (sum of the last 12 months of dividends / the last month\'s NAV plus capital-gain distributions)',
      effectiveYield,
      effectiveYieldText: formatPercentText(effectiveYield),
      effectiveYieldBasis,
      effectiveYieldComputed: publishedYield === null && indicated !== null,
      distributionYield: null,
      distributionYieldText: null,
      yield12M: page.twelveMonthYield,
      yield12MText: page.twelveMonthYieldText,
      indicatedYield: indicated,
      indicatedYieldText: formatPercentText(indicated),
      secYield: null,
      secYieldText: '—',
      secYieldKind: 'ProShares publishes no 30-day SEC yield on its fund pages (data limitation); fixed-income funds publish a Weighted Average Yield to Maturity instead',
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

/** Numbered before work starts, so concurrent workers and slow retries remain identifiable. */
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
  if (visible(entry.distributionFrequency) && entry.distributionFrequency !== '00 - —') {
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
      if (fund && typeof fund.ticker === 'string') funds[fund.ticker] = fund;
    }
    return { generatedAt: String(parsed.generatedAt || ''), funds };
  } catch {
    return { generatedAt: '', funds: {} };
  }
}

export async function readCursor(): Promise<string | null> {
  const file = path.join(API_ROOT, 'update-state.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    return parsed.cursor ? String(parsed.cursor) : null;
  } catch {
    return null;
  }
}

async function writeRawSamples(config: UpdaterConfig): Promise<void> {
  if (!config.storeRawDownloads) return;
  for (const [name, content] of rawSamples) {
    await writeIfChanged(path.join(API_ROOT, 'raw', name), content);
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
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
      console.log(`Catalog: ${parsed.length} ${page.kind} funds from ${page.url}`);
    } catch (error) {
      console.error(`Catalog: ${page.kind} finder page failed — ${errorMessage(error)}`);
      stats.failed++;
    }
  }
  const unique = new Map<string, CatalogFund>();
  for (const fund of funds) if (!unique.has(fund.ticker)) unique.set(fund.ticker, fund);
  return { funds: [...unique.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)), catalogReadAt };
}

export async function main(config: UpdaterConfig = readConfig()): Promise<void> {
  const runStartedAt = Date.now();
  await mkdir(path.join(API_ROOT, 'funds'), { recursive: true });
  const stats: Stats = { updated: 0, unchanged: 0, skipped: 0, failed: 0, filtered: 0 };
  const previousIndex = await readPreviousIndex();
  const previousFunds = previousIndex.funds;

  // --- catalog --------------------------------------------------------------
  let catalog: CatalogFund[] = [];
  let catalogReadAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (!config.offlineSeed) {
    const loaded = await loadCatalogs(config, stats);
    catalog = loaded.funds;
    catalogReadAt = loaded.catalogReadAt;
  }
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
    console.warn(`Catalog: falling back to the previously published catalog (${fallback.length} funds)`);
    catalog = fallback;
  }

  // --- bulk official files --------------------------------------------------
  let holdingsFile: HoldingsFile = { asOf: '', asOfIso: '', funds: new Map() };
  let performance = new Map<string, PerformanceRow>();
  let splits = new Map<string, SplitRow[]>();
  let navHistoryAll: Map<string, NavRow[]> = new Map();
  let navHistoryAllLoaded = false;
  let exchanges = new Map<string, string>();
  let exchangeSource = '—';

  if (!config.offlineSeed) {
    try {
      const text = await fetchText(HOLDINGS_ALL_URL, browserHeaders(), config, 'holdings file', 'psdlyhld.csv');
      holdingsFile = parseHoldingsFile(text);
      console.log(`Holdings: ${holdingsFile.funds.size} funds as of ${holdingsFile.asOf} from ${HOLDINGS_ALL_URL}`);
    } catch (error) {
      console.error(`Holdings file failed — ${errorMessage(error)}`);
      stats.failed++;
    }
    try {
      const text = await fetchText(PERFORMANCE_URL, browserHeaders(), config, 'performance file', 'etf_performance.csv');
      performance = parsePerformanceFile(text);
      console.log(`Performance: ${performance.size} rows from ${PERFORMANCE_URL}`);
    } catch (error) {
      console.error(`Performance file failed — ${errorMessage(error)}`);
      stats.failed++;
    }
    try {
      const text = await fetchText(SPLITS_URL, browserHeaders(), config, 'splits file', 'etf_splits.csv');
      splits = parseSplitsFile(text);
      console.log(`Splits: ${splits.size} symbols from ${SPLITS_URL}`);
    } catch (error) {
      console.error(`Splits file failed — ${errorMessage(error)}`);
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
          exchangeSource = 'Nasdaq Trader symbol directory (nasdaqlisted.txt + otherlisted.txt)';
          console.log(`Exchanges: ${exchanges.size} symbols resolved`);
        }
      } catch (error) {
        console.error(`Symbol directory failed — ${errorMessage(error)}`);
      }
    }
  }

  const loadNavHistoryAll = async (): Promise<Map<string, NavRow[]>> => {
    if (!navHistoryAllLoaded) {
      navHistoryAllLoaded = true;
      try {
        const text = await fetchText(NAV_HISTORY_ALL_URL, browserHeaders(), config, 'NAV history file', 'historical_nav.csv');
        navHistoryAll = parseCsvRecords(text)
          .slice(1)
          .map(row => ({
            ticker: cleanText(row[2] || '').toUpperCase(),
            date: formatUsDate(cleanText(row[0])),
            nav: numberOrNull(row[3]),
            sharesOutstanding: (() => {
              const shares = numberOrNull(row[7]);
              return shares === null ? null : round(shares * 1000, 0);
            })(),
            netAssets: numberOrNull(row[8]),
          }))
          .filter(row => /^[A-Z0-9]{1,8}$/.test(row.ticker))
          .reduce((acc, row) => {
            const list = acc.get(row.ticker) || [];
            list.push({ date: row.date, nav: row.nav, sharesOutstanding: row.sharesOutstanding, netAssets: row.netAssets });
            acc.set(row.ticker, list);
            return acc;
          }, new Map<string, NavRow[]>());
      } catch (error) {
        console.error(`Bulk NAV history failed — ${errorMessage(error)}`);
      }
    }
    return navHistoryAll;
  };

  // --- candidate selection (catalog-level filters, then the bounded cursor) --
  const catalogFiltersActive = Boolean(config.tickers.length || config.category || config.aumRange);
  let candidates = catalog.filter(fund => {
    if (config.tickers.length && !config.tickers.includes(fund.ticker)) return false;
    if (config.category && !(fund.assetClass || '').toLowerCase().includes(config.category.toLowerCase())) return false;
    if (config.aumRange && !matchesRange(fund.netAssetsValue, config.aumRange)) return false;
    return true;
  });
  const beforeBatch = candidates.length;
  const cursor = config.maxFetches > 0 ? await readCursor() : null;
  if (cursor) candidates = candidates.filter(fund => fund.ticker > cursor);
  if (config.maxFetches > 0) candidates = candidates.slice(0, config.maxFetches);
  stats.skipped += beforeBatch - candidates.length;
  console.log(`Funds: ${catalog.length} in catalog, ${beforeBatch} after filters, ${candidates.length} to process${cursor ? ` (after cursor ${cursor})` : ''}`);

  // --- per-fund processing --------------------------------------------------
  const results = await mapWithConcurrency(candidates, config.concurrency, async (fund, index) => {
    const label = progressLabel(fund.ticker, index + 1, candidates.length);
    const startedAt = Date.now();
    console.log(`${label} …`);
    const directory = path.join(API_ROOT, 'funds', fund.ticker);
    const previous = previousFunds[fund.ticker];
    const filtered = (reason: string): void => {
      stats.filtered++;
      console.log(`${label} filtered (${reason}) · ${formatElapsed(Date.now() - startedAt)}`);
    };
    try {
      let page: FundPageData | null = null;
      if (!config.offlineSeed) {
        const html = await fetchText(fund.fundPage, browserHeaders(), config, `${fund.ticker} fund page`, `fund-${fund.ticker}.html`);
        page = parseFundPage(html);
      }
      if (!page) {
        if (!previous) throw new Error('no previously published data and offline');
        const previousMetaFile = path.join(directory, 'meta.json');
        if (!existsSync(previousMetaFile)) throw new Error('no previously published meta.json');
        const previousMeta = JSON.parse(await readFile(previousMetaFile, 'utf8')) as Record<string, any>;
        page = {
          cusip: String(previousMeta.identifiers?.cusip || ''),
          expenseRatio: numberOrNull(previousMeta.expenseRatio?.value),
          expenseRatioText: String(previousMeta.expenseRatio?.display || '—'),
          expenseRatioFootnote: String(previousMeta.expenseRatio?.footnote || ''),
          grossExpenseRatio: numberOrNull(previousMeta.expenseRatio?.gross?.value),
          grossExpenseRatioText: String(previousMeta.expenseRatio?.gross?.display || '—'),
          netExpenseRatio: numberOrNull(previousMeta.expenseRatio?.net?.value),
          netExpenseRatioText: String(previousMeta.expenseRatio?.net?.display || '—'),
          inceptionDate: String(previous?.inceptionDate || '—'),
          netAssetsText: String(previousMeta.aum?.display || '—'),
          netAssetsValue: numberOrNull(previousMeta.aum?.value),
          nav: numberOrNull(previousMeta.nav?.value),
          navText: String(previousMeta.nav?.display || '—'),
          marketPrice: numberOrNull(previousMeta.marketPrice?.value),
          marketPriceText: String(previousMeta.marketPrice?.display || '—'),
          priceAsOf: String(previousMeta.nav?.asOfDate || '—'),
          distributionFrequency: String(previousMeta.distributions?.frequency || ''),
          twelveMonthYield: numberOrNull(previousMeta.yields?.dividendYield),
          twelveMonthYieldText: String(previousMeta.yields?.dividendYieldText || '—'),
          sec30DayYield: numberOrNull(previousMeta.yields?.secYield),
          sec30DayYieldText: String(previousMeta.yields?.secYieldText || '—'),
          distributionsAsOf: String(previousMeta.distributions?.asOfDate || '—'),
          distributionsNote: String(previousMeta.distributions?.note || ''),
          characteristics: (previousMeta.officialMetrics?.characteristics || {}) as Record<string, string>,
          characteristicsAsOf: String(previousMeta.officialMetrics?.characteristicsAsOf || '—'),
          indexStats: (previousMeta.officialMetrics?.index || {}) as Record<string, string>,
          indexAsOf: String(previousMeta.officialMetrics?.indexAsOf || '—'),
          exposures: [],
          returns: { monthEnd: {}, quarterEnd: {} },
        };
      }

      // Filter checks that need published fund-page values.
      if (config.terRange && !matchesRange(page.expenseRatio, config.terRange)) {
        filtered('TER');
        return;
      }
      // DIVIDEND_YIELD matches the official 12-Month Yield when the fund page
      // publishes one and the indicated yield (computed from the official
      // distribution rows) otherwise, i.e. the value the feed reports.
      if (config.dividendYieldRange && !matchesRange(page.twelveMonthYield, config.dividendYieldRange)) {
        filtered('DIVIDEND_YIELD');
        return;
      }
      if (config.secYieldRange) {
        filtered('SEC_YIELD');
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
        filtered('PERFORMANCE');
        return;
      }
      if (
        config.totalReturnRanges['1Y'] && !matchesReturnRange(performanceNavMonth?.yr1, config.totalReturnRanges['1Y']) ||
        config.totalReturnRanges['3Y'] && !matchesReturnRange(cumulativeFromAnnualized(performanceNavMonth?.yr3 ?? null, 3), config.totalReturnRanges['3Y']) ||
        config.totalReturnRanges['5Y'] && !matchesReturnRange(cumulativeFromAnnualized(performanceNavMonth?.yr5 ?? null, 5), config.totalReturnRanges['5Y']) ||
        config.totalReturnRanges['10Y'] && !matchesReturnRange(cumulativeFromAnnualized(performanceNavMonth?.yr10 ?? null, 10), config.totalReturnRanges['10Y']) ||
        config.totalReturnRanges.YTD && !matchesReturnRange(performanceNavMonth?.ytd, config.totalReturnRanges.YTD)
      ) {
        filtered('TOTAL_RETURN');
        return;
      }

      // NAV history: the per-fund file reaches inception, the bulk file starts
      // in 2011; the per-fund file is therefore preferred, the bulk slice is the
      // fallback.
      let navRows: NavRow[] = [];
      if (!config.offlineSeed) {
        try {
          const text = await fetchText(navHistoryUrl(fund.ticker), browserHeaders(), config, `${fund.ticker} NAV history`, '');
          navRows = parseNavHistoryFile(text, fund.ticker);
        } catch (error) {
          console.warn(`${fund.ticker}: per-fund NAV history failed (${errorMessage(error)}); using the bulk file`);
        }
      }
      if (!navRows.length) {
        const bulk = await loadNavHistoryAll();
        navRows = bulk.get(fund.ticker) || [];
      }
      navRows.sort((a, b) => compareDisplayDates(a.date, b.date));
      navRows = applyHistoryRange(navRows, config.historyRange);

      // Distribution history (official endpoint; two empty years stop the walk).
      let distributions: DistributionRow[] = [];
      if (!config.offlineSeed) {
        const currentYear = new Date().getUTCFullYear();
        let emptyYears = 0;
        for (let year = currentYear; year >= currentYear - config.distributionYears; year--) {
          try {
            const text = await fetchText(
              distributionSummaryUrl(fund.ticker, year),
              jsonHeaders(),
              config,
              `${fund.ticker} distributions ${year}`,
              distributions.length === 0 && year === currentYear ? `distributions-${fund.ticker}-${year}.json` : '',
            );
            const parsed = parseDistributionSummary(text);
            if (parsed.length) {
              emptyYears = 0;
              distributions.push(...parsed);
            } else {
              emptyYears++;
            }
          } catch (error) {
            console.warn(`${fund.ticker}: distributions ${year} failed — ${errorMessage(error)}`);
            emptyYears++;
          }
          if (emptyYears >= 2) break;
        }
        distributions.sort((a, b) => compareDisplayDates(a.exDate, b.exDate));
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
        console.warn(`${fund.ticker}: per-fund holdings download failed — ${errorMessage(error)} · using the all-funds file`);
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
        exchange: exchanges.get(fund.ticker) || '',
        exchangeSource: exchanges.get(fund.ticker) ? exchangeSource : '—',
        splits: splitRows,
        config,
        catalogReadAt,
      });

      await mkdir(directory, { recursive: true });
      const holdingsWrite = await writeSheetPages(directory, 'holdings', fund.ticker, artifacts.holdingsHeaders, artifacts.holdingsRows, config.holdingsPageSize);
      const historyWrite = await writeSheetPages(directory, 'history', fund.ticker, artifacts.historyHeaders, artifacts.historyRows, config.historyPageSize);
      const meta = {
        ...artifacts.meta,
        holdings: { ...(artifacts.meta.holdings as Record<string, unknown>), ...holdingsWrite.manifest },
        history: { ...(artifacts.meta.history as Record<string, unknown>), ...historyWrite.manifest },
      };
      const metaResult = await writeIfChanged(path.join(directory, 'meta.json'), serialize(meta));
      artifacts.changed = metaResult === 'written' || holdingsWrite.written > 0 || historyWrite.written > 0 || holdingsWrite.removed > 0 || historyWrite.removed > 0;
      if (artifacts.changed) stats.updated++;
      else stats.unchanged++;
      previousFunds[fund.ticker] = artifacts.entry;
      console.log(formatFundProgress(label, artifacts.entry, artifacts.changed, Date.now() - startedAt));
    } catch (error) {
      stats.failed++;
      console.error(`${label} FAILED: ${errorMessage(error)} · ${formatElapsed(Date.now() - startedAt)}`);
      if (!previousFunds[fund.ticker] && previous) previousFunds[fund.ticker] = previous;
    }
  });

  // --- index.json -----------------------------------------------------------
  const indexFile = path.join(API_ROOT, 'index.json');
  const funds = Object.values(previousFunds).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + Number(fund.holdings || 0), 0),
    history: funds.reduce((sum, fund) => sum + Number(fund.history || 0), 0),
  };
  const index = {
    // The stamp only moves when the feed content actually did, so a rerun
    // against unchanged upstream data leaves an empty git diff.
    generatedAt: previousIndex.generatedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
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
  const indexResult = await writeIfChanged(indexFile, serialize(index));
  if (indexResult === 'written' && previousIndex.generatedAt) {
    await writeFile(indexFile, serialize({ ...index, generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }), 'utf8');
  }

  // --- cursor & raw samples -------------------------------------------------
  const stateFile = path.join(API_ROOT, 'update-state.json');
  if (config.maxFetches > 0 && candidates.length) {
    await writeIfChanged(stateFile, serialize({ cursor: candidates[candidates.length - 1].ticker, savedAt: new Date().toISOString() }));
  } else if (config.maxFetches === 0 && existsSync(stateFile)) {
    await rm(stateFile);
  }
  await writeRawSamples(config);

  console.log(
    `Done. updated=${stats.updated} unchanged=${stats.unchanged} filtered=${stats.filtered} skipped=${stats.skipped} failed=${stats.failed} · funds=${counts.funds} holdings=${counts.holdings} history=${counts.history} · ${formatElapsed(Date.now() - runStartedAt)}`,
  );
  if (stats.failed > 0) console.warn(`${stats.failed} step(s) failed; previously published files were kept for those funds.`);
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
