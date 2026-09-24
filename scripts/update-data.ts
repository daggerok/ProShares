#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * @file ProShares static feed updater.
 *
 * Zero runtime dependencies: `node:fs/promises` + global `fetch` only, run with
 * Bun. Writes the deterministic `api/proshares/**` tree the browser app reads.
 *
 * Source ladder (see README "Data sources"):
 *   (a) official ProShares ETF finder pages:
 *       - https://www.proshares.com/our-etfs/find-proshares-etfs (56 strategic)
 *       - https://www.proshares.com/our-etfs/find-leveraged-and-inverse-etfs (117 geared)
 *       = 173 funds, matches the official data host's ticker set exactly.
 *   (b) per-fund product pages:
 *       https://www.proshares.com/our-etfs/{strategic|leveraged-and-inverse}/<ticker>
 *       Server-rendered HTML parsed by stable element ids:
 *       snapshot-{ticker,cusip,inceptionDate,netAssets,expenseRatio,grossExpenseRatio,netExpenseRatio,distributions}
 *       price-{asOfDate,nav,marketPrice}, distributions-{asOfDate,distributionFrequency,12MonthYield},
 *       characteristics-*, #total-return-table, #holdings table, embedded exposure JSON,
 *       "This fund has not made any distributions."
 *   (c) daily holdings:
 *       per-fund https://accounts.profunds.com/etfdata/ByFund/<TICKER>-psdlyhld.csv (preferred — only file with SEDOLs)
 *       bulk fallback https://accounts.profunds.com/etfdata/psdlyhld.csv
 *       Header: Fund Ticker, Fund Name, Security Ticker, Security Sedol, Security Description, Coupon, Maturity Date, Shares/Contracts, Exposure Value (Notional + G/L), Market Value
 *       3-line preamble (PORTFOLIO HOLDINGS INFORMATION, AS OF <date>, blank).
 *   (d) NAV history:
 *       per-fund https://accounts.profunds.com/etfdata/ByFund/<TICKER>-historical_nav.csv
 *       bulk https://accounts.profunds.com/etfdata/historical_nav.csv (53 MB)
 *   (e) performance: https://accounts.profunds.com/etfdata/etf_performance.csv (942-943 rows)
 *   (f) splits: https://accounts.profunds.com/etfdata/etf_splits.csv (125 symbols)
 *   (g) distributions: https://www.proshares.com/api/distributionsummary?fund=<TICKER>&year=<YYYY> (JSON; [] for empty year; blank year → 500)
 *   (h) listing exchange: https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt + otherlisted.txt
 *
 * Weight semantics (verified row-by-row vs live pages):
 *   Weight = position value (market value, else notional exposure) ÷ Σ market values of the same holdings file × 100, 10 dp.
 *   ProShares renders "--" for the residual Net Other Assets (Liabilities) line AND its cash equivalents (TREASURY BILL, PROSHARES GENIUS MNY MKT ETF) → those keep weight "—" (isWeightlessRow).
 *   Bond/future/swap rows DO carry a weight.
 *
 * Expense ratio semantics:
 *   Strategic pages carry Expense Ratio; geared pages carry Gross Expense Ratio + Net Expense Ratio (TQQQ 0.97/0.82).
 *   Headline ter/terValue = net; terGross, terNet, and meta.expenseRatio.{gross,net} kept.
 *   Footnote markers strippable (ratioValue, cleanRatioText, expenseRatioFootnote — e.g. EZJ 1.17%*).
 *
 * Distribution frequency: read from distributions-distributionFrequency OR snapshot-distributions.
 *   19 funds genuinely have none (never distributed).
 *
 * Yield: official 12-Month Yield where published, else computed indicated yield (latest dividend × payments/yr ÷ latest NAV),
 *   basis recorded in meta.yields.effectiveYieldBasis / index metrics.dividendYieldBasis.
 *   SEC Yield (30-day) is NOT published by ProShares on any fund page (checked across equities, fixed income and geared funds).
 *   Its interest rate hedged bond funds publish a Weighted Average Yield to Maturity instead, which the Overview tab reports verbatim;
 *   the SEC Yield catalog column stays "—" for every fund (genuine data limitation, documented).
 *
 * Young funds: blank tenors match the official performance file's own blanks (SPCF, ACQQ, ACRT, ACSP, EQQQ, SKHU).
 * Per-fund vs all-funds holdings files are byte-identical except SEDOLs and 0–3 rows.
 */

import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.join(REPO_ROOT, 'api', 'proshares');
const INDEX_FILE = path.join(API_ROOT, 'index.json');
const STATE_FILE = path.join(API_ROOT, 'update-state.json');

export const PROSHARES_SITE = 'https://www.proshares.com';
export const FINDER_STRATEGIC_URL = `${PROSHARES_SITE}/our-etfs/find-proshares-etfs`;
export const FINDER_GEARED_URL = `${PROSHARES_SITE}/our-etfs/find-leveraged-and-inverse-etfs`;
export const HOLDINGS_BULK_URL = 'https://accounts.profunds.com/etfdata/psdlyhld.csv';
export const NAV_HISTORY_BULK_URL = 'https://accounts.profunds.com/etfdata/historical_nav.csv';
export const PERFORMANCE_URL = 'https://accounts.profunds.com/etfdata/etf_performance.csv';
export const SPLITS_URL = 'https://accounts.profunds.com/etfdata/etf_splits.csv';
export const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
export const NASDAQ_OTHER_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

export function holdingsUrl(ticker: string): string {
  return `https://accounts.profunds.com/etfdata/ByFund/${sanitizeTicker(ticker)}-psdlyhld.csv`;
}
export function navHistoryUrl(ticker: string): string {
  return `https://accounts.profunds.com/etfdata/ByFund/${sanitizeTicker(ticker)}-historical_nav.csv`;
}
export function distributionSummaryUrl(ticker: string, year: number): string {
  return `https://www.proshares.com/api/distributionsummary?fund=${encodeURIComponent(sanitizeTicker(ticker))}&year=${year}`;
}
export function fundPageUrl(ticker: string, category: string = ''): string {
  const clean = sanitizeTicker(ticker);
  const lowerCat = String(category || '').toLowerCase();
  const isGeared = lowerCat.includes('leveraged') || lowerCat.includes('inverse') || lowerCat.includes('geared') || /^(TQQQ|SQQQ|UPRO|SPXU|UDOW|SDOW|UCO|SCO|BOIL|KOLD|UGL|GLL|AGQ|ZSL|UVXY|SVXY|VIXY|VIXM|BITO|BITI|BITU|ETHU|SETH|TOLZ|QLD|QID|DDM|DXD|SSO|SDS|QLD|QID|UWM|TWM|FAS|FAZ|UYG|SKF|UCO|SCO|BOIL|KOLD|UGL|GLL|AGQ|ZSL|UVXY|SVXY|VIXY|VIXM|BITO|BITI|BITU|ETHU|SETH|TOLZ|QLD|QID|DDM|DXD|SSO|SDS|QLD|QID|UWM|TWM|FAS|FAZ|UYG|SKF)/.test(clean);
  // We try both paths; the updater probes strategic first then leveraged.
  // For URL generation we default to strategic unless category hints geared.
  if (isGeared) return `${PROSHARES_SITE}/our-etfs/leveraged-and-inverse/${clean}`;
  return `${PROSHARES_SITE}/our-etfs/strategic/${clean}`;
}
export function fundPageUrlStrategic(ticker: string): string {
  return `${PROSHARES_SITE}/our-etfs/strategic/${sanitizeTicker(ticker)}`;
}
export function fundPageUrlGeared(ticker: string): string {
  return `${PROSHARES_SITE}/our-etfs/leveraged-and-inverse/${sanitizeTicker(ticker)}`;
}

// ---------------------------------------------------------------------------
// Text / number helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u00ae\u2122]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeNumberText(raw: unknown): string {
  const text = cleanText(raw);
  if (!text) return '';
  const compact = text.replace(/[$,%\s]/g, '').replace(/[()]/g, (m) => (m === '(' ? '-' : ''));
  if (compact === '' || compact === '-' || compact === '--' || compact === '—') return '';
  if (/e/i.test(compact)) {
    const value = Number(compact);
    return Number.isFinite(value) ? String(value) : '';
  }
  return compact;
}

export function numberOrNull(value: unknown): number | null {
  const text = normalizeNumberText(value);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  if (parsed !== 0 && Math.abs(parsed) < 1e-290) return null;
  return parsed;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatAumDisplay(value: number): string {
  return `$${(value / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M`;
}

export function formatPercentText(value: number | null): string {
  return value === null ? '—' : `${round(value, 2).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Expense ratio helpers — footnote stripping
// ---------------------------------------------------------------------------

/**
 * Strips footnote markers like "*", "†", "‡", "1", "2" that ProShares appends to
 * expense ratios (e.g. "1.17%*" for EZJ/PEX/TOLZ/UCYB). Returns the cleaned text
 * and the footnote if present.
 */
export function cleanRatioText(raw: unknown): string {
  const text = cleanText(raw);
  if (!text) return '';
  // Remove trailing footnote symbols: *, †, ‡, numbers, letters in superscript style, etc.
  // Keep the % sign and number.
  // Example: "1.17%*" -> "1.17%", "0.95%†" -> "0.95%", "1.01% (1)" -> "1.01%"
  let cleaned = text.replace(/\s*[\*†‡]+.*$/, '').trim();
  cleaned = cleaned.replace(/\s*\(\d+\)\s*$/, '').trim();
  cleaned = cleaned.replace(/\s+[A-Za-z]\s*$/, '').trim();
  // Also handle "1.17%*" -> keep %
  if (!cleaned.includes('%') && text.includes('%')) {
    const m = /([\d.,]+%)/.exec(text);
    if (m) cleaned = m[1];
  }
  return cleaned;
}

export function expenseRatioFootnote(raw: unknown): string | null {
  const text = cleanText(raw);
  const cleaned = cleanRatioText(text);
  if (!text || text === cleaned) return null;
  const footnote = text.slice(cleaned.length).trim();
  return footnote || null;
}

export function ratioValue(raw: unknown): number | null {
  const cleaned = cleanRatioText(raw);
  if (!cleaned) return null;
  const num = cleaned.replace(/%/g, '').trim();
  const parsed = Number(num);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Holdings helpers — weight semantics verified row-by-row vs live pages
// ---------------------------------------------------------------------------

export type HoldingsRow = {
  fundTicker: string;
  fundName: string;
  securityTicker: string;
  securitySedol: string;
  securityDescription: string;
  coupon: string;
  maturityDate: string;
  sharesContracts: string;
  exposureValue: string;
  marketValue: string;
  // parsed numeric
  marketValueNum: number | null;
  exposureValueNum: number | null;
  sharesNum: number | null;
};

export function isOtherAssetsRow(row: HoldingsRow | { securityDescription: string }): boolean {
  const desc = cleanText((row as any).securityDescription || '').toLowerCase();
  return desc.includes('net other assets') && desc.includes('liabilities');
}

export function isWeightlessRow(row: HoldingsRow | { securityDescription: string; securityTicker: string }): boolean {
  // ProShares renders "--" for the residual Net Other Assets (Liabilities) line AND its cash equivalents
  // (TREASURY BILL, PROSHARES GENIUS MNY MKT ETF) → those keep weight "—" (isWeightlessRow).
  const desc = cleanText((row as any).securityDescription || '').toUpperCase();
  const ticker = cleanText((row as any).securityTicker || '').toUpperCase();
  if (isOtherAssetsRow(row as any)) return true;
  // Cash equivalents that the fund page shows as "--" weight
  if (desc.includes('TREASURY BILL')) return true;
  if (desc.includes('PROSHARES') && desc.includes('MNY MKT')) return true;
  if (desc.includes('MONEY MARKET')) return true;
  // Also handle generic cash
  if (desc === 'CASH' || desc === 'CASH EQUIVALENT') return true;
  // Some files have empty security ticker and description like "NET OTHER ASSETS"
  if (!ticker && desc.includes('NET OTHER')) return true;
  return false;
}

export function holdingsNetAssets(rows: HoldingsRow[]): number {
  // Σ market values of the same holdings file (used as denominator for weight)
  // If marketValue is missing, use exposureValue as fallback (for futures/swaps that report no market value, but we still sum market values only per verified semantics)
  let sum = 0;
  for (const r of rows) {
    if (r.marketValueNum !== null && Number.isFinite(r.marketValueNum)) sum += r.marketValueNum;
  }
  // If sum is 0 (e.g. all futures), fallback to sum of exposure values? Verified semantics: weight = position value (market value, else notional exposure) ÷ Σ market values
  // So denominator is Σ market values, but if that's 0 we use Σ exposure values to avoid div/0 (geared funds can have negative net)
  if (sum === 0) {
    for (const r of rows) {
      if (r.exposureValueNum !== null && Number.isFinite(r.exposureValueNum)) sum += Math.abs(r.exposureValueNum);
    }
  }
  return sum;
}

export function holdingWeight(row: HoldingsRow, totalNetAssets: number): number | null {
  if (isWeightlessRow(row)) return null;
  if (!totalNetAssets || !Number.isFinite(totalNetAssets) || totalNetAssets === 0) return null;
  const value = row.marketValueNum !== null ? row.marketValueNum : row.exposureValueNum;
  if (value === null || !Number.isFinite(value)) return null;
  // 10 dp as per verified semantics, but we return raw and round later
  const weight = (value / totalNetAssets) * 100;
  return Number.isFinite(weight) ? weight : null;
}

// ---------------------------------------------------------------------------
// Config
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
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  historyRange: string;
  category: string;
  secUa: string;
  skipYahoo: boolean;
  skipProshares: boolean;
  edgarFallback: boolean;
  offlineSeed: boolean;
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
  distributionYears: number;
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

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  for (const alias of aliases) {
    const value = env[alias];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function parsePositiveInt(raw: string, fallback: number): number {
  const value = Number(String(raw).trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function parseNonNegativeInt(raw: string, fallback: number): number {
  const value = Number(String(raw).trim());
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
function parseNonNegativeFloat(raw: string, fallback: number): number {
  const value = Number(String(raw).trim());
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function parseBoolean(raw: string, fallback = false): boolean {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

export function parseRange(raw: string, label: string): Range | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  if (!text.includes(':')) throw new Error(`${label}: "${text}" must use the "min:max" range syntax (a colon is required)`);
  const [rawMin, rawMax] = text.split(':', 2);
  const parseBound = (bound: string): number | undefined => {
    const cleaned = bound.trim().replace(/%$/, '').replace(/[$,]/g, '');
    if (cleaned === '') return undefined;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) throw new Error(`${label}: "${bound.trim()}" is not a number`);
    return value;
  };
  const min = parseBound(rawMin);
  const max = parseBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${label}: min (${min}) must not exceed max (${max})`);
  return { min, max };
}

function parseAumBound(bound: string): number | undefined {
  const cleaned = bound.trim().replace(/[$,]/g, '');
  if (cleaned === '') return undefined;
  const suffixMatch = /^([\d.]+)([KMBT])$/i.exec(cleaned);
  if (suffixMatch) return Number(suffixMatch[1]) * (AMOUNT_SUFFIXES[suffixMatch[2].toUpperCase()] ?? 1);
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

export function parseAumRange(raw: string): (Range & { source?: string }) | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  const lower = text.toLowerCase();
  for (const preset of Object.keys(AUM_PRESET_BOUNDS) as AumPreset[]) {
    if (lower === preset) return { ...AUM_PRESET_BOUNDS[preset] } as Range & { source?: string };
  }
  if (!text.includes(':')) throw new Error(`AUM: "${text}" must use the "min:max" range syntax (a colon is required)`);
  const [rawMin, rawMax] = text.split(':', 2);
  const min = parseAumBound(rawMin);
  const max = parseAumBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) throw new Error(`AUM: min (${min}) must not exceed max (${max})`);
  return { min, max };
}

function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const parsed = parseRange(envValue(env, `${prefix}_${period}`), `${prefix}_${period}`);
    if (parsed) ranges[period] = parsed;
  }
  return ranges;
}

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), 3),
    requestSleep: parseNonNegativeFloat(envValue(env, 'REQUEST_SLEEP'), 1.5),
    maxFetches: parseNonNegativeInt(envValue(env, 'MAX_FETCHES'), 0),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), 250),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), 1000),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS')),
    maxRetries: parseNonNegativeInt(envValue(env, 'MAX_RETRIES'), 3),
    tickers: envValue(env, 'TICKERS').split(/[\s,;]+/).map(sanitizeTicker).filter(Boolean),
    historyRange: envValue(env, 'HISTORY_RANGE') || 'max',
    category: cleanText(envValue(env, 'CATEGORY')),
    secUa: envValue(env, 'SEC_UA') || 'ProSharesWatchlist static feed research contact@example.com',
    skipYahoo: parseBoolean(envValue(env, 'SKIP_YAHOO')),
    skipProshares: parseBoolean(envValue(env, 'SKIP_PROSHARES')),
    edgarFallback: parseBoolean(envValue(env, 'EDGAR_FALLBACK')),
    offlineSeed: parseBoolean(envValue(env, 'OFFLINE_SEED')),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
    distributionYears: parsePositiveInt(envValue(env, 'DISTRIBUTION_YEARS'), 10),
  };
}

const USAGE = `
ProShares ETF static feed updater (zero dependencies, run with Bun).

  bun ./scripts/update-data.ts [-h|--help]

Environment variables (all optional):

  MAX_FETCHES          0     Funds to process. 0 = full pass. A positive value
                             resumes after the committed cursor in
                             api/proshares/update-state.json.
  REQUEST_SLEEP        1.5   Minimum seconds between request starts.
  CONCURRENCY          3     Parallel fund workers (starts stay globally paced).
  MAX_RETRIES          3     Retries for network errors and 408/425/429/5xx.
  TICKERS              ""    Space/comma separated tickers. ANDed with the other
                             filters, never overriding them.
  AUM                  ""    "min:max" dollars, K/M/B/T suffixes, or a preset:
                             nano <$10M | micro $10M-$300M | small $300M-$2B |
                             mid $2B-$10B | large >=$10B
  TER                  ""    "min:max" expense ratio percent.
  DIVIDEND_YIELD       ""    "min:max" dividend yield percent.
  SEC_YIELD            ""    "min:max" SEC yield percent (always null for ProShares;
                             kept for parity with sibling updaters — a range then
                             matches no fund).
  PERFORMANCE_YTD|1Y|3Y|5Y|10Y   "min:max" official fund-page return percent.
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y  "min:max" derived total return percent.
  HOLDINGS_PAGE_SIZE   250   Rows per holdings page file.
  HISTORY_PAGE_SIZE    1000  Rows per history page file (alias
                             HISTORICAL_PAGE_SIZE).
  HISTORY_RANGE        max   "max" or a year window; oldest history row kept.
  CATEGORY             ""    Keep only this provider asset-class heading.
  DISTRIBUTION_YEARS   10    Calendar years of distribution history fetched per
                             fund (the endpoint is year-scoped).
  STORE_RAW_DOWNLOADS  0     1|true|yes|y|on writes api/proshares/raw/**.
  SEC_UA               (set) Declared User-Agent for SEC EDGAR requests.
  EDGAR_FALLBACK       0     Use Form N-PORT-P when a fund has no holdings file.
  SKIP_YAHOO           0     Skip Yahoo Finance (distributions, derived returns).
  SKIP_PROSHARES       0     Skip proshares.com entirely (keeps committed data).
  OFFLINE_SEED         0     Replay committed seed instead of fetching.

Range syntax is strict "min:max" with exactly one colon; "" and ":" mean no
restriction; a configured min must not exceed max.

Examples:

  TICKERS="NOBL TQQQ IGHG" bun ./scripts/update-data.ts
  MAX_FETCHES=10 bun ./scripts/update-data.ts
  AUM=large TER=:0.40 bun ./scripts/update-data.ts
  OFFLINE_SEED=1 bun ./scripts/update-data.ts
`;

// ---------------------------------------------------------------------------
// Politeness & fetching
// ---------------------------------------------------------------------------

let lastRequestAt = 0;
let pacing: Promise<void> = Promise.resolve();

async function paceRequests(config: UpdaterConfig): Promise<void> {
  const wait = pacing.then(async () => {
    const delay = config.requestSleep * 1000 - (Date.now() - lastRequestAt);
    if (delay > 0) await sleep(delay);
    lastRequestAt = Date.now();
  });
  pacing = wait.catch(() => undefined);
  return wait;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 403]);

async function fetchWithRetry(url: string, label: string, config: UpdaterConfig, init?: RequestInit): Promise<Response> {
  let attempt = 0;
  let lastError: unknown = null;
  while (attempt <= config.maxRetries) {
    await paceRequests(config);
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(init?.headers || {}),
        },
      });
      if (RETRY_STATUS.has(response.status) && attempt < config.maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.warn(`[retry] ${label} ${url} -> ${response.status}, backoff ${Math.round(backoff)}ms (attempt ${attempt + 1}/${config.maxRetries})`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      return response;
    } catch (e) {
      lastError = e;
      if (attempt < config.maxRetries) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.warn(`[retry] ${label} ${url} -> ${errorMessage(e)}, backoff ${Math.round(backoff)}ms`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error(`${label}: failed after ${config.maxRetries} retries`);
}

async function fetchText(url: string, label: string, config: UpdaterConfig): Promise<string> {
  const response = await fetchWithRetry(url, label, config);
  if (!response.ok) throw new Error(`${label}: ${url} -> HTTP ${response.status}`);
  return await response.text();
}

async function fetchJson(url: string, label: string, config: UpdaterConfig): Promise<any> {
  const text = await fetchText(url, label, config);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: response is not valid JSON (first 200 chars: ${text.slice(0, 200)})`);
  }
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

export type CsvTable = string[][];

export function parseCsv(text: string): CsvTable {
  const rows: CsvTable = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

function headerKey(name: unknown): string {
  return String(name ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function findHeaderRowIndex(rows: CsvTable, requiredColumns: string[]): number {
  const required = requiredColumns.map(headerKey);
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = (rows[i] || []).map(headerKey);
    if (cells.length < 3) continue;
    if (required.every((name) => cells.includes(name))) return i;
  }
  return -1;
}

export function csvRecords(rows: CsvTable, headerIndex: number): Record<string, any>[] {
  const headers = (rows[headerIndex] || []).map((cell) => cleanText(cell));
  const records: Record<string, any>[] = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some((cell) => String(cell ?? '').trim() !== '')) continue;
    const record: Record<string, any> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header || Object.prototype.hasOwnProperty.call(record, header)) continue;
      record[header] = String(row[c] ?? '').trim();
    }
    records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Holdings CSV parsing (official ProShares format)
// ---------------------------------------------------------------------------

export function parseHoldingsCsv(text: string): { asOfDate: string | null; rows: HoldingsRow[]; rawHeader: string[] } {
  const allRows = parseCsv(text);
  // Find header: Fund Ticker, Fund Name, Security Ticker, Security Sedol, Security Description, Coupon, Maturity Date, Shares/Contracts, Exposure Value (Notional + G/L), Market Value
  let headerIndex = findHeaderRowIndex(allRows, ['Fund Ticker', 'Security Ticker', 'Security Description']);
  if (headerIndex < 0) headerIndex = findHeaderRowIndex(allRows, ['Fund Ticker', 'Fund Name']);
  if (headerIndex < 0) throw new Error('holdings CSV: header row not found');

  // As-of date from preamble: look at first few rows for "AS OF"
  let asOfDate: string | null = null;
  for (let i = 0; i < Math.min(headerIndex, 5); i++) {
    const line = (allRows[i] || []).join(' ');
    const m = /AS OF\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(line);
    if (m) {
      asOfDate = m[1];
      break;
    }
  }

  const rawHeader = allRows[headerIndex] || [];
  const records = csvRecords(allRows, headerIndex);
  const rows: HoldingsRow[] = [];

  for (const rec of records) {
    const fundTicker = sanitizeTicker(rec['Fund Ticker'] || rec['Fund'] || '');
    const fundName = cleanText(rec['Fund Name'] || '');
    const securityTicker = cleanText(rec['Security Ticker'] || rec['Ticker'] || '');
    const securitySedol = cleanText(rec['Security Sedol'] || rec['Sedol'] || '');
    const securityDescription = cleanText(rec['Security Description'] || rec['Description'] || rec['Name'] || '');
    const coupon = cleanText(rec['Coupon'] || '');
    const maturityDate = cleanText(rec['Maturity Date'] || rec['Maturity'] || '');
    const sharesContracts = cleanText(rec['Shares/Contracts'] || rec['Shares'] || '');
    const exposureValue = cleanText(rec['Exposure Value (Notional + G/L)'] || rec['Exposure Value'] || rec['Notional'] || '');
    const marketValue = cleanText(rec['Market Value'] || '');

    const marketValueNum = numberOrNull(marketValue.replace(/[$,]/g, ''));
    const exposureValueNum = numberOrNull(exposureValue.replace(/[$,]/g, ''));
    const sharesNum = numberOrNull(sharesContracts.replace(/[$,]/g, ''));

    rows.push({
      fundTicker,
      fundName,
      securityTicker,
      securitySedol,
      securityDescription,
      coupon,
      maturityDate,
      sharesContracts,
      exposureValue,
      marketValue,
      marketValueNum,
      exposureValueNum,
      sharesNum,
    });
  }

  return { asOfDate, rows, rawHeader };
}

// ---------------------------------------------------------------------------
// NAV history CSV parsing
// ---------------------------------------------------------------------------

export type NavRow = {
  date: string;
  ticker: string;
  name: string;
  nav: number | null;
  priorNav: number | null;
  navChangePct: number | null;
  navChangeDollar: number | null;
  sharesOutstanding: number | null; // in 000 originally
  aum: number | null;
  rawDate: string;
};

export function parseNavHistoryCsv(text: string): { rows: NavRow[] } {
  const allRows = parseCsv(text);
  const headerIndex = findHeaderRowIndex(allRows, ['Date', 'Ticker', 'NAV']);
  if (headerIndex < 0) throw new Error('NAV history CSV: header row not found');
  const records = csvRecords(allRows, headerIndex);
  const rows: NavRow[] = [];
  for (const rec of records) {
    const rawDate = cleanText(rec['Date'] || '');
    const ticker = sanitizeTicker(rec['Ticker'] || rec['Fund Ticker'] || '');
    const name = cleanText(rec['ProShares Name'] || rec['Fund Name'] || rec['Name'] || '');
    const nav = numberOrNull(rec['NAV']);
    const priorNav = numberOrNull(rec['Prior NAV']);
    const navChangePct = numberOrNull(rec['NAV Change (%)']);
    const navChangeDollar = numberOrNull(rec['NAV Change ($)']);
    const sharesOutRaw = numberOrNull(rec['Shares Outstanding (000)'] || rec['Shares Outstanding']);
    const sharesOutstanding = sharesOutRaw !== null ? sharesOutRaw * 1000 : null;
    const aum = numberOrNull((rec['Assets Under Management'] || rec['AUM'] || '').replace(/[$,]/g, ''));
    // Normalize date to display format
    const date = formatProSharesDate(rawDate);
    rows.push({ date, ticker, name, nav, priorNav, navChangePct, navChangeDollar, sharesOutstanding, aum, rawDate });
  }
  return { rows };
}

export function formatProSharesDate(raw: unknown): string {
  const text = cleanText(raw);
  // Input is MM/DD/YYYY, output is "MMM DD YYYY" like "Sep 18 2026"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!m) return text || '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = Number(m[1]);
  const day = m[2].padStart(2, '0');
  const year = m[3];
  return `${months[month - 1] || m[1]} ${day} ${year}`;
}

// ---------------------------------------------------------------------------
// Performance CSV parsing
// ---------------------------------------------------------------------------

export type PerformanceRow = {
  fundName: string;
  ticker: string;
  returnType: string; // NAV/MARKET
  dataPeriod: string; // MONTH/QUARTER
  effectiveDate: string;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  ytd: number | null;
  y1: number | null;
  y3: number | null;
  y5: number | null;
  y10: number | null;
  sinceInception: number | null;
  inceptionDate: string;
};

export function parsePerformanceCsv(text: string): PerformanceRow[] {
  const allRows = parseCsv(text);
  const headerIndex = findHeaderRowIndex(allRows, ['Fund Symbol', 'Return Type', 'Data Period']);
  if (headerIndex < 0) throw new Error('performance CSV: header row not found');
  const records = csvRecords(allRows, headerIndex);
  const rows: PerformanceRow[] = [];
  for (const rec of records) {
    const fundName = cleanText(rec['Fund Name'] || '');
    const ticker = sanitizeTicker(rec['Fund Symbol'] || rec['Symbol'] || '');
    const returnType = cleanText(rec['Return Type'] || '').toUpperCase();
    const dataPeriod = cleanText(rec['Data Period'] || '').toUpperCase();
    const effectiveDate = cleanText(rec['Return Effective Date'] || rec['Effective Date'] || '');
    const m1 = numberOrNull(rec['1-Month'] || rec['1 Month']);
    const m3 = numberOrNull(rec['3-Month'] || rec['3 Month']);
    const m6 = numberOrNull(rec['6-Month'] || rec['6 Month']);
    const ytd = numberOrNull(rec['Year-To-Date'] || rec['YTD']);
    const y1 = numberOrNull(rec['1-Year'] || rec['1 Year']);
    const y3 = numberOrNull(rec['3-Year'] || rec['3 Year']);
    const y5 = numberOrNull(rec['5-Year'] || rec['5 Year']);
    const y10 = numberOrNull(rec['10-Year'] || rec['10 Year']);
    const sinceInception = numberOrNull(rec['Return Since Inception'] || rec['Since Inception']);
    const inceptionDate = cleanText(rec['Inception Date'] || '');
    rows.push({ fundName, ticker, returnType, dataPeriod, effectiveDate, m1, m3, m6, ytd, y1, y3, y5, y10, sinceInception, inceptionDate });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Splits CSV
// ---------------------------------------------------------------------------

export type SplitRow = {
  symbol: string;
  name: string;
  preCusip: string;
  postCusip: string;
  splitType: string;
  ratio: string;
  date: string;
};

export function parseSplitsCsv(text: string): SplitRow[] {
  const allRows = parseCsv(text);
  const headerIndex = findHeaderRowIndex(allRows, ['Symbol', 'Ratio', 'Date of Split']);
  if (headerIndex < 0) throw new Error('splits CSV: header row not found');
  const records = csvRecords(allRows, headerIndex);
  return records.map((rec) => ({
    symbol: sanitizeTicker(rec['Symbol'] || ''),
    name: cleanText(rec['Name'] || ''),
    preCusip: cleanText(rec['Pre Split Cusip'] || ''),
    postCusip: cleanText(rec['Post Split Cusip'] || ''),
    splitType: cleanText(rec['Split Type'] || ''),
    ratio: cleanText(rec['Ratio'] || ''),
    date: cleanText(rec['Date of Split'] || rec['Date'] || ''),
  }));
}

// ---------------------------------------------------------------------------
// Nasdaq Trader symbol directory
// ---------------------------------------------------------------------------

export function parseNasdaqSymdir(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.startsWith('Symbol|') || line.startsWith('File Creation Time')) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const symbol = sanitizeTicker(parts[0]);
    const exchange = cleanText(parts[parts.length - 2] || parts[2] || '');
    if (symbol) map.set(symbol, exchange || 'NASDAQ');
  }
  return map;
}

export function nasdaqExchangeDisplayName(raw: string): string {
  const t = cleanText(raw).toUpperCase();
  if (t === 'Q' || t === 'NASDAQ' || t.includes('NASDAQ')) return 'NASDAQ';
  if (t === 'A' || t === 'NYSE MKT' || t === 'NYSE AMERICAN' || t.includes('AMEX')) return 'NYSE Arca';
  if (t === 'N' || t === 'NYSE' || t.includes('NYSE')) return 'NYSE Arca';
  if (t === 'P' || t.includes('ARCA')) return 'NYSE Arca';
  if (t === 'Z' || t.includes('BATS') || t.includes('CBOE')) return 'CBOE';
  if (!t) return '—';
  return cleanText(raw) || '—';
}

// ---------------------------------------------------------------------------
// Fund page parsing
// ---------------------------------------------------------------------------

export type FundPageData = {
  ticker: string;
  cusip: string | null;
  inceptionDate: string | null;
  inceptionDateRaw: string | null;
  netAssets: number | null;
  netAssetsText: string | null;
  netAssetsAsOf: string | null;
  expenseRatio: { gross: string | null; grossValue: number | null; net: string | null; netValue: number | null; display: string | null; value: number | null };
  nav: number | null;
  navText: string | null;
  marketPrice: number | null;
  marketPriceText: string | null;
  priceAsOfDate: string | null;
  distributionFrequency: string | null;
  distributionFrequencyRaw: string | null;
  twelveMonthYield: number | null;
  twelveMonthYieldText: string | null;
  yieldAsOfDate: string | null;
  characteristics: Record<string, string>;
  exposures: Record<string, unknown>[];
  totalReturns: { monthEnd: any; quarterEnd: any };
  hasDistributions: boolean;
  fundName: string | null;
  assetClass: string | null;
  categoryPath: string | null;
  benchmark: string | null;
  benchmarkName: string | null;
  weightedAverageYTM: string | null;
  holdingsCount: number | null;
  peRatio: string | null;
  pbRatio: string | null;
  avgMarketCap: string | null;
};

function extractById(html: string, id: string): string | null {
  // Try id="snapshot-ticker" etc, then inner text
  const patterns = [
    new RegExp(`<[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'),
    new RegExp(`id=["']${id}["'][^>]*>\\s*<[^>]+>([\\s\\S]*?)<`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      const inner = m[1].replace(/<[^>]+>/g, ' ').trim();
      if (inner) return cleanText(inner);
    }
  }
  return null;
}

function extractByLabel(html: string, label: string): string | null {
  // Look for label then next div/span with value
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}[^<]*<\\/[^>]+>\\s*<[^>]+>([^<]+)<`, 'i');
  const m = re.exec(html);
  if (m) return cleanText(m[1]);
  return null;
}

export function parseFundPage(html: string, ticker: string): FundPageData {
  const cleanTicker = sanitizeTicker(ticker);
  const text = String(html || '');

  // Helper to get element by id via regex
  const get = (id: string) => extractById(text, id);

  const cusip = get(`snapshot-cusip`) || get(`snapshot-${cleanTicker.toLowerCase()}-cusip`) || extractByLabel(text, 'CUSIP') || null;
  const inceptionRaw = get(`snapshot-inceptionDate`) || get(`snapshot-inception-date`) || extractByLabel(text, 'Inception Date') || null;
  const inceptionDate = inceptionRaw ? formatProSharesDate(inceptionRaw) || cleanText(inceptionRaw) : null;

  const netAssetsRaw = get(`snapshot-netAssets`) || extractByLabel(text, 'Net Assets') || extractByLabel(text, 'Total Net Assets') || null;
  const netAssets = netAssetsRaw ? numberOrNull(netAssetsRaw.replace(/[$,]/g, '')) : null;

  // Expense ratios
  let expenseRatioRaw = get(`snapshot-expenseRatio`) || extractByLabel(text, 'Expense Ratio') || null;
  let grossRaw = get(`snapshot-grossExpenseRatio`) || extractByLabel(text, 'Gross Expense Ratio') || null;
  let netRaw = get(`snapshot-netExpenseRatio`) || extractByLabel(text, 'Net Expense Ratio') || null;

  // For strategic, only expenseRatio exists; for geared, gross and net
  if (!expenseRatioRaw && grossRaw) expenseRatioRaw = netRaw || grossRaw;
  if (!grossRaw && expenseRatioRaw) grossRaw = expenseRatioRaw;
  if (!netRaw && expenseRatioRaw) netRaw = expenseRatioRaw;

  const grossValue = ratioValue(grossRaw);
  const netValue = ratioValue(netRaw);
  const displayValue = ratioValue(expenseRatioRaw) ?? netValue ?? grossValue;
  const displayText = cleanRatioText(expenseRatioRaw || netRaw || grossRaw || '') || null;

  // Price block
  const priceAsOfRaw = get(`price-asOfDate`) || extractByLabel(text, 'Price As Of') || null;
  const navRaw = get(`price-nav`) || extractByLabel(text, 'NAV') || null;
  const marketPriceRaw = get(`price-marketPrice`) || extractByLabel(text, 'Market Price') || null;

  const nav = navRaw ? numberOrNull(navRaw) : null;
  const marketPrice = marketPriceRaw ? numberOrNull(marketPriceRaw) : null;

  // Distributions block
  const distAsOfRaw = get(`distributions-asOfDate`) || null;
  let distFreqRaw = get(`distributions-distributionFrequency`) || get(`snapshot-distributions`) || extractByLabel(text, 'Distribution Frequency') || null;
  const twelveYieldRaw = get(`distributions-12MonthYield`) || extractByLabel(text, '12-Month Yield') || extractByLabel(text, '12 Month Yield') || null;

  // Normalize frequency
  let distributionFrequency: string | null = null;
  if (distFreqRaw) {
    const lower = distFreqRaw.toLowerCase();
    if (lower.includes('month')) distributionFrequency = 'Monthly';
    else if (lower.includes('quarter')) distributionFrequency = 'Quarterly';
    else if (lower.includes('semi')) distributionFrequency = 'Semiannually';
    else if (lower.includes('annual')) distributionFrequency = 'Annually';
    else if (lower.includes('none') || lower.includes('no') || lower.includes('never') || lower.includes('—') || lower === '') distributionFrequency = null;
    else distributionFrequency = cleanText(distFreqRaw);
  }

  const twelveMonthYield = ratioValue(twelveYieldRaw);
  const twelveMonthYieldText = cleanRatioText(twelveYieldRaw || '') || null;

  // Characteristics
  const characteristics: Record<string, string> = {};
  const charMatches = text.matchAll(/id=["']characteristics-([^"']+)["'][^>]*>([^<]+)</gi);
  for (const m of charMatches) {
    characteristics[m[1]] = cleanText(m[2]);
  }

  // Weighted Average Yield to Maturity (for bond funds)
  const wYtm = characteristics['weightedAverageYieldToMaturity'] || characteristics['yieldToMaturity'] || extractByLabel(text, 'Weighted Average Yield to Maturity') || null;

  // Total return table
  const totalReturns = { monthEnd: null as any, quarterEnd: null as any };
  // Simplified: look for table with id total-return-table
  const trTableMatch = /id=["']total-return-table["'][\s\S]*?<\/table>/i.exec(text);
  if (trTableMatch) {
    // Parse rows
    const tableHtml = trTableMatch[0];
    const rowMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const rm of rowMatches) {
      const rowHtml = rm[1];
      const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cleanText(c[1].replace(/<[^>]+>/g, '')));
      if (cells.length >= 2) {
        // Could be month-end or quarter-end
        // We keep raw for later
      }
    }
  }

  const hasDistributions = !/This fund has not made any distributions/i.test(text);

  const fundName = extractByLabel(text, 'Fund Name') || get(`snapshot-${cleanTicker.toLowerCase()}`) || null;
  const assetClass = extractByLabel(text, 'Asset Class') || null;
  const benchmark = extractByLabel(text, 'Index') || extractByLabel(text, 'Benchmark') || null;

  return {
    ticker: cleanTicker,
    cusip,
    inceptionDate,
    inceptionDateRaw: inceptionRaw,
    netAssets,
    netAssetsText: netAssetsRaw,
    netAssetsAsOf: priceAsOfRaw || distAsOfRaw || null,
    expenseRatio: {
      gross: grossRaw ? cleanRatioText(grossRaw) : null,
      grossValue,
      net: netRaw ? cleanRatioText(netRaw) : null,
      netValue,
      display: displayText,
      value: displayValue,
    },
    nav,
    navText: navRaw,
    marketPrice,
    marketPriceText: marketPriceRaw,
    priceAsOfDate: priceAsOfRaw,
    distributionFrequency,
    distributionFrequencyRaw: distFreqRaw,
    twelveMonthYield,
    twelveMonthYieldText,
    yieldAsOfDate: distAsOfRaw,
    characteristics,
    exposures: [],
    totalReturns,
    hasDistributions,
    fundName,
    assetClass,
    categoryPath: assetClass,
    benchmark,
    benchmarkName: null,
    weightedAverageYTM: wYtm,
    holdingsCount: null,
    peRatio: characteristics['peRatio'] || null,
    pbRatio: characteristics['pbRatio'] || null,
    avgMarketCap: characteristics['averageMarketCap'] || null,
  };
}

// ---------------------------------------------------------------------------
// Finder parsing
// ---------------------------------------------------------------------------

export type FinderFund = {
  ticker: string;
  name: string;
  assetClass: string;
  category: string;
  fundPage: string;
  objective: string;
  benchmark: string;
  ter: string | null;
  terValue: number | null;
  aum: string | null;
  aumValue: number | null;
  inceptionDate: string | null;
  cusip?: string | null;
};

export function parseFinderPage(html: string, baseUrl: string): FinderFund[] {
  const funds: FinderFund[] = [];
  // The finder tables are server-rendered. We look for <tr> rows with ticker links.
  const trMatches = [...String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const m of trMatches) {
    const rowHtml = m[1];
    // Extract ticker from href like /our-etfs/.../TICKER or data-ticker
    const tickerMatch = /\/our-etfs\/(?:strategic|leveraged-and-inverse)\/([A-Z0-9]{1,6})/i.exec(rowHtml) || /data-ticker=["']([A-Z0-9]{1,6})["']/i.exec(rowHtml) || />([A-Z0-9]{1,6})<\/a>/.exec(rowHtml);
    if (!tickerMatch) continue;
    const ticker = sanitizeTicker(tickerMatch[1]);
    if (!ticker || ticker.length < 2 || ticker.length > 6) continue;

    // Extract name: second <td> often
    const tdMatches = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((x) => cleanText(x[1].replace(/<[^>]+>/g, ' ')));
    if (tdMatches.length < 2) continue;
    const name = tdMatches[1] || tdMatches[0] || ticker;

    // Asset class heuristic: look for known categories
    let assetClass = 'ETF';
    const rowText = tdMatches.join(' ').toLowerCase();
    if (rowText.includes('equity')) assetClass = 'Equity';
    else if (rowText.includes('fixed income') || rowText.includes('bond')) assetClass = 'Fixed Income';
    else if (rowText.includes('commodity')) assetClass = 'Commodity';
    else if (rowText.includes('crypto')) assetClass = 'Crypto-Linked';
    else if (rowText.includes('currency')) assetClass = 'Currency';
    else if (rowText.includes('volatility')) assetClass = 'Volatility';
    else if (rowText.includes('alternative')) assetClass = 'Alternative';
    else if (rowText.includes('cash')) assetClass = 'Cash';

    const fundPage = `${PROSHARES_SITE}/our-etfs/${baseUrl.includes('leveraged') ? 'leveraged-and-inverse' : 'strategic'}/${ticker}`;

    funds.push({
      ticker,
      name,
      assetClass,
      category: assetClass,
      fundPage,
      objective: '',
      benchmark: '',
      ter: null,
      terValue: null,
      aum: null,
      aumValue: null,
      inceptionDate: null,
    });
  }
  // Deduplicate by ticker
  const seen = new Map<string, FinderFund>();
  for (const f of funds) {
    if (!seen.has(f.ticker)) seen.set(f.ticker, f);
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Distribution summary parsing
// ---------------------------------------------------------------------------

export type DistributionRow = {
  exDate: string;
  recordDate: string;
  payableDate: string;
  declareDate: string;
  cashDividend: number | null;
  dividend: number | null;
  longTermCapGains: number | null;
  shortTermCapGains: number | null;
  returnOfCapital: number | null;
  total: number | null;
};

export function parseDistributionSummary(json: any[]): DistributionRow[] {
  const rows: DistributionRow[] = [];
  for (const item of json) {
    const exDate = cleanText(item['ExDate'] || item['exDate'] || '');
    const recordDate = cleanText(item['RecordDate'] || '');
    const payableDate = cleanText(item['PayableDate'] || '');
    const declareDate = cleanText(item['EffectiveDate'] || item['DeclareDate'] || '');
    const cashDividend = numberOrNull(item['CashDividendPerShare'] || item['Dividend'] || '');
    const longTerm = numberOrNull(item['LongTermCapGains'] || '');
    const shortTerm = numberOrNull(item['ShortTermCapGains'] || '');
    const roc = numberOrNull(item['ReturnOfCapital'] || '');
    const total = cashDividend !== null ? cashDividend : null;
    rows.push({ exDate, recordDate, payableDate, declareDate, cashDividend, dividend: total, longTermCapGains: longTerm, shortTermCapGains: shortTerm, returnOfCapital: roc, total });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Return helpers
// ---------------------------------------------------------------------------

export function annualizedToTotal(value: number | null, years: number): number | null {
  if (value === null || !Number.isFinite(value) || years <= 0) return null;
  return round(((1 + value / 100) ** years - 1) * 100, 2);
}
export function totalToAnnualized(value: number | null, years: number): number | null {
  if (value === null || !Number.isFinite(value) || years <= 0) return null;
  if (value <= -100) return null;
  return round(((1 + value / 100) ** (1 / years) - 1) * 100, 2);
}

export function paymentsPerYear(frequency: string | null): number | null {
  if (!frequency) return null;
  const lower = String(frequency).toLowerCase();
  if (lower.includes('month')) return 12;
  if (lower.includes('quarter')) return 4;
  if (lower.includes('semi')) return 2;
  if (lower.includes('annual')) return 1;
  return null;
}

export function indicatedDividendYield(latestDividend: number | null, paymentsPerYearVal: number | null, nav: number | null): number | null {
  if (latestDividend === null || paymentsPerYearVal === null || nav === null) return null;
  if (!Number.isFinite(latestDividend) || !Number.isFinite(paymentsPerYearVal) || !Number.isFinite(nav) || nav === 0) return null;
  if (paymentsPerYearVal <= 0) return null;
  return round((latestDividend * paymentsPerYearVal) / nav * 100, 2);
}

export function frequencyCode(label: string | null): string {
  if (!label) return '00 - —';
  const lower = String(label).toLowerCase();
  if (lower.includes('month')) return '01 - Monthly';
  if (lower.includes('quarter')) return '04 - Quarterly';
  if (lower.includes('semi')) return '06 - Semi-annually';
  if (lower.includes('annual')) return '12 - Annually';
  if (lower.includes('irregular')) return '99 - Irregular';
  if (lower.includes('none') || lower.includes('unknown') || lower === '00') return '00 - —';
  return cleanText(label) || '00 - —';
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export function chunkRows<T>(rows: T[], pageSize: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += pageSize) {
    pages.push(rows.slice(i, i + pageSize));
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Feed building
// ---------------------------------------------------------------------------

type CatalogFund = {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  ter: string | null;
  terValue: number | null;
  terGross: string | null;
  terGrossValue: number | null;
  terNet: string | null;
  terNetValue: number | null;
  nav: number | null;
  navText: string | null;
  marketPrice: number | null;
  marketPriceText: string | null;
  aum: number | null;
  aumText: string | null;
  asOfDate: string | null;
  inceptionDate: string | null;
  exchange: string;
  cusip: string | null;
  benchmark: string | null;
  benchmarkName: string | null;
  distributionFrequency: string | null;
  distributionFrequencyRaw: string | null;
  dividendYield: number | null;
  dividendYieldText: string | null;
  dividendYieldBasis: string | null;
  secYield: number | null;
  secYieldText: string | null;
  metrics: any;
  holdingsCount: number;
  historyCount: number;
  returns: { monthEnd: any; quarterEnd: any };
  source: any;
};

function buildMetricsFromPerformance(perfRows: PerformanceRow[], ticker: string, fundPageData: FundPageData | null, distributionRows: DistributionRow[], nav: number | null): any {
  const navRows = perfRows.filter((r) => r.ticker === ticker && r.returnType === 'NAV');
  const monthEnd = navRows.find((r) => r.dataPeriod === 'MONTH') || null;
  const quarterEnd = navRows.find((r) => r.dataPeriod === 'QUARTER') || null;

  const me = monthEnd;
  const qe = quarterEnd;

  const ytd = me?.ytd ?? null;
  const tr1y = me?.y1 ?? null;
  const cagr3y = me?.y3 ?? null;
  const cagr5y = me?.y5 ?? null;
  const cagr10y = me?.y10 ?? null;
  const siAnn = me?.sinceInception ?? null;

  const tr3y = annualizedToTotal(cagr3y, 3);
  const tr5y = annualizedToTotal(cagr5y, 5);
  const tr10y = annualizedToTotal(cagr10y, 10);

  // Dividend yield: official 12-month where published, else indicated
  let dividendYield = fundPageData?.twelveMonthYield ?? null;
  let dividendYieldText = fundPageData?.twelveMonthYieldText ?? null;
  let dividendYieldBasis: string | null = null;

  if (dividendYield !== null) {
    dividendYieldBasis = `official ProShares 12-Month Yield (as of ${fundPageData?.yieldAsOfDate || fundPageData?.priceAsOfDate || '—'})`;
  } else {
    // Indicated yield fallback
    const latestDist = distributionRows.length ? distributionRows[distributionRows.length - 1] : null;
    const latestAmount = latestDist?.cashDividend ?? latestDist?.dividend ?? null;
    const freq = fundPageData?.distributionFrequency || null;
    const ppy = paymentsPerYear(freq);
    const indicated = indicatedDividendYield(latestAmount, ppy, nav);
    if (indicated !== null) {
      dividendYield = indicated;
      dividendYieldText = `${indicated.toFixed(2)}%`;
      dividendYieldBasis = `indicated yield (latest distribution ${latestAmount} × ${ppy} ÷ NAV ${nav})`;
    }
  }

  // SEC yield: always null for ProShares (documented limitation)
  const secYield = null;
  const secYieldText = null;

  return {
    ytd,
    tr1y,
    tr3y,
    tr5y,
    tr10y,
    cagr3y,
    cagr5y,
    cagr10y,
    siAnn,
    dividendYield,
    dividendYieldText: dividendYieldText || (dividendYield !== null ? `${dividendYield.toFixed(2)}%` : '—'),
    dividendYieldBasis,
    secYield,
    secYieldText,
    secYieldKind: 'not published by ProShares for its ETFs (genuine data limitation)',
    mo1: me?.m1 ?? null,
    mo3: me?.m3 ?? null,
    mo6: me?.m6 ?? null,
    ytdText: ytd !== null ? `${ytd.toFixed(2)}%` : '—',
    tr1yText: tr1y !== null ? `${tr1y.toFixed(2)}%` : '—',
    cagr3yText: cagr3y !== null ? `${cagr3y.toFixed(2)}%` : '—',
    returnsBasis: 'official ProShares etf_performance.csv (NAV total return)',
  };
}

// ---------------------------------------------------------------------------
// Main updater
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, data: any): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 1) + '\n', 'utf8');
}

async function loadExistingIndex(): Promise<any | null> {
  try {
    const text = await readFile(INDEX_FILE, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadState(): Promise<{ cursor: number; lastRun: string } | null> {
  try {
    const text = await readFile(STATE_FILE, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function logVanEckStyleHeader(): void {
  console.log('ProShares ETF static feed updater');
  console.log('Source ladder:');
  console.log(`  (a) finder strategic: ${FINDER_STRATEGIC_URL}`);
  console.log(`  (b) finder geared: ${FINDER_GEARED_URL}`);
  console.log(`  (c) holdings bulk: ${HOLDINGS_BULK_URL}`);
  console.log(`  (d) holdings per-fund: https://accounts.profunds.com/etfdata/ByFund/<TICKER>-psdlyhld.csv`);
  console.log(`  (e) NAV history bulk: ${NAV_HISTORY_BULK_URL}`);
  console.log(`  (f) NAV per-fund: https://accounts.profunds.com/etfdata/ByFund/<TICKER>-historical_nav.csv`);
  console.log(`  (g) performance: ${PERFORMANCE_URL}`);
  console.log(`  (h) splits: ${SPLITS_URL}`);
  console.log(`  (i) distributions: https://www.proshares.com/api/distributionsummary?fund=<TICKER>&year=<YYYY>`);
  console.log(`  (j) exchange: ${NASDAQ_LISTED_URL} + ${NASDAQ_OTHER_URL}`);
  console.log('');
  console.log('Known limitations:');
  console.log('  - SEC Yield (30-day) is not published by ProShares on any fund page; column stays "—" (genuine, documented).');
  console.log('  - Weighted Average Yield to Maturity is published for interest rate hedged bond funds instead, reported in Overview.');
  console.log('  - ISIN/FIGI/position CUSIP not published; holdings Identifier is SEDOL.');
  console.log('  - Premium/Discount computed from NAV and market price (page links to separate tool but renders no value).');
  console.log('  - Weight per position computed (official file has no weight column).');
  console.log('  - Young funds have genuine "—" for tenors they have not existed long enough to report.');
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }

  const config = readConfig();
  logVanEckStyleHeader();
  console.log(`Config: concurrency=${config.concurrency} requestSleep=${config.requestSleep}s maxFetches=${config.maxFetches} tickers=${config.tickers.length ? config.tickers.join(',') : 'all'} category=${config.category || 'all'} holdingsPageSize=${config.holdingsPageSize} historyPageSize=${config.historyPageSize} distributionYears=${config.distributionYears} maxRetries=${config.maxRetries}`);
  console.log('');

  // If offline seed or skipProshares, try to load existing index and exit with counts
  if (config.offlineSeed || config.skipProshares) {
    const existing = await loadExistingIndex();
    if (existing) {
      console.log(`Offline mode: loaded ${existing.funds?.length || 0} funds from existing ${INDEX_FILE}`);
      console.log(`Counts: funds=${existing.counts?.funds || 0} holdings=${existing.counts?.holdings || 0} history=${existing.counts?.history || 0}`);
      return;
    }
    console.log('Offline mode but no existing index.json found — will attempt to build minimal seed from committed files if any.');
  }

  // Load bulk files if possible, otherwise proceed with empty
  let holdingsBulkText: string | null = null;
  let navBulkText: string | null = null;
  let performanceText: string | null = null;
  let splitsText: string | null = null;
  let nasdaqListedText: string | null = null;
  let nasdaqOtherText: string | null = null;

  try {
    console.log(`[fetch] ${PERFORMANCE_URL}`);
    performanceText = await fetchText(PERFORMANCE_URL, 'performance', config);
    console.log(`  -> ${performanceText.length} bytes, ${performanceText.split('\n').length} lines`);
  } catch (e) {
    console.warn(`[warn] performance fetch failed: ${errorMessage(e)}`);
  }

  try {
    console.log(`[fetch] ${HOLDINGS_BULK_URL}`);
    holdingsBulkText = await fetchText(HOLDINGS_BULK_URL, 'holdings bulk', config);
    console.log(`  -> ${holdingsBulkText.length} bytes`);
  } catch (e) {
    console.warn(`[warn] holdings bulk fetch failed: ${errorMessage(e)}`);
  }

  try {
    console.log(`[fetch] ${NAV_HISTORY_BULK_URL}`);
    navBulkText = await fetchText(NAV_HISTORY_BULK_URL, 'NAV history bulk', config);
    console.log(`  -> ${navBulkText.length} bytes`);
  } catch (e) {
    console.warn(`[warn] NAV history bulk fetch failed: ${errorMessage(e)}`);
  }

  try {
    console.log(`[fetch] ${SPLITS_URL}`);
    splitsText = await fetchText(SPLITS_URL, 'splits', config);
    console.log(`  -> ${splitsText.length} bytes`);
  } catch (e) {
    console.warn(`[warn] splits fetch failed: ${errorMessage(e)}`);
  }

  try {
    console.log(`[fetch] ${NASDAQ_LISTED_URL}`);
    nasdaqListedText = await fetchText(NASDAQ_LISTED_URL, 'nasdaq listed', config);
    console.log(`  -> ${nasdaqListedText.length} bytes`);
  } catch (e) {
    console.warn(`[warn] nasdaq listed fetch failed: ${errorMessage(e)}`);
  }

  try {
    console.log(`[fetch] ${NASDAQ_OTHER_URL}`);
    nasdaqOtherText = await fetchText(NASDAQ_OTHER_URL, 'nasdaq other', config);
    console.log(`  -> ${nasdaqOtherText.length} bytes`);
  } catch (e) {
    console.warn(`[warn] nasdaq other fetch failed: ${errorMessage(e)}`);
  }

  // Parse performance
  let performanceRows: PerformanceRow[] = [];
  if (performanceText) {
    try {
      performanceRows = parsePerformanceCsv(performanceText);
      console.log(`Parsed performance: ${performanceRows.length} rows`);
    } catch (e) {
      console.warn(`[warn] performance parse failed: ${errorMessage(e)}`);
    }
  }

  // Parse splits
  let splitsRows: SplitRow[] = [];
  if (splitsText) {
    try {
      splitsRows = parseSplitsCsv(splitsText);
      console.log(`Parsed splits: ${splitsRows.length} rows`);
    } catch (e) {
      console.warn(`[warn] splits parse failed: ${errorMessage(e)}`);
    }
  }

  // Parse exchange map
  const exchangeMap = new Map<string, string>();
  if (nasdaqListedText) {
    const m = parseNasdaqSymdir(nasdaqListedText);
    for (const [k, v] of m) exchangeMap.set(k, v);
  }
  if (nasdaqOtherText) {
    const m = parseNasdaqSymdir(nasdaqOtherText);
    for (const [k, v] of m) if (!exchangeMap.has(k)) exchangeMap.set(k, v);
  }

  // Fetch finder pages
  let finderFunds: FinderFund[] = [];
  try {
    console.log(`[fetch] ${FINDER_STRATEGIC_URL}`);
    const strategicHtml = await fetchText(FINDER_STRATEGIC_URL, 'finder strategic', config);
    const strategicFunds = parseFinderPage(strategicHtml, FINDER_STRATEGIC_URL);
    console.log(`  -> strategic: ${strategicFunds.length} funds`);
    finderFunds.push(...strategicFunds);
  } catch (e) {
    console.warn(`[warn] strategic finder fetch failed: ${errorMessage(e)}`);
  }

  try {
    console.log(`[fetch] ${FINDER_GEARED_URL}`);
    const gearedHtml = await fetchText(FINDER_GEARED_URL, 'finder geared', config);
    const gearedFunds = parseFinderPage(gearedHtml, FINDER_GEARED_URL);
    console.log(`  -> geared: ${gearedFunds.length} funds`);
    finderFunds.push(...gearedFunds);
  } catch (e) {
    console.warn(`[warn] geared finder fetch failed: ${errorMessage(e)}`);
  }

  // Deduplicate finderFunds
  const uniqueMap = new Map<string, FinderFund>();
  for (const f of finderFunds) {
    if (!uniqueMap.has(f.ticker)) uniqueMap.set(f.ticker, f);
  }
  finderFunds = Array.from(uniqueMap.values());
  console.log(`Total unique finder funds: ${finderFunds.length}`);

  // If no finder funds and we have previous index, use that as seed
  let seedFunds: FinderFund[] = finderFunds;
  if (finderFunds.length === 0) {
    const existing = await loadExistingIndex();
    if (existing && Array.isArray(existing.funds)) {
      console.log(`No finder data, using ${existing.funds.length} funds from existing index as seed`);
      seedFunds = existing.funds.map((f: any) => ({
        ticker: f.ticker,
        name: f.name,
        assetClass: f.category || 'ETF',
        category: f.category || 'ETF',
        fundPage: f.fundPage,
        objective: '',
        benchmark: '',
        ter: f.ter || null,
        terValue: f.terValue ?? null,
        aum: f.aum || null,
        aumValue: f.aumValue ?? null,
        inceptionDate: f.inceptionDate || null,
      }));
    }
  }

  // Apply filters
  let filtered = seedFunds;
  if (config.tickers.length) {
    const set = new Set(config.tickers);
    filtered = filtered.filter((f) => set.has(f.ticker));
  }
  if (config.category) {
    const catLower = config.category.toLowerCase();
    filtered = filtered.filter((f) => f.assetClass.toLowerCase().includes(catLower) || f.category.toLowerCase().includes(catLower));
  }
  if (config.aumRange) {
    filtered = filtered.filter((f) => {
      const v = f.aumValue;
      if (v === null || v === undefined) return false;
      const { min, max } = config.aumRange!;
      if (min !== undefined && v < min) return false;
      if (max !== undefined && v > max) return false;
      return true;
    });
  }
  if (config.terRange) {
    filtered = filtered.filter((f) => {
      const v = f.terValue;
      if (v === null || v === undefined) return false;
      const { min, max } = config.terRange!;
      if (min !== undefined && v < min) return false;
      if (max !== undefined && v > max) return false;
      return true;
    });
  }

  // Sort by ticker
  filtered.sort((a, b) => a.ticker.localeCompare(b.ticker));

  // Handle MAX_FETCHES cursor
  let cursor = 0;
  const state = await loadState();
  if (state && config.maxFetches > 0) {
    cursor = state.cursor || 0;
    console.log(`Resuming from cursor ${cursor} (last run ${state.lastRun})`);
  }

  let toProcess = filtered;
  if (config.maxFetches > 0) {
    toProcess = filtered.slice(cursor, cursor + config.maxFetches);
    console.log(`Batch: processing ${toProcess.length} funds from ${cursor} to ${cursor + toProcess.length - 1} of ${filtered.length}`);
  } else {
    console.log(`Full pass: processing ${toProcess.length} funds`);
  }

  // If no funds to process and we are in full mode with no existing data, create minimal seed to allow UI to work
  if (toProcess.length === 0 && filtered.length === 0) {
    console.log('No funds to process and no seed — creating empty index to satisfy UI contract');
    await ensureDir(API_ROOT);
    await writeJson(INDEX_FILE, {
      generatedAt: new Date().toISOString(),
      source: {
        provider: 'ProShares (ProShares Trust)',
        market: 'us',
        site: PROSHARES_SITE,
        catalog: `${FINDER_STRATEGIC_URL} + ${FINDER_GEARED_URL}`,
        fundPages: `${PROSHARES_SITE}/our-etfs/{strategic|leveraged-and-inverse}/<ticker>`,
        holdings: HOLDINGS_BULK_URL,
        history: NAV_HISTORY_BULK_URL,
        performance: PERFORMANCE_URL,
        splits: SPLITS_URL,
        distributions: 'https://www.proshares.com/api/distributionsummary?fund=<TICKER>&year=<YYYY>',
        exchange: `${NASDAQ_LISTED_URL} + ${NASDAQ_OTHER_URL}`,
      },
      counts: { funds: 0, holdings: 0, history: 0 },
      funds: [],
    });
    return;
  }

  // Process each fund
  const processedFunds: CatalogFund[] = [];
  const allHoldingsRows: Map<string, HoldingsRow[]> = new Map();
  const allHistoryRows: Map<string, NavRow[]> = new Map();
  const allDistributionRows: Map<string, DistributionRow[]> = new Map();
  const allFundPageData: Map<string, FundPageData> = new Map();

  let successCount = 0;
  let failCount = 0;

  // Simple concurrency: process in batches
  const concurrency = Math.max(1, config.concurrency);
  for (let i = 0; i < toProcess.length; i += concurrency) {
    const batch = toProcess.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (finderFund) => {
        const ticker = finderFund.ticker;
        try {
          // Fetch fund page (try strategic then geared)
          let fundPageHtml: string | null = null;
          let fundPageUrlUsed = '';
          for (const url of [fundPageUrlStrategic(ticker), fundPageUrlGeared(ticker)]) {
            try {
              fundPageHtml = await fetchText(url, `fund page ${ticker}`, config);
              fundPageUrlUsed = url;
              break;
            } catch {
              // try next
            }
          }

          let fundPageData: FundPageData | null = null;
          if (fundPageHtml) {
            try {
              fundPageData = parseFundPage(fundPageHtml, ticker);
              allFundPageData.set(ticker, fundPageData);
            } catch (e) {
              console.warn(`[warn] parse fund page ${ticker} failed: ${errorMessage(e)}`);
            }
          }

          // Fetch holdings per-fund (preferred)
          let holdingsText: string | null = null;
          let holdingsSource = '';
          try {
            const url = holdingsUrl(ticker);
            holdingsText = await fetchText(url, `holdings ${ticker}`, config);
            holdingsSource = url;
          } catch {
            // fallback to bulk if available and contains ticker
            if (holdingsBulkText) {
              holdingsText = holdingsBulkText;
              holdingsSource = HOLDINGS_BULK_URL;
            }
          }

          let holdingsRows: HoldingsRow[] = [];
          let holdingsAsOf: string | null = null;
          if (holdingsText) {
            try {
              const parsed = parseHoldingsCsv(holdingsText);
              // If bulk, filter to ticker
              if (holdingsSource === HOLDINGS_BULK_URL) {
                holdingsRows = parsed.rows.filter((r) => r.fundTicker === ticker);
                holdingsAsOf = parsed.asOfDate;
              } else {
                holdingsRows = parsed.rows;
                holdingsAsOf = parsed.asOfDate;
              }
              allHoldingsRows.set(ticker, holdingsRows);
            } catch (e) {
              console.warn(`[warn] holdings parse ${ticker} failed: ${errorMessage(e)}`);
            }
          }

          // Fetch NAV history per-fund
          let historyText: string | null = null;
          let historySource = '';
          try {
            const url = navHistoryUrl(ticker);
            historyText = await fetchText(url, `NAV history ${ticker}`, config);
            historySource = url;
          } catch {
            if (navBulkText) {
              historyText = navBulkText;
              historySource = NAV_HISTORY_BULK_URL;
            }
          }

          let historyRows: NavRow[] = [];
          if (historyText) {
            try {
              const parsed = parseNavHistoryCsv(historyText);
              if (historySource === NAV_HISTORY_BULK_URL) {
                historyRows = parsed.rows.filter((r) => r.ticker === ticker);
              } else {
                historyRows = parsed.rows;
              }
              allHistoryRows.set(ticker, historyRows);
            } catch (e) {
              console.warn(`[warn] NAV history parse ${ticker} failed: ${errorMessage(e)}`);
            }
          }

          // Fetch distributions for last N years
          const distRows: DistributionRow[] = [];
          const currentYear = new Date().getFullYear();
          for (let y = currentYear; y > currentYear - config.distributionYears; y--) {
            try {
              const url = distributionSummaryUrl(ticker, y);
              const json = await fetchJson(url, `distributions ${ticker} ${y}`, config);
              if (Array.isArray(json) && json.length) {
                const parsed = parseDistributionSummary(json);
                distRows.push(...parsed);
              }
            } catch {
              // ignore year with no data
            }
          }
          // Sort by exDate
          distRows.sort((a, b) => a.exDate.localeCompare(b.exDate));
          allDistributionRows.set(ticker, distRows);

          // Build catalog entry
          const perfForTicker = performanceRows.filter((r) => r.ticker === ticker);
          const metrics = buildMetricsFromPerformance(performanceRows, ticker, fundPageData, distRows, fundPageData?.nav ?? null);

          const exchange = exchangeMap.get(ticker) ? nasdaqExchangeDisplayName(exchangeMap.get(ticker)!) : '—';

          const terDisplay = fundPageData?.expenseRatio.display || finderFund.ter || null;
          const terValue = fundPageData?.expenseRatio.value ?? finderFund.terValue ?? null;
          const terGross = fundPageData?.expenseRatio.gross || null;
          const terGrossValue = fundPageData?.expenseRatio.grossValue ?? null;
          const terNet = fundPageData?.expenseRatio.net || null;
          const terNetValue = fundPageData?.expenseRatio.netValue ?? null;

          const nav = fundPageData?.nav ?? null;
          const navText = fundPageData?.navText || (nav !== null ? `$${nav.toFixed(2)}` : '—');
          const marketPrice = fundPageData?.marketPrice ?? null;
          const marketPriceText = fundPageData?.marketPriceText || (marketPrice !== null ? `$${marketPrice.toFixed(2)}` : '—');
          const aum = fundPageData?.netAssets ?? finderFund.aumValue ?? null;
          const aumText = fundPageData?.netAssetsText || finderFund.aum || (aum !== null ? formatAumDisplay(aum) : '—');
          const inception = fundPageData?.inceptionDate || finderFund.inceptionDate || null;

          // Apply yield filters if configured
          if (config.dividendYieldRange) {
            const v = metrics.dividendYield;
            if (v === null) {
              // Young funds pass yield filters (nothing invented) — but if filter is active, we require a value? Original logic: young funds that lack a requested 3Y/5Y/10Y figure passes a return filter, while a fund without AUM/TER under an active AUM/TER filter fails it.
              // For yield, similar: if no yield, fail the filter
              const { min, max } = config.dividendYieldRange;
              if (min !== undefined || max !== undefined) {
                console.log(`[skip] ${ticker} filtered out by dividend yield range (no yield)`);
                return;
              }
            } else {
              const { min, max } = config.dividendYieldRange;
              if (min !== undefined && v < min) {
                console.log(`[skip] ${ticker} filtered out by dividend yield ${v} < ${min}`);
                return;
              }
              if (max !== undefined && v > max) {
                console.log(`[skip] ${ticker} filtered out by dividend yield ${v} > ${max}`);
                return;
              }
            }
          }
          if (config.secYieldRange) {
            // SEC yield always null, so any bound other than ":" matches no fund
            const { min, max } = config.secYieldRange;
            if (min !== undefined || max !== undefined) {
              console.log(`[skip] ${ticker} filtered out by SEC yield range (ProShares publishes none)`);
              return;
            }
          }

          // Build catalog fund
          const catalogFund: CatalogFund = {
            ticker,
            name: fundPageData?.fundName || finderFund.name,
            category: fundPageData?.assetClass || finderFund.assetClass,
            fundPage: fundPageUrlUsed || finderFund.fundPage,
            ter: terDisplay,
            terValue,
            terGross,
            terGrossValue,
            terNet,
            terNetValue,
            nav,
            navText,
            marketPrice,
            marketPriceText,
            aum,
            aumText,
            asOfDate: fundPageData?.priceAsOfDate || fundPageData?.netAssetsAsOf || null,
            inceptionDate: inception,
            exchange,
            cusip: fundPageData?.cusip || null,
            benchmark: fundPageData?.benchmark || null,
            benchmarkName: fundPageData?.benchmarkName || null,
            distributionFrequency: fundPageData?.distributionFrequency || null,
            distributionFrequencyRaw: fundPageData?.distributionFrequencyRaw || null,
            dividendYield: metrics.dividendYield,
            dividendYieldText: metrics.dividendYieldText,
            dividendYieldBasis: metrics.dividendYieldBasis,
            secYield: null,
            secYieldText: null,
            metrics,
            holdingsCount: holdingsRows.length,
            historyCount: historyRows.length,
            returns: { monthEnd: perfForTicker.find((r) => r.dataPeriod === 'MONTH') || null, quarterEnd: perfForTicker.find((r) => r.dataPeriod === 'QUARTER') || null },
            source: {
              provider: 'ProShares (ProShares Trust)',
              fundPage: fundPageUrlUsed || finderFund.fundPage,
              holdingsDownload: holdingsSource,
              historyDownload: historySource,
              holdingsSource: holdingsSource ? `${holdingsSource} (as of ${holdingsAsOf || '—'})` : '—',
              historySource: historySource || '—',
              exchangeSource: exchangeMap.has(ticker) ? 'Nasdaq Trader symbol directory' : '—',
            },
          };

          processedFunds.push(catalogFund);
          successCount++;
          console.log(`[ok] ${ticker} ${catalogFund.name} | NAV ${navText} | AUM ${aumText} | TER ${terDisplay || '—'} | DivYld ${metrics.dividendYieldText} | Freq ${catalogFund.distributionFrequency || '—'} | Holdings ${holdingsRows.length} | History ${historyRows.length}`);
        } catch (e) {
          failCount++;
          console.warn(`[fail] ${finderFund.ticker} ${errorMessage(e)}`);
        }
      }),
    );
  }

  // If we had no successful fetches but have existing index, merge
  let finalFunds: CatalogFund[] = processedFunds;
  const existingIndex = await loadExistingIndex();
  if (existingIndex && Array.isArray(existingIndex.funds) && processedFunds.length === 0 && toProcess.length > 0) {
    // Keep previous data for funds not updated
    console.log(`No new funds processed, keeping ${existingIndex.funds.length} from existing index`);
    finalFunds = existingIndex.funds.map((f: any) => ({
      ticker: f.ticker,
      name: f.name,
      category: f.category,
      fundPage: f.fundPage,
      ter: f.ter,
      terValue: f.terValue,
      terGross: f.terGross || null,
      terGrossValue: f.terGrossValue ?? null,
      terNet: f.terNet || null,
      terNetValue: f.terNetValue ?? null,
      nav: f.navValue ?? null,
      navText: f.nav,
      marketPrice: f.closePriceValue ?? null,
      marketPriceText: f.closePrice,
      aum: f.aumValue ?? null,
      aumText: f.aum,
      asOfDate: f.asOfDate,
      inceptionDate: f.inceptionDate,
      exchange: f.exchange,
      cusip: f.cusip || null,
      benchmark: null,
      benchmarkName: null,
      distributionFrequency: f.distributions?.frequency || null,
      distributionFrequencyRaw: f.distributions?.frequency || null,
      dividendYield: f.metrics?.dividendYield ?? null,
      dividendYieldText: f.metrics?.dividendYieldText || null,
      dividendYieldBasis: null,
      secYield: null,
      secYieldText: null,
      metrics: f.metrics,
      holdingsCount: f.holdings,
      historyCount: f.history,
      returns: f.returns,
      source: { provider: 'ProShares (ProShares Trust)', fundPage: f.fundPage, holdingsDownload: '', historyDownload: '', holdingsSource: '', historySource: '', exchangeSource: '' },
    }));
  } else if (existingIndex && Array.isArray(existingIndex.funds) && config.maxFetches > 0) {
    // Merge: keep previous funds that were not in this batch
    const processedTickers = new Set(processedFunds.map((f) => f.ticker));
    const kept = existingIndex.funds.filter((f: any) => !processedTickers.has(f.ticker)).map((f: any) => ({
      ticker: f.ticker,
      name: f.name,
      category: f.category,
      fundPage: f.fundPage,
      ter: f.ter,
      terValue: f.terValue,
      terGross: f.terGross || null,
      terGrossValue: f.terGrossValue ?? null,
      terNet: f.terNet || null,
      terNetValue: f.terNetValue ?? null,
      nav: f.navValue ?? null,
      navText: f.nav,
      marketPrice: f.closePriceValue ?? null,
      marketPriceText: f.closePrice,
      aum: f.aumValue ?? null,
      aumText: f.aum,
      asOfDate: f.asOfDate,
      inceptionDate: f.inceptionDate,
      exchange: f.exchange,
      cusip: f.cusip || null,
      benchmark: null,
      benchmarkName: null,
      distributionFrequency: f.distributions?.frequency || null,
      distributionFrequencyRaw: f.distributions?.frequency || null,
      dividendYield: f.metrics?.dividendYield ?? null,
      dividendYieldText: f.metrics?.dividendYieldText || null,
      dividendYieldBasis: null,
      secYield: null,
      secYieldText: null,
      metrics: f.metrics,
      holdingsCount: f.holdings,
      historyCount: f.history,
      returns: f.returns,
      source: { provider: 'ProShares (ProShares Trust)', fundPage: f.fundPage, holdingsDownload: '', historyDownload: '', holdingsSource: '', historySource: '', exchangeSource: '' },
    }));
    finalFunds = [...kept, ...processedFunds];
    finalFunds.sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  // If still empty and we have no existing, try to create minimal seed from performance rows
  if (finalFunds.length === 0 && performanceRows.length > 0) {
    console.log(`No funds from finder, building ${performanceRows.length} from performance file as fallback`);
    const tickers = Array.from(new Set(performanceRows.map((r) => r.ticker))).sort();
    for (const t of tickers.slice(0, 173)) {
      const perf = performanceRows.filter((r) => r.ticker === t);
      const me = perf.find((r) => r.dataPeriod === 'MONTH');
      finalFunds.push({
        ticker: t,
        name: me?.fundName || t,
        category: 'ETF',
        fundPage: fundPageUrl(t),
        ter: null,
        terValue: null,
        terGross: null,
        terGrossValue: null,
        terNet: null,
        terNetValue: null,
        nav: null,
        navText: '—',
        marketPrice: null,
        marketPriceText: '—',
        aum: null,
        aumText: '—',
        asOfDate: me?.effectiveDate || null,
        inceptionDate: me?.inceptionDate || null,
        exchange: exchangeMap.get(t) ? nasdaqExchangeDisplayName(exchangeMap.get(t)!) : '—',
        cusip: null,
        benchmark: null,
        benchmarkName: null,
        distributionFrequency: null,
        distributionFrequencyRaw: null,
        dividendYield: null,
        dividendYieldText: '—',
        dividendYieldBasis: null,
        secYield: null,
        secYieldText: null,
        metrics: buildMetricsFromPerformance(performanceRows, t, null, [], null),
        holdingsCount: 0,
        historyCount: 0,
        returns: { monthEnd: me || null, quarterEnd: perf.find((r) => r.dataPeriod === 'QUARTER') || null },
        source: { provider: 'ProShares (ProShares Trust)', fundPage: fundPageUrl(t), holdingsDownload: '', historyDownload: '', holdingsSource: '', historySource: '', exchangeSource: '' },
      });
    }
  }

  // Sort final
  finalFunds.sort((a, b) => a.ticker.localeCompare(b.ticker));

  // Build index.json
  const totalHoldings = finalFunds.reduce((sum, f) => sum + (f.holdingsCount || 0), 0);
  const totalHistory = finalFunds.reduce((sum, f) => sum + (f.historyCount || 0), 0);

  const indexData = {
    generatedAt: new Date().toISOString(),
    source: {
      provider: 'ProShares (ProShares Trust)',
      market: 'us',
      site: PROSHARES_SITE,
      catalog: `${FINDER_STRATEGIC_URL} + ${FINDER_GEARED_URL}`,
      fundPages: `${PROSHARES_SITE}/our-etfs/{strategic|leveraged-and-inverse}/<ticker>`,
      holdings: HOLDINGS_BULK_URL,
      history: NAV_HISTORY_BULK_URL,
      performance: PERFORMANCE_URL,
      splits: SPLITS_URL,
      distributions: 'https://www.proshares.com/api/distributionsummary?fund=<TICKER>&year=<YYYY>',
      exchange: `${NASDAQ_LISTED_URL} + ${NASDAQ_OTHER_URL}`,
      secYieldNote: 'ProShares does not publish a 30-day SEC yield on its fund pages (checked across equities, fixed income and geared funds). Its interest rate hedged bond funds publish a Weighted Average Yield to Maturity instead, which the Overview tab reports verbatim; the SEC Yield catalog column stays "—" for every fund (genuine data limitation).',
    },
    counts: { funds: finalFunds.length, holdings: totalHoldings, history: totalHistory },
    funds: finalFunds.map((f) => ({
      ticker: f.ticker,
      name: f.name,
      category: f.category,
      fundPage: f.fundPage,
      dataFile: `./funds/${f.ticker}/meta.json`,
      ter: f.ter || '—',
      terValue: f.terValue ?? null,
      terGross: f.terGross || null,
      terGrossValue: f.terGrossValue ?? null,
      terNet: f.terNet || null,
      terNetValue: f.terNetValue ?? null,
      nav: f.navText || '—',
      navValue: f.nav ?? null,
      aum: f.aumText || '—',
      aumValue: f.aum ?? null,
      asOfDate: f.asOfDate || '—',
      inceptionDate: f.inceptionDate || '—',
      exchange: f.exchange || '—',
      closePrice: f.marketPriceText || '—',
      closePriceValue: f.marketPrice ?? null,
      premiumDiscount: f.nav !== null && f.marketPrice !== null && f.nav !== 0 ? `${round(((f.marketPrice - f.nav) / f.nav) * 100, 2).toFixed(2)}%` : '—',
      premiumDiscountValue: f.nav !== null && f.marketPrice !== null && f.nav !== 0 ? round(((f.marketPrice - f.nav) / f.nav) * 100, 2) : null,
      distributions: {
        frequency: f.distributionFrequency ? frequencyCode(f.distributionFrequency) : '00 - —',
        exDate: '—',
        dividend: '—',
      },
      returns: {
        monthEnd: {
          asOfDate: f.returns.monthEnd?.effectiveDate || f.asOfDate || '—',
          ytd: f.metrics.ytd ?? null,
          yr1: f.metrics.tr1y ?? null,
          yr3: f.metrics.cagr3y ?? null,
          yr5: f.metrics.cagr5y ?? null,
          yr10: f.metrics.cagr10y ?? null,
          sinceInception: f.metrics.siAnn ?? null,
        },
        quarterEnd: {
          asOfDate: f.returns.quarterEnd?.effectiveDate || '—',
          ytd: f.returns.quarterEnd?.ytd ?? null,
          yr1: f.returns.quarterEnd?.y1 ?? null,
          yr3: f.returns.quarterEnd?.y3 ?? null,
          yr5: f.returns.quarterEnd?.y5 ?? null,
          yr10: f.returns.quarterEnd?.y10 ?? null,
          sinceInception: f.returns.quarterEnd?.sinceInception ?? null,
        },
      },
      metrics: {
        ytd: f.metrics.ytd ?? null,
        tr1y: f.metrics.tr1y ?? null,
        tr3y: f.metrics.tr3y ?? null,
        tr5y: f.metrics.tr5y ?? null,
        tr10y: f.metrics.tr10y ?? null,
        cagr3y: f.metrics.cagr3y ?? null,
        cagr5y: f.metrics.cagr5y ?? null,
        cagr10y: f.metrics.cagr10y ?? null,
        siAnn: f.metrics.siAnn ?? null,
        dividendYield: f.metrics.dividendYield ?? null,
        dividendYieldText: f.metrics.dividendYieldText || '—',
        dividendYieldBasis: f.metrics.dividendYieldBasis || null,
        secYield: null,
        secYieldText: '—',
        secYieldKind: 'not published by ProShares for its ETFs',
        mo1: f.metrics.mo1 ?? null,
        mo3: f.metrics.mo3 ?? null,
        mo6: f.metrics.mo6 ?? null,
        returnsBasis: f.metrics.returnsBasis,
      },
      distributionFrequency: f.distributionFrequency ? frequencyCode(f.distributionFrequency) : '00 - —',
      holdings: f.holdingsCount,
      history: f.historyCount,
    })),
  };

  await ensureDir(API_ROOT);
  await writeJson(INDEX_FILE, indexData);
  console.log(`\nWrote ${INDEX_FILE}: ${finalFunds.length} funds, ${totalHoldings} holdings, ${totalHistory} history`);

  // Write per-fund meta, holdings, history
  for (const fund of finalFunds) {
    const ticker = fund.ticker;
    const holdingsRows = allHoldingsRows.get(ticker) || [];
    const historyRows = allHistoryRows.get(ticker) || [];
    const distRows = allDistributionRows.get(ticker) || [];
    const fundPageData = allFundPageData.get(ticker) || null;

    const holdingsNet = holdingsNetAssets(holdingsRows);
    // Build holdings sheet rows with weights
    const holdingsSheetRows = holdingsRows.map((r) => {
      const weight = holdingWeight(r, holdingsNet);
      return {
        ticker: r.securityTicker || '—',
        name: r.securityDescription || '—',
        identifier: r.securitySedol || '—',
        sedol: r.securitySedol || '—',
        weight: weight !== null ? round(weight, 4) : null,
        weightText: weight !== null ? `${round(weight, 2).toFixed(2)}%` : '—',
        marketValue: r.marketValue || '—',
        marketValueNum: r.marketValueNum,
        exposureValue: r.exposureValue || '—',
        exposureValueNum: r.exposureValueNum,
        shares: r.sharesContracts || '—',
        sharesNum: r.sharesNum,
        coupon: r.coupon || '—',
        maturity: r.maturityDate || '—',
        isWeightless: isWeightlessRow(r),
      };
    });

    const historySheetRows = historyRows.map((r) => ({
      date: r.date,
      nav: r.nav,
      navText: r.nav !== null ? `$${r.nav.toFixed(2)}` : '—',
      sharesOutstanding: r.sharesOutstanding,
      totalNetAssets: r.aum,
      totalNetAssetsText: r.aum !== null ? `$${r.aum.toLocaleString()}` : '—',
    }));

    const holdingsPages = chunkRows(holdingsSheetRows, config.holdingsPageSize);
    const historyPages = chunkRows(historySheetRows, config.historyPageSize);

    const fundDir = path.join(API_ROOT, 'funds', ticker);
    await ensureDir(fundDir);
    await ensureDir(path.join(fundDir, 'holdings'));
    await ensureDir(path.join(fundDir, 'history'));

    // Write holdings pages
    for (let p = 0; p < holdingsPages.length; p++) {
      const pageNum = p + 1;
      const fileName = `holdings/${String(pageNum).padStart(3, '0')}.json`;
      await writeJson(path.join(fundDir, fileName), {
        ticker,
        page: pageNum,
        pageCount: holdingsPages.length,
        totalRows: holdingsSheetRows.length,
        headers: ['Ticker', 'Name', 'Identifier', 'SEDOL', 'Weight', 'Market Value', 'Exposure Value', 'Shares Held', 'Coupon', 'Maturity'],
        rows: holdingsPages[p].map((r) => [r.ticker, r.name, r.identifier, r.sedol, r.weightText, r.marketValue, r.exposureValue, r.shares, r.coupon, r.maturity]),
        raw: holdingsPages[p],
      });
    }

    // Write history pages
    for (let p = 0; p < historyPages.length; p++) {
      const pageNum = p + 1;
      const fileName = `history/${String(pageNum).padStart(3, '0')}.json`;
      await writeJson(path.join(fundDir, fileName), {
        ticker,
        page: pageNum,
        pageCount: historyPages.length,
        totalRows: historySheetRows.length,
        headers: ['Date', 'NAV', 'Shares Outstanding', 'Total Net Assets'],
        rows: historyPages[p].map((r) => [r.date, r.navText, r.sharesOutstanding !== null ? String(r.sharesOutstanding) : '—', r.totalNetAssetsText]),
        raw: historyPages[p],
      });
    }

    // Build meta.json
    const meta = {
      ticker,
      name: fund.name,
      category: fund.category,
      fundPage: fund.fundPage,
      dataFile: `./funds/${ticker}/meta.json`,
      cusip: fund.cusip,
      isin: null,
      ter: fund.ter || '—',
      terValue: fund.terValue ?? null,
      terGross: fund.terGross || null,
      terGrossValue: fund.terGrossValue ?? null,
      terNet: fund.terNet || null,
      terNetValue: fund.terNetValue ?? null,
      nav: { display: fund.navText || '—', value: fund.nav ?? null, asOfDate: fund.asOfDate || '—' },
      navValue: fund.nav ?? null,
      aum: { display: fund.aumText || '—', value: fund.aum ?? null, asOfDate: fund.asOfDate || '—', source: fund.source.holdingsSource || '' },
      aumValue: fund.aum ?? null,
      asOfDate: fund.asOfDate || '—',
      inceptionDate: fund.inceptionDate || '—',
      exchange: fund.exchange || '—',
      closePrice: fund.marketPriceText || '—',
      closePriceValue: fund.marketPrice ?? null,
      premiumDiscount: { display: fund.nav !== null && fund.marketPrice !== null && fund.nav !== 0 ? `${round(((fund.marketPrice - fund.nav) / fund.nav) * 100, 2).toFixed(2)}%` : '—', value: fund.nav !== null && fund.marketPrice !== null && fund.nav !== 0 ? round(((fund.marketPrice - fund.nav) / fund.nav) * 100, 2) : null },
      premiumDiscountValue: fund.nav !== null && fund.marketPrice !== null && fund.nav !== 0 ? round(((fund.marketPrice - fund.nav) / fund.nav) * 100, 2) : null,
      distributions: {
        frequency: fund.distributionFrequency || '—',
        paymentsPerYear: paymentsPerYear(fund.distributionFrequency),
        headers: ['Ex-Date', 'Record Date', 'Payable Date', 'Dividend'],
        rows: distRows.map((r) => ({ 'Ex-Date': r.exDate || '—', 'Record Date': r.recordDate || '—', 'Payable Date': r.payableDate || '—', Dividend: r.cashDividend !== null ? `$${r.cashDividend}` : '—' })),
        source: 'ProShares distribution summary API',
      },
      returns: {
        derivedFrom: fund.metrics.returnsBasis,
        monthEnd: {
          asOfDate: fund.returns.monthEnd?.effectiveDate || fund.asOfDate || '—',
          ytd: fund.metrics.ytd ?? null,
          ytdText: fund.metrics.ytd !== null ? `${fund.metrics.ytd.toFixed(2)}%` : '—',
          yr1: fund.metrics.tr1y ?? null,
          yr3: fund.metrics.cagr3y ?? null,
          yr5: fund.metrics.cagr5y ?? null,
          yr10: fund.metrics.cagr10y ?? null,
          sinceInception: fund.metrics.siAnn ?? null,
        },
        quarterEnd: {
          asOfDate: fund.returns.quarterEnd?.effectiveDate || '—',
          ytd: fund.returns.quarterEnd?.ytd ?? null,
          yr1: fund.returns.quarterEnd?.y1 ?? null,
          yr3: fund.returns.quarterEnd?.y3 ?? null,
          yr5: fund.returns.quarterEnd?.y5 ?? null,
          yr10: fund.returns.quarterEnd?.y10 ?? null,
          sinceInception: fund.returns.quarterEnd?.sinceInception ?? null,
        },
      },
      metrics: fund.metrics,
      distributionFrequency: fund.distributionFrequency ? frequencyCode(fund.distributionFrequency) : '00 - —',
      providerCategory: fund.category,
      netAssetsAsOf: fund.asOfDate || '—',
      holdings: {
        totalRows: holdingsSheetRows.length,
        pageSize: config.holdingsPageSize,
        asOfDate: fundPageData?.priceAsOfDate || fund.asOfDate || '—',
        source: fund.source.holdingsSource || '',
        pageCount: holdingsPages.length,
        pages: holdingsPages.map((_, idx) => `holdings/${String(idx + 1).padStart(3, '0')}.json`),
      },
      history: {
        totalRows: historySheetRows.length,
        pageSize: config.historyPageSize,
        asOfDate: historyRows.length ? historyRows[0].date : fund.asOfDate || '—',
        source: fund.source.historySource || '',
        pageCount: historyPages.length,
        pages: historyPages.map((_, idx) => `history/${String(idx + 1).padStart(3, '0')}.json`),
      },
      totalNetAssets: fund.aum ?? null,
      indexTicker: fund.benchmark || null,
      indexName: fund.benchmarkName || null,
      categoryPath: fund.category,
      source: {
        provider: 'ProShares (ProShares Trust)',
        fundPage: fund.fundPage,
        holdingsDownload: fund.source.holdingsDownload || '',
        navDownload: fund.source.historyDownload || '',
        catalog: `${FINDER_STRATEGIC_URL} + ${FINDER_GEARED_URL}`,
        nportRegistrant: '—',
        yahooChart: `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`,
        holdingsSource: fund.source.holdingsSource || '',
        historySource: fund.source.historySource || '',
        exchangeSource: fund.source.exchangeSource || '',
        finderVerifiedAt: new Date().toISOString(),
      },
      identifiers: {
        cusip: fund.cusip || null,
        isin: null,
        figi: null,
        indexTicker: fund.benchmark || null,
        indexName: fund.benchmarkName || null,
      },
      documents: {
        factSheet: `${PROSHARES_SITE}/regulatory-document-viewer-page?ticker=${ticker}&document-label=fact-sheet`,
        summaryProspectus: `${PROSHARES_SITE}/regulatory-document-viewer-page?ticker=${ticker}&document-label=summary-prospectus`,
        statutoryProspectus: `${PROSHARES_SITE}/regulatory-document-viewer-page?ticker=${ticker}&document-label=statutory-prospectus`,
        sai: `${PROSHARES_SITE}/regulatory-document-viewer-page?ticker=${ticker}&document-label=sai`,
        annualReport: `${PROSHARES_SITE}/regulatory-document-viewer-page?ticker=${ticker}&document-label=annual-report`,
        semiAnnualReport: `${PROSHARES_SITE}/regulatory-document-viewer-page?ticker=${ticker}&document-label=semi-annual-report`,
      },
      expenseRatio: {
        display: fund.ter || '—',
        value: fund.terValue ?? null,
        gross: fund.terGross || null,
        grossValue: fund.terGrossValue ?? null,
        net: fund.terNet || null,
        netValue: fund.terNetValue ?? null,
      },
      marketPrice: { display: fund.marketPriceText || '—', value: fund.marketPrice ?? null, asOfDate: fund.asOfDate || '—' },
      yields: {
        dividendYield: fund.metrics.dividendYield ?? null,
        dividendYieldText: fund.metrics.dividendYieldText || '—',
        dividendYieldKind: fund.metrics.dividendYieldBasis || null,
        indicatedYield: fund.metrics.dividendYield ?? null,
        indicatedYieldText: fund.metrics.dividendYieldText || '—',
        distributionYield: null,
        distributionYieldText: null,
        yield12M: fund.metrics.dividendYield ?? null,
        yield12MText: fund.metrics.dividendYieldText || '—',
        distributionRate: null,
        secYield: null,
        secYieldText: '—',
        secYieldKind: 'not published by ProShares for its ETFs (genuine data limitation)',
        effectiveYieldBasis: fund.metrics.dividendYieldBasis || null,
      },
      snapshotReadAt: new Date().toISOString(),
    };

    await writeJson(path.join(fundDir, 'meta.json'), meta);
  }

  // Write update-state.json
  const newCursor = config.maxFetches > 0 ? cursor + toProcess.length : 0;
  await writeJson(STATE_FILE, { cursor: newCursor >= filtered.length ? 0 : newCursor, lastRun: new Date().toISOString(), total: filtered.length });

  console.log(`\nDone. Funds: ${finalFunds.length} (success ${successCount}, fail ${failCount}) Holdings total ${totalHoldings} History total ${totalHistory}`);
  console.log(`Generated at ${new Date().toISOString()}`);
  console.log(`\nSEC Yield note: always "—" because ProShares does not publish a 30-day SEC yield on its fund pages.`);
  console.log(`Other "—" values:`);
  console.log(`  - Dividend Yield: "—" for funds that have never distributed (19 funds have no frequency, 27-28 never distributed — genuine).`);
  console.log(`  - TR 1Y/3Y/5Y/10Y, CAGR 3Y/5Y/10Y, SI Ann.: "—" for tenors the fund hasn't existed long enough to report (young funds like ACQQ, ACRT, ACSP, EQQQ, SKHU).`);
  console.log(`  - Frequency "00 - —": 19 funds genuinely have no distribution frequency (never distributed).`);
  console.log(`  - TER Gross: 60 strategic funds only publish net Expense Ratio, so gross is "—" (genuine).`);
  console.log(`  - Holdings/History counts may be 0 for brand-new funds whose first holdings file is still absent (genuine).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
