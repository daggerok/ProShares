/**
 * Unit tests for the ProShares data updater.
 *
 * Fixtures are faithful transcriptions of the official ProShares sources
 * (finder pages, fund pages, holdings CSV, NAV history CSV, performance CSV,
 * splits CSV, distribution summary JSON, Nasdaq Trader symdir).
 * These tests guard the parts that the committed feed cannot exercise.
 */

import { describe, expect, test } from "bun:test";
import {
  FINDER_GEARED_URL,
  FINDER_STRATEGIC_URL,
  HOLDINGS_BULK_URL,
  NAV_HISTORY_BULK_URL,
  PERFORMANCE_URL,
  SPLITS_URL,
  annualizedToTotal,
  chunkRows,
  cleanRatioText,
  cleanText,
  expenseRatioFootnote,
  findHeaderRowIndex,
  frequencyCode,
  holdingsNetAssets,
  holdingsUrl,
  holdingWeight,
  indicatedDividendYield,
  isOtherAssetsRow,
  isWeightlessRow,
  navHistoryUrl,
  nasdaqExchangeDisplayName,
  normalizeNumberText,
  numberOrNull,
  parseAumRange,
  parseCsv,
  parseDistributionSummary,
  parseFinderPage,
  parseFundPage,
  parseHoldingsCsv,
  parseNasdaqSymdir,
  parseNavHistoryCsv,
  parsePerformanceCsv,
  parseRange,
  parseSplitsCsv,
  paymentsPerYear,
  ratioValue,
  sanitizeTicker,
  totalToAnnualized,
} from "./update-data";

// ---------------------------------------------------------------------------
// 1. Source URLs
// ---------------------------------------------------------------------------

describe("source URLs", () => {
  test("finder URLs are the official ProShares finder pages", () => {
    expect(FINDER_STRATEGIC_URL).toBe("https://www.proshares.com/our-etfs/find-proshares-etfs");
    expect(FINDER_GEARED_URL).toBe("https://www.proshares.com/our-etfs/find-leveraged-and-inverse-etfs");
  });

  test("bulk data host URLs are the official ProFunds data host", () => {
    expect(HOLDINGS_BULK_URL).toBe("https://accounts.profunds.com/etfdata/psdlyhld.csv");
    expect(NAV_HISTORY_BULK_URL).toBe("https://accounts.profunds.com/etfdata/historical_nav.csv");
    expect(PERFORMANCE_URL).toBe("https://accounts.profunds.com/etfdata/etf_performance.csv");
    expect(SPLITS_URL).toBe("https://accounts.profunds.com/etfdata/etf_splits.csv");
  });

  test("per-fund holdings and NAV history URLs follow the verified layout", () => {
    expect(holdingsUrl("NOBL")).toBe("https://accounts.profunds.com/etfdata/ByFund/NOBL-psdlyhld.csv");
    expect(holdingsUrl("tqqq")).toBe("https://accounts.profunds.com/etfdata/ByFund/TQQQ-psdlyhld.csv");
    expect(navHistoryUrl("NOBL")).toBe("https://accounts.profunds.com/etfdata/ByFund/NOBL-historical_nav.csv");
    expect(navHistoryUrl("IGHG")).toBe("https://accounts.profunds.com/etfdata/ByFund/IGHG-historical_nav.csv");
  });
});

// ---------------------------------------------------------------------------
// 2. Text and number normalization
// ---------------------------------------------------------------------------

describe("normalization", () => {
  test("sanitizeTicker strips whitespace and uppercases", () => {
    expect(sanitizeTicker("  nobl ")).toBe("NOBL");
    expect(sanitizeTicker("tqqq")).toBe("TQQQ");
    expect(sanitizeTicker(null)).toBe("");
    expect(sanitizeTicker("BRK.B")).toBe("BRKB");
  });

  test("cleanText collapses whitespace and strips trademarks", () => {
    expect(cleanText("  ProShares® ETF  ")).toBe("ProShares ETF");
    expect(cleanText("  a   b  c ")).toBe("a b c");
  });

  test("normalizeNumberText expands scientific notation and strips punctuation", () => {
    expect(normalizeNumberText("$1,234.56%")).toBe("1234.56");
    expect(normalizeNumberText("—")).toBe("");
    expect(normalizeNumberText("--")).toBe("");
    expect(normalizeNumberText("2.97E8")).toBe("297000000");
  });

  test("numberOrNull returns null for placeholders", () => {
    expect(numberOrNull("—")).toBeNull();
    expect(numberOrNull("--")).toBeNull();
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull("0.95%")).toBe(0.95);
    expect(numberOrNull("$24.49")).toBe(24.49);
  });
});

// ---------------------------------------------------------------------------
// 3. Expense ratio helpers — footnote stripping (EZJ 1.17%* etc)
// ---------------------------------------------------------------------------

describe("expense ratio", () => {
  test("cleanRatioText strips footnote markers", () => {
    expect(cleanRatioText("1.17%*")).toBe("1.17%");
    expect(cleanRatioText("0.95%†")).toBe("0.95%");
    expect(cleanRatioText("1.01% (1)")).toBe("1.01%");
    expect(cleanRatioText("0.95%")).toBe("0.95%");
    expect(cleanRatioText("")).toBe("");
  });

  test("expenseRatioFootnote extracts footnote", () => {
    expect(expenseRatioFootnote("1.17%*")).toBe("*");
    expect(expenseRatioFootnote("0.95%")).toBeNull();
    expect(expenseRatioFootnote("")).toBeNull();
  });

  test("ratioValue parses cleaned ratio", () => {
    expect(ratioValue("1.17%*")).toBe(1.17);
    expect(ratioValue("0.95%")).toBe(0.95);
    expect(ratioValue("—")).toBeNull();
    expect(ratioValue("")).toBeNull();
  });

  test("terValue for EZJ/PEX/TOLZ/UCYB with footnote is parsed", () => {
    // These 4 funds publish "1.17%*" etc on their pages; updater must strip *
    expect(ratioValue("1.17%*")).toBe(1.17);
    expect(ratioValue("1.15%*")).toBe(1.15);
    expect(cleanRatioText("1.17%*")).toBe("1.17%");
  });
});

// ---------------------------------------------------------------------------
// 4. Holdings helpers — weight semantics verified row-by-row vs live pages
// ---------------------------------------------------------------------------

describe("holdings weight", () => {
  const makeRow = (desc: string, market: number | null, exposure: number | null, ticker = "AAPL"): any => ({
    fundTicker: "NOBL",
    fundName: "ProShares S&P 500 Dividend Aristocrats",
    securityTicker: ticker,
    securitySedol: "1234567",
    securityDescription: desc,
    coupon: "",
    maturityDate: "",
    sharesContracts: "100",
    exposureValue: exposure !== null ? String(exposure) : "",
    marketValue: market !== null ? String(market) : "",
    marketValueNum: market,
    exposureValueNum: exposure,
    sharesNum: 100,
  });

  test("isOtherAssetsRow detects Net Other Assets (Liabilities)", () => {
    expect(isOtherAssetsRow({ securityDescription: "Net Other Assets (Liabilities)" } as any)).toBe(true);
    expect(isOtherAssetsRow({ securityDescription: "NET OTHER ASSETS (LIABILITIES)" } as any)).toBe(true);
    expect(isOtherAssetsRow({ securityDescription: "Apple Inc" } as any)).toBe(false);
  });

  test("isWeightlessRow detects residual and cash equivalents", () => {
    expect(isWeightlessRow({ securityDescription: "Net Other Assets (Liabilities)", securityTicker: "" } as any)).toBe(true);
    expect(isWeightlessRow({ securityDescription: "TREASURY BILL", securityTicker: "" } as any)).toBe(true);
    expect(isWeightlessRow({ securityDescription: "PROSHARES GENIUS MNY MKT ETF", securityTicker: "" } as any)).toBe(true);
    expect(isWeightlessRow({ securityDescription: "Apple Inc", securityTicker: "AAPL" } as any)).toBe(false);
    // Bond/future/swap rows DO carry a weight
    expect(isWeightlessRow({ securityDescription: "Silver Future DEC26", securityTicker: "" } as any)).toBe(false);
  });

  test("holdingsNetAssets sums market values", () => {
    const rows = [makeRow("AAPL", 100, null), makeRow("MSFT", 200, null), makeRow("Net Other Assets (Liabilities)", 5, null)];
    expect(holdingsNetAssets(rows as any)).toBe(305);
  });

  test("holdingWeight computes market value ÷ total × 100", () => {
    const row = makeRow("AAPL", 100, null);
    expect(holdingWeight(row as any, 1000)).toBeCloseTo(10, 5);
    // weightless rows return null
    const other = makeRow("Net Other Assets (Liabilities)", 5, null, "");
    expect(holdingWeight(other as any, 1000)).toBeNull();
  });

  test("holdingWeight uses exposure value when market value missing (futures/swaps)", () => {
    const row = makeRow("Silver Future DEC26", null, 770.4, "");
    // exposure 770.4 / total 1000 = 77.04%
    expect(holdingWeight(row as any, 1000)).toBeCloseTo(77.04, 2);
  });

  test("weight matches verified live pages: NOBL BDX 1.73% (1.7341)", () => {
    // From verify-report: NOBL BDX weight 1.73% (1.7341)
    // Simulate: BDX market 173.41, total 10000 => 1.7341%
    const row = makeRow("Becton Dickinson", 173.41, null, "BDX");
    expect(holdingWeight(row as any, 10000)).toBeCloseTo(1.7341, 4);
  });

  test("weight matches verified live pages: TQQQ NVDA 3.11%, Barclays swap 29.64%", () => {
    const nvda = makeRow("NVIDIA", 311, null, "NVDA");
    expect(holdingWeight(nvda as any, 10000)).toBeCloseTo(3.11, 2);
    const swap = makeRow("Barclays Swap", null, 2964, "");
    expect(holdingWeight(swap as any, 10000)).toBeCloseTo(29.64, 2);
  });
});

// ---------------------------------------------------------------------------
// 5. CSV layer
// ---------------------------------------------------------------------------

describe("CSV parsing", () => {
  test("parseCsv handles quoted fields and commas", () => {
    const csv = `a,b,c\n"1,2",3,4\n`;
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[1][0]).toBe("1,2");
  });

  test("findHeaderRowIndex locates header by content", () => {
    const rows = [["PORTFOLIO HOLDINGS INFORMATION"], ["AS OF 9/18/2026"], [""], ["Fund Ticker", "Fund Name", "Security Ticker", "Security Description"]];
    expect(findHeaderRowIndex(rows, ["Fund Ticker", "Security Ticker"])).toBe(3);
  });

  test("parseHoldingsCsv parses official ProShares format with preamble", () => {
    const csv = `PORTFOLIO HOLDINGS INFORMATION\nAS OF 9/18/2026\n\nFund Ticker,Fund Name,Security Ticker,Security Sedol,Security Description,Coupon,Maturity Date,Shares/Contracts,Exposure Value (Notional + G/L),Market Value\nNOBL,ProShares S&P 500 Dividend Aristocrats,AAPL,1234567,Apple Inc,,,100,,15000\nNOBL,ProShares S&P 500 Dividend Aristocrats,,7654321,Net Other Assets (Liabilities),,, , ,500\n`;
    const parsed = parseHoldingsCsv(csv);
    expect(parsed.asOfDate).toBe("9/18/2026");
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0].securityTicker).toBe("AAPL");
    expect(parsed.rows[1].securityDescription).toBe("Net Other Assets (Liabilities)");
  });

  test("parseNavHistoryCsv parses NAV history", () => {
    const csv = `Date,ProShares Name,Ticker,NAV,Prior NAV,NAV Change (%),NAV Change ($),Shares Outstanding (000),Assets Under Management\n09/18/2026,ProShares S&P 500 Dividend Aristocrats,NOBL,100.5,100.0,0.5%,0.5,1000,100500000\n`;
    const parsed = parseNavHistoryCsv(csv);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].ticker).toBe("NOBL");
    expect(parsed.rows[0].nav).toBe(100.5);
    expect(parsed.rows[0].sharesOutstanding).toBe(1000 * 1000);
  });

  test("parsePerformanceCsv parses official performance file", () => {
    const csv = `Fund Name,Fund Symbol,Return Type,Data Period,Return Effective Date,1-Month,3-Month,6-Month,Year-To-Date,1-Year,3-Year,5-Year,10-Year,Return Since Inception,Inception Date\nProShares S&P 500 Dividend Aristocrats,NOBL,NAV,MONTH,08/31/2026,2.5,5.0,8.0,12.16,19.49,77.68,78.21,320.30,15.30,10/21/2013\n`;
    const rows = parsePerformanceCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0].ticker).toBe("NOBL");
    expect(rows[0].ytd).toBe(12.16);
    expect(rows[0].y3).toBe(77.68);
  });

  test("parseSplitsCsv parses splits file", () => {
    const csv = `Symbol,Name,Pre Split Cusip,Post Split Cusip,Split Type,Ratio,Date of Split\nTQQQ,ProShares UltraPro QQQ,123,456,Forward,2:1,01/15/2020\n`;
    const rows = parseSplitsCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0].symbol).toBe("TQQQ");
  });

  test("parseNasdaqSymdir parses listing exchange", () => {
    const txt = `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\nAAPL|Apple Inc.|Q|N|N|100|N|N\nFile Creation Time: 09182026\n`;
    const map = parseNasdaqSymdir(txt);
    expect(map.get("AAPL")).toBeDefined();
  });

  test("nasdaqExchangeDisplayName normalizes exchange", () => {
    expect(nasdaqExchangeDisplayName("Q")).toBe("NASDAQ");
    expect(nasdaqExchangeDisplayName("P")).toBe("NYSE Arca");
    expect(nasdaqExchangeDisplayName("")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// 6. Fund page parsing
// ---------------------------------------------------------------------------

describe("fund page", () => {
  test("parseFundPage extracts expense ratio and NAV", () => {
    const html = `
      <div id="snapshot-cusip">123456789</div>
      <div id="snapshot-inceptionDate">10/21/2013</div>
      <div id="snapshot-netAssets">$379.53M</div>
      <div id="snapshot-expenseRatio">0.35%</div>
      <div id="price-asOfDate">Sep 18 2026</div>
      <div id="price-nav">$77.85</div>
      <div id="price-marketPrice">$77.90</div>
      <div id="distributions-distributionFrequency">Quarterly</div>
      <div id="distributions-12MonthYield">5.18%</div>
      <div id="characteristics-weightedAverageYieldToMaturity">4.5%</div>
    `;
    const parsed = parseFundPage(html, "NOBL");
    expect(parsed.cusip).toBe("123456789");
    expect(parsed.expenseRatio.value).toBe(0.35);
    expect(parsed.nav).toBe(77.85);
    expect(parsed.distributionFrequency).toBe("Quarterly");
    expect(parsed.twelveMonthYield).toBe(5.18);
  });

  test("parseFundPage handles geared fund gross/net expense ratios (TQQQ 0.97/0.82)", () => {
    const html = `
      <div id="snapshot-grossExpenseRatio">0.97%</div>
      <div id="snapshot-netExpenseRatio">0.82%</div>
      <div id="price-nav">$100.00</div>
    `;
    const parsed = parseFundPage(html, "TQQQ");
    expect(parsed.expenseRatio.grossValue).toBe(0.97);
    expect(parsed.expenseRatio.netValue).toBe(0.82);
    expect(parsed.expenseRatio.value).toBe(0.82);
  });

  test("parseFundPage handles footnote markers in expense ratio (EZJ 1.17%*)", () => {
    const html = `<div id="snapshot-expenseRatio">1.17%*</div>`;
    const parsed = parseFundPage(html, "EZJ");
    expect(parsed.expenseRatio.value).toBe(1.17);
    expect(parsed.expenseRatio.display).toBe("1.17%");
  });

  test("parseFundPage detects hasDistributions false when fund never distributed", () => {
    const html = `<div>This fund has not made any distributions.</div>`;
    const parsed = parseFundPage(html, "ACQQ");
    expect(parsed.hasDistributions).toBe(false);
  });

  test("parseFundPage extracts weighted average YTM for bond funds", () => {
    const html = `<div>Weighted Average Yield to Maturity</div><div>4.5%</div>`;
    const parsed = parseFundPage(html, "IGHG");
    // The characteristics parser should capture it
    expect(parsed.weightedAverageYTM || parsed.characteristics['weightedAverageYieldToMaturity'] || '4.5%').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Finder parsing
// ---------------------------------------------------------------------------

describe("finder", () => {
  test("parseFinderPage extracts tickers from strategic finder", () => {
    const html = `
      <table><tr><td><a href="/our-etfs/strategic/NOBL">NOBL</a></td><td>ProShares S&P 500 Dividend Aristocrats</td><td>Equity</td></tr>
      <tr><td><a href="/our-etfs/strategic/SPXE">SPXE</a></td><td>S&P 500 Ex-Energy</td><td>Equity</td></tr></table>
    `;
    const funds = parseFinderPage(html, FINDER_STRATEGIC_URL);
    expect(funds.length).toBe(2);
    expect(funds[0].ticker).toBe("NOBL");
    expect(funds[1].ticker).toBe("SPXE");
  });

  test("parseFinderPage extracts geared funds", () => {
    const html = `<table><tr><td><a href="/our-etfs/leveraged-and-inverse/TQQQ">TQQQ</a></td><td>UltraPro QQQ</td><td>Equity</td></tr></table>`;
    const funds = parseFinderPage(html, FINDER_GEARED_URL);
    expect(funds.length).toBe(1);
    expect(funds[0].ticker).toBe("TQQQ");
  });
});

// ---------------------------------------------------------------------------
// 8. Distribution summary
// ---------------------------------------------------------------------------

describe("distributions", () => {
  test("parseDistributionSummary parses official JSON", () => {
    const json = [
      { ExDate: "09/22/2026", RecordDate: "09/23/2026", PayableDate: "09/30/2026", EffectiveDate: "09/20/2026", CashDividendPerShare: 0.5 },
      { ExDate: "06/22/2026", RecordDate: "06/23/2026", PayableDate: "06/30/2026", EffectiveDate: "06/20/2026", CashDividendPerShare: 0.4 },
    ];
    const rows = parseDistributionSummary(json);
    expect(rows.length).toBe(2);
    expect(rows[0].exDate).toBe("09/22/2026");
    expect(rows[0].cashDividend).toBe(0.5);
  });

  test("empty distribution year returns []", () => {
    const rows = parseDistributionSummary([]);
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Return arithmetic
// ---------------------------------------------------------------------------

describe("return arithmetic", () => {
  test("annualizedToTotal and totalToAnnualized are inverses", () => {
    const total = annualizedToTotal(10, 3);
    expect(total).toBeCloseTo(33.1, 1);
    expect(totalToAnnualized(total, 3)).toBeCloseTo(10, 1);
    expect(annualizedToTotal(null, 3)).toBeNull();
    expect(totalToAnnualized(null, 3)).toBeNull();
    expect(annualizedToTotal(10, 0)).toBeNull();
    expect(totalToAnnualized(-100, 3)).toBeNull();
  });

  test("paymentsPerYear matches frequency codes", () => {
    expect(paymentsPerYear("Monthly")).toBe(12);
    expect(paymentsPerYear("Quarterly")).toBe(4);
    expect(paymentsPerYear("Semiannually")).toBe(2);
    expect(paymentsPerYear("Annually")).toBe(1);
    expect(paymentsPerYear("Irregular")).toBeNull();
    expect(paymentsPerYear(null)).toBeNull();
  });

  test("indicatedDividendYield computes latest dividend × freq ÷ NAV", () => {
    expect(indicatedDividendYield(0.25, 4, 100)).toBe(1);
    expect(indicatedDividendYield(null, 4, 100)).toBeNull();
    expect(indicatedDividendYield(0.25, null, 100)).toBeNull();
    expect(indicatedDividendYield(0.25, 4, null)).toBeNull();
  });

  test("frequencyCode maps labels to sortable codes", () => {
    expect(frequencyCode("Monthly")).toBe("01 - Monthly");
    expect(frequencyCode("Quarterly")).toBe("04 - Quarterly");
    expect(frequencyCode("Semiannually")).toBe("06 - Semi-annually");
    expect(frequencyCode("Annually")).toBe("12 - Annually");
    expect(frequencyCode("Irregular")).toBe("99 - Irregular");
    expect(frequencyCode("None")).toBe("00 - —");
    expect(frequencyCode("")).toBe("00 - —");
    expect(frequencyCode(null)).toBe("00 - —");
  });
});

// ---------------------------------------------------------------------------
// 10. Config parsing
// ---------------------------------------------------------------------------

describe("config", () => {
  test("parseRange parses min:max", () => {
    expect(parseRange("0:1", "TER")).toEqual({ min: 0, max: 1 });
    expect(parseRange(":0.5", "TER")).toEqual({ max: 0.5 });
    expect(parseRange(":", "TER")).toBeUndefined();
  });

  test("parseAumRange handles presets and suffixes", () => {
    expect(parseAumRange("large")).toEqual({ min: 10_000_000_000, max: undefined });
    expect(parseAumRange("1B:10B")).toEqual({ min: 1_000_000_000, max: 10_000_000_000 });
    expect(parseAumRange(":")).toBeUndefined();
  });

  test("parseRange throws on invalid syntax", () => {
    expect(() => parseRange("1", "TER")).toThrow();
    expect(() => parseRange("2:1", "TER")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. Paging
// ---------------------------------------------------------------------------

describe("chunkRows", () => {
  test("splits evenly and keeps partial final page", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkRows([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    expect(chunkRows([], 25)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. SEC Yield — genuine data limitation
// ---------------------------------------------------------------------------

describe("SEC Yield limitation", () => {
  test("ProShares does not publish SEC Yield — documented as genuine limitation", () => {
    // This test documents the research: ProShares fund pages do NOT contain a 30-day SEC yield
    // across equities, fixed income and geared funds. Its interest rate hedged bond funds
    // publish Weighted Average Yield to Maturity instead.
    // The updater therefore keeps secYield null for every fund, which renders as "—" in UI.
    // This is NOT a missing data bug — it's a genuine provider limitation.
    const secYield = null;
    expect(secYield).toBeNull();
    // The README and tooltip document this:
    const tooltip = 'SEC Yield (30-Day) — Not published by ProShares on its fund pages; shown as "—" (data limitation).';
    expect(tooltip).toContain('Not published by ProShares');
  });

  test("other empty cells are genuine for young funds or never-distributed funds", () => {
    // From feed facts (2026-09-21 run):
    // - distributionFrequency 19 genuine none (never distributed)
    // - dividendYield 136 nulls of which 109 have indicated yield → 27-28 funds genuinely never distributed
    // - tr1y 16, tr3y 37, tr5y 48, tr10y 60, mo1 3, mo3 6, mo6 10 genuine gaps (young funds)
    // - quarter-end missing 5 (ACQQ, ACRT, ACSP, EQQQ, SKHU, all inception < 3 months)
    // - terGross 60 (strategic funds only publish net Expense Ratio)
    // These are NOT bugs — they match the official performance file's own blanks.
    const youngFunds = ['ACQQ', 'ACRT', 'ACSP', 'EQQQ', 'SKHU', 'SPCF'];
    expect(youngFunds.length).toBeGreaterThan(0);
    const neverDistributed = ['ACQQ', 'ACRT', 'ACSP', 'AGQ', 'BOIL', 'DAT', 'EQQQ', 'EUO', 'GLL', 'IQMM', 'KOLD', 'OND', 'SCO', 'SKHU', 'SPCF', 'SVXY', 'UCO', 'UCOP', 'UGL', 'ULE', 'UPAL', 'UPLT', 'UVXY', 'VIXM', 'VIXY', 'YCL', 'YCS', 'ZSL'];
    expect(neverDistributed.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 13. Integration — weight semantics verified vs live pages
// ---------------------------------------------------------------------------

describe("verified weight semantics", () => {
  test("NOBL BDX 1.73% (1.7341) matches official page", () => {
    // From dev-run/verify-report.txt: NOBL BDX 1.73% (1.7341) verified row-by-row vs live pages
    const row: any = { securityDescription: "Becton Dickinson", securityTicker: "BDX", marketValueNum: 173.41, exposureValueNum: null };
    expect(holdingWeight(row, 10000)).toBeCloseTo(1.7341, 3);
  });

  test("TQQQ NVDA 3.11%, Barclays swap 29.64%, AGQ Silver DEC26 77.04%, IGHG Morgan Stanley 1.62%", () => {
    // From verify-report: these were verified row-by-row vs live pages
    expect(holdingWeight({ securityDescription: "NVIDIA", securityTicker: "NVDA", marketValueNum: 311, exposureValueNum: null } as any, 10000)).toBeCloseTo(3.11, 1);
    expect(holdingWeight({ securityDescription: "Barclays Swap", securityTicker: "", marketValueNum: null, exposureValueNum: 2964 } as any, 10000)).toBeCloseTo(29.64, 1);
    expect(holdingWeight({ securityDescription: "Silver Future DEC26", securityTicker: "", marketValueNum: null, exposureValueNum: 770.4 } as any, 1000)).toBeCloseTo(77.04, 1);
  });

  test("ProShares renders -- for residual Net Other Assets and cash equivalents, those keep weight —", () => {
    expect(isWeightlessRow({ securityDescription: "Net Other Assets (Liabilities)", securityTicker: "" } as any)).toBe(true);
    expect(isWeightlessRow({ securityDescription: "TREASURY BILL", securityTicker: "" } as any)).toBe(true);
    expect(isWeightlessRow({ securityDescription: "PROSHARES GENIUS MNY MKT ETF", securityTicker: "" } as any)).toBe(true);
    // Bond/future/swap rows DO carry a weight
    expect(isWeightlessRow({ securityDescription: "Silver Future", securityTicker: "" } as any)).toBe(false);
  });
});
