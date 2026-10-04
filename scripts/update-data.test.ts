/**
 * @file Unit tests for the ProShares static feed updater.
 *
 * Five groups shared by every ETF repo: controls, parsing, metrics, pipeline, network.
 * Tiny inline samples, mocked fetch, a per-test temp copy of the updater for pipeline runs;
 * no network, no fixtures, no dependence on the machine zone, directory order or exported
 * control variables. Run with `bun test scripts/update-data.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CONTROL_NAMES,
  GEARED_FINDER_URL,
  HOLDINGS_ALL_URL,
  NAV_HISTORY_ALL_URL,
  NASDAQ_LISTED_URL,
  NASDAQ_OTHER_LISTED_URL,
  PERFORMANCE_URL,
  SPLITS_URL,
  STRATEGIC_FINDER_URL,
  USAGE,
  distributionRefreshDue,
  readPublishedDistributions,
  applyHistoryRange,
  atomicWrite,
  buildFeed,
  cleanText,
  compareDisplayDates,
  cumulativeFromAnnualized,
  cursorScope,
  decodeEntities,
  distributionRowsForCsv,
  fetchText,
  formatAumDisplay,
  formatMoneyText,
  formatPercentText,
  formatUsDate,
  headerIndex,
  historyRangeDays,
  holdingWeight,
  holdingsHeaders,
  holdingsNetAssets,
  holdingsUrl,
  indicatedYield,
  installSystemCa,
  isCertError,
  isOtherAssetsRow,
  isWeightlessRow,
  mapWithConcurrency,
  matchesRange,
  matchesReturnRange,
  navHistoryUrl,
  normalizeDistributionFrequency,
  normalizeNumberText,
  numberOrNull,
  pageName,
  paceRequests,
  parseAumRange,
  parseCsvRecords,
  parseDistributionSummary,
  parseFinderCatalogPage,
  parseFundPage,
  parseHoldingsFile,
  parseNavHistoryFile,
  parsePerformanceFile,
  parseRange,
  parseRanges,
  publishedAsOf,
  stalestFirst,
  parseSplitsFile,
  parseSymbolDirectory,
  paymentsPerYear,
  performanceAsOfIso,
  readConfig,
  resolveControls,
  resolveDividendYield,
  rowFromMeta,
  runtimeControls,
  selectBatch,
  serialize,
  stripTags,
  tenorAvailable,
  toIsoDate,
  writeIfChanged,
  writeJsonIfChanged,
  writeSheetPages,
  type HoldingsRow,
  type NavRow,
  type UpdaterConfig,
} from './update-data';

// ---------------------------------------------------------------------------
// Inline samples (verbatim excerpts of the live sources)
// ---------------------------------------------------------------------------

const STRATEGIC_ROW = `
                                        <tr>
                                                <td><a href="/our-etfs/strategic/nobl">NOBL</a></td>
                                             <td>S&amp;P 500 Dividend Aristocrats ETF</td>
                                            <td>Dividend Growers</td>
                                                                                            <td>Equity</td>
                                                                                                <td class="fund-screener-table__upss-arrow text-nowrap bracket-sort"><span class="fund-screener-table__value-one">$11,270,728,460</span></td>
                                                <td>10/09/2013</td>
                                                <td class="text-left"></td>
                                            <td style="display:none" class="td_category">DividendGrowers</td>
                                        </tr>`;

const GEARED_ROW = `
                                    <tr>
                                            <td><a href="/our-etfs/leveraged-and-inverse/tqqq">TQQQ</a></td>
                                        <td>UltraPro QQQ</td>
                                            <td class="strategy">Broad Market</td>
                                            <td class="etf">
<span class="d-none">+</span>3x<span></span>
                                            </td>
                                            <td>Equity</td>
                                                <td class="fund-screener-table__up-arrow text-nowrap"><span class="fund-screener-table__value-one">$36,885,565,159</span></td>
                                        <td class="benchmark"> Nasdaq-100&reg; Index<span>&nbsp;(NDX)</span></td>
                                            <td class="td_strategies d-none">Broad Market</td>
                                        <td class="td_benchmark d-none" data-symbol="NDX"> Nasdaq-100&reg; Index<span>&nbsp;(NDX)</span></td>
                                    </tr>`;

const FUND_PAGE = `
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Ticker</span> <div><span id="snapshot-ticker" class="about-fund__list-value d-inline-block">NOBL</span></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">CUSIP</span> <div><span id="snapshot-cusip" class="about-fund__list-value d-inline-block">74348A467</span></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Inception Date</span> <div><span id="snapshot-inceptionDate" class="about-fund__list-value d-inline-block">10/9/13</span></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Net Assets</span> <div><span id="snapshot-netAssets" class="about-fund__list-value d-inline-block">$11,270,728,460</span></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Expense Ratio</span> <div><span id="snapshot-expenseRatio" class="about-fund__list-value d-inline-block">0.35%</span></div></li>
<span id="price-asOfDate" class="about-fund__list-subheader">as of 9/18/2026</span>
<span id="price-nav" class="about-fund__list-value d-inline-block">$55.66</span>
<span id="price-marketPrice" class="about-fund__list-value d-inline-block">$55.66</span>
<span id="characteristics-asOfDate" class="about-fund__list-subheader">as of 8/31/2026</span>
<span id="characteristics-numberOfHoldings" class="about-fund__list-value d-inline-block">71</span>
<span id="characteristics-priceEarningsRatio" class="about-fund__list-value d-inline-block">24.342</span>
<span id="characteristics-priceBookRatio" class="about-fund__list-value d-inline-block">3.589</span>
<span id="characteristics-avgMarketCap" class="about-fund__list-value d-inline-block">$0.16 billion</span>
<span id="distributions-asOfDate" class="about-fund__list-subheader">as of 8/31/2026</span>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Distribution Frequency</span> <div><span id="distributions-distributionFrequency" class="about-fund__list-value d-inline-block">Quarterly</span></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">SEC 30-Day Yield</span> <div><span id="distributions-sec30DayYield" class="about-fund__list-value d-inline-block">2.09%</span></div><div class="about-fund__popover-content"><p><strong data-renderer-mark="true">SEC 30-Day Yield&nbsp;</strong>is a standard yield calculation developed by the Securities and Exchange Commission (SEC).</p></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">12-Month Yield</span> <div><span id="distributions-12MonthYield" class="about-fund__list-value d-inline-block">2.01%</span></div></li>
<div id="index">
<span class="about-fund__list-subheader">as of 6/30/2026</span>
<li>Total Number of Holdings69</li>
<li>Price/Earnings Ratio23.94</li>
<li>Dividend Yield ( % )2.49</li>
</div>
<div class="tab-pane fade active show" id="month-end-total-returns">
<span class="px-3 pt-3 pb-2 d-block tabs__selected-label link-primary tabs__caret">Month-End Total Returns as of 8/31/2026</span>
<table id="total-return-table" class="table" tabindex="0">
<thead><tr><th>Fund + Index</th><th>1m</th><th>3m</th><th>6m</th><th>YTD</th><th>1Y</th><th>3Y</th><th>5Y</th><th>10Y</th><th>Since Inception</th><th>Inception Date</th></tr></thead>
<tbody>
<tr><td>NOBL NAV</td><td>1.41%</td><td>8.43%</td><td>2.02%</td><td>12.35%</td><td>12.93%</td><td>9.34%</td><td>6.38%</td><td>9.98%</td><td>10.82%</td><td>10/09/2013</td></tr>
<tr><td>NOBL Market Price</td><td>1.38%</td><td>8.44%</td><td>2.05%</td><td>12.37%</td><td>12.86%</td><td>9.35%</td><td>6.40%</td><td>9.98%</td><td>10.83%</td><td>10/09/2013</td></tr>
<tr><td>S&amp;P 500 Dividend Aristocrats Index</td><td>1.45%</td><td>8.55%</td><td>2.22%</td><td>12.66%</td><td>13.38%</td><td>9.73%</td><td>6.76%</td><td>10.39%</td><td>11.24%</td><td>--</td></tr>
</tbody></table></div>
<div class="tab-pane fade" id="month-end-total-returns1">
<span class="px-3 pt-3 pb-2 d-block tabs__selected-label link-primary tabs__caret">Quarter-End Total Returns as of 6/30/2026</span>
<table id="total-return-table" class="table" tabindex="0">
<thead><tr><th>Fund + Index</th><th>1m</th><th>3m</th><th>6m</th><th>YTD</th><th>1Y</th><th>3Y</th><th>5Y</th><th>10Y</th><th>Since Inception</th><th>Inception Date</th></tr></thead>
<tbody>
<tr><td>NOBL NAV</td><td>5.28%</td><td>6.61%</td><td>9.09%</td><td>9.09%</td><td>14.05%</td><td>8.36%</td><td>6.61%</td><td>9.85%</td><td>10.72%</td><td>10/09/2013</td></tr>
</tbody></table></div>
                "label": "Fund Country Weighting",
    "tableData": [
      {
        "Country": "United States",
        "Weight": 92.592586
      },
      {
        "Country": "Switzerland",
        "Weight": 2.8879680000000003
      }
    ]
`;

const HOLDINGS_CSV = `PORTFOLIO HOLDINGS INFORMATION,,,,
AS OF 9/18/2026,,,,
,,,,
Fund Ticker, Fund Name, Security Ticker, Security Sedol, Security Description, Coupon, Maturity Date, Shares/Contracts, Exposure Value (Notional + G/L), Market Value
"NOBL","ProShares S&P 500 Dividend Aristocrats ETF","BDX","2087807","BECTON DICKINSON AND CO",,,1079626,,195347528.4,
"NOBL","ProShares S&P 500 Dividend Aristocrats ETF","MDT","BTN1Y11","MEDTRONIC PLC",,,2019274,,186035713.6,
"NOBL","ProShares S&P 500 Dividend Aristocrats ETF","","","NET OTHER ASSETS (LIABILITIES)",,,27861053,,27861053.4,
"IGHG","ProShares Investment Grade-Interest Rate Hedged","","BYM4WR8","MORGAN STANLEY",4.375,2047-01-22,7779000,,6152311.3,
"IGHG","ProShares Investment Grade-Interest Rate Hedged","","","US 10YR NOTE (CBT) BOND 21/DEC/2026 TYZ6 COMDTY",,,-1557,-164774390.6,,
"ANEW","ProShares MSCI Transformational Changes ETF","SY1","","SYMRISE AG",,,1714,,175276.6,"1,25"
`;

const NAV_CSV = `Date,ProShares Name,Ticker,NAV,Prior NAV,NAV Change (%),NAV Change ($),Shares Outstanding (000),Assets Under Management
09/18/2026,ProShares S&P 500 Dividend Aristocrats ETF,NOBL,55.6579,56.0278,-0.66021,-0.3699,202400,11265159071.3158
09/17/2026,ProShares S&P 500 Dividend Aristocrats ETF,NOBL,56.0278,55.8546,0.31009,0.1732,202500,11345629612.0556
09/18/2026,ProShares UltraPro QQQ,PLACEHOLDER,77.1,77.0,0.1,0.1,100,1000
`;

const PERFORMANCE_CSV = `Fund Name,Fund Symbol,Return Type,Data Period,Return Effective Date,1-Month Return,3-Month Return,6-Month Return,Year-To-Date Return,1-Year Return,3-Year Return,5-Year Return,10-Year Return,Return Since Inception,Inception Date
S&P 500 Ex-Energy ETF,SPXE,MARKET,MONTH,2026-08-31 00:00:00.000,2.54,1.28,12.44,12.17,19.6,21.12,12.27,15.38,15.38,2015-09-24 00:00:00.000
S&P 500 Dividend Aristocrats ETF,NOBL,NAV,MONTH,2026-08-31 00:00:00.000,1.41,8.43,2.02,12.35,12.93,9.34,6.38,9.98,10.82,2013-10-09 00:00:00.000
S&P 500 Dividend Aristocrats ETF,NOBL,MARKET,MONTH,2026-08-31 00:00:00.000,1.38,8.44,2.05,12.37,12.86,9.35,6.4,9.98,10.83,2013-10-09 00:00:00.000
S&P 500 Dividend Aristocrats ETF,NOBL,NAV,QUARTER,2026-06-30 00:00:00.000,5.28,6.61,9.09,9.09,14.05,8.36,6.61,9.85,10.72,2013-10-09 00:00:00.000
Ultra SpaceX,SPCF,MARKET,MONTH,2026-08-31 00:00:00.000,60.59,,,-37.24,,,,,,2026-06-15 00:00:00.000
`;

const SPLITS_CSV = `Symbol,Name,Pre Split Cusip,Post Split Cusip,Split Type,Ratio,Date of Split
REW,UltraShort Technology,74350P568,74350P451,Reverse,2,05/28/2026
NOBL,S&P 500 Dividend Aristocrats ETF,74348A467,,Forward,2,05/28/2026
`;

const DISTRIBUTIONS_JSON = `[
  {
    "CashDividendPerShare": 0.303711,
    "Dividend": ".303711",
    "EffectiveDate": "2026-06-23T00:00:00",
    "ExDate": "2026-06-24T00:00:00",
    "LongTermCapGains": null,
    "OtherPerShare": null,
    "PayableDate": "2026-06-30T00:00:00",
    "RecordDate": "2026-06-24T00:00:00",
    "ReturnOfCapital": null,
    "ShortTermCapGains": null,
    "SpecialPerShare": null,
    "Symbol": "NOBL"
  },
  {
    "CashDividendPerShare": 0.256121,
    "Dividend": ".256121",
    "EffectiveDate": "2026-03-24T00:00:00",
    "ExDate": "2026-03-25T00:00:00",
    "LongTermCapGains": null,
    "OtherPerShare": null,
    "PayableDate": "2026-03-31T00:00:00",
    "RecordDate": "2026-03-25T00:00:00",
    "ReturnOfCapital": null,
    "ShortTermCapGains": 0.0121,
    "SpecialPerShare": null,
    "Symbol": "NOBL"
  }
]`;

const testConfig: UpdaterConfig = {
  concurrency: 1,
  requestSleep: 0,
  maxFetches: 0,
  holdingsPageSize: 2,
  historyPageSize: 2,
  historyRange: 'max',
  distributionYears: 10,
  storeRawDownloads: false,
  maxRetries: 3,
  tickers: [],
  category: '',
  offlineSeed: false,
  performanceRanges: {},
  totalReturnRanges: {},
};

// ---------------------------------------------------------------------------
// Shared hooks: clean environment, pinned zone, restored globals
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realDateNow = Date.now;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const realExitCode = process.exitCode;
const ENV_KEYS: string[] = [
  ...CONTROL_NAMES, 'PROSHARES_TICKERS', 'HISTORICAL_PAGE_SIZE', 'AUM_RANGE', 'EXPENSE_RATIO', 'TER_RANGE',
  'GITHUB_STEP_SUMMARY', 'NODE_USE_SYSTEM_CA', 'ETF_UPDATER_SYSTEM_CA', 'TZ',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.TZ = 'UTC';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  Date.now = realDateNow;
  Object.assign(console, realConsole);
  process.exitCode = realExitCode ?? 0; // assigning undefined would keep a leaked 1
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const readText = (relative: string): string => readFileSync(new URL(`./${relative}`, import.meta.url), 'utf8');
const configFile = (): Record<string, unknown> => JSON.parse(readText('update-data.config.json'));
const quiet = (): void => { console.log = console.warn = console.error = () => {}; };

// ---------------------------------------------------------------------------
// controls: precedence, strict validation, aliases (no network)
// ---------------------------------------------------------------------------

describe('controls', () => {
  test('precedence: file < advanced < nonblank input < env, an explicit empty env wins', () => {
    const merged = resolveControls({ CONCURRENCY: 2, TICKERS: 'NOBL' }, { CONCURRENCY: 3, TICKERS: 'TQQQ' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
    expect(merged.CONCURRENCY).toBe('5');
    expect(merged.TICKERS).toBe('TQQQ'); // blank input does not erase the advanced value
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'NOBL' }, { TICKERS: '' }, {}).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'NOBL' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ OFFLINE_SEED: true }, {}, {}, { OFFLINE_SEED: 'false' }).OFFLINE_SEED).toBe('false');
  });

  test('brand env aliases work and the canonical name wins', () => {
    expect(resolveControls({}, {}, {}, { PROSHARES_TICKERS: 'NOBL' }).TICKERS).toBe('NOBL');
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
    expect(resolveControls({}, {}, {}, { AUM_RANGE: '1B:' }).AUM).toBe('1B:');
    expect(resolveControls({}, {}, {}, { EXPENSE_RATIO: '0:1' }).TER).toBe('0:1');
    expect(resolveControls({}, {}, {}, { TICKERS: 'TQQQ', PROSHARES_TICKERS: 'NOBL' }).TICKERS).toBe('TQQQ');
  });

  test('config file defaults: scheduled path equals the file, documented provider defaults, runtime env wins', async () => {
    const defaults = configFile();
    const stringified = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, String(value)]));
    expect(resolveControls(defaults, {}, {}, {})).toEqual(stringified);
    expect(resolveControls(defaults, {}, Object.fromEntries(CONTROL_NAMES.map(name => [name, ''])), {})).toEqual(stringified);
    const config = readConfig(resolveControls(defaults));
    expect(config).toMatchObject({ tickers: [], maxFetches: 0, concurrency: 3, requestSleep: 2, holdingsPageSize: 250, historyPageSize: 1000, historyRange: 'max', distributionYears: 10, maxRetries: 3, storeRawDownloads: false, offlineSeed: false });
    expect(config.performanceRanges).toEqual({});
    expect(config.totalReturnRanges).toEqual({});
    expect(await runtimeControls({})).toEqual(resolveControls(defaults));
    const overridden = await runtimeControls({ TICKERS: 'NOBL', REQUEST_SLEEP: '0' });
    expect([overridden.TICKERS, overridden.REQUEST_SLEEP, overridden.CONCURRENCY]).toEqual(['NOBL', '0', '3']);
  });

  test('config keys equal CONTROL_NAMES and --help; USE_SYSTEM_CA is auto, true or false only', () => {
    const defaults = configFile();
    expect(Object.keys(defaults).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(Object.values(defaults).every(value => typeof value === 'string')).toBe(true);
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_/);
      expect(USAGE).toContain(tenor ? `${tenor[1]}_YTD|1Y|3Y|5Y|10Y` : name);
    }
    expect(defaults.USE_SYSTEM_CA).toBe('auto');
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) {
      expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: mode }).USE_SYSTEM_CA).toBe(mode.toLowerCase());
    }
    expect(() => resolveControls({}, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow(/USE_SYSTEM_CA/);
  });

  test('strict validation: bad values never fall back silently', () => {
    const bad: [string, unknown][] = [
      ['CONCURRENCY', 0], ['CONCURRENCY', 'x'], ['MAX_RETRIES', 0], ['MAX_RETRIES', -1], ['MAX_FETCHES', 1.5], ['DISTRIBUTION_YEARS', -1],
      ['HOLDINGS_PAGE_SIZE', 0], ['HISTORY_PAGE_SIZE', '1e3'], ['REQUEST_SLEEP', '-1'], ['REQUEST_SLEEP', 'fast'],
      ['VERBOSE', 'maybe'], ['STORE_RAW_DOWNLOADS', 'sometimes'], ['OFFLINE_SEED', '2'],
      ['HISTORY_RANGE', 'forever'], ['HISTORY_RANGE', '0y'], ['HISTORY_RANGE', '0d'],
      ['AUM', '1:2:3'], ['AUM', 'huge:'], ['AUM', 'large:micro'], ['TER', 'x'], ['TER', '2:1'], ['TER', '5'],
      ['DIVIDEND_YIELD', '5:1'], ['SEC_YIELD', '1'], ['PERFORMANCE_5Y', 'a:b'], ['TOTAL_RETURN_10Y', '9:1'],
      ['TICKERS', 'AAA $$$'], ['TICKERS', ';;;x!'],
    ];
    for (const [key, value] of bad) expect(() => resolveControls({}, { [key]: value }), `${key}=${String(value)}`).toThrow();
    expect(() => resolveControls({}, { MAX_RETRIES: 0 })).toThrow(/MAX_RETRIES/);
    expect(() => resolveControls({}, { HISTORY_RANGE: '0y' })).toThrow(/at least 1/);
    expect(() => resolveControls({}, { TICKERS: 'AAA $$$' })).toThrow(/invalid ticker/);
    // shapes, unknown keys, non-scalars and control characters
    for (const value of [{ UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { TICKERS: ['NOBL'] }, { TICKERS: { a: 1 } }, { TICKERS: null }, null, [], 'text', 7]) {
      expect(() => resolveControls(value)).toThrow();
    }
    for (const call of [
      () => resolveControls({}, []), () => resolveControls({}, 'x'), () => resolveControls({}, {}, null),
      () => resolveControls({}, { TICKERS: 'NOBL\nEVIL=yes' }), () => resolveControls({}, {}, { CATEGORY: 'a\rb' }), () => resolveControls({}, {}, {}, { TICKERS: 'x\0y' }),
    ]) expect(call).toThrow();
    expect(() => resolveControls({}, { TICKERS: 'NOBL\nEVIL=yes' })).toThrow(/multiline/);
  });

  test('range filters: syntax, AUM presets, a colon never filters nulls, young funds skip return filters', () => {
    expect(parseRange('', 'TER')).toBeUndefined();
    expect(parseRange(':', 'TER')).toEqual({ min: undefined, max: undefined });
    expect(parseRange('0.2%:1.5%', 'TER')).toEqual({ min: 0.2, max: 1.5 });
    expect(() => parseRange('5', 'TER')).toThrow(/single colon/);
    expect(() => parseRange('2:1', 'TER')).toThrow(/minimum is above maximum/);
    expect(() => parseRange('a:b', 'TER')).toThrow(/Invalid TER minimum/);
    expect(parseAumRange('micro:large')).toEqual({ min: 10_000_000, max: undefined });
    expect(parseAumRange('1B:2B')).toEqual({ min: 1_000_000_000, max: 2_000_000_000 });
    expect(readConfig({ AUM: '300M:' }).aumRange).toEqual({ min: 300_000_000, max: undefined });
    expect(readConfig({ TICKERS: 'nobl, tqqq\nbrk.b' }).tickers).toEqual(['NOBL', 'TQQQ', 'BRK.B']);
    expect(parseRanges({ PERFORMANCE_YTD: ':', PERFORMANCE_1Y: ':', TOTAL_RETURN_1Y: ':' }, 'PERFORMANCE')).toEqual({});
    expect(matchesRange(null, { min: 1 })).toBe(false);
    expect(matchesRange(null, { min: undefined, max: undefined })).toBe(true);
    expect(matchesReturnRange(null, { min: 1 })).toBe(true);
    expect(matchesReturnRange(5, { min: 1, max: 4 })).toBe(false);
    const published = parseFundPage(FUND_PAGE).sec30DayYield;
    const absent = parseFundPage('<span id="snapshot-distributions">Quarterly</span>').sec30DayYield;
    expect(matchesRange(published, readConfig({ SEC_YIELD: '2:3' }).secYieldRange)).toBe(true);
    expect(matchesRange(published, readConfig({ SEC_YIELD: '3:' }).secYieldRange)).toBe(false);
    expect(matchesRange(absent, readConfig({ SEC_YIELD: '2:3' }).secYieldRange)).toBe(false);
    expect(matchesRange(absent, readConfig({ SEC_YIELD: ':' }).secYieldRange)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parsing: one tiny sample per provider payload; missing values become null
// ---------------------------------------------------------------------------

describe('parsing', () => {
  test('text, number, date and CSV helpers; placeholders are null, a real 0 stays 0', () => {
    expect(cleanText('  UltraPro   QQQ  ')).toBe('UltraPro QQQ');
    expect(stripTags('<span class="d-none">+</span>3x<span></span>')).toBe('+ 3x');
    expect(decodeEntities('Nasdaq-100&reg; Index&nbsp;(NDX)')).toBe('Nasdaq-100® Index (NDX)');
    expect(normalizeNumberText('2.97E8')).toBe('297000000');
    expect(normalizeNumberText('$1,234.50')).toBe('1234.50');
    expect(normalizeNumberText('--')).toBe('');
    expect(numberOrNull('')).toBeNull();
    expect(numberOrNull('—')).toBeNull();
    expect(numberOrNull('5e-324')).toBeNull();
    expect(numberOrNull('-1557')).toBe(-1557);
    expect(numberOrNull('0')).toBe(0);
    expect(formatPercentText(9.345)).toBe('9.35%');
    expect(formatPercentText(null)).toBe('—');
    expect(formatMoneyText(11270728460)).toBe('$11.27B');
    expect(formatAumDisplay(11270728460)).toBe('$11.27 B');
    expect(formatUsDate('9/18/2026')).toBe('Sep 18 2026');
    expect(formatUsDate('2026-06-24T00:00:00')).toBe('Jun 24 2026');
    expect(formatUsDate('')).toBe('—');
    expect(toIsoDate('9/18/2026')).toBe('2026-09-18');
    expect(['Jun 24 2026', 'Mar 25 2026', 'Dec 24 2025'].sort(compareDisplayDates)).toEqual(['Dec 24 2025', 'Mar 25 2026', 'Jun 24 2026']);
    expect(parseCsvRecords('﻿a,b\r\n"1,25",2\r\n"say ""hi""",3\r\n')).toEqual([['a', 'b'], ['1,25', '2'], ['say "hi"', '3']]);
    const index = headerIndex(['Fund Ticker', 'Shares/Contracts', 'Exposure Value (Notional + G/L)']);
    expect([index.get('fundticker'), index.get('sharescontracts'), index.get('exposurevaluenotionalgl')]).toEqual([0, 1, 2]);
  });

  test('finder catalog: strategic and geared rows, rows without a fund link are ignored', () => {
    const [strategic] = parseFinderCatalogPage(STRATEGIC_ROW, 'strategic');
    expect(strategic).toMatchObject({
      ticker: 'NOBL', name: 'S&P 500 Dividend Aristocrats ETF', assetClass: 'Equity', marketingCategory: 'DividendGrowers',
      fundPage: 'https://www.proshares.com/our-etfs/strategic/nobl', inceptionDateText: 'Oct 09 2013', netAssetsValue: 11_270_728_460,
    });
    const [geared] = parseFinderCatalogPage(GEARED_ROW, 'geared');
    expect(geared).toMatchObject({ ticker: 'TQQQ', assetClass: 'Equity', strategy: 'Broad Market', dailyObjective: '+3x', benchmarkTicker: 'NDX' });
    expect(parseFinderCatalogPage('<tr><td>no link here</td></tr>', 'strategic')).toEqual([]);
  });

  test('fund page: snapshot, price, distributions, characteristics, exposures and return tables', () => {
    const page = parseFundPage(FUND_PAGE);
    expect(page).toMatchObject({
      cusip: '74348A467', expenseRatio: 0.35, netAssetsValue: 11_270_728_460, nav: 55.66, marketPrice: 55.66, priceAsOf: 'Sep 18 2026',
      distributionFrequency: 'Quarterly', twelveMonthYield: 2.01, sec30DayYield: 2.09, sec30DayYieldText: '2.09%', inceptionDate: 'Oct 09 2013',
      distributionsNote: '',
    });
    expect(page.characteristics['Number of Holdings']).toBe('71');
    expect(page.characteristics['Price/Earnings Ratio']).toBe('24.342');
    expect(page.indexStats['Dividend Yield ( % )']).toBe('2.49');
    expect(page.exposures[0].label).toBe('Fund Country Weighting');
    expect(page.exposures[0].rows[0]).toEqual({ Country: 'United States', Weight: 92.592586 });
    expect(page.returns.monthEnd).toMatchObject({ asOfDate: 'Aug 31 2026', ytd: 12.35, mpytd: 12.37 });
    expect(page.returns.quarterEnd).toMatchObject({ asOfDate: 'Jun 30 2026', ytd: 9.09 });
    // return tenors follow the header labels, not their position
    const swapped = parseFundPage(FUND_PAGE.replace('<th>Fund + Index</th><th>1m</th><th>3m</th>', '<th>Fund + Index</th><th>3m</th><th>1m</th>'));
    expect([swapped.returns.monthEnd.mo1, swapped.returns.monthEnd.mo3]).toEqual([8.43, 1.41]);
  });

  test('fund page: absent or unavailable values are null, never 0', () => {
    const never = parseFundPage('<div id="distributionTab"><p>This fund has not made any distributions.</p></div>');
    expect(never.distributionsNote).toBe('This fund has not made any distributions.');
    expect(never.sec30DayYield).toBeNull();
    expect(never.sec30DayYieldText).toBe('—');
    const geared = parseFundPage('<span id="snapshot-distributions">Quarterly</span>');
    expect(geared.sec30DayYield).toBeNull();
    expect(geared.expenseRatio).toBeNull();
    expect(geared.nav).toBeNull();
    const unavailable = parseFundPage('<span id="distributions-sec30DayYield">—</span>');
    expect(unavailable.sec30DayYield).toBeNull();
    const bond = parseFundPage('<span id="characteristics-weightedAverageYieldMaturity">5.63%</span><span id="distributions-sec30DayYield">5.42%</span>');
    expect(bond.sec30DayYield).toBe(5.42); // distinct from the bond yield to maturity
    expect(bond.characteristics['Weighted Average Yield to Maturity']).toBe('5.63%');
  });

  test('holdings file: preamble, per-security identifiers, headers that grow only when used', () => {
    const file = parseHoldingsFile(HOLDINGS_CSV);
    expect(file.asOf).toBe('Sep 18 2026');
    expect(file.asOfIso).toBe('2026-09-18');
    expect([...file.funds.keys()].sort()).toEqual(['ANEW', 'IGHG', 'NOBL']);
    const nobl = file.funds.get('NOBL')?.rows || [];
    const ighg = file.funds.get('IGHG')?.rows || [];
    expect(nobl).toHaveLength(3);
    expect(nobl[0]).toMatchObject({ ticker: 'BDX', identifier: '2087807', marketValue: '195347528.4' });
    expect(ighg[0]).toMatchObject({ ticker: '', identifier: 'BYM4WR8', coupon: '4.375', maturity: '2047-01-22' });
    expect(ighg[1]).toMatchObject({ exposure: '-164774390.6', marketValue: '' });
    expect(holdingsHeaders(nobl)).toEqual(['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held']);
    expect(holdingsHeaders(ighg)).toEqual(['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Exposure Value', 'Coupon', 'Maturity Date']);
  });

  test('holdings weights reproduce the fund page; cash-like lines carry no weight', () => {
    const nobl = parseHoldingsFile(HOLDINGS_CSV).funds.get('NOBL')?.rows || [];
    const blank = { ticker: '', identifier: '', coupon: '', maturity: '', exposure: '', marketValue: '' };
    // the fixture keeps 3 of NOBL's rows: the published fund total is used as the denominator
    expect(Number(holdingWeight(nobl[0], 11_264_839_323)).toFixed(2)).toBe('1.73');
    expect(holdingsNetAssets(nobl)).toBeCloseTo(409_244_295.4, 4);
    expect(isOtherAssetsRow(nobl[2])).toBe(true);
    const tqqq: HoldingsRow[] = [
      { ...blank, name: 'NVDA', ticker: 'NVDA', shares: '5127506', marketValue: '1139690759' },
      { ...blank, name: 'NASDAQ 100 INDEX SWAP BARCLAYS CAPITAL', shares: '366121', exposure: '10853353165' },
      { ...blank, name: 'Net Other Assets (Liabilities)', shares: '9707363674', marketValue: '9707363673.76' },
    ];
    const total = 36_617_542_112;
    expect(Number(holdingWeight(tqqq[0], total)).toFixed(2)).toBe('3.11');
    expect(Number(holdingWeight(tqqq[1], total)).toFixed(2)).toBe('29.64');
    expect(holdingWeight(tqqq[2], total)).toBe('—');
    expect(isWeightlessRow({ ...blank, name: 'TREASURY BILL', shares: '1', marketValue: '998429170' })).toBe(true);
    expect(isWeightlessRow({ ...blank, name: 'US 10YR NOTE (CBT) BOND 21/DEC/2026 TYZ6 COMDTY', shares: '-1557', exposure: '-164774390.6' })).toBe(false);
    expect(holdingWeight({ ...blank, name: 'NO SIDE', shares: '' }, 1)).toBe('—');
  });

  test('NAV history keeps one ticker, converts shares to units; per-fund URLs and HISTORY_RANGE windows', () => {
    const rows = parseNavHistoryFile(NAV_CSV, 'NOBL');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: 'Sep 18 2026', nav: 55.6579, sharesOutstanding: 202_400_000, netAssets: 11_265_159_071.3158 });
    expect(navHistoryUrl('NOBL')).toBe('https://accounts.profunds.com/etfdata/ByFund/NOBL-historical_nav.csv');
    expect(holdingsUrl('NOBL')).toBe('https://accounts.profunds.com/etfdata/ByFund/NOBL-psdlyhld.csv');
    expect([historyRangeDays('max'), historyRangeDays('10y'), historyRangeDays('6m'), historyRangeDays('30d')]).toEqual([null, 3650, 180, 30]);
    const old: NavRow[] = [
      { date: 'Sep 18 2020', nav: 1, sharesOutstanding: 1, netAssets: 1 },
      { date: 'Sep 18 2026', nav: 2, sharesOutstanding: 2, netAssets: 2 },
    ];
    expect(applyHistoryRange(old, '1y').map(row => row.nav)).toEqual([2]); // the oldest rows go
    expect(applyHistoryRange(old, 'max')).toHaveLength(2);
  });

  test('performance and splits files; young funds keep empty tenors as null', () => {
    const performance = parsePerformanceFile(PERFORMANCE_CSV);
    expect(performance.size).toBe(5);
    expect(performance.get('NOBL|NAV|MONTH')).toMatchObject({ asOfDate: 'Aug 31 2026', ytd: 12.35, yr3: 9.34 });
    expect(performance.get('NOBL|MARKET|MONTH')!.yr5).toBe(6.4);
    expect(performance.get('NOBL|NAV|QUARTER')!.sinceInception).toBe(10.72);
    const young = performance.get('SPCF|MARKET|MONTH')!;
    expect([young.yr1, young.yr10, young.ytd]).toEqual([null, null, -37.24]);
    expect(cumulativeFromAnnualized(9.34, 3)).toBeCloseTo(30.7185, 3);
    expect(cumulativeFromAnnualized(null, 5)).toBeNull();
    const splits = parseSplitsFile(SPLITS_CSV);
    expect(splits.get('NOBL')![0]).toMatchObject({ splitType: 'Forward', ratio: 2, date: 'May 28 2026' });
    expect(splits.get('REW')![0].postSplitCusip).toBe('74350P451');
  });

  test('distribution summary: payouts sorted by ex-date, CSV rows, tolerated bad payloads', () => {
    const rows = parseDistributionSummary(DISTRIBUTIONS_JSON);
    expect(rows).toHaveLength(2);
    expect(rows[0].exDate).toBe('Mar 25 2026');
    expect(rows[1].dividend).toBeCloseTo(0.303711, 6);
    expect(rows[0].shortTermCapGains).toBeCloseTo(0.0121, 6);
    const csv = distributionRowsForCsv(rows);
    expect([csv[1]['Ex-Date'], csv[1].Dividend, csv[0]['LT Cap Gains']]).toEqual(['24-Jun-2026', '0.303711', '—']);
    expect(parseDistributionSummary('[]')).toEqual([]);
    expect(parseDistributionSummary('not json')).toEqual([]);
  });

  test('nasdaq symbol directory resolves listing exchanges and skips the trailer line', () => {
    const text = [
      'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
      'A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A',
      'NOBL|ProShares S&P 500 Dividend Aristocrats ETF|P|NOBL|Y|100|N|NOBL',
      'File Creation Time: 0918202600:00|||||||',
    ].join('\r\n');
    const map = parseSymbolDirectory(text, { N: 'NYSE', P: 'NYSE Arca' });
    expect([map.get('NOBL'), map.get('A'), map.size]).toEqual(['NYSE Arca', 'NYSE', 2]);
  });

  test('published distribution rows read back to the same CSV rows (the merge keeps old years unchanged)', () => {
    const rows = distributionRowsForCsv(parseDistributionSummary(DISTRIBUTIONS_JSON));
    expect(rows.length).toBeGreaterThan(0);
    expect(distributionRowsForCsv(readPublishedDistributions(rows)!)).toEqual(rows);
    expect(readPublishedDistributions([{ 'Ex-Date': '\u2014' }])).toBeNull(); // unreadable: the caller walks every year
    expect(readPublishedDistributions(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// metrics: nulls for young funds, one key set, basis and as-of travel together
// ---------------------------------------------------------------------------

describe('metrics', () => {
  const performance = parsePerformanceFile(PERFORMANCE_CSV);
  const inputs = {
    fund: parseFinderCatalogPage(STRATEGIC_ROW, 'strategic')[0],
    page: parseFundPage(FUND_PAGE),
    performanceNavMonth: performance.get('NOBL|NAV|MONTH'),
    performanceMarketMonth: performance.get('NOBL|MARKET|MONTH'),
    performanceNavQuarter: performance.get('NOBL|NAV|QUARTER'),
    performanceMarketQuarter: undefined,
    navRows: parseNavHistoryFile(NAV_CSV, 'NOBL'),
    holdingsRows: parseHoldingsFile(HOLDINGS_CSV).funds.get('NOBL')?.rows || [],
    holdingsAsOf: 'Sep 18 2026',
    holdingsSourceLabel: 'official ProShares daily holdings download (ByFund/NOBL-psdlyhld.csv, as of Sep 18 2026)',
    distributions: parseDistributionSummary(DISTRIBUTIONS_JSON),
    exchange: 'NYSE Arca',
    exchangeSource: 'Nasdaq Trader symbol directory (nasdaqlisted.txt + otherlisted.txt)',
    splits: parseSplitsFile(SPLITS_CSV).get('NOBL') || [],
    config: testConfig,
    catalogReadAt: '2026-09-21T00:00:00Z',
  };
  const artifacts = buildFeed(inputs);
  const entry = artifacts.entry as Record<string, any>;
  const meta = artifacts.meta as Record<string, any>;
  const entryOf = (override: Partial<typeof inputs>) => buildFeed({ ...inputs, ...override }).entry as Record<string, any>;
  const numericKeys = ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'secYield'];

  test('index entry carries the columns the browser reads', () => {
    expect(entry).toMatchObject({
      ticker: 'NOBL', category: 'Equity', terValue: 0.35, terNetValue: 0.35, terGrossValue: 0.35, nav: '$55.66', aumValue: 11_265_159_071.3158,
      exchange: 'NYSE Arca', closePrice: '$55.66', premiumDiscount: '0.00%', distributionFrequency: 'Quarterly', holdings: 3, history: 2,
    });
    expect(entry.distributions).toMatchObject({ frequency: 'Quarterly', exDate: 'Jun 24 2026', dividend: '0.3037' });
    expect(entry.metrics).toMatchObject({ ytd: 12.35, secYield: 2.09, secYieldText: '2.09%' });
    expect(entry.metrics.secYieldKind).toContain('official ProShares SEC 30-Day Yield');
    expect(meta.identifiers).toMatchObject({ cusip: '74348A467', isin: null });
    expect(meta.source.holdingsSource).toContain('psdlyhld.csv');
    expect(meta.holdings.asOf).toBe('2026-09-18');
    for (const row of artifacts.holdingsRows) expect(Object.keys(row)).toEqual(artifacts.holdingsHeaders);
    for (const row of artifacts.historyRows) expect(Object.keys(row)).toEqual(artifacts.historyHeaders);
  });

  test('every row has the same metrics keys (numbers or null), ending with returnsBasis then performanceAsOf', () => {
    const young = { ...inputs.performanceNavMonth!, inceptionDate: 'Mar 01 2026', yr1: 0, yr3: 0, yr5: 0, yr10: 0, sinceInception: 9 };
    const rows = [entry, entryOf({ performanceNavMonth: young }), entryOf({ performanceNavMonth: undefined })];
    const keys = Object.keys(entry.metrics);
    expect(keys.slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    const rebuilt = rowFromMeta(meta) as Record<string, any>;
    for (const row of [...rows, rebuilt]) {
      expect(Object.keys(row.metrics)).toEqual(keys);
      for (const key of numericKeys) expect(typeof row.metrics[key] === 'number' || row.metrics[key] === null, key).toBe(true);
      expect(String(row.metrics.returnsBasis).length).toBeGreaterThan(1);
    }
  });

  test('returnsBasis and performanceAsOf travel together: ISO table date, null when there is no table', () => {
    expect(entry.metrics.returnsBasis).toContain('official ProShares performance file');
    expect(entry.metrics.performanceAsOf).toBe('2026-08-31'); // the table date, not the NAV date (Sep 18)
    const without = entryOf({ performanceNavMonth: undefined });
    expect(without.metrics.performanceAsOf).toBeNull();
    expect(without.metrics.returnsBasis.length).toBeGreaterThan(1);
    for (const key of ['ytd', 'tr1y', 'tr3y', 'cagr3y', 'siAnn']) expect(without.metrics[key]).toBeNull();
    expect(performanceAsOfIso({ asOfDate: '—' } as any)).toBeNull();
    expect(performanceAsOfIso(undefined)).toBeNull();
    const row = rowFromMeta(meta) as Record<string, any>;
    expect(row.metrics.performanceAsOf).toBe(entry.metrics.performanceAsOf);
    expect(row.dataFile).toBe('./funds/NOBL/meta.json');
    for (const key of ['dividendYieldBasis', 'dividendYieldComputed', 'secYieldKind']) expect(row.metrics[key]).toEqual(entry.metrics[key]);
    expect([row.aumValue, row.holdings, row.history]).toEqual([entry.aumValue, entry.holdings, entry.history]);
  });

  test('young fund: horizons longer than its age and siAnn under one year are null, never a placeholder 0', () => {
    const young = { ...inputs.performanceNavMonth!, inceptionDate: 'Mar 01 2026', asOfDate: 'Aug 31 2026', yr1: 0, yr3: 0, yr5: 0, yr10: 0, sinceInception: 9 };
    const metrics = entryOf({ performanceNavMonth: young }).metrics;
    for (const key of ['tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn']) expect(metrics[key], key).toBeNull();
    expect(tenorAvailable({ ...young, inceptionDate: 'Aug 01 2023' }, 3)).toBe(true);
    expect(tenorAvailable({ ...young, inceptionDate: 'Aug 01 2024' }, 3)).toBe(false);
    expect(tenorAvailable(undefined, 1)).toBe(false);
  });

  test('derived total returns sit next to the published annualized ones', () => {
    expect(entry.metrics.cagr3y).toBe(9.34);
    expect(entry.metrics.tr3y).toBeCloseTo(30.7185, 3);
    expect(entry.metrics.tr5y).toBeCloseTo(36.2385, 3);
    expect(entry.metrics.tr10y).toBeCloseTo(158.903, 3);
  });

  test('TER: one published ratio serves as gross and net; geared pages map gross, net and the footnote', () => {
    expect(inputs.page).toMatchObject({ expenseRatio: 0.35, grossExpenseRatio: 0.35, netExpenseRatio: 0.35, expenseRatioFootnote: '' });
    const geared = parseFundPage(`
<span id="snapshot-grossExpenseRatio" class="about-fund__list-value d-inline-block">0.97%</span>
<span id="snapshot-netExpenseRatio" class="about-fund__list-value d-inline-block">0.82%</span>`);
    expect([geared.grossExpenseRatio, geared.netExpenseRatio, geared.expenseRatio]).toEqual([0.97, 0.82, 0.82]);
    const mapped = entryOf({ page: { ...inputs.page, ...geared } });
    expect([mapped.terGrossValue, mapped.terNetValue, mapped.terValue]).toEqual([0.97, 0.82, 0.82]);
    const waived = parseFundPage('<li><span class="about-fund__list-label">Net Expense Ratio</span> <span id="snapshot-netExpenseRatio" class="about-fund__list-value">1.17%*</span></li>');
    expect([waived.netExpenseRatio, waived.netExpenseRatioText, waived.expenseRatioFootnote]).toEqual([1.17, '1.17%', '*']);
  });

  test('yields: official, indicated and absent values keep honest nulls and provenance', () => {
    const noSec = buildFeed({ ...inputs, page: { ...inputs.page, sec30DayYield: null, sec30DayYieldText: '—' } });
    const noSecEntry = noSec.entry as Record<string, any>;
    expect(noSecEntry.metrics.secYield).toBeNull();
    expect(noSecEntry.metrics.secYieldKind).toBe('not published on this fund page (data limitation)');
    expect((noSec.meta as Record<string, any>).yields.secYield).toBeNull();
    const noFrequency = { ...inputs.page, distributionFrequency: '', twelveMonthYield: null, twelveMonthYieldText: '—' };
    expect(entryOf({ page: noFrequency }).metrics.dividendYield).toBeNull();
    expect(entryOf({ page: noFrequency }).metrics.dividendYieldBasis).toContain('no payment frequency is published');
    expect(entryOf({ page: noFrequency, distributions: [] }).metrics.dividendYieldBasis).toContain('no distributions yet');
    expect(resolveDividendYield(2.01, 0.303711, 'Quarterly', 55.66).effective).toBe(2.01);
    const indicated = resolveDividendYield(null, 0.15596, 'Quarterly', 78.62);
    expect(indicated.effective).toBe(indicated.indicated);
    expect(indicatedYield(0.303711, 'Quarterly', 55.66)).toBeCloseTo(2.1825, 3);
    expect(indicatedYield(null, 'Quarterly', 55.66)).toBeNull();
    expect(indicatedYield(0.303711, 'Quarterly', null)).toBeNull();
    expect(normalizeDistributionFrequency('Semi-Annual')).toBe('Semi-annually');
    expect(normalizeDistributionFrequency('')).toBe('—');
    expect([paymentsPerYear('Weekly'), paymentsPerYear('Monthly'), paymentsPerYear('Irregular'), paymentsPerYear('—')]).toEqual([52, 12, null, null]);
    const bounded = readConfig({ DIVIDEND_YIELD: '0.5:1' }).dividendYieldRange;
    expect(matchesRange(indicated.effective, bounded)).toBe(true);
    expect(matchesRange(null, bounded)).toBe(false);
  });

  test('AUM text and aumValue come from one source', () => {
    const skewed = buildFeed({ ...inputs, page: { ...inputs.page, netAssetsText: '$1', netAssetsValue: 1 } });
    const e = skewed.entry as Record<string, any>;
    expect(e.aum).toBe(formatAumDisplay(e.aumValue));
    expect((skewed.meta as Record<string, any>).aum.display).toBe(formatAumDisplay(e.aumValue));
  });
});

// ---------------------------------------------------------------------------
// pipeline: mocked fetch, a 3-fund catalog, a per-test temp copy of the updater
// ---------------------------------------------------------------------------

type Updater = typeof import('./update-data');
const FUNDS: Record<string, 'strategic' | 'geared'> = { IGHG: 'strategic', NOBL: 'strategic', TQQQ: 'geared' };
const TICKERS = Object.keys(FUNDS);
const FUND_STAGE = /our-etfs\/(?:strategic|leveraged-and-inverse)\/|ByFund\/|distributionsummary/;

const catalogRow = (ticker: string, kind: 'strategic' | 'geared'): string =>
  kind === 'strategic'
    ? STRATEGIC_ROW.replace(/NOBL/g, ticker).replace(/nobl/g, ticker.toLowerCase())
    : GEARED_ROW.replace(/TQQQ/g, ticker).replace(/tqqq/g, ticker.toLowerCase());
const holdingsCsvFor = (tickers: string[]): string =>
  [...HOLDINGS_CSV.split('\n').slice(0, 4), ...tickers.flatMap(t => [
    `"${t}","ProShares ${t}","BDX","2087807","BECTON DICKINSON AND CO",,,1079626,,195347528.4,`,
    `"${t}","ProShares ${t}","","","NET OTHER ASSETS (LIABILITIES)",,,27861053,,27861053.4,`,
  ])].join('\n');
const navCsvFor = (ticker: string): string =>
  NAV_CSV.replace(/NOBL/g, ticker) + `09/18/2020,ProShares ${ticker},${ticker},40,40,0,0,100000,4000000000\n`;

type FeedOptions = { fail?: (url: string) => boolean; barrier?: number; distributionYears?: number[] };
type FeedState = { urls: string[]; inFlight: number; peak: number };

/** Installs a mocked fetch serving a complete 3-fund ProShares feed; `fail` answers 404 for matching URLs. */
function mockFeed(options: FeedOptions = {}): FeedState {
  const state: FeedState = { urls: [], inFlight: 0, peak: 0 };
  const year = new Date().getUTCFullYear();
  let latch: () => void = () => {};
  const released = new Promise<void>(resolve => { latch = resolve; });
  if (options.barrier) realSetTimeout(latch, 1500); // safety net only: a broken pool then fails on `peak`
  const body = (url: string): string | null => {
    if (url === STRATEGIC_FINDER_URL) return TICKERS.filter(t => FUNDS[t] === 'strategic').map(t => catalogRow(t, 'strategic')).join('');
    if (url === GEARED_FINDER_URL) return TICKERS.filter(t => FUNDS[t] === 'geared').map(t => catalogRow(t, 'geared')).join('');
    if (url === HOLDINGS_ALL_URL) return holdingsCsvFor(TICKERS);
    if (url === PERFORMANCE_URL) return PERFORMANCE_CSV;
    if (url === SPLITS_URL) return SPLITS_CSV;
    if (url === NAV_HISTORY_ALL_URL || url === NASDAQ_LISTED_URL || url === NASDAQ_OTHER_LISTED_URL) return null;
    if (/our-etfs\/(?:strategic|leveraged-and-inverse)\/\w+$/.test(url)) return FUND_PAGE;
    const file = url.match(/ByFund\/(\w+)-(historical_nav|psdlyhld)\.csv$/);
    if (file) return file[2] === 'psdlyhld' ? holdingsCsvFor([file[1]]) : navCsvFor(file[1]);
    const dist = url.match(/distributionsummary\?fund=\w+&year=(\d+)/);
    if (dist && options.distributionYears) {
      return options.distributionYears.includes(Number(dist[1])) ? DISTRIBUTIONS_JSON.replace(/\d{4}(-\d\d-\d\dT)/g, `${dist[1]}$1`) : '[]';
    }
    if (dist) return Number(dist[1]) === year ? DISTRIBUTIONS_JSON : '[]';
    return null;
  };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    state.urls.push(url);
    const staged = FUND_STAGE.test(url);
    if (staged) { state.inFlight++; state.peak = Math.max(state.peak, state.inFlight); }
    try {
      if (staged) {
        if (options.barrier && state.inFlight >= options.barrier) latch();
        await (options.barrier ? released : new Promise(resolve => realSetTimeout(resolve, 1)));
      }
      const text = options.fail?.(url) ? null : body(url);
      return text === null ? new Response('missing', { status: 404, statusText: 'Not Found' }) : new Response(text);
    } finally {
      if (staged) state.inFlight--;
    }
  }) as unknown as typeof fetch;
  return state;
}

type Repo = { mod: Updater; api: string; run: (override?: Partial<UpdaterConfig>) => Promise<void> };

/** Runs `fn` against a fresh temp copy of the updater, so main() writes into a temp api/ tree, removed afterwards. */
async function withRepo<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'proshares-test-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    for (const name of ['update-data.ts', 'update-data.config.json']) copyFileSync(new URL(`./${name}`, import.meta.url), path.join(root, 'scripts', name));
    const mod = (await import(pathToFileURL(path.join(root, 'scripts', 'update-data.ts')).href)) as Updater;
    quiet();
    return await fn({ mod, api: path.join(root, 'api', 'proshares'), run: override => mod.main({ ...testConfig, ...override }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every file under `dir`, sorted, as path -> mtime + content: equal snapshots mean nothing was written. */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(path.join(dir, prefix)).sort()) {
    const relative = path.join(prefix, name);
    const stat = statSync(path.join(dir, relative));
    if (stat.isDirectory()) Object.assign(out, snapshot(dir, relative));
    else out[relative] = `${stat.mtimeMs}:${readFileSync(path.join(dir, relative), 'utf8')}`;
  }
  return out;
}
const readIndex = (api: string): { funds: Record<string, any>[] } => JSON.parse(readFileSync(path.join(api, 'index.json'), 'utf8'));
const tickersIn = (api: string): string[] => readIndex(api).funds.map(fund => String(fund.ticker));

describe('pipeline', () => {
  test('a full run publishes every fund with a complete row and its meta file', async () => {
    mockFeed();
    await withRepo(async ({ api, run }) => {
      await run();
      const { funds } = readIndex(api);
      expect(funds.map(fund => fund.ticker)).toEqual(TICKERS);
      for (const row of funds) {
        expect(row.dataFile).toBe(`./funds/${row.ticker}/meta.json`);
        expect(existsSync(path.join(api, 'funds', row.ticker, 'meta.json'))).toBe(true);
        expect(row.metrics.returnsBasis.length).toBeGreaterThan(1);
      }
      const byTicker = Object.fromEntries(funds.map(fund => [fund.ticker, fund]));
      expect(byTicker.NOBL.metrics.ytd).toBe(12.35);
      expect(byTicker.IGHG.metrics.ytd).toBeNull(); // no performance row: null, never 0
      expect(byTicker.IGHG.metrics.performanceAsOf).toBeNull();
      expect(process.exitCode).not.toBe(1);
    });
  });

  test('a filtered run (one ticker, batch size, filter, lost index) never shrinks the feed', async () => {
    mockFeed();
    await withRepo(async ({ api, run }) => {
      await run();
      const before = snapshot(path.join(api, 'funds'));
      await run({ tickers: ['NOBL'] });
      expect(tickersIn(api)).toEqual(TICKERS);
      expect(snapshot(path.join(api, 'funds'))).toEqual(before);
      await run({ maxFetches: 1 });
      expect(tickersIn(api)).toEqual(TICKERS);
      await run({ terRange: { min: 5, max: undefined } });
      expect(tickersIn(api)).toEqual(TICKERS);
      rmSync(path.join(api, 'index.json'));
      await run({ tickers: ['TQQQ'] });
      expect(tickersIn(api)).toEqual(TICKERS); // rebuilt from every funds/*/meta.json
    });
  });

  test('a second identical run writes nothing (zero diff)', async () => {
    mockFeed();
    await withRepo(async ({ api, run }) => {
      await run();
      const first = snapshot(api);
      expect(Object.keys(first).length).toBeGreaterThan(TICKERS.length * 3);
      await run();
      expect(snapshot(api)).toEqual(first);
    });
  });

  test('a failed source keeps the fund exactly as published', async () => {
    await withRepo(async ({ api, run }) => {
      mockFeed();
      await run();
      const published = snapshot(api);
      mockFeed({ fail: url => url.includes('/strategic/nobl') });
      await run();
      expect(snapshot(api)).toEqual(published);
      expect(tickersIn(api)).toEqual(TICKERS);
      expect(process.exitCode).not.toBe(1); // one failed fund among three is not a failed run
      mockFeed({ fail: url => url === PERFORMANCE_URL });
      await run();
      expect(snapshot(api)).toEqual(published);
      expect(process.exitCode).toBe(1); // every fund failed
    });
  });

  test('distributions: only the current and previous year are requested once rows are published, every year otherwise, reruns write nothing', async () => {
    const year = new Date().getUTCFullYear();
    const perYear = parseDistributionSummary(DISTRIBUTIONS_JSON).length;
    const distRequests = (feed: FeedState): string[] => feed.urls.filter(url => url.includes('distributionsummary?fund=NOBL')).map(url => url.slice(-4));
    const published = (api: string): { rows: Record<string, string>[]; refreshedAt?: string } =>
      JSON.parse(readFileSync(path.join(api, 'funds', 'NOBL', 'meta.json'), 'utf8')).distributions;
    await withRepo(async ({ api, run }) => {
      const years = [year, year - 1, year - 2, year - 3];
      const first = mockFeed({ distributionYears: years });
      await run({ tickers: ['NOBL'] });
      expect(distRequests(first)).toEqual([year, year - 1, year - 2, year - 3, year - 4, year - 5].map(String)); // full walk, two empty years stop it
      expect(published(api).rows.length).toBe(4 * perYear);
      expect(published(api).refreshedAt).toBe(new Date().toISOString().slice(0, 10));

      const before = snapshot(api);
      const second = mockFeed({ distributionYears: years });
      await run({ tickers: ['NOBL'] });
      expect(distRequests(second)).toEqual([String(year), String(year - 1)]);
      expect(snapshot(api)).toEqual(before); // zero diff on a rerun

      // older years are immutable history: kept from the published rows even if the source stops serving them
      mockFeed({ distributionYears: [year, year - 1] });
      await run({ tickers: ['NOBL'] });
      expect(published(api).rows.length).toBe(4 * perYear);

      // a stale refreshedAt triggers the full walk again, which then sees the source as it is now
      const metaFile = path.join(api, 'funds', 'NOBL', 'meta.json');
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      meta.distributions.refreshedAt = '2000-01-01';
      writeFileSync(metaFile, JSON.stringify(meta));
      const refresh = mockFeed({ distributionYears: [year, year - 1] });
      await run({ tickers: ['NOBL'] });
      expect(distRequests(refresh).length).toBe(4); // years with data, then two empty years
      expect(published(api).rows.length).toBe(2 * perYear);
      expect(published(api).refreshedAt).toBe(new Date().toISOString().slice(0, 10));
    });
  });

  test('distribution refresh is due after 90 days plus a per-ticker offset of under 30 days', () => {
    const now = new Date(Date.UTC(2026, 9, 3));
    const ago = (days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    expect(distributionRefreshDue('NOBL', ago(89), now)).toBe(false);
    expect(distributionRefreshDue('NOBL', ago(120), now)).toBe(true);
    expect(distributionRefreshDue('NOBL', undefined, now)).toBe(false); // unknown stamp is backfilled, not refetched
    // the same stamp, different tickers: one is already due, the other waits for its offset
    expect([distributionRefreshDue('IGHG', ago(110), now), distributionRefreshDue('NOBL', ago(110), now)]).toEqual([true, false]);
  });

  test('unknown tickers fail before any fund is written', async () => {
    mockFeed();
    await withRepo(async ({ api, run }) => {
      await expect(run({ tickers: ['ZZZZ'] })).rejects.toThrow(/absent from the catalog/);
      expect(readdirSync(path.join(api, 'funds'))).toEqual([]);
    });
  });

  test('HISTORY_RANGE trims the published NAV history from the old end', async () => {
    mockFeed();
    await withRepo(async ({ api, run }) => {
      await run({ tickers: ['NOBL'] });
      const history = () => JSON.parse(readFileSync(path.join(api, 'funds', 'NOBL', 'meta.json'), 'utf8')).history.totalRows;
      expect(history()).toBe(3);
      await run({ tickers: ['NOBL'], historyRange: '1y' });
      expect(history()).toBe(2);
    });
  });

  test('stalest fund first: a deadline-truncated run refreshes the stalest, the next runs pick up the skipped funds', async () => {
    mockFeed();
    await withRepo(async ({ api, run }) => {
      await run();
      // published as-of dates: TQQQ stalest, then IGHG, then NOBL (alphabetical order would be IGHG, NOBL, TQQQ)
      const asOf: Record<string, string> = { TQQQ: 'Sep 01 2026', IGHG: 'Sep 05 2026', NOBL: 'Sep 10 2026' };
      const index = readIndex(api);
      for (const row of index.funds) { row.asOfDate = asOf[row.ticker]; row.netAssetsAsOf = asOf[row.ticker]; row.metrics.performanceAsOf = '2026-08-31'; }
      writeFileSync(path.join(api, 'index.json'), JSON.stringify(index));
      const published = Object.fromEntries(index.funds.map(row => [row.ticker, row]));
      expect(stalestFirst([{ ticker: 'IGHG' }, { ticker: 'NOBL' }, { ticker: 'TQQQ' }, { ticker: 'ZNEW' }], published).map(f => f.ticker)).toEqual(['ZNEW', 'TQQQ', 'IGHG', 'NOBL']);
      expect(publishedAsOf({ ...index.funds[0], dataFile: null })).toBeNull();

      // fake clock: the first fund page of each run "takes" 26 minutes (soft deadline 25), so each run handles exactly one fund
      let clock = realDateNow();
      Date.now = () => clock;
      const summary = path.join(path.dirname(api), 'summary.md');
      process.env.GITHUB_STEP_SUMMARY = summary;
      const order: string[] = [];
      const feed = globalThis.fetch;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const page = /our-etfs\/(?:strategic|leveraged-and-inverse)\/(\w+)$/.exec(String(input));
        if (page) { order.push(page[1].toUpperCase()); clock += 26 * 60_000; }
        return feed(input as RequestInfo, init);
      }) as typeof fetch;
      const runs: string[][] = [];
      for (let i = 0; i < 3; i++) {
        order.length = 0;
        await run();
        runs.push([...order]);
      }
      expect(runs).toEqual([['TQQQ'], ['IGHG'], ['NOBL']]);
      expect(readFileSync(summary, 'utf8')).toContain('1 of 3 funds refreshed, 2 keep their published files, oldest remaining published as-of: 2026-09-05 (IGHG)');
      expect(tickersIn(api)).toEqual(TICKERS);
      expect(readIndex(api).funds.every(row => row.asOfDate === 'Sep 18 2026')).toBe(true);
    });
  });

  test('batches continue after the cursor and wrap; the cursor scope follows the selection', () => {
    const funds = ['AAA', 'BBB', 'CCC', 'DDD'].map(ticker => ({ ticker }));
    const tickers = (items: { ticker: string }[]) => items.map(item => item.ticker);
    expect(tickers(selectBatch(funds, 2, null))).toEqual(['AAA', 'BBB']);
    expect(tickers(selectBatch(funds, 2, 'BBB'))).toEqual(['CCC', 'DDD']);
    expect(tickers(selectBatch(funds, 3, 'CCC'))).toEqual(['DDD', 'AAA', 'BBB']);
    expect(selectBatch(funds, 0, 'BBB')).toHaveLength(4);
    const base = { tickers: [] as string[], category: '' };
    expect(cursorScope({ ...base, category: 'Equity' })).not.toBe(cursorScope(base));
    expect(cursorScope({ ...base, tickers: ['B', 'A'] })).toBe(cursorScope({ ...base, tickers: ['A', 'B'] }));
  });

  test('writes: stable serialization, rewrite only when bytes move, stamps ignored, pages paginated and pruned', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'proshares-writes-'));
    try {
      expect(serialize({ b: 1, a: 2 })).toBe('{\n "b": 1,\n "a": 2\n}\n');
      const plain = path.join(directory, 'plain.json');
      expect(await writeIfChanged(plain, 'one')).toBe('written');
      expect(await writeIfChanged(plain, 'one')).toBe('unchanged');
      expect(await writeIfChanged(plain, 'two')).toBe('written');
      const file = path.join(directory, 'index.json');
      const index = (stamp: string, ticker = 'AAA') => ({ generatedAt: stamp, source: { catalogReadAt: stamp }, funds: [{ ticker }] });
      expect(await writeJsonIfChanged(file, index('2026-10-01T00:00:00Z'))).toBe('written');
      expect(await writeJsonIfChanged(file, index('2026-10-02T00:00:00Z'))).toBe('unchanged');
      expect(await writeJsonIfChanged(file, index('2026-10-03T00:00:00Z', 'BBB'))).toBe('written');
      await atomicWrite(path.join(directory, 'x.json'), '{}');
      expect(readdirSync(directory).filter(name => name.includes('.tmp-'))).toEqual([]);

      const rows = [{ a: '1' }, { a: '2' }, { a: '3' }, { a: '4' }, { a: '5' }];
      const first = await writeSheetPages(directory, 'holdings', 'NOBL', ['a'], rows, 2);
      expect(first.manifest.pages).toEqual(['./holdings/001.json', './holdings/002.json', './holdings/003.json']);
      expect([first.manifest.totalRows, first.written]).toEqual([5, 3]);
      const last = JSON.parse(readFileSync(path.join(directory, 'holdings', pageName(3)), 'utf8'));
      expect(last).toMatchObject({ ticker: 'NOBL', page: 3, pageSize: 2, totalRows: 5, headers: ['a'], rows: [{ a: '5' }] });
      const second = await writeSheetPages(directory, 'holdings', 'NOBL', ['a'], rows.slice(0, 3), 2);
      expect([second.manifest.pages.length, second.removed, second.written]).toEqual([2, 1, 2]);
      expect(existsSync(path.join(directory, 'holdings', '003.json'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// network: timeouts, bounded retries, pacing, concurrency, certificate fallback
// ---------------------------------------------------------------------------

describe('network', () => {
  /** setTimeout that fires at once and records the requested delays, so retry back-offs cost nothing. */
  const instantTimers = (): number[] => {
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => { delays.push(Number(ms)); return realSetTimeout(fn, 0); }) as unknown as typeof setTimeout;
    return delays;
  };

  test('retries are bounded: permanent 4xx once, 403 twice, other failures maxRetries + 1 calls', async () => {
    instantTimers();
    const cases: [number, number, number][] = [[404, 3, 1], [403, 5, 2], [500, 2, 3], [500, 0, 1]];
    for (const [status, maxRetries, expectedCalls] of cases) {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response('x', { status, statusText: 'Nope' }); }) as unknown as typeof fetch;
      await expect(fetchText('https://example.test/x', {}, { ...testConfig, maxRetries }, 'probe')).rejects.toThrow(`probe: HTTP ${status} Nope`);
      expect(calls, `${status}/${maxRetries}`).toBe(expectedCalls);
    }
    let attempts = 0;
    globalThis.fetch = (async () => { if (++attempts === 1) throw new Error('socket hang up'); return new Response('fine'); }) as unknown as typeof fetch;
    expect(await fetchText('https://example.test/x', {}, { ...testConfig, maxRetries: 2 }, 'probe')).toBe('fine');
    expect(attempts).toBe(2);
  });

  test('every request carries a timeout signal', async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { signal = init?.signal; return new Response('ok'); }) as unknown as typeof fetch;
    await fetchText('https://example.test/x', {}, testConfig, 'probe');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  test('request lanes are reserved before awaiting: starts are spaced per lane, not bursted (fake clock)', async () => {
    const now = Date.now();
    Date.now = () => now;
    const delays = instantTimers();
    const config = { ...testConfig, requestSleep: 0.1 };
    await paceRequests({ ...config, concurrency: 5 }); // resets the lanes
    delays.length = 0;
    for (let i = 0; i < 12; i++) await paceRequests({ ...config, concurrency: 3 });
    // 3 lanes x 4 starts, 100 ms apart per lane: the first three start at once, then 100, 200 and 300 ms
    expect(delays.sort((a, b) => a - b)).toEqual([100, 100, 100, 200, 200, 200, 300, 300, 300]);
  });

  test('in-flight work: worker pool peak is 1 at limit 1 and N at limit N, a passed deadline starts nothing', async () => {
    const measure = async (limit: number): Promise<number> => {
      let active = 0;
      let peak = 0;
      await mapWithConcurrency([1, 2, 3, 4, 5, 6], limit, async () => {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => realSetTimeout(resolve, 2));
        active--;
      });
      return peak;
    };
    expect(await measure(1)).toBe(1);
    expect(await measure(3)).toBe(3);
    let started = 0;
    await mapWithConcurrency([1, 2, 3], 2, async () => { started++; }, Date.now() - 1);
    expect(started).toBe(0);
  });

  test('the real run fetches funds in parallel at CONCURRENCY=3 and one at a time at CONCURRENCY=1', async () => {
    await withRepo(async ({ run }) => {
      const serial = mockFeed();
      await run({ concurrency: 1 });
      expect(serial.peak).toBe(1);
      const parallel = mockFeed({ barrier: 3 });
      await run({ concurrency: 3, tickers: [] });
      expect(parallel.peak).toBe(3);
    });
  });

  test('HISTORY_RANGE and per-fund NAV and holdings requests use the official per-fund files', async () => {
    await withRepo(async ({ run }) => {
      const feed = mockFeed();
      await run({ tickers: ['NOBL'], historyRange: '1y' });
      expect(feed.urls).toContain(navHistoryUrl('NOBL'));
      expect(feed.urls).toContain(holdingsUrl('NOBL'));
      expect(feed.urls.filter(url => url.includes('distributionsummary?fund=NOBL')).length).toBeGreaterThan(0);
      expect(feed.urls.some(url => /TQQQ|IGHG/.test(url) && FUND_STAGE.test(url))).toBe(false);
    });
  });

  test('system CA: auto restarts once on certificate errors only, false and active leave fetch untouched', async () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    quiet();
    const noReexec = (): never => { throw new Error('unexpected reexec'); };
    const stub = (async () => new Response('ok')) as unknown as typeof fetch;
    globalThis.fetch = stub;
    installSystemCa('false', noReexec, false);
    installSystemCa('auto', noReexec, true);
    installSystemCa('true', noReexec, true);
    expect(globalThis.fetch).toBe(stub);
    let restarts = 0;
    const reexec = (() => { restarts++; return undefined as never; }) as () => never;
    installSystemCa('true', reexec, false);
    expect(restarts).toBe(1);
    globalThis.fetch = (async () => { throw new Error('unable to get local issuer certificate'); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await fetch('https://example.invalid');
    expect(restarts).toBe(2);
    globalThis.fetch = (async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.invalid')).rejects.toThrow('reset');
    expect(restarts).toBe(2);
  });
});
