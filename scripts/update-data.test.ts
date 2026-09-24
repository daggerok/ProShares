/**
 * @file Unit tests for the ProShares static feed updater.
 *
 * Pure-function coverage with inline fixtures taken from the real sources: the
 * finder rows, the fund-page markup, the official `psdlyhld.csv`, NAV history,
 * performance and splits files, and the distribution summary JSON. Run with
 * `bun test scripts/update-data.test.ts` (the same command the workflow uses).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyHistoryRange,
  buildFeed,
  cleanText,
  compareDisplayDates,
  cumulativeFromAnnualized,
  decodeEntities,
  distributionRowsForCsv,
  formatAumDisplay,
  formatElapsed,
  formatFundProgress,
  formatMoneyText,
  formatPercentText,
  formatRetry,
  formatUsDate,
  headerIndex,
  historyRangeDays,
  holdingWeight,
  holdingsHeaders,
  holdingsUrl,
  holdingsNetAssets,
  isOtherAssetsRow,
  isWeightlessRow,
  indicatedYield,
  matchesRange,
  matchesReturnRange,
  navHistoryUrl,
  normalizeDistributionFrequency,
  normalizeNumberText,
  normalizeSecurityName,
  numberOrNull,
  pageName,
  parseAumBound,
  parseAumRange,
  parseBoolean,
  parseCsvRecords,
  parseDistributionSummary,
  parseFinderCatalogPage,
  parseFundPage,
  parseHoldingsFile,
  parseNavHistoryFile,
  parsePerformanceFile,
  parseRange,
  parseSplitsFile,
  parseSymbolDirectory,
  paymentsPerYear,
  progressLabel,
  readConfig,
  serialize,
  stripTags,
  toIsoDate,
  writeIfChanged,
  writeSheetPages,
  type HoldingsRow,
  type NavRow,
  type UpdaterConfig,
} from './update-data';

// ---------------------------------------------------------------------------
// Fixtures (verbatim excerpts of the live sources)
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
  maxRetries: 0,
  tickers: [],
  category: '',
  audienceType: '',
  secUa: '',
  skipProShares: false,
  offlineSeed: false,
  performanceRanges: {},
  totalReturnRanges: {},
};

// ---------------------------------------------------------------------------
// Text, number and date helpers
// ---------------------------------------------------------------------------

describe('text and number helpers', () => {
  test('cleanText collapses whitespace and decodes non-breaking spaces', () => {
    expect(cleanText('  UltraPro   QQQ\u00a0 ')).toBe('UltraPro QQQ');
  });

  test('stripTags removes markup and decodes entities', () => {
    expect(stripTags('<span class="d-none">+</span>3x<span></span>')).toBe('+ 3x');
    expect(decodeEntities('Nasdaq-100&reg; Index&nbsp;(NDX)')).toBe('Nasdaq-100® Index (NDX)');
  });

  test('normalizeNumberText expands scientific notation and drops placeholders', () => {
    expect(normalizeNumberText('2.97E8')).toBe('297000000');
    expect(normalizeNumberText('$1,234.50')).toBe('1234.50');
    expect(normalizeNumberText('--')).toBe('');
    expect(normalizeNumberText('N/A')).toBe('');
  });

  test('numberOrNull treats provider placeholders and denormals as missing', () => {
    expect(numberOrNull('')).toBeNull();
    expect(numberOrNull('—')).toBeNull();
    expect(numberOrNull('-1557')).toBe(-1557);
    expect(numberOrNull('5e-324')).toBeNull();
    expect(numberOrNull('0')).toBe(0);
  });

  test('formatters follow the shared display contract', () => {
    expect(formatPercentText(9.345)).toBe('9.35%');
    expect(formatPercentText(null)).toBe('—');
    expect(formatMoneyText(11270728460)).toBe('$11.27B');
    expect(formatMoneyText(null)).toBe('—');
    expect(formatAumDisplay(11270728460)).toBe('$11.27 B');
  });

  test('normalizeSecurityName keeps the published upper-case names', () => {
    expect(normalizeSecurityName('  BECTON   DICKINSON AND CO ')).toBe('BECTON DICKINSON AND CO');
  });
});

describe('date helpers', () => {
  test('formatUsDate normalizes US, ISO and dashed forms', () => {
    expect(formatUsDate('9/18/2026')).toBe('Sep 18 2026');
    expect(formatUsDate('2026-06-24T00:00:00')).toBe('Jun 24 2026');
    expect(formatUsDate('01-Jan-2020')).toBe('Jan 01 2020');
    expect(formatUsDate('')).toBe('—');
  });

  test('toIsoDate keeps provenance sortable', () => {
    expect(toIsoDate('9/18/2026')).toBe('2026-09-18');
    expect(toIsoDate('2026-06-24T00:00:00')).toBe('2026-06-24');
  });

  test('compareDisplayDates sorts display dates chronologically', () => {
    const dates = ['Jun 24 2026', 'Mar 25 2026', 'Dec 24 2025'];
    expect([...dates].sort(compareDisplayDates)).toEqual(['Dec 24 2025', 'Mar 25 2026', 'Jun 24 2026']);
  });
});

// ---------------------------------------------------------------------------
// CSV reader
// ---------------------------------------------------------------------------

describe('CSV reader', () => {
  test('handles quotes, embedded commas, CRLF and BOM', () => {
    const records = parseCsvRecords('\uFEFFa,b\r\n"1,25",2\r\n"say ""hi""",3\r\n');
    expect(records).toEqual([['a', 'b'], ['1,25', '2'], ['say "hi"', '3']]);
  });

  test('headerIndex and lookups ignore punctuation and case', () => {
    const index = headerIndex(['Fund Ticker', 'Shares/Contracts', 'Exposure Value (Notional + G/L)']);
    expect(index.get('fundticker')).toBe(0);
    expect(index.get('sharescontracts')).toBe(1);
    expect(index.get('exposurevaluenotionalgl')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Range parsing (shared with every sibling updater)
// ---------------------------------------------------------------------------

describe('range parsing', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseRange('', 'TER')).toBeUndefined();
    expect(parseRange(':', 'TER')).toEqual({ min: undefined, max: undefined });
  });

  test('accepts optional % and $ and inclusive bounds', () => {
    expect(parseRange('0.2%:1.5%', 'TER')).toEqual({ min: 0.2, max: 1.5 });
    expect(() => parseRange('$1B:', 'AUM')).toThrow(/Invalid AUM minimum/);
  });

  test('rejects colonless input and inverted ranges', () => {
    expect(() => parseRange('5', 'TER')).toThrow(/single colon/);
    expect(() => parseRange('2:1', 'TER')).toThrow(/minimum is above maximum/);
    expect(() => parseRange('a:b', 'TER')).toThrow(/Invalid TER minimum/);
  });

  test('AUM presets, suffixes and preset bounds', () => {
    expect(parseAumBound('nano')).toEqual({ preset: 'nano' });
    expect(parseAumBound('2b')).toEqual({ value: 2_000_000_000 });
    expect(() => parseAumBound('huge')).toThrow(/Invalid AUM bound/);
    expect(parseAumRange('micro:large')).toEqual({ min: 10_000_000, max: undefined });
    expect(parseAumRange('1B:2B')).toEqual({ min: 1_000_000_000, max: 2_000_000_000 });
    expect(() => parseAumRange('large:micro')).toThrow(/above maximum/);
  });

  test('matchesRange and matchesReturnRange differ for young funds', () => {
    expect(matchesRange(null, { min: 1 })).toBe(false);
    expect(matchesReturnRange(null, { min: 1 })).toBe(true);
    expect(matchesReturnRange(5, { min: 1, max: 4 })).toBe(false);
  });

  test('booleans accept the documented truthy spellings only', () => {
    expect(parseBoolean('YES')).toBe(true);
    expect(parseBoolean('on')).toBe(true);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('', true)).toBe(true);
  });
});

describe('configuration', () => {
  test('defaults match the documented surface', () => {
    const config = readConfig({});
    expect(config.concurrency).toBe(3);
    expect(config.requestSleep).toBe(1.5);
    expect(config.holdingsPageSize).toBe(250);
    expect(config.historyPageSize).toBe(1000);
    expect(config.historyRange).toBe('max');
    expect(config.distributionYears).toBe(10);
    expect(config.aumRange).toBeUndefined();
  });

  test('aliases, tickers and invalid values', () => {
    const config = readConfig({ HISTORICAL_PAGE_SIZE: '500', TICKERS: 'nobl, tqqq\nbrk.b', AUM: '300M:' });
    expect(config.historyPageSize).toBe(500);
    expect(config.tickers).toEqual(['NOBL', 'TQQQ', 'BRKB']);
    expect(config.aumRange).toEqual({ min: 300_000_000, max: undefined });
    expect(() => readConfig({ AUDIENCE_TYPE: 'Retail' })).toThrow(/Invalid AUDIENCE_TYPE/);
    expect(() => readConfig({ TER: 'x' })).toThrow(/Invalid TER range/);
  });
});

// ---------------------------------------------------------------------------
// Progress output (never changes the generated feed)
// ---------------------------------------------------------------------------

describe('per-fund progress', () => {
  test('numbers concurrent work with a stable candidate position and elapsed time', () => {
    expect(progressLabel('TQQQ', 37, 173)).toBe('[  37/173] TQQQ');
    expect(progressLabel('NOBL', 1, 7)).toBe('[   1/7] NOBL');
    expect(formatElapsed(2450)).toBe('2.5s');
    expect(formatRetry('BIS fund page', 'HTTP 500 Internal Server Error', 15, 1, 3))
      .toBe('[retry] BIS fund page → HTTP 500 Internal Server Error, backoff 15s (attempt 1/3)');
  });

  test('summarizes successful or unchanged funds but hides unavailable metrics', () => {
    const before = { nav: '$55.66', aumValue: 11_270_728_460, ter: '0.35%', distributionFrequency: '04 - Quarterly', holdings: 71, history: 3220, metrics: { dividendYieldText: '2.01%' } };
    const snapshot = JSON.stringify(before);
    expect(formatFundProgress(progressLabel('NOBL', 1, 7), before, true, 2400))
      .toBe('[   1/7] NOBL ok · NAV $55.66 · AUM $11.27B · TER 0.35% · DivYld 2.01% · Freq 04 - Quarterly · holdings 71 · history 3220 · 2.4s');
    expect(formatFundProgress(progressLabel('BOIL', 2, 7), { nav: '—', ter: '—', aumValue: null, distributionFrequency: '00 - —', holdings: 0, history: 15, metrics: { dividendYieldText: '—' } }, false, 99))
      .toBe('[   2/7] BOIL ok (unchanged) · holdings 0 · history 15 · 0.1s');
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// (a) Finder catalog
// ---------------------------------------------------------------------------

describe('finder catalog parsing', () => {
  test('strategic rows keep the provider asset class and marketing category', () => {
    const funds = parseFinderCatalogPage(STRATEGIC_ROW, 'strategic');
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      ticker: 'NOBL',
      name: 'S&P 500 Dividend Aristocrats ETF',
      assetClass: 'Equity',
      marketingCategory: 'DividendGrowers',
      fundPage: 'https://www.proshares.com/our-etfs/strategic/nobl',
      inceptionDateText: 'Oct 09 2013',
      netAssetsValue: 11_270_728_460,
    });
  });

  test('geared rows keep strategy, daily objective and benchmark ticker', () => {
    const funds = parseFinderCatalogPage(GEARED_ROW, 'geared');
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      ticker: 'TQQQ',
      assetClass: 'Equity',
      strategy: 'Broad Market',
      dailyObjective: '+3x',
      benchmarkTicker: 'NDX',
    });
  });

  test('rows without a fund link are ignored', () => {
    expect(parseFinderCatalogPage('<tr><td>no link here</td></tr>', 'strategic')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) Fund page
// ---------------------------------------------------------------------------

describe('fund page parsing', () => {
  const page = parseFundPage(FUND_PAGE);

  test('snapshot, price and distribution blocks', () => {
    expect(page.cusip).toBe('74348A467');
    expect(page.expenseRatio).toBe(0.35);
    expect(page.netAssetsValue).toBe(11_270_728_460);
    expect(page.nav).toBe(55.66);
    expect(page.marketPrice).toBe(55.66);
    expect(page.priceAsOf).toBe('Sep 18 2026');
    expect(page.distributionFrequency).toBe('Quarterly');
    expect(page.twelveMonthYield).toBe(2.01);
    expect(page.inceptionDate).toBe('Oct 09 2013');
    expect(page.expenseRatio).toBe(0.35);
    expect(page.netExpenseRatio).toBe(0.35);
    // One published ratio serves as gross and net (ProShares publishes no waiver).
    expect(page.grossExpenseRatio).toBe(0.35);
    expect(page.expenseRatioFootnote).toBe('');
  });

  test('a fund that never distributed says so on its own page', () => {
    const never = parseFundPage('<div id="distributionTab"><p>This fund has not made any distributions.</p></div>');
    expect(never.distributionsNote).toBe('This fund has not made any distributions.');
    expect(parseFundPage(FUND_PAGE).distributionsNote).toBe('');
  });

  test('geared pages publish gross and net ratios plus a snapshot frequency', () => {
    const geared = parseFundPage(`
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Gross Expense Ratio</span> <div><span id="snapshot-grossExpenseRatio" class="about-fund__list-value d-inline-block">0.97%</span></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Net Expense Ratio</span> <div><span id="snapshot-netExpenseRatio" class="about-fund__list-value d-inline-block">0.82%</span></div></li>
<li class="about-fund__list-item mb-3"><span class="about-fund__list-label d-inline-block">Distributions</span> <div><span id="snapshot-distributions" class="about-fund__list-value d-inline-block">Quarterly</span></div></li>`);
    expect(geared.grossExpenseRatio).toBe(0.97);
    expect(geared.netExpenseRatio).toBe(0.82);
    expect(geared.expenseRatio).toBe(0.82);
    expect(geared.distributionFrequency).toBe('Quarterly');
    // "Net Expense Ratio 1.17%*" keeps the footnote marker out of the number.
    const waived = parseFundPage('<li><span class="about-fund__list-label">Net Expense Ratio</span> <span id="snapshot-netExpenseRatio" class="about-fund__list-value">1.17%*</span></li>');
    expect(waived.netExpenseRatio).toBe(1.17);
    expect(waived.netExpenseRatioText).toBe('1.17%');
    expect(waived.expenseRatioFootnote).toBe('*');
  });

  test('characteristics and index stats', () => {
    expect(page.characteristics['Number of Holdings']).toBe('71');
    expect(page.characteristics['Price/Earnings Ratio']).toBe('24.342');
    expect(page.indexStats['Dividend Yield ( % )']).toBe('2.49');
  });

  test('month-end and quarter-end return tables are paired with their as-of dates', () => {
    expect(page.returns.monthEnd.asOfDate).toBe('Aug 31 2026');
    expect(page.returns.monthEnd.ytd).toBe(12.35);
    expect(page.returns.monthEnd.mpytd).toBe(12.37);
    expect(page.returns.quarterEnd.asOfDate).toBe('Jun 30 2026');
    expect(page.returns.quarterEnd.ytd).toBe(9.09);
  });

  test('return tenors follow the header labels, not their position', () => {
    const swapped = parseFundPage(FUND_PAGE.replace(
      '<th>Fund + Index</th><th>1m</th><th>3m</th>',
      '<th>Fund + Index</th><th>3m</th><th>1m</th>'));
    // The NOBL NAV row reads 1.41% for 1m and 8.43% for 3m; swapped columns must
    // still land in their own tenor.
    expect(swapped.returns.monthEnd.mo1).toBe(8.43);
    expect(swapped.returns.monthEnd.mo3).toBe(1.41);
  });

  test('exposure JSON blocks are decoded', () => {
    expect(page.exposures[0].label).toBe('Fund Country Weighting');
    expect(page.exposures[0].rows[0]).toEqual({ Country: 'United States', Weight: 92.592586 });
  });
});

// ---------------------------------------------------------------------------
// (c) Holdings file
// ---------------------------------------------------------------------------

describe('holdings file parsing', () => {
  const file = parseHoldingsFile(HOLDINGS_CSV);

  test('preamble resolves the as-of date and every fund row', () => {
    expect(file.asOf).toBe('Sep 18 2026');
    expect(file.asOfIso).toBe('2026-09-18');
    expect([...file.funds.keys()].sort()).toEqual(['ANEW', 'IGHG', 'NOBL']);
    expect(file.funds.get('NOBL')?.rows.length).toBe(3);
  });

  test('equity, bond and derivative rows keep their own identifiers', () => {
    const nobl = file.funds.get('NOBL')?.rows || [];
    expect(nobl[0]).toMatchObject({ ticker: 'BDX', identifier: '2087807', marketValue: '195347528.4' });
    const ighg = file.funds.get('IGHG')?.rows || [];
    expect(ighg[0]).toMatchObject({ ticker: '', identifier: 'BYM4WR8', coupon: '4.375', maturity: '2047-01-22' });
    expect(ighg[1]).toMatchObject({ exposure: '-164774390.6', marketValue: '' });
  });

  test('headers grow only for the columns a fund actually uses', () => {
    expect(holdingsHeaders(file.funds.get('NOBL')?.rows || [])).toEqual(['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held']);
    expect(holdingsHeaders(file.funds.get('IGHG')?.rows || [])).toEqual(['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Exposure Value', 'Coupon', 'Maturity Date']);
  });

  test('weights reproduce the fund page Exposure Weight column', () => {
    // Live checks: NOBL BDX 1.73%, TQQQ NVDA 3.11%, TQQQ Barclays swap 29.64%,
    // AGQ Silver DEC26 77.04%, IGHG Morgan Stanley 1.62% — the denominator is the
    // sum of the market values the same official file reports.
    const nobl = parseHoldingsFile(HOLDINGS_CSV).funds.get('NOBL')?.rows || [];
    // The fixture keeps three of NOBL's seventy rows, so the published fund
    // total (Σ market values in the official file on 2026-09-18) is used here.
    expect(Number(holdingWeight(nobl[0], 11_264_839_323)).toFixed(2)).toBe('1.73');
    expect(holdingsNetAssets(nobl)).toBeCloseTo(409_244_295.4, 4);
    expect(isOtherAssetsRow(nobl[2])).toBe(true);

    const tqqq: HoldingsRow[] = [
      { name: 'NVDA', ticker: 'NVDA', identifier: '', coupon: '', maturity: '', shares: '5127506', exposure: '', marketValue: '1139690759' },
      { name: 'NASDAQ 100 INDEX SWAP BARCLAYS CAPITAL', ticker: '', identifier: '', coupon: '', maturity: '', shares: '366121', exposure: '10853353165', marketValue: '' },
      { name: 'Net Other Assets (Liabilities)', ticker: '', identifier: '', coupon: '', maturity: '', shares: '9707363674', exposure: '', marketValue: '9707363673.76' },
      { name: 'TREASURY BILL', ticker: '', identifier: '', coupon: '', maturity: '', shares: '1', exposure: '', marketValue: '1000000000' },
    ];
    // Σ market values for TQQQ in the official file on 2026-09-18.
    const tqqqTotal = 36_617_542_112;
    expect(holdingsNetAssets(tqqq)).toBeCloseTo(11_847_054_432.76, 2);
    expect(Number(holdingWeight(tqqq[0], tqqqTotal)).toFixed(2)).toBe('3.11');
    expect(Number(holdingWeight(tqqq[1], tqqqTotal)).toFixed(2)).toBe('29.64');
    expect(holdingWeight(tqqq[2], tqqqTotal)).toBe('—');
    // The fund page renders no weight for its cash-equivalent lines either:
    // Net Other Assets, Treasury bills and the ProShares money-market fund.
    expect(isWeightlessRow(tqqq[2])).toBe(true);
    expect(isWeightlessRow({ name: 'TREASURY BILL', ticker: '', identifier: '', coupon: '', maturity: '', shares: '1', exposure: '', marketValue: '998429170' })).toBe(true);
    expect(isWeightlessRow({ name: 'PROSHARES GENIUS MNY MKT ETF', ticker: '', identifier: '', coupon: '', maturity: '', shares: '1', exposure: '', marketValue: '7019262250' })).toBe(true);
    expect(isWeightlessRow({ name: 'US 10YR NOTE (CBT) BOND 21/DEC/2026 TYZ6 COMDTY', ticker: '', identifier: '', coupon: '', maturity: '', shares: '-1557', exposure: '-164774390.6', marketValue: '' })).toBe(false);
    expect(holdingWeight({ name: 'PROSHARES GENIUS MNY MKT ETF', ticker: '', identifier: '', coupon: '', maturity: '', shares: '1', exposure: '', marketValue: '7019262250' }, tqqqTotal)).toBe('—');

    const agq: HoldingsRow[] = [
      { name: 'SILVER FUTURE DEC26', ticker: '', identifier: '', coupon: '', maturity: '', shares: '3411', exposure: '1145226195', marketValue: '' },
      { name: 'Net Other Assets / Cash', ticker: '', identifier: '', coupon: '', maturity: '', shares: '1486541291', exposure: '', marketValue: '1486541291.25' },
    ];
    expect(Number(holdingWeight(agq[0], holdingsNetAssets(agq))).toFixed(2)).toBe('77.04');

    expect(holdingWeight({ name: 'NO SIDE', ticker: '', identifier: '', coupon: '', maturity: '', shares: '', exposure: '', marketValue: '' }, 1)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// (d) NAV history
// ---------------------------------------------------------------------------

describe('NAV history parsing', () => {
  test('keeps only the requested ticker and converts shares to units', () => {
    const rows = parseNavHistoryFile(NAV_CSV, 'NOBL');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: 'Sep 18 2026',
      nav: 55.6579,
      sharesOutstanding: 202_400_000,
      netAssets: 11_265_159_071.3158,
    });
  });

  test('per-fund URL pattern and range windows', () => {
    expect(navHistoryUrl('NOBL')).toBe('https://accounts.profunds.com/etfdata/ByFund/NOBL-historical_nav.csv');
    expect(holdingsUrl('NOBL')).toBe('https://accounts.profunds.com/etfdata/ByFund/NOBL-psdlyhld.csv');
    expect(historyRangeDays('max')).toBeNull();
    expect(historyRangeDays('10y')).toBe(3650);
    expect(historyRangeDays('6m')).toBe(180);
    expect(historyRangeDays('30d')).toBe(30);
    expect(() => historyRangeDays('forever')).toThrow(/Invalid HISTORY_RANGE/);
  });

  test('applyHistoryRange trims the oldest rows only', () => {
    const rows: NavRow[] = [
      { date: 'Sep 18 2020', nav: 1, sharesOutstanding: 1, netAssets: 1 },
      { date: 'Sep 18 2026', nav: 2, sharesOutstanding: 2, netAssets: 2 },
    ];
    expect(applyHistoryRange(rows, '1y')).toHaveLength(1);
    expect(applyHistoryRange(rows, 'max')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (e) Performance, (f) splits, (g) distributions, (h) symbol directory
// ---------------------------------------------------------------------------

describe('performance file', () => {
  const map = parsePerformanceFile(PERFORMANCE_CSV);

  test('keys each row by symbol, basis and period', () => {
    expect(map.size).toBe(5);
    const nobl = map.get('NOBL|NAV|MONTH')!;
    expect(nobl.asOfDate).toBe('Aug 31 2026');
    expect(nobl.ytd).toBe(12.35);
    expect(nobl.yr3).toBe(9.34);
    expect(map.get('NOBL|MARKET|MONTH')!.yr5).toBe(6.4);
    expect(map.get('NOBL|NAV|QUARTER')!.sinceInception).toBe(10.72);
  });

  test('young funds keep empty tenors as null', () => {
    const spcf = map.get('SPCF|MARKET|MONTH')!;
    expect(spcf.yr1).toBeNull();
    expect(spcf.yr10).toBeNull();
    expect(spcf.ytd).toBe(-37.24);
  });

  test('cumulative returns are derived from the published annualized ones', () => {
    expect(cumulativeFromAnnualized(9.34, 3)).toBeCloseTo(30.7185, 3);
    expect(cumulativeFromAnnualized(6.38, 5)).toBeCloseTo(36.2385, 3);
    expect(cumulativeFromAnnualized(null, 5)).toBeNull();
  });
});

describe('splits file', () => {
  test('groups split rows per symbol, newest first', () => {
    const splits = parseSplitsFile(SPLITS_CSV);
    expect(splits.get('NOBL')![0]).toMatchObject({ splitType: 'Forward', ratio: 2, date: 'May 28 2026' });
    expect(splits.get('REW')![0].postSplitCusip).toBe('74350P451');
  });
});

describe('distribution summary', () => {
  const rows = parseDistributionSummary(DISTRIBUTIONS_JSON);

  test('parses every payout and sorts by ex-date', () => {
    expect(rows).toHaveLength(2);
    expect(rows[0].exDate).toBe('Mar 25 2026');
    expect(rows[1].dividend).toBeCloseTo(0.303711, 6);
    expect(rows[0].shortTermCapGains).toBeCloseTo(0.0121, 6);
  });

  test('CSV rows use sortable dates and six-decimal money', () => {
    const csv = distributionRowsForCsv(rows);
    expect(csv[1]['Ex-Date']).toBe('24-Jun-2026');
    expect(csv[1].Dividend).toBe('0.303711');
    expect(csv[0]['LT Cap Gains']).toBe('—');
  });

  test('frequency labels and payment counts', () => {
    expect(normalizeDistributionFrequency('Quarterly')).toBe('Quarterly');
    expect(normalizeDistributionFrequency('Semi-Annual')).toBe('Semi-annually');
    expect(normalizeDistributionFrequency('')).toBe('—');
    expect(paymentsPerYear('Monthly')).toBe(12);
    expect(paymentsPerYear('Irregular')).toBe(1);
    expect(paymentsPerYear('—')).toBeNull();
  });

  test('indicated yield is annualised from the latest payout only', () => {
    expect(indicatedYield(0.303711, 'Quarterly', 55.66)).toBeCloseTo(2.1825, 3);
    expect(indicatedYield(null, 'Quarterly', 55.66)).toBeNull();
    expect(indicatedYield(0.303711, 'Quarterly', null)).toBeNull();
  });

  test('malformed or empty payloads are tolerated', () => {
    expect(parseDistributionSummary('[]')).toEqual([]);
    expect(parseDistributionSummary('not json')).toEqual([]);
  });
});

describe('nasdaq symbol directory', () => {
  test('resolves listing exchanges and skips the trailer line', () => {
    const text = [
      'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
      'A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A',
      'NOBL|ProShares S&P 500 Dividend Aristocrats ETF|P|NOBL|Y|100|N|NOBL',
      'File Creation Time: 0918202600:00|||||||',
    ].join('\r\n');
    const map = parseSymbolDirectory(text, { N: 'NYSE', P: 'NYSE Arca' });
    expect(map.get('NOBL')).toBe('NYSE Arca');
    expect(map.get('A')).toBe('NYSE');
    expect(map.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Feed assembly and deterministic writes
// ---------------------------------------------------------------------------

describe('feed assembly', () => {
  const artifacts = buildFeed({
    fund: parseFinderCatalogPage(STRATEGIC_ROW, 'strategic')[0],
    page: parseFundPage(FUND_PAGE),
    performanceNavMonth: parsePerformanceFile(PERFORMANCE_CSV).get('NOBL|NAV|MONTH'),
    performanceMarketMonth: parsePerformanceFile(PERFORMANCE_CSV).get('NOBL|MARKET|MONTH'),
    performanceNavQuarter: parsePerformanceFile(PERFORMANCE_CSV).get('NOBL|NAV|QUARTER'),
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
  });

  const entry = artifacts.entry as Record<string, any>;
  const meta = artifacts.meta as Record<string, any>;

  test('index entry carries every column the browser reads', () => {
    expect(entry.ticker).toBe('NOBL');
    expect(entry.category).toBe('Equity');
    expect(entry.terValue).toBe(0.35);
    expect(entry.terNetValue).toBe(0.35);
    // ProShares publishes one ratio for NOBL, so it serves as gross and net.
    expect(entry.terGrossValue).toBe(0.35);
    expect(entry.nav).toBe('$55.66');
    expect(entry.aumValue).toBe(11_265_159_071.3158);
    expect(entry.exchange).toBe('NYSE Arca');
    expect(entry.closePrice).toBe('$55.66');
    expect(entry.premiumDiscount).toBe('0.00%');
    expect(entry.distributionFrequency).toBe('Quarterly');
    expect(entry.distributions).toMatchObject({ frequency: 'Quarterly', exDate: 'Jun 24 2026', dividend: '0.3037' });
    expect(entry.metrics.ytd).toBe(12.35);
    expect(entry.metrics.secYield).toBeNull();
    expect(entry.metrics.secYieldText).toBe('—');
    expect(entry.holdings).toBe(3);
    expect(entry.history).toBe(2);
  });

  test('derived tenors are stored alongside the published annualized ones', () => {
    expect(entry.metrics.cagr3y).toBe(9.34);
    expect(entry.metrics.tr3y).toBeCloseTo(30.7185, 3);
    expect(entry.metrics.tr5y).toBeCloseTo(36.2385, 3);
    expect(entry.metrics.tr10y).toBeCloseTo(158.903, 3);
  });

  test('meta carries provenance for every consumer', () => {
    expect(meta.identifiers.cusip).toBe('74348A467');
    expect(meta.identifiers.isin).toBeNull();
    expect(meta.source.holdingsSource).toContain('psdlyhld.csv');
    expect(meta.source.historySource).toContain('ByFund/NOBL-historical_nav.csv');
    expect(meta.yields.secYield).toBeNull();
    expect(meta.yields.secYieldKind).toContain('no 30-day SEC yield');
    expect(meta.distributions.headers).toContain('Record Date');
    expect(meta.holdings.asOf).toBe('2026-09-18');
    expect(meta.documents.summaryProspectus).toContain('ticker=NOBL');
    expect(meta.officialMetrics.splits).toHaveLength(1);
  });

  test('holdings and history rows are keyed by their page headers', () => {
    for (const row of artifacts.holdingsRows) expect(Object.keys(row)).toEqual(artifacts.holdingsHeaders);
    for (const row of artifacts.historyRows) expect(Object.keys(row)).toEqual(artifacts.historyHeaders);
  });
});

describe('deterministic writes', () => {
  test('serialize is stable and newline-terminated', () => {
    expect(serialize({ b: 1, a: 2 })).toBe('{\n "b": 1,\n "a": 2\n}\n');
  });

  test('writeIfChanged only rewrites when the bytes move', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'proshares-updater-'));
    const file = path.join(directory, 'index.json');
    expect(await writeIfChanged(file, 'one')).toBe('written');
    expect(await writeIfChanged(file, 'one')).toBe('unchanged');
    expect(await writeIfChanged(file, 'two')).toBe('written');
    expect(await readFile(file, 'utf8')).toBe('two');
    await rm(directory, { recursive: true, force: true });
  });

  test('writeSheetPages paginates, matches headers and drops stale pages', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'proshares-pages-'));
    const rows = [{ a: '1' }, { a: '2' }, { a: '3' }, { a: '4' }, { a: '5' }];
    const first = await writeSheetPages(directory, 'holdings', 'NOBL', ['a'], rows, 2);
    expect(first.manifest.pages).toEqual(['./holdings/001.json', './holdings/002.json', './holdings/003.json']);
    expect(first.manifest.totalRows).toBe(5);
    expect(first.written).toBe(3);
    const page = JSON.parse(await readFile(path.join(directory, 'holdings', pageName(3)), 'utf8'));
    expect(page).toMatchObject({ ticker: 'NOBL', page: 3, pageSize: 2, totalRows: 5, headers: ['a'] });
    expect(page.rows).toEqual([{ a: '5' }]);

    const second = await writeSheetPages(directory, 'holdings', 'NOBL', ['a'], rows.slice(0, 3), 2);
    expect(second.manifest.pages).toHaveLength(2);
    expect(second.removed).toBe(1);
    // Page 1 and 2 change because `totalRows` moved with the shorter row set.
    expect(second.written).toBe(2);
    expect(existsSync(path.join(directory, 'holdings', '003.json'))).toBe(false);
    await rm(directory, { recursive: true, force: true });
  });
});
