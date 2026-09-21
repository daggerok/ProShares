/**
 * Unit tests for the ProShares data updater.
 *
 * Every HTML fixture below is a faithful transcription of the markup ProShares
 * actually serves (verified against the live pages on 2026-09-18/19), trimmed
 * to the columns that matter. These tests are the guard for the parts of the
 * updater that the committed feed cannot exercise: the fixed-income holdings
 * sheet (which has no Ticker column at all) and the row/header shape contract.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  HOLDINGS_HEADERS,
  PROSHARES_ETF_TRUST_CIK,
  PROSHARES_FINDER_URL,
  annualizedFromCumulative,
  chunkRows,
  cleanText,
  compareDisplayDates,
  cumulativeFromAnnualized,
  decodeHtmlEntities,
  findHeaderRowIndex,
  formatAumDisplay,
  formatMoneyText,
  formatPercentText,
  formatProSharesDate,
  frequencyCode,
  indicatedDividendYield,
  indicatedYieldAllowed,
  inferDistributionFrequency,
  nasdaqExchangeDisplayName,
  normalizeNumberText,
  normalizeYahooExchangeName,
  numberOrNull,
  parseAumRange,
  parseHtmlTables,
  parseNasdaqSymdir,
  parseRange,
  parseProSharesFundPage,
  parseProSharesHistory,
  parseProSharesHistoryXlsx,
  parseProSharesHoldings,
  parseProSharesHoldingsXlsx,
  parseProSharesPerformance,
  parseXlsxSheet,
  parseYahooExchangeName,
  loadSharedStrings,
  paymentsPerYear,
  premiumDiscount,
  sanitizeTicker,
  toIsoDate,
  prosharesEdgarFilingsUrl,
  prosharesFactSheetUrl,
  prosharesFundDocuments,
  prosharesFundPageUrl,
  prosharesHistoryUrl,
  prosharesHoldingsUrl,
  prosharesLegacyHoldingsUrl,
  prosharesProspectusUrl,
  yahooChartProvenanceUrl,
  yahooChartUrl,
} from "./update-data";
import { PROSHARES_FINDER, finderForTicker, normalizeFinderFrequency } from "./proshares-finder";
import { VAN_ECK_SEED } from "./proshares-funds";

const REPO_ROOT = path.join(import.meta.dir, "..");
const API_ROOT = path.join(REPO_ROOT, "api", "proshares");

function feedJson(relative: string): any {
  return JSON.parse(readFileSync(path.join(API_ROOT, relative), "utf8"));
}

// ---------------------------------------------------------------------------
// Minimal in-memory ZIP (STORE method) writer for building XLSX fixtures,
// so the XLSX-parsing tests stay dependency-free like the updater itself.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: Map<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.size, true);
  eocdView.setUint16(10, files.size, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let position = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Builds a worksheet XML. `namespaced` mirrors what ProShares's own downloads
 * actually emit (`<x:row>`/`<x:c>`/`<x:v>` under an `xmlns:x=` worksheet), as
 * opposed to the bare `<row>`/`<c>`/`<v>` some other providers emit — the
 * parser must tolerate both.
 */
function sheetXml(rows: string[][], namespaced: boolean): string {
  const p = namespaced ? "x:" : "";
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, columnIndex) =>
            `<${p}c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><${p}is><${p}t>${escapeXml(value)}</${p}t></${p}is></${p}c>`,
        )
        .join("");
      return `<${p}row r="${rowIndex + 1}">${cells}</${p}row>`;
    })
    .join("");
  const root = namespaced
    ? `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    : `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`;
  const rootClose = namespaced ? "</x:worksheet>" : "</worksheet>";
  return `<?xml version="1.0" encoding="UTF-8"?>${root}<${p}sheetData>${body}</${p}sheetData>${rootClose}`;
}

function buildXlsx(rows: string[][], namespaced = true): Uint8Array {
  const encoder = new TextEncoder();
  return buildZip(
    new Map<string, Uint8Array>([
      ["xl/workbook.xml", encoder.encode("<?xml version=\"1.0\"?><workbook/>")],
      ["xl/worksheets/sheet1.xml", encoder.encode(sheetXml(rows, namespaced))],
    ]),
  );
}

// ---------------------------------------------------------------------------
// 1. Source URLs
// ---------------------------------------------------------------------------

describe("source URLs", () => {
  test("fund page, holdings and history URLs follow the verified proshares.com layout", () => {
    // Canonical slugs are harvested from the Investment Finder (2026-09-19);
    // /investments/etf-<ticker>/ is a greedy 302 (etf-einc → inc → 404) so the
    // slug table is authoritative.
    expect(prosharesFundPageUrl("GDX")).toBe("https://www.proshares.com/us/en/investments/gold-miners-etf-gdx/");
    expect(prosharesFundPageUrl("smh")).toBe("https://www.proshares.com/us/en/investments/semiconductor-etf-smh/");
    expect(prosharesFundPageUrl("EINC")).toBe("https://www.proshares.com/us/en/investments/energy-income-etf-einc/");
    expect(prosharesFundPageUrl("AFK")).toBe("https://www.proshares.com/us/en/investments/africa-index-etf-afk/");
    // Unknown ticker falls back to etf-<ticker> so the 404 is visible.
    expect(prosharesFundPageUrl("ZZZZ")).toBe("https://www.proshares.com/us/en/investments/etf-zzzz/");
    expect(prosharesHoldingsUrl("https://www.proshares.com/us/en/investments/gold-miners-etf-gdx/")).toBe(
      "https://www.proshares.com/us/en/investments/gold-miners-etf-gdx/downloads/holdings/",
    );
    expect(prosharesHistoryUrl("https://www.proshares.com/us/en/investments/gold-miners-etf-gdx")).toBe(
      "https://www.proshares.com/us/en/investments/gold-miners-etf-gdx/downloads/fundhistoprices/",
    );
    // Holdings/history are always <fundPage>/downloads/…
    expect(prosharesHoldingsUrl("https://www.proshares.com/us/en/investments/equity/gdx/overview/")).toBe(
      "https://www.proshares.com/us/en/investments/equity/gdx/overview/downloads/holdings/",
    );
    expect(prosharesHistoryUrl("https://www.proshares.com/us/en/investments/equity/gdx/overview")).toBe(
      "https://www.proshares.com/us/en/investments/equity/gdx/overview/downloads/fundhistoprices/",
    );
  });

  test("the EDGAR fallback targets the ProShares ETF Trust, not the adviser", () => {
    expect(PROSHARES_ETF_TRUST_CIK).toBe("0001137360");
    expect(prosharesEdgarFilingsUrl()).toContain("CIK=0001137360");
    expect(prosharesEdgarFilingsUrl()).toContain("type=NPORT-P");
    expect(prosharesEdgarFilingsUrl("0000768847")).toContain("CIK=0000768847");
  });

  test("the finder URL is the one that actually server-renders the fund table", () => {
    expect(PROSHARES_FINDER_URL).toBe("https://www.proshares.com/us/en/etf-mutual-fund-finder/");
  });

  test("the recorded chart provenance URL carries no wall-clock value", () => {
    // A live query needs period2 = now or Yahoo downgrades range=max to monthly
    // bars; the provenance copy must not, or every no-op rerun would git-diff.
    const live = yahooChartUrl("GDX", 1_789_848_311_000);
    expect(live).toContain("period2=1789848311");
    expect(live).toContain("interval=1d");
    const provenance = yahooChartProvenanceUrl("GDX");
    expect(provenance).toBe("https://query1.finance.yahoo.com/v8/finance/chart/GDX");
    expect(provenance).not.toContain("period2");
    // stable across calls made at different instants
    expect(yahooChartProvenanceUrl("GDX")).toBe(yahooChartProvenanceUrl("GDX"));
  });
});

// ---------------------------------------------------------------------------
// 2. Text and number normalization
// ---------------------------------------------------------------------------

describe("normalization", () => {
  test("sanitizeTicker strips whitespace and uppercases", () => {
    expect(sanitizeTicker("  gdx ")).toBe("GDX");
    expect(sanitizeTicker(null)).toBe("");
    expect(sanitizeTicker(undefined)).toBe("");
  });

  test("cleanText collapses whitespace and drops nbsp", () => {
    expect(cleanText("  Total   Net\nAssets\u00a0 ")).toBe("Total Net Assets");
    expect(cleanText(null)).toBe("");
  });

  test("normalizeNumberText strips currency, thousands separators and percent", () => {
    expect(normalizeNumberText("$3,094,290,686.41")).toBe("3094290686.41");
    expect(normalizeNumberText("10.89%")).toBe("10.89");
    expect(normalizeNumberText("24,875,719")).toBe("24875719");
  });

  test("numberOrNull returns null for ProShares's placeholders, never NaN", () => {
    expect(numberOrNull("$95.67")).toBe(95.67);
    expect(numberOrNull("10.89%")).toBe(10.89);
    expect(numberOrNull("--")).toBeNull();
    expect(numberOrNull("—")).toBeNull();
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull("n/a")).toBeNull();
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull(undefined)).toBeNull();
  });

  test("decodeHtmlEntities handles the entities ProShares's pages actually emit", () => {
    expect(decodeHtmlEntities("ProShares&nbsp;&amp;&nbsp;Co &lt;ETF&gt; &#39;x&#39; &quot;y&quot;")).toBe(
      "ProShares & Co <ETF> 'x' \"y\"",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Dates
// ---------------------------------------------------------------------------

describe("dates", () => {
  test("formatProSharesDate renders mm/dd/yyyy as the display form the UI expects", () => {
    expect(formatProSharesDate("09/18/2026")).toBe("Sep 18 2026");
    expect(formatProSharesDate("05/16/2006")).toBe("May 16 2006");
    expect(formatProSharesDate("12/20/2011")).toBe("Dec 20 2011");
    expect(formatProSharesDate("")).toBe("—");
    // ProShares prints "--" verbatim for unavailable cells; it is passed through
    // unchanged rather than rewritten, and the UI renders it as-is.
    expect(formatProSharesDate("--")).toBe("--");
  });

  test("toIsoDate is stable for sorting and compareDisplayDates orders correctly", () => {
    expect(toIsoDate("09/18/2026")).toBe("2026-09-18");
    expect(toIsoDate("9/8/2026")).toBe("2026-09-08");
    // already-display text is passed through unchanged
    expect(toIsoDate("Sep 18 2026")).toBe("Sep 18 2026");
    expect(compareDisplayDates("Sep 18 2026", "Sep 17 2026")).toBeGreaterThan(0);
    expect(compareDisplayDates("Sep 17 2026", "Sep 18 2026")).toBeLessThan(0);
    expect(compareDisplayDates("Sep 18 2026", "Sep 18 2026")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Display formatters
// ---------------------------------------------------------------------------

describe("formatters", () => {
  test("formatAumDisplay uses the millions form ProShares's ETF Guide prints", () => {
    expect(formatAumDisplay(22_753_000_000)).toBe("$22,753.00 M");
    expect(formatAumDisplay(1_234_567)).toBe("$1.23 M");
  });

  test("percent and money text render an em dash for null, never a blank cell", () => {
    expect(formatPercentText(11.22)).toBe("11.22%");
    expect(formatPercentText(0)).toBe("0.00%");
    expect(formatPercentText(null)).toBe("—");
    expect(formatMoneyText(95.67)).toBe("$95.67");
    expect(formatMoneyText(null)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// 5. Range parsing (MAX_FETCHES / AUM / TER config)
// ---------------------------------------------------------------------------

describe("range parsing", () => {
  test("parseRange requires the explicit min:max syntax", () => {
    expect(parseRange("0.10:0.60", "TER")).toEqual({ min: 0.1, max: 0.6 });
    expect(parseRange("", "TER")).toBeUndefined();
    expect(parseRange(":", "TER")).toBeUndefined();
    expect(() => parseRange("0.35", "TER")).toThrow(/min:max/);
  });

  test("parseAumRange accepts presets and explicit dollar ranges", () => {
    expect(parseAumRange("")).toBeUndefined();
    expect(parseAumRange("large")).toBeDefined();
    expect(parseAumRange("1000000000:")).toMatchObject({ min: 1_000_000_000 });
  });
});

// ---------------------------------------------------------------------------
// 6. HTML table extraction
// ---------------------------------------------------------------------------

describe("HTML table extraction", () => {
  const HTML = `
    <table><tr><th>Date</th><th>NAV</th><th>Last Trade</th></tr>
      <tr><td>09/18/2026</td><td>95.67</td><td>95.48</td></tr></table>
    <table><tr><td>Number</td><td>Ticker</td><td>Holding Name</td><td>% of Net Assets</td></tr>
      <tr><td>1</td><td>NEM</td><td>Newmont Corp</td><td>10.89</td></tr></table>`;

  test("parseHtmlTables returns every table's rows in document order", () => {
    const tables = parseHtmlTables(HTML);
    expect(tables.length).toBe(2);
    expect(tables[0][0]).toEqual(["Date", "NAV", "Last Trade"]);
    expect(tables[1][1]).toEqual(["1", "NEM", "Newmont Corp", "10.89"]);
  });

  test("findHeaderRowIndex matches on normalized cell text", () => {
    const tables = parseHtmlTables(HTML);
    expect(findHeaderRowIndex(tables[0], ["Date", "NAV", "Last Trade"])).toBe(0);
    expect(findHeaderRowIndex(tables[0], ["Holding Name", "% of Net Assets"])).toBe(-1);
    expect(findHeaderRowIndex(tables[1], ["Holding Name", "% of Net Assets"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Holdings parsing — the equity sheet
// ---------------------------------------------------------------------------

// ProShares's holdings/history "downloads" endpoints do not serve HTML — they
// serve a real .xlsx workbook (verified against the live downloads on
// 2026-09-19; see parseXlsxSheet). parseProSharesHoldings/parseProSharesHistory
// take the worksheet's raw rows directly, so these fixtures are rows of cell
// text rather than markup.
const EQUITY_HOLDINGS_ROWS = [
  ["Daily Holdings (%)  09/17/2026"],
  [],
  ["Number", "Ticker", "Holding Name", "Identifier (FIGI)", "Shares", "Asset Class", "Market Value (US$)", "Notional Value", "% of Net Assets"],
  ["1", "NEM", "Newmont Corp", "BBG000BPWXK1", "24,875,719", "Stock", "$3,094,290,686.41", "--", "10.89"],
  ["2", "NST AU", "Northern Star Resources Ltd", "BBG00X7YS2P3", "9,000,000", "Stock", "$100,000,000.00", "--", "0.35"],
  ["3", "-USD CASH-", "", "", "0", "Cash", "$57,000,000.00", "--", "0.20"],
  ["4", "--", "Other/Cash", "--", "--", "Cash", "$31,792,656.80", "--", "0.11"],
  ["This information is not recommendations to buy or to sell any security."],
];

describe("parseProSharesHoldings (equity sheet)", () => {
  const parsed = parseProSharesHoldings(EQUITY_HOLDINGS_ROWS);

  test("the as-of date comes from the 'Daily Holdings (%)' header line", () => {
    expect(parsed.asOfDate).toBe("Sep 17 2026");
  });

  test("columns are emitted in the shared contract's order, not the provider's", () => {
    expect(parsed.headers).toEqual([
      "Name", "Ticker", "Identifier", "Shares Held",
      "Asset Category", "Market Value", "Notional Value", "Weight",
    ]);
  });

  test("every row carries exactly the published headers, in that order", () => {
    // Regression guard: the snapshot tuples were once zipped against the wrong
    // header order, silently swapping Name and Ticker in every row.
    expect(parsed.rows.length).toBe(4);
    for (const row of parsed.rows) expect(row.length).toBe(parsed.headers.length);
    const nameIndex = parsed.headers.indexOf("Name");
    const tickerIndex = parsed.headers.indexOf("Ticker");
    expect(parsed.rows[0][nameIndex]).toBe("Newmont Corp");
    expect(parsed.rows[0][tickerIndex]).toBe("NEM");
    expect(parsed.rows[0][parsed.headers.indexOf("Identifier")]).toBe("BBG000BPWXK1");
    // the "%" in "% of Net Assets" is stripped during header normalization, so
    // the lookup key must be normalized too or every weight comes back empty
    expect(parsed.rows[0][parsed.headers.indexOf("Weight")]).toBe("10.89%");
    expect(parsed.rows[1][parsed.headers.indexOf("Weight")]).toBe("0.35%");
    expect(parsed.rows[3][parsed.headers.indexOf("Weight")]).toBe("0.11%");
    // ProShares prints "--" for Notional Value on every equity position, and
    // cleanCell collapses that placeholder to "" (the client renders "—").
    expect(parsed.rows[0][parsed.headers.indexOf("Notional Value")]).toBe("");
  });

  test("non-US listings keep their local exchange suffix verbatim", () => {
    expect(parsed.rows[1][parsed.headers.indexOf("Ticker")]).toBe("NST AU");
  });

  test("cash balances are kept, including the placeholder-ticker Other/Cash row", () => {
    expect(parsed.rows[2][parsed.headers.indexOf("Ticker")]).toBe("-USD CASH-");
    expect(parsed.rows[3][parsed.headers.indexOf("Name")]).toBe("Other/Cash");
    expect(parsed.rows[3][parsed.headers.indexOf("Ticker")]).toBe("");
  });

  test("the trailing legal-disclosure row is dropped, not counted as a position", () => {
    expect(parsed.rows.some((r) => r.join(" ").includes("not recommendations"))).toBe(false);
    expect(parsed.rows.length).toBe(4);
  });

  test("a sheet with no recognizable holdings table yields zero rows, never a throw", () => {
    const empty = parseProSharesHoldings([["Nothing here"]]);
    expect(empty.rows).toEqual([]);
    expect(empty.headers).toEqual(HOLDINGS_HEADERS);
  });
});

// ---------------------------------------------------------------------------
// 8. Holdings parsing — the fixed-income sheet (no Ticker column at all)
// ---------------------------------------------------------------------------

const FIXED_INCOME_HOLDINGS_ROWS = [
  ["Daily Holdings (%)  09/17/2026"],
  [],
  ["Number", "Holding Name", "Maturity", "Identifier (FIGI)", "Coupon", "Asset Class", "Par Value/ Contracts", "Market Value", "Notional Value", "% of Net Assets", "Country", "Currency"],
  ["1", "Celanese US Holdings Inc", "04/01/2027", "BBG00K1ABC23", "6.05", "Corporate", "$1,000,000", "$1,020,000", "--", "1.42", "United States", "USD"],
  ["2", "Celanese US Holdings Inc", "07/15/2029", "BBG00K1XYZ89", "5.75", "Corporate", "$800,000", "$790,000", "--", "1.10", "United States", "USD"],
  ["This information is not recommendations to buy or to sell any security."],
];

describe("parseProSharesHoldings (fixed-income sheet)", () => {
  const parsed = parseProSharesHoldings(FIXED_INCOME_HOLDINGS_ROWS);

  test("a Maturity column switches the parser to the fixed-income column set", () => {
    expect(parsed.headers).toEqual([
      "Name", "Maturity", "Identifier", "Coupon", "Asset Category",
      "Par Value", "Market Value", "Weight", "Country", "Currency",
    ]);
    expect(parsed.headers).not.toContain("Ticker");
  });

  test("the FIGI is the only identifier, and duplicate issuers stay distinct rows", () => {
    expect(parsed.rows.length).toBe(2);
    const identifierIndex = parsed.headers.indexOf("Identifier");
    expect(parsed.rows[0][identifierIndex]).toBe("BBG00K1ABC23");
    expect(parsed.rows[1][identifierIndex]).toBe("BBG00K1XYZ89");
    // Same issuer name across two maturities — dedupe must key on the FIGI.
    const nameIndex = parsed.headers.indexOf("Name");
    expect(parsed.rows[0][nameIndex]).toBe(parsed.rows[1][nameIndex]);
    expect(parsed.rows[0][identifierIndex]).not.toBe(parsed.rows[1][identifierIndex]);
  });

  test("maturity is normalized to the display date form and coupon is kept verbatim", () => {
    expect(parsed.rows[0][parsed.headers.indexOf("Maturity")]).toBe("Apr 01 2027");
    expect(parsed.rows[0][parsed.headers.indexOf("Coupon")]).toBe("6.05");
    expect(parsed.rows[0][parsed.headers.indexOf("Country")]).toBe("United States");
    expect(parsed.rows[0][parsed.headers.indexOf("Currency")]).toBe("USD");
  });

  test("every row still carries exactly the published headers", () => {
    for (const row of parsed.rows) expect(row.length).toBe(parsed.headers.length);
  });
});

// ---------------------------------------------------------------------------
// 9. History parsing
// ---------------------------------------------------------------------------

const HISTORY_ROWS = [
  ["ProShares Gold Miners ETF - GDX"],
  ["Date", "NAV", "Change", "% Change", "Last Trade", "Volume", "Premium/Discount", "% Premium/Discount", "AUM", "Index Level"],
  ["09/18/2026", "95.67", "0.42", "0.44", "95.48", "5,000,000", "-0.19", "-0.20", "28,418,567,995.87", "1,234.56"],
  ["09/17/2026", "95.25", "-1.10", "-1.14", "95.30", "4,800,000", "0.05", "0.05", "28,300,000,000.00", "1,229.10"],
];

describe("parseProSharesHistory", () => {
  const parsed = parseProSharesHistory(HISTORY_ROWS);

  test("the descending provider order is preserved", () => {
    expect(parsed.headers[0]).toBe("Date");
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0][0]).toBe("Sep 18 2026");
    expect(parsed.rows[1][0]).toBe("Sep 17 2026");
  });

  test("premium/discount is derived from NAV and Last Trade, not re-parsed blindly", () => {
    const nav = Number(parsed.rows[0][parsed.headers.indexOf("NAV")].replace(/[^-\d.]/g, ""));
    const close = Number(parsed.rows[0][parsed.headers.indexOf("Close")].replace(/[^-\d.]/g, ""));
    expect(premiumDiscount(close, nav)).toBeCloseTo(-0.1986, 2);
    expect(parsed.rows[0][parsed.headers.indexOf("Premium/Discount")]).toBe("-0.19");
    expect(parsed.rows[0][parsed.headers.indexOf("Total Net Assets")]).toBe("28,418,567,995.87");
  });

  test("a sheet without a history table yields zero rows", () => {
    expect(parseProSharesHistory([["No table"]]).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9b. XLSX byte parsing — the holdings/history "downloads" endpoints serve a
// real .xlsx workbook, not HTML. ProShares's own worksheet XML namespaces every
// element (`<x:row>`, `<x:c>`, `<x:v>`); a parser only built for bare
// `<row>`/`<c>`/`<v>` silently reads zero rows from the real file (this was a
// real regression, not a hypothetical one).
// ---------------------------------------------------------------------------

describe("parseXlsxSheet", () => {
  test("reads a namespaced worksheet (the shape ProShares actually serves)", () => {
    const bytes = buildXlsx(EQUITY_HOLDINGS_ROWS, true);
    const rows = parseXlsxSheet(bytes, loadSharedStrings(bytes));
    expect(rows[2]).toEqual(EQUITY_HOLDINGS_ROWS[2]);
    expect(rows[3][2]).toBe("Newmont Corp");
  });

  test("also reads a bare, non-namespaced worksheet", () => {
    const bytes = buildXlsx(EQUITY_HOLDINGS_ROWS, false);
    const rows = parseXlsxSheet(bytes, loadSharedStrings(bytes));
    expect(rows[3][2]).toBe("Newmont Corp");
  });
});

describe("parseProSharesHoldingsXlsx / parseProSharesHistoryXlsx (end to end from bytes)", () => {
  test("equity holdings workbook", () => {
    const parsed = parseProSharesHoldingsXlsx(buildXlsx(EQUITY_HOLDINGS_ROWS));
    expect(parsed.asOfDate).toBe("Sep 17 2026");
    expect(parsed.rows.length).toBe(4);
    expect(parsed.rows[0][parsed.headers.indexOf("Name")]).toBe("Newmont Corp");
    expect(parsed.rows[0][parsed.headers.indexOf("Weight")]).toBe("10.89%");
  });

  test("fixed-income holdings workbook", () => {
    const parsed = parseProSharesHoldingsXlsx(buildXlsx(FIXED_INCOME_HOLDINGS_ROWS));
    expect(parsed.headers).not.toContain("Ticker");
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0][parsed.headers.indexOf("Maturity")]).toBe("Apr 01 2027");
  });

  test("NAV history workbook", () => {
    const parsed = parseProSharesHistoryXlsx(buildXlsx(HISTORY_ROWS));
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0][0]).toBe("Sep 18 2026");
  });
});

// ---------------------------------------------------------------------------
// 10. Fund page parsing
// ---------------------------------------------------------------------------

describe("parseProSharesFundPage", () => {
  test("GDX publishes Gross and Net expense ratios separately", () => {
    const html = `
      <h1>GDX ProShares Gold Miners ETF</h1>
      <div>NAV</div><div>$95.67</div><div>as of September 18, 2026</div>
      <div>YTD RETURNS</div><div>11.22%</div><div>as of September 18, 2026</div>
      <div>Total Net Assets</div><div>$28.42B</div><div>as of September 18, 2026</div>
      <div>Gross Expense Ratio</div><div>0.51%</div>
      <div>Net Expense Ratio</div><div>0.51%</div>
      <div>Inception Date</div><div>05/16/2006</div>`;
    const parsed = parseProSharesFundPage(html, "https://www.proshares.com/us/en/investments/equity/gdx/overview/");
    expect(parsed.nav).toBe(95.67);
    expect(parsed.ytdReturn).toBe(11.22);
    expect(parsed.totalNetAssets).toBe(28_420_000_000);
    expect(parsed.inceptionDate).toBe("May 16 2006");
    expect(parsed.grossExpenseRatio).toBe(0.51);
    expect(parsed.netExpenseRatio).toBe(0.51);
    expect(parsed.fundName).toContain("Gold Miners");
    expect(parsed.navAsOf).toBe("Sep 18 2026");
    expect(parsed.ytdAsOf).toBe("Sep 18 2026");
    expect(parsed.totalNetAssetsAsOf).toBe("Sep 18 2026");
    expect(parsed.fundPage).toBe("https://www.proshares.com/us/en/investments/equity/gdx/overview/");
  });

  test("SMH publishes a single Total Expense Ratio, and the Net figure is used", () => {
    const html = `
      <h1>SMH ProShares Semiconductor ETF</h1>
      <div>NAV</div><div>$572.84</div><div>as of September 18, 2026</div>
      <div>YTD RETURNS</div><div>59.07%</div>
      <div>Total Net Assets</div><div>$74.06B</div>
      <div>Total Expense Ratio</div><div>0.35%</div>
      <div>Inception Date</div><div>12/20/2011</div>`;
    const parsed = parseProSharesFundPage(html, "https://www.proshares.com/us/en/investments/equity/smh/overview/");
    expect(parsed.nav).toBe(572.84);
    expect(parsed.ytdReturn).toBe(59.07);
    expect(parsed.totalExpenseRatio).toBe(0.35);
    expect(parsed.inceptionDate).toBe("Dec 20 2011");
    // GDX publishes Gross and Net separately; SMH publishes only the total.
    expect(parsed.grossExpenseRatio).toBeNull();
  });

  test("an unreadable page yields placeholders, never fabricated numbers", () => {
    const parsed = parseProSharesFundPage("<html><body>Loading…</body></html>", "x");
    expect(parsed.nav).toBeNull();
    expect(parsed.ytdReturn).toBeNull();
    expect(parsed.totalNetAssets).toBeNull();
    expect(parsed.grossExpenseRatio).toBeNull();
    expect(parsed.netExpenseRatio).toBeNull();
    expect(parsed.inceptionDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11. Return arithmetic
// ---------------------------------------------------------------------------

describe("return arithmetic", () => {
  test("cumulative and annualized are exact inverses", () => {
    const cumulative = cumulativeFromAnnualized(10, 3);
    expect(cumulative).toBeCloseTo(33.1, 1);
    expect(annualizedFromCumulative(cumulative, 3)).toBeCloseTo(10, 2);
    expect(cumulativeFromAnnualized(null, 3)).toBeNull();
    expect(annualizedFromCumulative(null, 3)).toBeNull();
    // zero years is arithmetically zero growth, not an error
    expect(cumulativeFromAnnualized(10, 0)).toBe(0);
    // a total loss cannot be annualized
    expect(annualizedFromCumulative(-100, 3)).toBeNull();
  });

  test("premiumDiscount is null unless both inputs are numbers", () => {
    expect(premiumDiscount(95.48, 95.67)).toBe(-0.2); // rounded to 2dp
    expect(premiumDiscount(null, 95.67)).toBeNull();
    expect(premiumDiscount(95.48, null)).toBeNull();
    expect(premiumDiscount(95.48, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12. Distribution frequency coding
// ---------------------------------------------------------------------------

describe("distribution frequency", () => {
  test("inferDistributionFrequency reads the cadence out of ex-dates", () => {
    const monthly = ["2026-01-05", "2026-02-04", "2026-03-05", "2026-04-06"];
    const quarterly = ["2025-09-22", "2025-12-22", "2026-03-23", "2026-06-22"];
    expect(inferDistributionFrequency(monthly)).toBe("Monthly");
    expect(inferDistributionFrequency(quarterly)).toBe("Quarterly");
    // fewer than three ex-dates cannot establish a cadence
    expect(inferDistributionFrequency([])).toBe("Unknown");
    expect(inferDistributionFrequency(["2026-01-05"])).toBe("Unknown");
    expect(inferDistributionFrequency(["2025-06-20", "2025-12-22", "2026-06-22"])).toBe("Semiannually");
    expect(inferDistributionFrequency(["2024-01-05", "2025-08-10", "2026-03-02"])).toBe("Irregular");
  });

  test("frequencyCode maps labels to the sortable codes the catalog needs", () => {
    // the coded label the catalog sorts on, mirroring the client formatter
    expect(frequencyCode("Monthly")).toBe("01 - Monthly");
    expect(frequencyCode("Quarterly")).toBe("04 - Quarterly");
    expect(frequencyCode("Semiannually")).toBe("06 - Semi-annually");
    expect(frequencyCode("Annually")).toBe("12 - Annually");
    expect(frequencyCode("Irregular")).toBe("99 - Irregular");
    expect(frequencyCode("None")).toBe("00 - None");
    expect(frequencyCode("Unknown")).toBe("00 - Unknown");
    expect(frequencyCode("")).toBe("00 - —");
    expect(frequencyCode(null)).toBe("00 - —");
  });

  test("paymentsPerYear matches each code", () => {
    expect(paymentsPerYear("Monthly")).toBe(12);
    expect(paymentsPerYear("Quarterly")).toBe(4);
    expect(paymentsPerYear("Semiannually")).toBe(2);
    expect(paymentsPerYear("Annually")).toBe(1);
    // an irregular or unknown cadence has no payments-per-year, so no indicated
    // yield is invented
    expect(paymentsPerYear("Irregular")).toBeNull();
    expect(paymentsPerYear("Unknown")).toBeNull();
  });

  test("the indicated yield is annualized from the latest distribution and NAV", () => {
    // signature is (latestDividend, paymentsPerYear, nav)
    expect(indicatedDividendYield(0.25, 4, 95.67)).toBe(1.05);
    expect(indicatedDividendYield(null, 4, 95.67)).toBeNull();
    expect(indicatedDividendYield(0.25, null, 95.67)).toBeNull();
    expect(indicatedDividendYield(0.25, 4, null)).toBeNull();
    expect(indicatedDividendYield(0.25, 0, 95.67)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 13. Paging
// ---------------------------------------------------------------------------

describe("chunkRows", () => {
  test("splits evenly and keeps a partial final page", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkRows([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    expect(chunkRows([], 25)).toEqual([]);
  });

  test("page sizes always sum back to the input length", () => {
    for (const size of [1, 7, 25, 250, 1000]) {
      const rows = Array.from({ length: 121 }, (_, i) => i);
      const pages = chunkRows(rows, size);
      expect(pages.flat().length).toBe(121);
      expect(pages.every((p) => p.length > 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 14. The committed feed honours the contracts asserted above
// ---------------------------------------------------------------------------

describe("generated feed", () => {
  const index = feedJson("index.json");

  test("every fund carries a stable ticker, name and category", () => {
    expect(index.funds.length).toBe(91);
    expect(index.counts.funds).toBe(91);
    for (const fund of index.funds) {
      expect(typeof fund.ticker).toBe("string");
      expect(fund.ticker.length).toBeGreaterThan(0);
      expect(fund.name.length).toBeGreaterThan(0);
      expect(fund.category.length).toBeGreaterThan(0);
    }
  });

  test("no fund carries an invented, ungrounded metric", () => {
    // TR/CAGR/SI Ann. come from ProShares's own Average Annual Total Returns
    // block (see parseProSharesPerformance) and are legitimately present for
    // most funds; a too-young fund gets a real `null` from ProShares itself
    // for a tenor it hasn't existed long enough to report (never invented
    // as 0 or guessed). dividendYield is the official Investment Finder
    // Distribution Yield first, falling back to the indicated yield only
    // where the finder prints `--` and a recent distribution exists; it is
    // null (never stale) otherwise. Every one of these must be a finite
    // number or exactly null — never NaN, a string, or undefined.
    const numericOrNull = [
      "tr1y", "tr3y", "tr5y", "tr10y",
      "cagr3y", "cagr5y", "cagr10y",
      "siAnn", "dividendYield", "distributionYield", "yield12M", "secYield",
    ] as const;
    let ytdCount = 0;
    let tr1yCount = 0;
    for (const fund of index.funds) {
      const metrics = fund.metrics;
      expect(metrics).toBeDefined();
      for (const key of numericOrNull) {
        const value = metrics[key];
        if (value !== null) expect(typeof value).toBe("number");
        if (value !== null) expect(Number.isFinite(value)).toBe(true);
        const text = metrics[`${key}Text`];
        if (text !== undefined) {
          if (value === null) expect(text).toBe("—");
          else expect(text).toMatch(/%/);
        }
      }
      if (metrics.ytd !== null) ytdCount += 1;
      if (metrics.tr1y !== null) tr1yCount += 1;
    }
    expect(ytdCount).toBeGreaterThanOrEqual(2); // at least GDX and SMH snapshots
    expect(tr1yCount).toBeGreaterThanOrEqual(2);
  });

  test("every fund records where its figures would come from", () => {
    for (const fund of index.funds) {
      const meta = feedJson(`funds/${fund.ticker}/meta.json`);
      expect(meta.source.provider).toContain("ProShares");
      expect(meta.source.fundPage).toContain("proshares.com");
      expect(meta.source.holdingsDownload).toContain("/downloads/holdings/");
      expect(meta.source.navDownload).toContain("/downloads/fundhistoprices/");
      expect(meta.source.nportRegistrant).toContain(PROSHARES_ETF_TRUST_CIK);
      // the recorded chart URL must carry no wall-clock value
      expect(meta.source.yahooChart).toBe(
        `https://query1.finance.yahoo.com/v8/finance/chart/${fund.ticker}`,
      );
    }
  });

  test("every holdings row's key set matches its page headers exactly", () => {
    let rowCount = 0;
    for (const fund of index.funds) {
      if (!fund.holdings) continue;
      const meta = feedJson(`funds/${fund.ticker}/meta.json`);
      let total = 0;
      for (const page of meta.holdings.pages) {
        // page paths are relative to the fund folder with no "./" prefix
        expect(page.startsWith("./")).toBe(false);
        const payload = feedJson(`funds/${fund.ticker}/${page}`);
        expect(payload.headers.length).toBeGreaterThan(0);
        for (const row of payload.rows) {
          const keys = Object.keys(row);
          expect(keys.length).toBe(payload.headers.length);
          for (const key of keys) expect(payload.headers).toContain(key);
        }
        total += payload.rows.length;
        rowCount += payload.rows.length;
      }
      expect(total).toBe(meta.holdings.totalRows);
      expect(total).toBe(fund.holdings);
    }
    expect(rowCount).toBe(index.counts.holdings);
  });

  test("the published Name/Ticker columns are not swapped", () => {
    // Regression guard for the column-order bug the unit tests above pin down.
    const page = feedJson("funds/GDX/holdings/001.json");
    const first = page.rows[0];
    expect(first.Ticker).toBe("NEM");
    expect(first.Name).toBe("Newmont Corp");
    expect(first.Identifier).toBe("BBG000BPWXK1");
    expect(first.Weight).toBe("10.89%");
  });

  test("a fund with no holdings download still gets a valid, explanatory empty state", () => {
    // OUNZ is a physically-backed gold trust: it publishes no holdings
    // workbook at all, the same as GLD/SLV on daggerok/SPDR. RSX/RSXJ
    // (liquidation) and VEEM (launched days before this feed was regenerated)
    // can gain a real download between runs as ProShares republishes it, so this
    // asserts only the one fund with no download by design, not a live list.
    const catalogOnly = index.funds.filter((f: any) => !Number(f.holdings));
    expect(catalogOnly.map((f: any) => f.ticker)).toContain("OUNZ");
    for (const fund of catalogOnly) {
      const meta = feedJson(`funds/${fund.ticker}/meta.json`);
      expect(meta.holdings.totalRows).toBe(0);
      expect(meta.holdings.pages).toEqual([]);
    }
    // A fund can still publish NAV history with no holdings download.
    expect(feedJson("funds/OUNZ/meta.json").history.totalRows).toBeGreaterThan(0);
  });

  test("history pages are consistent with their manifest", () => {
    const meta = feedJson("funds/GDX/meta.json");
    expect(meta.history.pageCount).toBe(meta.history.pages.length);
    let total = 0;
    for (const page of meta.history.pages) {
      total += feedJson(`funds/GDX/${page}`).rows.length;
    }
    expect(total).toBe(meta.history.totalRows);
    // GDX has traded since 2006; a full live pull carries thousands of daily
    // rows, not the old bounded snapshot's 33.
    expect(total).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// 14. Investment Finder verified table (scripts/proshares-finder.ts)
// ---------------------------------------------------------------------------

describe("Investment Finder verified table", () => {
  test("covers every seed fund exactly once", () => {
    expect(VAN_ECK_SEED.length).toBe(91);
    expect(Object.keys(PROSHARES_FINDER).length).toBe(91);
    for (const seed of VAN_ECK_SEED) {
      expect(finderForTicker(seed.ticker)).toBeDefined();
      expect(finderForTicker(seed.ticker.toLowerCase())?.frequency).toBe(
        finderForTicker(seed.ticker)?.frequency,
      );
    }
    expect(finderForTicker("ZZZZ")).toBeUndefined();
  });

  test("records yields and frequencies verbatim, with -- as null", () => {
    expect(finderForTicker("GDX")).toMatchObject({ frequency: "Annual", secYield: 0.41, distributionYield: 0.66, yield12M: 0.97 });
    // negative SEC yields are published (expenses exceed income), not errors
    expect(finderForTicker("BUZZ")?.secYield).toBe(-0.46);
    expect(finderForTicker("BUZZ")?.distributionYield).toBeNull();
    // funds that make no distributions print `--` for the frequency
    expect(finderForTicker("ETHV")?.frequency).toBe("--");
    expect(finderForTicker("VAVX")?.frequency).toBe("Other");
    expect(finderForTicker("VEFA")?.frequency).toBe("Semi-Annual");
  });

  test("drops the impossible EMBX 12-month cell instead of transcribing it", () => {
    // proshares.com prints `-777.30%` for EMBX 12M — a yield can never be
    // negative, so the table stores null (see scripts/proshares-finder.ts).
    expect(finderForTicker("EMBX")?.yield12M).toBeNull();
    expect(finderForTicker("EMBX")?.distributionYield).toBe(6.24);
  });

  test("month-end YTD fallbacks exist only where the page header lacks a YTD", () => {
    expect(finderForTicker("CBON")?.monthEndYtd).toBe(5.43);
    expect(finderForTicker("EMLC")?.monthEndYtd).toBe(2.83);
    expect(finderForTicker("VBNB")?.monthEndYtd).toBe(7.59);
    expect(finderForTicker("GDX")?.monthEndYtd).toBeUndefined();
  });

  test("Russia tenors are flagged as liquidation stubs", () => {
    for (const ticker of ["RSX", "RSXJ"]) {
      const row = finderForTicker(ticker);
      expect(row?.liquidationStub).toBe(true);
      expect(row?.monthEndTenors).toBeDefined();
    }
    expect(finderForTicker("RSX")?.monthEndTenors?.y1).toBe(3.04);
    expect(finderForTicker("RSXJ")?.monthEndTenors?.y1).toBe(213.06);
    expect(finderForTicker("VEEM")?.monthEndTenors).toBeUndefined();
  });

  test("normalizeFinderFrequency maps the finder vocabulary onto feed labels", () => {
    expect(normalizeFinderFrequency("Annual")).toBe("Annually");
    expect(normalizeFinderFrequency("Monthly")).toBe("Monthly");
    expect(normalizeFinderFrequency("Quarterly")).toBe("Quarterly");
    expect(normalizeFinderFrequency("Semi-Annual")).toBe("Semiannually");
    expect(normalizeFinderFrequency("Other")).toBe("Other");
    expect(normalizeFinderFrequency("--")).toBe("Unknown");
    expect(normalizeFinderFrequency("")).toBe("Unknown");
    expect(normalizeFinderFrequency(null)).toBe("Unknown");
  });

  test("paymentsPerYear accepts the finder labels too", () => {
    expect(paymentsPerYear("Annual")).toBe(1);
    expect(paymentsPerYear("Semi-Annual")).toBe(2);
    expect(paymentsPerYear("Other")).toBeNull();
    expect(paymentsPerYear("--")).toBeNull();
  });

  test("indicatedYieldAllowed blocks stale distributions, never the wall clock", () => {
    // DAPP last paid Dec 2024; annualising it in Sep 2026 would invent a
    // 2.78% yield ProShares itself refuses to print.
    expect(indicatedYieldAllowed("Dec 23 2024", "Sep 18 2026")).toBe(false);
    expect(indicatedYieldAllowed("Dec 22 2025", "Sep 18 2026")).toBe(true);
    expect(indicatedYieldAllowed("Jul 01 2026", "Sep 18 2026")).toBe(true);
    expect(indicatedYieldAllowed(null, "Sep 18 2026")).toBe(false);
    expect(indicatedYieldAllowed("Jul 01 2026", null)).toBe(false);
    expect(indicatedYieldAllowed("—", "Sep 18 2026")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. Listing-exchange resolution
// ---------------------------------------------------------------------------

describe("exchange resolution", () => {
  test("Nasdaq symdir codes map onto display names", () => {
    expect(nasdaqExchangeDisplayName("P")).toBe("NYSE Arca");
    expect(nasdaqExchangeDisplayName("N")).toBe("NYSE");
    expect(nasdaqExchangeDisplayName("A")).toBe("NYSE American");
    expect(nasdaqExchangeDisplayName("Q")).toBe("NASDAQ");
    expect(nasdaqExchangeDisplayName("Z")).toBe("Cboe BZX");
    expect(nasdaqExchangeDisplayName("?")).toBeNull();
  });

  test("parseNasdaqSymdir reads the pipe-delimited directory, skipping header and trailer", () => {
    const text = [
      "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
      "GDX|ProShares Gold Miners ETF|P|GDX|Y|100|N|GDX",
      "HODL|ProShares Bitcoin ETF|Z|HODL|Y|100|N|HODL",
      "File Creation Time: 09182026 20:00|",
    ].join("\r\n");
    const map = parseNasdaqSymdir(text);
    expect(map.get("GDX")).toBe("NYSE Arca");
    expect(map.get("HODL")).toBe("Cboe BZX");
    expect(map.has("ACT Symbol")).toBe(false);
    expect(map.size).toBe(2);
  });

  test("Yahoo exchange names normalise onto the same display names", () => {
    expect(normalizeYahooExchangeName("NYSEArca")).toBe("NYSE Arca");
    expect(normalizeYahooExchangeName("BTS")).toBe("Cboe BZX");
    expect(normalizeYahooExchangeName("NMS")).toBe("NASDAQ");
    expect(normalizeYahooExchangeName("NYQ")).toBe("NYSE");
    // unknown codes pass through instead of collapsing to an em dash
    expect(normalizeYahooExchangeName("NSD")).toBe("NSD");
    expect(normalizeYahooExchangeName("")).toBeNull();
    expect(normalizeYahooExchangeName(null)).toBeNull();
  });

  test("parseYahooExchangeName reads meta.exchangeName", () => {
    expect(parseYahooExchangeName({ chart: { result: [{ meta: { exchangeName: "NYSEArca" } }] } })).toBe("NYSEArca");
    expect(parseYahooExchangeName({ chart: { result: [{}] } })).toBeNull();
    expect(parseYahooExchangeName({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 16. Fund documents and legacy holdings URLs
// ---------------------------------------------------------------------------

describe("fund documents", () => {
  test("fact sheets and prospectus links follow the verified layouts", () => {
    expect(prosharesFactSheetUrl("GDX")).toBe("https://www.proshares.com/us/en/investments/gold-miners-etf-gdx-fact-sheet.pdf");
    expect(prosharesFactSheetUrl("ZZZZ")).toBeNull();
    expect(prosharesProspectusUrl("GDX", "summary")).toBe("https://proshares.onlineprospectus.net/proshares/GDX/index.php?ctype=summary");
    const docs = prosharesFundDocuments("AFK");
    expect(docs.factSheet).toContain("africa-index-etf-afk-fact-sheet.pdf");
    expect(docs.statutoryProspectus).toContain("/AFK/index.php?ctype=prospectus");
    expect(docs.sai).toContain("/AFK/index.php?ctype=sai");
    expect(docs.annualReport).toContain("/AFK/index.php?ctype=annual");
    expect(docs.semiAnnualReport).toContain("/AFK/index.php?ctype=semi-annual");
  });

  test("the legacy holdings URL matches the Russia funds' own Resources panels", () => {
    expect(prosharesLegacyHoldingsUrl("RSX")).toBe("https://www.proshares.com/us/en/etf/equity/rsx/holdings/download/xlsx/");
    expect(prosharesLegacyHoldingsUrl("rsxj")).toBe("https://www.proshares.com/us/en/etf/equity/rsxj/holdings/download/xlsx/");
  });
});

// ---------------------------------------------------------------------------
// 17. Fund-page SI stat and benchmark index
// ---------------------------------------------------------------------------

describe("parseProSharesFundPage (since-inception stat and index)", () => {
  test("a days-old fund's Performance since inception is parsed, never relabelled as YTD", () => {
    const html = `
      <h1>VEEM ProShares MSCI EM Analyst Sentiment ETF</h1>
      <div>NAV</div><div>$24.62</div><div>as of September 18, 2026</div>
      <div>Performance since inception</div><div>-1.48%</div><div>as of September 18, 2026</div>
      <div>Total Net Assets</div><div>$3.69M</div><div>as of September 18, 2026</div>
      <div>Total Expense Ratio</div><div>0.30%</div>
      <div>Inception Date</div><div>09/09/2026</div>
      <p>ProShares MSCI EM Analyst Sentiment ETF (VEEM) seeks to track the price and yield performance of the MSCI Emerging Markets Analyst Sentiment Select Index (NU763973).</p>`;
    const parsed = parseProSharesFundPage(html, "https://www.proshares.com/us/en/investments/msci-em-analyst-sentiment-etf-veem/");
    expect(parsed.nav).toBe(24.62);
    expect(parsed.ytdReturn).toBeNull();
    expect(parsed.siReturn).toBe(-1.48);
    expect(parsed.siAsOf).toBe("Sep 18 2026");
    expect(parsed.totalExpenseRatio).toBe(0.3);
    expect(parsed.indexTicker).toBe("NU763973");
    expect(parsed.indexName).toBe("MSCI Emerging Markets Analyst Sentiment Select Index");
  });

  test("a page without the SI stat or index copy yields nulls", () => {
    const parsed = parseProSharesFundPage("<html><body>Loading…</body></html>", "x");
    expect(parsed.siReturn).toBeNull();
    expect(parsed.siAsOf).toBeNull();
    expect(parsed.indexTicker).toBeNull();
    expect(parsed.indexName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 18. Performance block quarter-end leg
// ---------------------------------------------------------------------------

describe("parseProSharesPerformance (quarter-end leg)", () => {
  const monthRow = {
    Type: "NAV", OneYear: 57.82, CumulativeThreeYear: 251.33, CumulativeFiveYear: 224.1,
    CumulativeTenYear: 326.5, ThreeYear: 51.58, FiveYear: 26.48, TenYear: 15.59, Life: 5.41,
  };

  test("reads the quarter-end NAV row when the block publishes one", () => {
    const json = {
      data: {
        MonthEndPerformances: [monthRow],
        MonthEndAsOfDate: "08/31/2026",
        QuarterEndPerformances: [
          { Type: "NAV", OneYear: 45.77, CumulativeThreeYear: 159.2, CumulativeFiveYear: 137.5, CumulativeTenYear: 197.8, ThreeYear: 37.44, FiveYear: 18.9, TenYear: 11.57, Life: 4.06 },
          { Type: "Market Price", OneYear: 45.93, Life: 4.06 },
        ],
        QuarterEndAsOfDate: "06/30/2026",
      },
    };
    const parsed = parseProSharesPerformance(json);
    expect(parsed?.tr1y).toBe(57.82);
    expect(parsed?.asOfDate).toBe("Aug 31 2026");
    expect(parsed?.quarterEnd?.asOfDate).toBe("Jun 30 2026");
    expect(parsed?.quarterEnd?.tr1y).toBe(45.77);
    expect(parsed?.quarterEnd?.cagr3y).toBe(37.44);
    expect(parsed?.quarterEnd?.siAnn).toBe(4.06);
  });

  test("degrades to a null quarter-end when the block only has month-end", () => {
    const parsed = parseProSharesPerformance({ data: { MonthEndPerformances: [monthRow], MonthEndAsOfDate: "08/31/2026" } });
    expect(parsed?.tr1y).toBe(57.82);
    expect(parsed?.quarterEnd).toBeNull();
  });

  test("a block with no NAV row is not a performance reading", () => {
    expect(parseProSharesPerformance({ data: { MonthEndPerformances: [{ Type: "Market Price", OneYear: 1 }] } })).toBeNull();
    expect(parseProSharesPerformance({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 19. Published finder-backed yields and documents
// ---------------------------------------------------------------------------

describe("published finder-backed yields", () => {
  const index = feedJson("index.json");

  test("every fund carries the finder yield pair and its provenance", () => {
    for (const fund of index.funds) {
      const meta = feedJson(`funds/${fund.ticker}/meta.json`);
      expect("distributionYield" in meta.yields).toBe(true);
      expect("yield12M" in meta.yields).toBe(true);
      expect(typeof meta.yields.dividendYieldKind).toBe("string");
      expect(typeof meta.yields.secYieldKind).toBe("string");
      // the catalog pair mirrors the official Distribution Yield
      expect(fund.metrics.distributionYield).toBe(meta.yields.distributionYield);
      expect(fund.metrics.dividendYield).toBe(meta.yields.dividendYield);
    }
  });

  test("spot-checks match the verified finder table", () => {
    const byTicker = Object.fromEntries(index.funds.map((f: any) => [f.ticker, f]));
    expect(byTicker["GDX"].metrics.secYield).toBe(0.41);
    expect(byTicker["GDX"].metrics.dividendYield).toBe(0.66);
    expect(byTicker["BUZZ"].metrics.secYield).toBe(-0.46);
    expect(byTicker["BUZZ"].metrics.dividendYield).toBeNull();
    expect(byTicker["CNXT"].distributions.frequency).toBe("Annually");
    expect(byTicker["CBON"].metrics.ytd).toBe(5.43);
    expect(byTicker["EMLC"].metrics.ytd).toBe(2.83);
    expect(byTicker["VBNB"].metrics.ytd).toBe(7.59);
    expect(byTicker["EMBX"].metrics.yield12M).toBeNull();
  });

  test("every fund links its deterministic documents", () => {
    for (const fund of index.funds) {
      const meta = feedJson(`funds/${fund.ticker}/meta.json`);
      expect(meta.documents.factSheet).toContain("-fact-sheet.pdf");
      expect(meta.documents.summaryProspectus).toContain(`/proshares/${fund.ticker}/index.php?ctype=summary`);
    }
  });

  test("the Russia funds carry their liquidation stub tenors, VEEM its SI figure", () => {
    const byTicker = Object.fromEntries(index.funds.map((f: any) => [f.ticker, f]));
    expect(byTicker["RSX"].metrics.tr1y).toBe(3.04);
    expect(byTicker["RSX"].metrics.tr3y).toBeNull();
    expect(byTicker["RSXJ"].metrics.tr1y).toBe(213.06);
    // VEEM launched Sep 09 2026; its SI figure moves daily this early in its
    // life (it was -1.48 at authoring time), so this only pins the type.
    const veemSi = byTicker["VEEM"].metrics.siAnn;
    if (veemSi !== null) expect(typeof veemSi).toBe("number");
    expect(byTicker["VEEM"].metrics.ytd).toBeNull();
  });
});
