/**
 * @file ProShares Watchlist Application
 * Client-side static feed viewer for api/proshares/** with multi-ETF Watchlist
 * aggregation. Same single-file approach as daggerok/Amplify: the paginated
 * static API and lazy sheet loading follow daggerok/iShares.
 *
 * Babel standalone note: the inline pipeline strips type annotations, but it
 * does not accept every TypeScript-only expression. Follow the Amplify dev
 * style — plain `byId()` instead of DOM casts, no `as` casts, no non-null
 * `!`, no interfaces or enums.
 */

/// <reference types="bun" />

// =========================================================================
// 1. Types, constants & column tooltips
// =========================================================================

type ActiveTab = string;
type SortDirection = 'asc' | 'desc';
type TableRow = Record<string, unknown> & { searchIndex?: string };
type TabInfo = { id: ActiveTab; label: string; count: number | string };

type IndexFund = {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  dataFile: string;
  ter: string;
  terValue: number;
  nav: string;
  navValue: number;
  aum: string;
  aumValue: number;
  asOfDate: string;
  inceptionDate: string;
  exchange: string;
  closePrice: string;
  premiumDiscount: string;
  cusip?: string | null;
  isin?: string | null;
  distributions: { frequency: string; exDate: string; dividend: string };
  returns: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
  metrics?: {
    tr1y?: number | null;
    tr3y?: number | null;
    tr5y?: number | null;
    tr10y?: number | null;
    cagr3y?: number | null;
    cagr5y?: number | null;
    cagr10y?: number | null;
    siAnn?: number | null;
    dividendYield?: number | null;
    dividendYieldText?: string | null;
    secYield?: number | null;
    secYieldText?: string | null;
  };
  holdings: number;
  history: number;
};

type FundRow = TableRow & {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  ter: string;
  terValue: number;
  nav: string;
  navValue: number;
  aum: string;
  aumValue: number;
  asOfDate: string;
  inceptionDate: string;
  exchange: string;
  closePrice: string;
  premiumDiscount: string;
  ytd: number;
  yr1: number;
  yr3: number;
  yr5: number;
  yr10: number;
  si: number;
  tr3y?: number | null;
  tr5y?: number | null;
  tr10y?: number | null;
  cagr3y?: number | null;
  cagr5y?: number | null;
  cagr10y?: number | null;
  dividendYield?: number | null;
  dividendFrequency: string;
  secYield?: number | null;
  returnAsOf: string;
  returns?: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
  distributions?: { frequency: string; exDate: string; dividend: string };
  holdings: number;
  history: number;
};

type WatchlistRow = TableRow & {
  key: string;
  symbol: string;
  name: string;
  funds: string[];
  fundCount: number;
  weightSum: number;
  maxWeight: number;
  cusips: string[];
  identifier: string;
};

const INDEX_URL = './api/proshares/index.json';
const THEME_KEY = 'proshares-theme';
const SELECTED_KEY = 'proshares-selected-etfs';
const BLACKLIST_KEY = 'proshares-blacklisted-etfs';
const ACTIVE_FUND_KEY = 'proshares-active-fund';
const FILTERS_KEY = 'proshares-tab-filters';
const LEGACY_FILTERS_KEY = 'proshares-searches'; // pre-rename key, migrated at boot
const SORTS_KEY = 'proshares-tab-sorts';
const SITE_STATE_KEY = 'proshares-site-state';
const HOLDINGS_CONCURRENCY = 6; // bounded whole-catalog aggregation workers
const WATCHLIST_CHUNK = 250; // rows per rendered Watchlist DOM chunk
const DEFAULT_SELECTED_TICKERS: string[] = []; // start clean: no pre-selected funds

const DETAIL_TABS: Array<{ key: string; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'holdings', label: 'Holdings' },
  { key: 'history', label: 'History' },
  { key: 'distributions', label: 'Distributions' },
];

const NUMERIC_SHEET_HEADERS = ['Weight', 'Shares Held', 'Shares Outstanding', 'Total Net Assets', 'Par Value', 'Market Value', 'Coupon', 'NAV'];

// Hover explanations for table headers. Native `title` tooltips, same pattern as daggerok/iShares.
const COLUMN_TOOLTIPS: Record<string, string> = {
  '#': 'Row index in current table view.',
  Use: 'Use / Multi-ETF Selection — Check this box to include this ETF\'s underlying holdings in the combined Watchlist tab.',
  Ticker: 'Ticker Symbol — Unique stock market identifier. For holdings: the Security Ticker column exactly as published in the official ProShares daily holdings file (psdlyhld), which carries the local exchange suffix for non-US listings (NST AU, 2259 HK, BRMS IJ). "-" when the position has no exchange ticker (futures, swaps, treasury bills, net other assets); those rows then key on the SEDOL identifier.',
  'Fund Name': 'Fund Name — Official legal name of the ProShares exchange-traded fund (ETF), as published on the ProShares finder and fund pages.',
  Category: 'Category — proshares.com groups its ETFs by asset class ("Equity", "Fixed Income", "Commodity", "Crypto-Linked", "Cash", "Alternative", "Volatility"); the tab shows that provider asset-class label verbatim, and the marketing category / geared strategy is kept in meta.json.',
  Name: 'Security Name — Full registered legal name of the company or underlying financial asset, as published in the official ProShares daily holdings file.',
  Identifier: 'SEDOL — Security identifier published in the official ProShares daily holdings file (Security Sedol). ProShares publishes no CUSIP/ISIN/FIGI for its positions, so this is the identifier key: rows without an exchange ticker (futures, swaps, bonds, cash) are identified in the Watchlist by this.',
  SEDOL: 'SEDOL — Stock Exchange Daily Official List identifier, exactly as published in the ProShares daily holdings file (Security Sedol).',
  FIGI: 'FIGI — Bloomberg Financial Instrument Global Identifier. Not published by ProShares; shown as "—" (data limitation).',
  TER: 'Expense Ratio — Total annual fund operating expenses as a % of assets. ProShares publishes a single ratio for most funds and a gross plus a net ratio for the geared funds; the feed headline is the net ratio.',
  NAV: 'NAV (Net Asset Value) — Per-share dollar value of the fund, as published in the ProShares fund page price block and in the official daily NAV history file.',
  'Net Assets': 'Net Assets (AUM) — Total net assets as published in the ProShares fund page snapshot and in the official daily NAV history file.',
  Weight: 'Weight — ProShares Exposure Weight: the position value (market value, or notional exposure for futures and swaps) as a percentage of the fund\'s total net assets in the same official holdings file (the file carries no weight column, so the updater reproduces the column the fund pages render). Cash and payable lines carry no weight.',
  'Weight Sum': 'Weight Sum — Summed weight of this holding across all selected ETFs (%).',
  'Max Weight': 'Max Weight — Highest single-fund weight for this holding across selected ETFs (%).',
  '# ETFs': 'Number of selected ETFs that currently hold this security.',
  ETFs: 'Selected ETFs holding this security.',
  Type: 'Category — the asset-class part of the proshares.com classification (see the Category column). Same source as the category tabs.',
  Expense: 'Expense Ratio — Total annual fund operating expenses as a % of assets. ProShares publishes a single ratio for most funds and a gross plus a net ratio for the geared funds; the feed headline is the net ratio.',
  'Dividend Yield': 'Dividend Yield — the official 12-Month Yield published in the ProShares fund page distributions block: the last 12 months\' distributions divided by the latest NAV plus any capital-gain distributions. "—" for funds with no distribution history yet.',
  'SEC Yield': 'SEC Yield (30-Day) — Not published by ProShares on its fund pages; shown as "—" (data limitation). ProShares prints a Weighted Average Yield to Maturity for its interest rate hedged bond funds instead, which the Overview tab reports.',
  'YTD Return': 'YTD Return — Year-To-Date return from the official ProShares performance file (etf_performance.csv, NAV total return, month-end period), as of the date shown in the Return As Of column.',
  'TR 1Y': 'TR 1Y (1-Year Total Return) — from the official ProShares performance file (NAV total return).',
  'TR 3Y': 'TR 3Y (3-Year Total Return) — cumulative 3-year return derived from the annualized 3-Year figure in the official ProShares performance file as (1 + 3Y)^3 − 1 (NAV basis). "—" for a fund younger than 3 years.',
  'TR 5Y': 'TR 5Y (5-Year Total Return) — cumulative 5-year return derived from the annualized 5-Year figure in the official ProShares performance file as (1 + 5Y)^5 − 1 (NAV basis). "—" for a fund younger than 5 years.',
  'TR 10Y': 'TR 10Y (10-Year Total Return) — cumulative 10-year return derived from the annualized 10-Year figure in the official ProShares performance file as (1 + 10Y)^10 − 1 (NAV basis). "—" for a fund younger than 10 years.',
  'CAGR 3Y': 'CAGR 3Y (3-Year Compound Annual Growth Rate) — the annualized 3-Year figure in the official ProShares performance file (NAV basis). "—" for a fund younger than 3 years.',
  'CAGR 5Y': 'CAGR 5Y (5-Year Compound Annual Growth Rate) — the annualized 5-Year figure in the official ProShares performance file (NAV basis). "—" for a fund younger than 5 years.',
  'CAGR 10Y': 'CAGR 10Y (10-Year Compound Annual Growth Rate) — the annualized 10-Year figure in the official ProShares performance file (NAV basis). "—" for a fund younger than 10 years.',
  YTD: 'Year-to-date return from the official ProShares performance file.',
  '1Y': '1-year total return, from the official ProShares performance file (NAV basis).',
  '3Y': '3-year average annual total return (CAGR), from the official ProShares performance file (NAV basis). "—" for a fund younger than 3 years.',
  '5Y': '5-year average annual total return (CAGR), from the official ProShares performance file (NAV basis). "—" for a fund younger than 5 years.',
  '10Y': '10-year average annual total return (CAGR), from the official ProShares performance file (NAV basis). "—" for a fund younger than 10 years.',
  'SI Ann.': 'Since-inception annualized total return, from the official ProShares performance file (NAV basis).',
  'Return As Of': 'As-of date of the month-end returns in the official ProShares performance file.',
  Inception: 'Inception Date — fund launch date as published on the ProShares finder and fund pages.',
  Exchange: 'Primary listing exchange.',
  Close: 'Last Trade — most recent market price, as published in the ProShares fund page price block.',
  'Prem/Disc': 'Premium / Discount — market price versus NAV (%), computed from the ProShares fund page price block (the page links to a separate tool but server-renders no value).',
  Holdings: 'Rows in the fund\'s latest official daily holdings file (psdlyhld).',
  History: 'Rows in the fund\'s official daily NAV history file.',
  'As Of': 'As-of date of the NAV / net assets figures.',
  Frequency: 'Distribution frequency — the declared schedule published in the ProShares fund page distributions block. Codes: 00 — / None / Unknown, 01 Monthly, 04 Quarterly, 06 Semi-annually, 12 Annually, 99 Irregular. The Overview tab shows the raw label.',
  'Ex-Date': 'Ex-dividend date of the latest distribution, from the official ProShares distribution summary API.',
  Dividend: 'Latest distribution per share, from the official ProShares distribution summary API. "—" if the fund has never made a distribution.',
  Coupon: 'Bond annual coupon rate (%), as published in the official ProShares daily holdings file (empty for non-bond positions).',
  Maturity: 'Bond maturity date, as published in the official ProShares daily holdings file (empty for non-bond positions).',
  'Maturity Date': 'Bond maturity date, as published in the official ProShares daily holdings file (empty for non-bond positions).',
  'Market Value': 'Position market value, as published in the official ProShares daily holdings file.',
  'Exposure Value': 'Exposure value (notional + gain/loss) as published in the official ProShares daily holdings file — carried by futures and swap positions that report no market value.',
  'Shares Held': 'Shares or contracts held, as published in the official ProShares daily holdings file (negative for short futures and swap positions).',
  Section: 'Section — Grouping of the overview metric (Fund, Cost, Price, Assets, Returns, Distributions, Holdings).',
  Metric: 'Metric — Overview metric name.',
  Value: 'Overview metric value.',
  Date: 'NAV history date, from the official ProShares daily NAV history file.',
  'Shares Outstanding': 'Fund shares outstanding on that date (converted from the thousands published in the NAV history file).',
  'Total Net Assets': 'Fund total net assets on that date (USD), as published in the NAV history file.',
};

// =========================================================================
// 2. DOM references, application state & lazy fund data
// =========================================================================

function byId(id: string): any {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzone-text');
const fileInput = document.getElementById('file-input');

const el = {
  themeToggle: byId('theme-toggle'),
  tickerCount: byId('ticker-count'),
  subtitle: byId('app-subtitle'),
  searchInput: byId('search-input'),
  searchClearBtn: byId('search-clear-btn'),
  tabsBar: byId('tabs-bar'),
  selectedTabsPanel: byId('selected-tabs-panel'),
  selectedTabsBar: byId('selected-tabs-bar'),
  copyBtn: byId('copy-btn'),
  exportCsvBtn: byId('export-csv-btn'),
  exportTxtBtn: byId('export-txt-btn'),
  resetBtn: byId('reset-btn'),
  blacklistBtn: byId('blacklist-btn'),
  blacklistPanel: byId('blacklist-panel'),
  blacklistInput: byId('blacklist-input'),
  blacklistAddBtn: byId('blacklist-add-btn'),
  blacklistClearBtn: byId('blacklist-clear-btn'),
  blacklistChips: byId('blacklist-chips'),
  blacklistEmpty: byId('blacklist-empty'),
  tableHead: byId('table-head'),
  tableBody: byId('table-body'),
  tableScroll: byId('table-scroll'),
  staticLoadSentinel: byId('static-load-sentinel'),
  staticLoadStatus: byId('static-load-status'),
};

type AppState = {
  funds: FundRow[];
  selected: Set<string>;
  blacklist: Set<string>;
  activeTab: ActiveTab;
  activeFundTicker: string | null;
  queryByTab: Record<string, string>;
  sortKey: string;
  sortDir: SortDirection;
  // Last sort the user explicitly chose (column-header click) per tab. Tab
  // switches restore it instead of falling back to the tab default, so an
  // All ETFs sort like "YTD Return" survives Watchlist / detail round trips.
  sortByTab: Record<string, { key: string; dir: SortDirection }>;
  generatedAt: string | null;
  counts: { funds: number; holdings: number; history: number } | null;
};

const state: AppState = {
  funds: [],
  selected: new Set(),
  blacklist: new Set(),
  activeTab: 'All',
  activeFundTicker: null,
  queryByTab: {},
  sortKey: 'rank',
  sortDir: 'asc',
  sortByTab: {},
  generatedAt: null,
  counts: null,
};

// Holdings pipeline bookkeeping (see docs/ui-contract.md §4–§6):
// per-ticker in-flight meta.json dedupe, one serialized page-load chain per
// ticker (the detail-view pager and the background Watchlist loader share it,
// so pages can never be fetched twice or skipped), per-ticker completion
// flags powering the Watchlist "Loading… / N+" label, and the chunked
// Watchlist rendering cursor.
const metaInFlight: Map<string, Promise<any>> = new Map();
const holdingsChains: Map<string, Promise<void>> = new Map();
const holdingsComplete = new Set<string>();
let watchlistChunkSig = '';
let watchlistRenderedCount = 0;
let watchlistRefreshTimer: any = null;

// Lazy per-fund data: meta.json plus accumulated sheet pages (iShares-style).
type SheetEntry = {
  headers: string[];
  rows: string[][];
  nextPage: number;
  manifest: any;
  loading: boolean;
};

const fundMetaCache: Map<string, any> = new Map();
const sheetState: Map<string, SheetEntry> = new Map();
let sheetGeneration = 0;

init();

// =========================================================================
// 3. Theme & small helpers
// =========================================================================

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  el.themeToggle.textContent = dark ? '☀️' : '🌙';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char] || char));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === '-') return null;
  const parsed = Number(value.replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberCell(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null ? '' : String(parsed);
}

function formatPercent(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null ? '—' : `${parsed.toFixed(2)}%`;
}

function formatDividendFrequency(value: unknown): string {
  const raw = String(value ?? '').trim();
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
  if (!normalized || normalized === '-') return '00 - —';
  if (normalized === 'monthly') return '01 - Monthly';
  if (normalized === 'quarterly') return '04 - Quarterly';
  if (normalized === 'semi-annual' || normalized === 'semi-annually' || normalized === 'semiannual') return '06 - Semi-annually';
  if (normalized === 'annual' || normalized === 'annually') return '12 - Annually';
  if (normalized === 'none') return '00 - None';
  if (normalized === 'unknown') return '00 - Unknown';
  if (normalized === 'irregular') return '99 - Irregular';
  return raw;
}

function formatInteger(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null || parsed === 0 ? '—' : parsed.toLocaleString('en-US');
}

function formatMoney(value: unknown): string {
  const parsed = numberOrNull(value);
  if (parsed === null) return '—';
  if (Math.abs(parsed) >= 1e12) return `$${(parsed / 1e12).toFixed(2)}T`;
  if (Math.abs(parsed) >= 1e9) return `$${(parsed / 1e9).toFixed(2)}B`;
  if (Math.abs(parsed) >= 1e6) return `$${(parsed / 1e6).toFixed(2)}M`;
  if (Math.abs(parsed) >= 1e3) return `$${(parsed / 1e3).toFixed(2)}K`;
  return `$${parsed.toFixed(2)}`;
}

function sanitizeTicker(value: unknown): string {
  return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function getHeaderTooltip(header: string): string {
  if (!header) return '';
  if (COLUMN_TOOLTIPS[header]) return COLUMN_TOOLTIPS[header];
  const clean = String(header).trim();
  const keys = Object.keys(COLUMN_TOOLTIPS);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key.toLowerCase() === clean.toLowerCase()) return COLUMN_TOOLTIPS[key];
  }
  return clean;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function downloadText(text: string, fileName: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows: string[][]): string {
  return rows
    .map(row => row.map(cell => {
      const value = String(cell ?? '');
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(','))
    .join('\n');
}

function exportFileName(scope: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `proshares-${scope.toLowerCase().replace(/\s+/g, '-')}-${stamp}.${extension}`;
}

function setStatus(message: string, tone: 'info' | 'success' | 'error'): void {
  console.debug(`[${tone}] ${message}`);
}

// =========================================================================
// 4. Static API loading & paginated sheets (api/proshares/**, iShares-style)
// =========================================================================

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** Flattens index.json month-end metrics onto the row so sorting works. */
function normalizeFundRow(fund: IndexFund): FundRow {
  const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
  const metrics = fund.metrics || {};
  const row: any = {
    ...fund,
    ytd: monthEnd.ytd ?? null,
    yr1: metrics.tr1y ?? monthEnd.yr1 ?? null,
    yr3: monthEnd.yr3 ?? null,
    yr5: monthEnd.yr5 ?? null,
    yr10: monthEnd.yr10 ?? null,
    si: metrics.siAnn ?? monthEnd.sinceInception ?? null,
    tr3y: metrics.tr3y ?? null,
    tr5y: metrics.tr5y ?? null,
    tr10y: metrics.tr10y ?? null,
    cagr3y: metrics.cagr3y ?? monthEnd.yr3 ?? null,
    cagr5y: metrics.cagr5y ?? monthEnd.yr5 ?? null,
    cagr10y: metrics.cagr10y ?? monthEnd.yr10 ?? null,
    dividendYield: metrics.dividendYield ?? null,
    dividendFrequency: formatDividendFrequency(fund.distributions && fund.distributions.frequency ? fund.distributions.frequency : '—'),
    secYield: metrics.secYield ?? null, // ProShares publishes no 30-day SEC yield: null renders as "—".
    returnAsOf: monthEnd.asOfDate ?? null,
    searchIndex: '',
  };
  row.searchIndex = [
    fund.ticker, fund.name, fund.category, fund.ter, fund.nav, fund.aum,
    fund.exchange, fund.inceptionDate, fund.asOfDate, monthEnd.asOfDate,
    fund.distributions && fund.distributions.frequency, metrics.dividendYieldText, metrics.secYieldText,
    fund.cusip, fund.isin,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
  return row;
}

async function loadCatalog(): Promise<void> {
  setStatus('Loading ProShares ETF data from api/proshares/index.json…', 'info');
  const data = await fetchJson(INDEX_URL);
  state.funds = (data.funds || [])
    .map((fund: IndexFund) => normalizeFundRow(fund))
    .sort((a: FundRow, b: FundRow) => a.ticker.localeCompare(b.ticker));
  state.generatedAt = data.generatedAt || null;
  state.counts = data.counts || null;

  // A restored selection/blacklist must reference known funds only.
  state.blacklist = new Set([...state.blacklist].filter(ticker => state.funds.some(fund => fund.ticker === ticker)));
  state.selected = new Set([...state.selected].filter(ticker => state.funds.some(fund => fund.ticker === ticker) && !state.blacklist.has(ticker)));
  if (!state.activeFundTicker && state.selected.size) state.activeFundTicker = [...state.selected][0] || null;
  if (state.activeFundTicker && !state.selected.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }

  el.searchInput.disabled = false;
  [el.copyBtn, el.exportCsvBtn, el.exportTxtBtn, el.resetBtn].forEach(button => { button.disabled = false; });
  applyRestoredTab();
  applySortForTab(state.activeTab);
  render();
  void ensureHoldingsForSelection();
  const activeTicker = state.activeFundTicker;
  if (activeTicker) {
    void loadFundMeta(activeTicker).then(meta => {
      if (meta && state.activeTab === 'detail:holdings') void ensureSheet('holdings', meta.holdings);
    });
  }
}

/**
 * meta.json requests are deduplicated per ticker while in flight: the
 * detail view and the background Watchlist loader share one request.
 * Catalog-only funds (no holdings, no history) short-circuit to null and
 * are cached as such; failed fetches are not cached so they can retry.
 */
async function loadFundMeta(ticker: string): Promise<any> {
  const cached = fundMetaCache.get(ticker);
  if (cached !== undefined) return cached;
  const inflight = metaInFlight.get(ticker);
  if (inflight) return inflight;
  const known = state.funds.find(fund => fund.ticker === ticker);
  if (known && !known.holdings && !known.history) {
    fundMetaCache.set(ticker, null); // catalog-only fund: no workbook exists
    return null;
  }
  const request = (async () => {
    try {
      const meta = await fetchJson(`./api/proshares/funds/${encodeURIComponent(ticker)}/meta.json`);
      fundMetaCache.set(ticker, meta);
      return meta;
    } catch (error) {
      console.warn(`Failed to load meta.json for ${ticker}:`, error);
      return null;
    }
  })();
  metaInFlight.set(ticker, request.finally(() => metaInFlight.delete(ticker)));
  return metaInFlight.get(ticker);
}

function sheetKey(sheet: string): string {
  return `${state.activeFundTicker}:${sheet}`;
}

function resetSheetPaging(): void {
  sheetGeneration += 1;
}

async function fetchPage(ticker: string, pagePath: string): Promise<{ headers: string[]; rows: string[][] }> {
  const path = String(pagePath).replace(/^\.?\//, '');
  const page = await fetchJson(`./api/proshares/funds/${encodeURIComponent(ticker)}/${path}`);
  const headers: string[] = Array.isArray(page.headers) ? page.headers : [];
  const rows: any[] = Array.isArray(page.rows) ? page.rows : [];
  return { headers, rows: rows.map(row => headers.map(header => String(row[header] ?? ''))) };
}

/** Loads the first page of a paginated sheet and prepares lazy appending. */
async function ensureSheet(sheet: 'holdings' | 'history', manifest: any): Promise<void> {
  const key = sheetKey(sheet);
  if (sheetState.has(key) || !manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) return;
  sheetState.set(key, { headers: [], rows: [], nextPage: 0, manifest, loading: false });
  await loadNextSheetPage(sheet);
}

/**
 * Serializes page-load work per ticker: the detail-view pager and the
 * background Watchlist loader enqueue onto the same chain, and each unit of
 * work re-checks `nextPage` while holding the chain — so two rapid selection
 * updates can never fetch the same holdings page twice or skip one.
 */
function withTickerChain<T>(ticker: string, fn: () => Promise<T>): Promise<T> {
  const previous = holdingsChains.get(ticker) ?? Promise.resolve();
  const work = previous.then(fn, fn);
  holdingsChains.set(ticker, work.catch(() => undefined));
  return work;
}

/** Fetches the next page of `entry`. The caller must already hold the
 *  per-ticker chain (loadAllHoldingsForTicker) or use appendSheetPage. */
async function fetchNextSheetPage(ticker: string, entry: SheetEntry): Promise<void> {
  if (entry.nextPage >= entry.manifest.pages.length) return;
  const page = await fetchPage(ticker, entry.manifest.pages[entry.nextPage]);
  if (!entry.headers.length && page.headers.length) entry.headers = page.headers;
  entry.rows = entry.rows.concat(page.rows);
  entry.nextPage += 1;
}

/** Enqueues the next page fetch of `entry` under the per-ticker chain (no-op when the manifest is exhausted). */
function appendSheetPage(ticker: string, entry: SheetEntry): Promise<void> {
  return withTickerChain(ticker, () => fetchNextSheetPage(ticker, entry));
}

async function loadNextSheetPage(sheet: 'holdings' | 'history'): Promise<void> {
  const key = sheetKey(sheet);
  const entry = sheetState.get(key);
  const ticker = state.activeFundTicker;
  if (!entry || !ticker || entry.loading || entry.nextPage >= entry.manifest.pages.length) return;
  entry.loading = true;
  renderStaticLoadSentinel();
  try {
    const generation = sheetGeneration;
    await appendSheetPage(ticker, entry);
    if (generation !== sheetGeneration) return;
    if (state.activeTab === `detail:${sheet}`) render();
  } catch (error) {
    console.error(`Failed to load ${ticker} ${sheet} page:`, error);
  } finally {
    entry.loading = false;
    renderStaticLoadSentinel();
  }
}

/** True while any selected ETF's holdings have not finished loading. */
function isHoldingsLoading(): boolean {
  for (const ticker of state.selected) {
    if (!holdingsComplete.has(ticker)) return true;
  }
  return false;
}

/**
 * Loads every holdings page of one ticker. Runs inside the per-ticker chain,
 * so it composes safely with the detail-view pager (shared cache entry, no
 * duplicate or skipped pages). Queued work for an ETF that was deselected in
 * the meantime is skipped; in-flight loads finish into the cache and are
 * ignored by the aggregation, which only reads the current selection.
 */
async function loadAllHoldingsForTicker(ticker: string): Promise<void> {
  await withTickerChain(ticker, async () => {
    if (!state.selected.has(ticker)) return; // deselected while queued: skip
    const meta = await loadFundMeta(ticker);
    if (!meta || !meta.holdings || !Array.isArray(meta.holdings.pages) || !meta.holdings.pages.length) return;
    const key = `${ticker}:holdings`;
    let entry = sheetState.get(key);
    if (!entry) {
      entry = { headers: [], rows: [], nextPage: 0, manifest: meta.holdings, loading: false };
      sheetState.set(key, entry);
    }
    while (entry.nextPage < entry.manifest.pages.length) {
      if (!state.selected.has(ticker)) return; // deselected mid-load: skip the rest
      await fetchNextSheetPage(ticker, entry); // chain already held: no re-queue
    }
  });
}

/**
 * Watchlist aggregation needs every holdings page of every selected ETF
 * (same pipeline as daggerok/iShares). Runs with bounded concurrency (6
 * funds at a time) so a whole-catalog selection cannot overload the static
 * feed; Watchlist holdings are cached under each fund's own key,
 * independent of the active fund.
 */
async function ensureHoldingsForSelection(): Promise<void> {
  const queue = [...state.selected].filter(ticker => !holdingsComplete.has(ticker));
  if (!queue.length) return;
  const workers = Array.from({ length: Math.min(HOLDINGS_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const ticker = queue.shift();
      if (!ticker) break;
      try {
        await loadAllHoldingsForTicker(ticker);
      } catch (error) {
        console.error(`Failed to load ${ticker} holdings:`, error);
      } finally {
        holdingsComplete.add(ticker);
        if (state.selected.size > 0) {
          // Keep the Watchlist tab label honest (Loading… -> N+ -> exact)
          // even while the user stays on another tab.
          if (state.activeTab === 'watchlist') scheduleWatchlistRefresh();
          else renderTabs();
        }
      }
    }
  });
  await Promise.all(workers);
  if (state.selected.size > 0) {
    if (state.activeTab === 'watchlist') renderWatchlistTable();
    else renderTabs();
  }
}

/** Progressive Watchlist rerenders are throttled (~150 ms) while rows stream in. */
function scheduleWatchlistRefresh(): void {
  if (state.activeTab !== 'watchlist') return;
  if (watchlistRefreshTimer !== null) return;
  watchlistRefreshTimer = setTimeout(() => {
    watchlistRefreshTimer = null;
    if (state.activeTab === 'watchlist') renderWatchlistTable();
  }, 150);
}

function activeSheetTab(): 'holdings' | 'history' | null {
  if (state.activeTab === 'detail:holdings') return 'holdings';
  if (state.activeTab === 'detail:history') return 'history';
  return null;
}

function maybeLoadMoreRows(): void {
  const sheet = activeSheetTab();
  if (!sheet) return;
  void loadNextSheetPage(sheet);
}

function renderStaticLoadSentinel(): void {
  const sheet = activeSheetTab();
  if (!sheet || !state.activeFundTicker) {
    el.staticLoadSentinel.classList.add('hidden');
    return;
  }
  const entry = sheetState.get(sheetKey(sheet));
  if (!entry) {
    el.staticLoadSentinel.classList.add('hidden');
    return;
  }
  const more = entry.nextPage < entry.manifest.pages.length;
  el.staticLoadSentinel.classList.toggle('hidden', !more);
  el.staticLoadStatus.textContent = entry.loading ? 'Loading more rows…' : more ? 'Scroll or click to load more rows…' : '';
}

// =========================================================================
// 5. Navigation tabs & tab switching
// =========================================================================

function categoryLabel(category: string): string {
  return category || 'ETF';
}

function uniqueCategories(): string[] {
  const categories = [...new Set(state.funds.map(fund => fund.category).filter(Boolean))];
  return categories.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function visibleFunds(): FundRow[] {
  const tab = isEtfCatalogTab(state.activeTab) ? state.activeTab : 'All';
  return state.funds.filter(fund => (tab === 'All' || fund.category === tab) && !state.blacklist.has(fund.ticker));
}

function getTabs(): TabInfo[] {
  const tabs: TabInfo[] = [];
  tabs.push({ id: 'All', label: 'All ETFs', count: state.funds.filter(fund => !state.blacklist.has(fund.ticker)).length });
  uniqueCategories().forEach(category => {
    tabs.push({
      id: category,
      label: categoryLabel(category),
      count: state.funds.filter(fund => fund.category === category && !state.blacklist.has(fund.ticker)).length,
    });
  });
  return tabs;
}

function getSelectedTabs(): TabInfo[] {
  const tabs: TabInfo[] = [];
  const activeFund = getActiveFund();

  if (activeFund) {
    DETAIL_TABS.forEach(tab => {
      tabs.push({
        id: `detail:${tab.key}`,
        label: tab.key === 'overview' ? `${activeFund.ticker} ${tab.label}` : tab.label,
        count: getDetailCount(tab.key),
      });
    });
  }

  if (state.selected.size > 0) {
    const rowCount = getDedupedWatchlistRows().length;
    // While holdings are still loading, never show a misleading exact count:
    // "Loading…" (nothing aggregated yet) or "N+" (partial aggregation that
    // can only grow). The exact deduplicated count appears on completion.
    const count = isHoldingsLoading() ? (rowCount ? `${rowCount}+` : 'Loading…') : rowCount;
    tabs.push({ id: 'watchlist', label: 'Watchlist', count });
  }

  return tabs;
}

function getAllTabIds(): ActiveTab[] {
  return [...getTabs(), ...getSelectedTabs()].map(tab => tab.id);
}

function getActiveFund(): FundRow | null {
  if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) return null;
  return state.funds.find(fund => fund.ticker === state.activeFundTicker) || null;
}

function getDetailCount(key: string): number {
  const activeFund = getActiveFund();
  if (!activeFund) return 0;
  if (key === 'holdings') return activeFund.holdings || 0;
  if (key === 'history') return activeFund.history || 0;
  if (key === 'distributions') {
    const meta = fundMetaCache.get(activeFund.ticker);
    return meta && meta.distributions && Array.isArray(meta.distributions.rows) ? meta.distributions.rows.length : 0;
  }
  return 0;
}

function ensureValidTab(): void {
  const tabIds = getAllTabIds();
  if (!tabIds.includes(state.activeTab)) {
    state.activeTab = 'All';
    applySortForTab(state.activeTab);
  }
}

function applyRestoredTab(): void {
  const tabIds = getAllTabIds();
  if (!tabIds.includes(state.activeTab)) state.activeTab = 'All';
  syncSearchInput();
}

function renderTabs(): void {
  renderTabButtons(el.tabsBar, getTabs());
  const selectedTabs = getSelectedTabs();
  el.selectedTabsPanel.classList.toggle('is-visible', selectedTabs.length > 0);
  renderTabButtons(el.selectedTabsBar, selectedTabs);
}

function renderTabButtons(container: any, tabs: TabInfo[]): void {
  container.classList.toggle('hidden', tabs.length <= 1);
  // All ETFs pill checkbox: checked iff EVERY non-blacklisted catalog ETF is
  // selected (.every over the whole catalog, never a size comparison).
  const catalogFunds = state.funds.filter(fund => !state.blacklist.has(fund.ticker));
  const allSelected = catalogFunds.length > 0 && catalogFunds.every(fund => state.selected.has(fund.ticker));
  container.innerHTML = tabs.map(tab => {
    const isActive = tab.id === state.activeTab;
    const activeClasses = 'bg-blue-600 text-white font-medium border-blue-500 shadow-sm';
    const inactiveClasses = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 border-slate-200 dark:border-slate-700';
    if (tab.id === 'All') {
      return `
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
          <input type="checkbox" id="select-all-toggle" ${allSelected ? 'checked' : ''} class="w-3.5 h-3.5 accent-blue-600 cursor-pointer" title="Select / Deselect all ETFs" />
          <button data-tab="All" class="font-medium hover:underline focus:outline-none">
            ${escapeHtml(tab.label)} (${tab.count})
          </button>
        </div>
      `;
    }
    return `
      <button
        data-tab="${escapeHtml(tab.id)}"
        class="px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
        ${escapeHtml(tab.label)} (${tab.count})
      </button>
    `;
  }).join('');

  container.querySelectorAll('button[data-tab]').forEach((button: any) => {
    button.addEventListener('click', () => {
      const next = button.dataset.tab || 'All';
      // Transition guard: leave the current tab's search query saved before
      // the destination tab restores its own (never overwrite when staying
      // on the same tab, e.g. at boot before DOM hydration).
      if (state.activeTab && state.activeTab !== next) saveActiveTabQuery();
      state.activeTab = next;
      // Coming back to a tab (e.g. All ETFs after visiting Watchlist) must
      // show the sort the user last chose there, not the tab default.
      applySortForTab(state.activeTab);
      resetSheetPaging();
      syncSearchInput();
      persistSiteState();
      render();
      maybeLoadMoreRows();
    });
  });

  const selectAllToggle = container.querySelector('#select-all-toggle');
  if (selectAllToggle) {
    selectAllToggle.addEventListener('change', (event: any) => {
      event.stopPropagation();
      // All ETFs pill: whole non-blacklisted catalog from any tab, no navigation.
      toggleAllCatalogEfts(Boolean(event.target.checked));
    });
    selectAllToggle.addEventListener('click', (event: any) => event.stopPropagation());
  }
}

function applyDefaultSortForTab(tab: ActiveTab): void {
  if (tab === 'watchlist') {
    state.sortKey = 'weightSum';
    state.sortDir = 'desc';
  } else if (tab === 'detail:overview') {
    state.sortKey = 'section';
    state.sortDir = 'asc';
  } else {
    // Holdings, History and Distributions arrive already ordered by the
    // source workbook (weight / date); keep the source order by default.
    state.sortKey = 'rank';
    state.sortDir = 'asc';
  }
}

/**
 * Restores the sort the user last chose on this tab (recorded on every
 * column-header click, persisted in localStorage) or falls back to the tab
 * default when the tab was never explicitly sorted.
 */
function applySortForTab(tab: ActiveTab): void {
  const remembered = state.sortByTab[tab];
  if (remembered) {
    state.sortKey = remembered.key;
    state.sortDir = remembered.dir;
    return;
  }
  applyDefaultSortForTab(tab);
}

/** Records the current sort as this tab's remembered sort. */
function rememberSortForCurrentTab(): void {
  state.sortByTab[state.activeTab] = { key: state.sortKey, dir: state.sortDir };
  persistTabSorts();
}

function tabLabel(tab: ActiveTab): string {
  const match = /^detail:(.+)$/.exec(tab);
  if (match) {
    const found = DETAIL_TABS.find(item => item.key === match[1]);
    return found ? found.label : tab;
  }
  return tab === 'watchlist' ? 'Watchlist' : categoryLabel(tab);
}

function isEtfCatalogTab(tab: ActiveTab): boolean {
  return tab === 'All' || uniqueCategories().includes(tab);
}

function isDetailTab(tab: ActiveTab): boolean {
  return /^detail:(overview|holdings|history|distributions)$/.test(tab);
}

function detailTabKey(tab: ActiveTab): string {
  const match = /^detail:(.+)$/.exec(tab);
  return match ? match[1] : 'overview';
}

// =========================================================================
// 6. Table rendering, sorting & tooltips
// =========================================================================

function render(): void {
  ensureValidTab();
  updateSearchClearBtn();
  renderTabs();
  renderBlacklistPanel();
  animateTableUpdate();
  if (state.activeTab === 'watchlist') renderWatchlistTable();
  else if (isDetailTab(state.activeTab)) renderDetailTable(detailTabKey(state.activeTab));
  else renderFundsTable();
  fitTableHeight();
  renderStaticLoadSentinel();
}

function animateTableUpdate(): void {
  el.tableBody.classList.remove('table-content-enter');
  void el.tableBody.offsetWidth; // reflow to restart the animation
  el.tableBody.classList.add('table-content-enter');
}

function currentQuery(): string {
  return state.queryByTab[state.activeTab] || '';
}

function setCurrentQuery(value: string): void {
  if (value) state.queryByTab[state.activeTab] = value;
  else delete state.queryByTab[state.activeTab];
  persistSearches();
}

/** Transition guard: stores the current input text under the tab being left. */
function saveActiveTabQuery(): void {
  const query = (el.searchInput.value || '').trim();
  if (query) state.queryByTab[state.activeTab] = query;
  else delete state.queryByTab[state.activeTab];
  persistSearches();
}

/** 1-click clear button visibility: shown iff the input has text. */
function updateSearchClearBtn(): void {
  el.searchClearBtn.classList.toggle('hidden', !el.searchInput.value);
}

function syncSearchInput(): void {
  const query = currentQuery();
  if (document.activeElement !== el.searchInput && el.searchInput.value !== query) {
    el.searchInput.value = query;
  }
  el.searchInput.placeholder = isEtfCatalogTab(state.activeTab)
    ? 'Search ETFs, fund names, holdings, tickers, CUSIPs/ISINs, SEDOLs...'
    : `Search ${tabLabel(state.activeTab)}...`;
  updateSearchClearBtn();
}

function filterRows(rows: any[]): any[] {
  const query = normalizeSearchText(currentQuery());
  if (!query) return rows;
  return rows.filter(row => String(row.searchIndex || '').includes(query));
}

function sortValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function compareValues(a: unknown, b: unknown): number {
  const an = numberOrNull(a);
  const bn = numberOrNull(b);
  if (an !== null && bn !== null) return an - bn;
  const as = String(a ?? '');
  const bs = String(b ?? '');
  // History dates ("Aug 21 2026") sort chronologically.
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(as) || /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(bs)) {
    const ad = Date.parse(as.replace(/-/g, ' '));
    const bd = Date.parse(bs.replace(/-/g, ' '));
    if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
  }
  return as.localeCompare(bs, undefined, { numeric: true });
}

function sortRows(rows: any[]): any[] {
  if (state.sortKey === 'rank') return rows;
  const direction = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  return [...rows].sort((a, b) => compareValues(sortValue(a, key), sortValue(b, key)) * direction);
}

// `extraClass` is opt-in and only used by the All ETFs catalog for its
// horizontally pinned columns (`Use` + `Ticker`). Every other call site
// (Watchlist, Overview, Distributions, generic sheet views) omits it and
// renders exactly as before. See the `catalog-sticky-*` rules in index.html.
function sortHeader(label: string, key: string, numeric = false, extraClass = ''): string {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const align = numeric ? ' text-right' : '';
  const tooltip = getHeaderTooltip(label);
  return `<th class="py-3.5 px-4${align}${extraClass ? ' ' + extraClass : ''}" title="${escapeHtml(tooltip)}"><button data-sort="${escapeHtml(key)}" title="${escapeHtml(tooltip)}" class="uppercase tracking-wider hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:text-blue-600 dark:focus:text-blue-400">${escapeHtml(label)}${arrow}</button></th>`;
}

function indexHeader(): string {
  return `<th class="py-3.5 px-4 w-12 text-center" title="${escapeHtml(getHeaderTooltip('#'))}">#</th>`;
}

/**
 * The rows the catalog table actually renders: catalog tab + active search
 * filter + blacklist exclusion. This is the exact scope of the header Use
 * checkbox (checked state is `.every(...)` over these rows, never a
 * selection-size comparison).
 */
function visibleCatalogRows(): FundRow[] {
  return filterRows(visibleFunds());
}

// Only the All ETFs catalog uses this header (single call site), so the
// horizontal pin is hard-coded here rather than parameterized.
function useHeader(): string {
  const rows = visibleCatalogRows();
  const allSelected = rows.length > 0 && rows.every(fund => state.selected.has(fund.ticker));
  return `<th class="catalog-sticky-col catalog-sticky-use py-3.5 px-4 w-20 text-center" title="${escapeHtml(getHeaderTooltip('Use'))}">
    <div class="inline-flex items-center justify-center gap-1">
      <input type="checkbox" id="select-all-checkbox" ${allSelected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" title="Select / Deselect all visible ETFs" />
      <span>Use</span>
    </div>
  </th>`;
}

function bindSortHeaders(): void {
  el.tableHead.querySelectorAll('button[data-sort]').forEach((button: any) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort || 'rank';
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else {
        state.sortKey = key;
        state.sortDir = ['ticker', 'name', 'category', 'symbol', 'section', 'metric', 'identifier', 'label'].includes(key) ? 'asc' : 'desc';
      }
      rememberSortForCurrentTab();
      render();
    });
  });
}

function bindSelectAllCheckbox(): void {
  const checkbox = el.tableHead.querySelector('#select-all-checkbox');
  if (!checkbox) return;
  checkbox.addEventListener('change', (event: any) => {
    event.stopPropagation();
    // Header Use checkbox: strictly the visible (filtered) catalog rows.
    toggleVisibleSelection(Boolean(event.target.checked));
  });
  checkbox.addEventListener('click', (event: any) => event.stopPropagation());
}

function renderFundsTable(): void {
  const rows = sortRows(filterRows(visibleFunds()));
  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${useHeader()}
      ${sortHeader('Ticker', 'ticker', false, 'catalog-sticky-col catalog-sticky-ticker')}
      ${sortHeader('Fund Name', 'name')}
      ${sortHeader('Type', 'category')}
      ${sortHeader('NAV', 'navValue', true)}
      ${sortHeader('Net Assets', 'aumValue', true)}
      ${sortHeader('Expense', 'terValue', true)}
      ${sortHeader('Dividend Yield', 'dividendYield', true)}
      ${sortHeader('SEC Yield', 'secYield', true)}
      ${sortHeader('Frequency', 'dividendFrequency')}
      ${sortHeader('YTD Return', 'ytd', true)}
      ${sortHeader('TR 1Y', 'yr1', true)}
      ${sortHeader('TR 3Y', 'tr3y', true)}
      ${sortHeader('TR 5Y', 'tr5y', true)}
      ${sortHeader('TR 10Y', 'tr10y', true)}
      ${sortHeader('CAGR 3Y', 'cagr3y', true)}
      ${sortHeader('CAGR 5Y', 'cagr5y', true)}
      ${sortHeader('CAGR 10Y', 'cagr10y', true)}
      ${sortHeader('SI Ann.', 'si', true)}
      ${sortHeader('Return As Of', 'returnAsOf')}
      ${sortHeader('Inception', 'inceptionDate')}
      ${sortHeader('Holdings', 'holdings', true)}
      ${sortHeader('History', 'history', true)}
      ${sortHeader('As Of', 'asOfDate')}
    </tr>
  `;
  bindSortHeaders();
  bindSelectAllCheckbox();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="25" class="py-12 text-center text-slate-400 dark:text-slate-500">No ETFs match your search.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((fund, index) => {
      const selected = state.selected.has(fund.ticker);
      return `
        <tr data-ticker="${escapeHtml(fund.ticker)}" class="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30 ${selected ? 'selected-row' : ''}">
          <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
          <td class="catalog-sticky-col catalog-sticky-use py-2.5 px-4 text-center">
            <div class="inline-flex items-center justify-center gap-1.5">
              <input data-checkbox="${escapeHtml(fund.ticker)}" type="checkbox" ${selected ? 'checked' : ''} class="w-4 h-4 accent-blue-600" aria-label="Use ${escapeHtml(fund.ticker)}" />
              <button data-blacklist="${escapeHtml(fund.ticker)}" class="w-4 h-4 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 leading-none transition" title="Blacklist ${escapeHtml(fund.ticker)} — hide it from All ETFs">✕</button>
            </div>
          </td>
          <td class="catalog-sticky-col catalog-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(fund.ticker)}</td>
          <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(fund.name)}">${escapeHtml(fund.name)}</td>
          <td class="py-2.5 px-4 text-slate-600 dark:text-slate-300">${escapeHtml(categoryLabel(fund.category))}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.nav || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatMoney(fund.aumValue)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.ter || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.dividendYield)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.secYield)}</td>
          <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">${escapeHtml(fund.dividendFrequency || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.ytd)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.yr1)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr3y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr5y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr10y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr3y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr5y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr10y)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.si)}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.returnAsOf || '—')}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.inceptionDate || '—')}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.holdings)}</td>
          <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.history)}</td>
          <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.asOfDate || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  el.tableBody.querySelectorAll('tr[data-ticker]').forEach((row: any) => {
    row.addEventListener('click', (event: any) => {
      const target: any = event.target;
      if (target.closest('a')) return;
      if (target.closest('button[data-blacklist]')) return;
      toggleFund(row.dataset.ticker || '');
    });
  });

  el.tableBody.querySelectorAll('button[data-blacklist]').forEach((button: any) => {
    button.addEventListener('click', (event: any) => {
      event.stopPropagation();
      blacklistTickers([button.dataset.blacklist || '']);
    });
  });

  const selected = state.selected.size;
  const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
  const activeText = state.activeFundTicker ? ` Active ETF detail tabs are for ${state.activeFundTicker}.` : '';
  setStatus(`Showing ${rows.length} ETF${rows.length === 1 ? '' : 's'}${queryText}. Click rows to select ETFs.${selected ? ` ${selected} selected.` : ' No ETFs selected yet.'}${activeText}`, selected ? 'success' : 'info');
  el.tickerCount.textContent = `${rows.length} ETFs`;
  renderSubtitle();
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

type HoldingPosition = { fund: string; name: string; identifier: string; weight: number; cells: Record<string, unknown> };

const MISSING_TOKENS = new Set(['', '-', '--', '—', '–', 'N/A', 'NA', 'NONE', 'NULL']);

/**
 * Treats blank / dash / N/A-style placeholders as missing. All-zero CUSIPs
 * (published as `000000000` verbatim by some SEC N-PORT filings) also count
 * as missing, so identifier-less rows fall through to the name instead of
 * collapsing into one garbage key.
 */
function cleanKeyPart(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || MISSING_TOKENS.has(text.toUpperCase())) return '';
  if (/^0+$/.test(text)) return '';
  return text.toUpperCase();
}

/**
 * Documented dedupe key fallback order (docs/ui-contract.md §5):
 * Ticker -> CUSIP -> ISIN -> Identifier/Security ID -> SEDOL/FIGI -> Name.
 * Keys are namespaced (T:/C:/I:/D:/S:/N:) so identifier values can never
 * collide with tickers. Numeric local listing tickers (e.g. 005930) are
 * valid tickers, not placeholders. Rows are never aggressively dropped:
 * bonds without exchange tickers, cash positions, derivatives and zero-weight
 * holdings all resolve to a key (the name being the last resort).
 */
function positionDedupeKey(row: Record<string, unknown>): { key: string; shown: string } | null {
  const first = (...values: unknown[]): string => {
    for (const value of values) {
      const clean = cleanKeyPart(value);
      if (clean) return clean;
    }
    return '';
  };
  const ticker = first(row.Ticker, row.Symbol);
  if (ticker) return { key: `T:${ticker}`, shown: ticker };
  const cusip = first(row.CUSIP);
  if (cusip) return { key: `C:${cusip}`, shown: cusip };
  const isin = first(row.ISIN);
  if (isin) return { key: `I:${isin}`, shown: isin };
  const identifier = first(row.Identifier, row['Security ID']);
  if (identifier) return { key: `D:${identifier}`, shown: identifier };
  const sedol = first(row.SEDOL, row.FIGI);
  if (sedol) return { key: `S:${sedol}`, shown: sedol };
  const name = String(row.Name ?? row['Security Name'] ?? '').trim();
  if (name) return { key: `N:${name.toUpperCase()}`, shown: name };
  return null;
}

function sheetPositions(ticker: string): HoldingPosition[] {
  const entry = sheetState.get(`${ticker}:holdings`);
  if (!entry || !entry.headers.length) return [];
  return entry.rows.map(row => {
    // Holding rows carry the exchange ticker resolved at data-build time;
    // bond / private positions have no ticker ("-") and the key falls back
    // through the identifier chain to the published name.
    const cells: Record<string, unknown> = {};
    entry.headers.forEach((header, index) => {
      if (header) cells[header] = row[index] ?? '';
    });
    const weight = numberOrNull(cells.Weight);
    const rawIdentifier = String(cells.Identifier ?? '').trim();
    return {
      fund: ticker,
      name: String(cells.Name ?? '').trim(),
      identifier: cleanKeyPart(rawIdentifier) ? rawIdentifier : '',
      weight: weight === null ? 0 : weight,
      cells,
    };
  });
}

function getSelectedPositions(): HoldingPosition[] {
  return [...state.selected].flatMap(ticker => sheetPositions(ticker));
}

let watchlistCache: { signature: string; rows: WatchlistRow[] } | null = null;

function getDedupedWatchlistRows(): WatchlistRow[] {
  // Memoized: the aggregation is recomputed only when the selection or the
  // loaded row counts change (progressive streaming and tab label updates
  // otherwise re-render many times per second on large selections).
  const tickers = [...state.selected].sort();
  const signature =
    tickers.join('|') +
    '#' +
    tickers.map(ticker => (sheetState.get(`${ticker}:holdings`)?.rows.length ?? 0)).join(',');
  if (watchlistCache && watchlistCache.signature === signature) return watchlistCache.rows;

  const map: Map<string, WatchlistRow> = new Map();
  getSelectedPositions().forEach(position => {
    const resolved = positionDedupeKey(position.cells);
    if (!resolved) return;
    let row = map.get(resolved.key);
    if (!row) {
      row = {
        key: resolved.key,
        symbol: resolved.shown,
        name: position.name,
        funds: [],
        fundCount: 0,
        weightSum: 0,
        maxWeight: 0,
        cusips: [],
        identifier: '',
        searchIndex: '',
      };
      map.set(resolved.key, row);
    }
    if (!row.funds.includes(position.fund)) row.funds.push(position.fund);
    row.weightSum += position.weight;
    row.maxWeight = Math.max(row.maxWeight, position.weight);
    if (position.identifier && !row.cusips.includes(position.identifier)) row.cusips.push(position.identifier);
    if (position.name) row.name = position.name;
  });
  map.forEach(row => {
    row.fundCount = row.funds.length;
    row.funds.sort();
    row.cusips.sort();
    row.identifier = row.cusips[0] || '';
    row.searchIndex = [row.symbol, row.name, row.cusips.join(' '), row.funds.join(' ')].join(' ').toLowerCase();
  });
  const rows = [...map.values()];
  watchlistCache = { signature, rows };
  return rows;
}

function getVisibleWatchlistRows(): WatchlistRow[] {
  return sortRows(filterRows(getDedupedWatchlistRows()));
}

function watchlistChunkSignature(rows: WatchlistRow[]): string {
  return [state.sortKey, state.sortDir, currentQuery(), rows.length, rows.length ? rows[0].key : ''].join('|');
}

/** Scroll/click extension of the rendered Watchlist chunk (bounded DOM). */
function growWatchlistChunk(): void {
  const rows = getVisibleWatchlistRows();
  if (watchlistRenderedCount + WATCHLIST_CHUNK >= rows.length) return;
  watchlistRenderedCount += WATCHLIST_CHUNK;
  renderWatchlistTable();
}

function renderWatchlistTable(): void {
  const rows = getVisibleWatchlistRows();
  const signature = watchlistChunkSignature(rows);
  if (signature !== watchlistChunkSig) {
    watchlistChunkSig = signature;
    watchlistRenderedCount = 0;
  }
  // The complete filtered result drives the counts, Copy Tickers and both
  // exports; only the DOM is chunked. Scrolling grows the mounted slice.
  const visibleRows = rows.slice(0, watchlistRenderedCount + WATCHLIST_CHUNK);
  const hasMore = rows.length > visibleRows.length;
  const loading = state.selected.size > 0 && isHoldingsLoading();

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${sortHeader('Ticker', 'symbol', false, 'watchlist-sticky-col watchlist-sticky-ticker')}
      ${sortHeader('Name', 'name')}
      ${sortHeader('ETFs', 'funds')}
      ${sortHeader('# ETFs', 'fundCount', true)}
      ${sortHeader('Weight Sum', 'weightSum', true)}
      ${sortHeader('Max Weight', 'maxWeight', true)}
      ${sortHeader('Identifier', 'identifier')}
    </tr>
  `;
  bindSortHeaders();

  if (!state.selected.size) {
    el.tableBody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400 dark:text-slate-500">Select ETFs in All ETFs to build the aggregated Watchlist.</td></tr>`;
  } else if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400 dark:text-slate-500">${
      loading
        ? `Loading holdings of ${state.selected.size} selected ETF${state.selected.size === 1 ? '' : 's'}…`
        : 'Holdings data is not available yet. Run bun ./scripts/update-data.ts to refresh the ProShares feed.'
    }${currentQuery() ? ' No rows match your search.' : ''}</td></tr>`;
  } else {
    let html = visibleRows.map((row, index) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        <td class="watchlist-sticky-col watchlist-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(row.symbol)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(row.name)}">${escapeHtml(row.name || '—')}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">
          <div class="flex flex-wrap gap-1 max-w-md">
            ${row.funds.map((ticker: string) => `<a href="javascript:void(0)" data-activate-fund="${escapeHtml(ticker)}" title="Open ${escapeHtml(ticker)} detail tabs" class="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800 rounded-full px-2 py-0.5 hover:underline">${escapeHtml(ticker)}</a>`).join('')}
          </div>
        </td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.fundCount}</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.weightSum.toFixed(3)}%</td>
        <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.maxWeight.toFixed(3)}%</td>
        <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400 text-xs">${escapeHtml(row.identifier || '—')}</td>
      </tr>
    `).join('');
    if (loading) {
      html += `<tr><td colspan="8" class="py-3 text-center text-xs text-slate-400 dark:text-slate-500">Loading holdings of the remaining selected ETFs…</td></tr>`;
    }
    if (hasMore) {
      html += `<tr id="watchlist-more-row" class="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition"><td colspan="8" class="py-3 text-center text-xs text-slate-400 dark:text-slate-500">Scroll or click to load more rows… (${rows.length - visibleRows.length} remaining)</td></tr>`;
    }
    el.tableBody.innerHTML = html;
  }

  el.tableBody.querySelectorAll('a[data-activate-fund]').forEach((link: any) => {
    link.addEventListener('click', (event: any) => {
      event.stopPropagation();
      activateFund(link.dataset.activateFund || '');
    });
  });
  const moreRow = el.tableBody.querySelector('#watchlist-more-row');
  if (moreRow) moreRow.addEventListener('click', () => growWatchlistChunk());

  const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
  setStatus(`Watchlist built from ${state.selected.size} selected ETF${state.selected.size === 1 ? '' : 's'}: ${rows.length} ticker${rows.length === 1 ? '' : 's'}${queryText}. Deduplicated by ticker, or by identifier for bond rows.`, 'success');
  el.tickerCount.textContent = `${rows.length} tickers`;
  renderSubtitle();
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function renderDetailTable(key: string): void {
  const activeFund = getActiveFund();
  if (!activeFund) {
    renderEmptyDetail('Select an ETF row to see ETF details.');
    return;
  }

  if (key === 'overview') return renderOverviewTable(activeFund);
  if (key === 'distributions') return renderDistributionsTable(activeFund);
  return renderSheetTable(activeFund, key === 'history' ? 'history' : 'holdings');
}

function renderEmptyDetail(message: string): void {
  el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Details</th></tr>`;
  el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(message)}</td></tr>`;
  el.tickerCount.textContent = activeDetailTickerText();
}

function activeDetailTickerText(): string {
  return state.activeFundTicker ? `${state.activeFundTicker}` : '0 ETFs';
}

function renderSheetTable(fund: FundRow, sheet: 'holdings' | 'history'): void {
  const catalogCount = sheet === 'holdings' ? fund.holdings : fund.history;
  const entry = sheetState.get(sheetKey(sheet));

  if (!catalogCount) {
    el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">${escapeHtml(fund.ticker)}</th></tr>`;
    el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(fund.ticker)} publishes no ${sheet === 'holdings' ? 'holdings workbook' : 'NAV history workbook'} (catalog-only fund, e.g. a commodity trust).</td></tr>`;
    el.tickerCount.textContent = fund.ticker;
    renderSubtitle(`${fund.ticker} has no current static ${sheet} sheet; the feed records the provider coverage limitation in meta.json.`);
    return;
  }

  if (!entry) {
    // Immediate loading placeholder: the previous fund's table is never left
    // visible while the next fund loads.
    el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Loading…</th></tr>`;
    el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">Loading ${escapeHtml(fund.ticker)} ${sheet}…</td></tr>`;
    el.tickerCount.textContent = fund.ticker;
    void loadFundMeta(fund.ticker).then(meta => {
      if (state.activeTab !== `detail:${sheet}` || state.activeFundTicker !== fund.ticker) return;
      if (!meta) {
        el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-rose-500">Could not load ${escapeHtml(fund.ticker)} data — meta.json is unavailable. Run bun ./scripts/update-data.ts to refresh the feed, then reload.</td></tr>`;
        return;
      }
      void ensureSheet(sheet, sheet === 'holdings' ? meta.holdings : meta.history).then(() => render());
    });
    return;
  }

  const headers = entry.headers;
  const rows = sortRows(filterRows(entry.rows.map((row, sourceIndex) => {
    const cells: Record<string, unknown> = { values: row, searchIndex: row.join(' ').toLowerCase() };
    headers.forEach((header, index) => { cells[`col${index}`] = row[index] ?? ''; });
    cells.rank = sourceIndex;
    return cells;
  })));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${headers.map((header, index) => sortHeader(header || `Col ${index + 1}`, `col${index}`, NUMERIC_SHEET_HEADERS.includes(header))).join('')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="py-12 text-center text-slate-400 dark:text-slate-500">No rows match your search${entry.loading ? ' (still loading…)' : ''}.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => {
      const values: string[] = row.values || [];
      return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        ${values.map((cell, columnIndex) => `
          <td class="py-2.5 px-4 ${NUMERIC_SHEET_HEADERS.includes(headers[columnIndex]) ? 'text-right font-mono text-slate-700 dark:text-slate-300' : 'text-slate-700 dark:text-slate-300'}">${escapeHtml(cell === '' ? '—' : cell)}</td>
        `).join('')}
      </tr>
    `;}).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} ${sheet === 'holdings' ? 'Holdings' : 'NAV History'} — ${entry.rows.length.toLocaleString('en-US')} of ${(entry.manifest.totalRows || 0).toLocaleString('en-US')} rows loaded${entry.manifest.asOfDate ? ` (as of ${entry.manifest.asOfDate})` : ''}.`);
}

function renderOverviewTable(fund: FundRow): void {
  const meta = fundMetaCache.get(fund.ticker);
  const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
  const quarterEnd = (fund.returns && fund.returns.quarterEnd) || {};
  const overview: Array<{ section: string; metric: string; value: unknown }> = [
    { section: 'Fund', metric: 'Ticker', value: fund.ticker },
    { section: 'Fund', metric: 'Fund Name', value: fund.name },
    { section: 'Fund', metric: 'Asset Class', value: categoryLabel(fund.category) },
    { section: 'Fund', metric: 'Inception', value: fund.inceptionDate },
    { section: 'Fund', metric: 'Exchange', value: fund.exchange },
    { section: 'Fund', metric: 'Fund Page', value: fund.fundPage },
    { section: 'Fund', metric: 'CUSIP', value: meta && meta.identifiers ? meta.identifiers.cusip : null },
    { section: 'Fund', metric: 'ISIN', value: meta && meta.identifiers ? meta.identifiers.isin : null },
    { section: 'Fund', metric: 'Benchmark Index', value: meta && meta.identifiers ? meta.identifiers.indexTicker : null },
    { section: 'Fund', metric: 'Benchmark Index Name', value: meta && meta.identifiers ? meta.identifiers.indexName : null },
    { section: 'Fund', metric: 'Exchange Source', value: meta && meta.source ? meta.source.exchangeSource : null },
    { section: 'Fund', metric: 'Finder Verified', value: meta && meta.source ? meta.source.finderVerifiedAt : null },
    { section: 'Documents', metric: 'Fact Sheet', value: meta && meta.documents ? meta.documents.factSheet : null },
    { section: 'Documents', metric: 'Summary Prospectus', value: meta && meta.documents ? meta.documents.summaryProspectus : null },
    { section: 'Documents', metric: 'Statutory Prospectus', value: meta && meta.documents ? meta.documents.statutoryProspectus : null },
    { section: 'Documents', metric: 'SAI', value: meta && meta.documents ? meta.documents.sai : null },
    { section: 'Documents', metric: 'Annual Report', value: meta && meta.documents ? meta.documents.annualReport : null },
    { section: 'Documents', metric: 'Semi-Annual Report', value: meta && meta.documents ? meta.documents.semiAnnualReport : null },
    { section: 'Fund', metric: 'Holdings Source', value: meta && meta.source ? meta.source.holdingsSource : null },
    { section: 'Fund', metric: 'History Source', value: meta && meta.source ? meta.source.historySource : null },
    { section: 'Fund', metric: 'Provider', value: meta && meta.source ? meta.source.provider : null },
    { section: 'Cost', metric: 'Expense Ratio (Net)', value: fund.ter },
    { section: 'Cost', metric: 'Gross Expense Ratio', value: meta && meta.expenseRatio && meta.expenseRatio.gross ? meta.expenseRatio.gross.display : null },
    { section: 'Price', metric: 'NAV', value: fund.nav },
    { section: 'Price', metric: 'Close Price', value: fund.closePrice },
    { section: 'Price', metric: 'Premium / Discount', value: fund.premiumDiscount },
    { section: 'Price', metric: 'As Of', value: fund.asOfDate },
    { section: 'Assets', metric: 'Net Assets', value: formatMoney(fund.aumValue) },
    { section: 'Assets', metric: 'Net Assets (published)', value: fund.aum },
    { section: 'Returns', metric: 'Month-End As Of', value: monthEnd.asOfDate },
    { section: 'Returns', metric: 'YTD (ME)', value: formatPercent(monthEnd.ytd) },
    { section: 'Returns', metric: '1Y (ME)', value: formatPercent(monthEnd.yr1) },
    { section: 'Returns', metric: '3Y CAGR (ME)', value: formatPercent(monthEnd.yr3) },
    { section: 'Returns', metric: '5Y CAGR (ME)', value: formatPercent(monthEnd.yr5) },
    { section: 'Returns', metric: '10Y CAGR (ME)', value: formatPercent(monthEnd.yr10) },
    { section: 'Returns', metric: 'SI Ann. (ME)', value: formatPercent(monthEnd.sinceInception) },
    { section: 'Returns', metric: 'Quarter-End As Of', value: quarterEnd.asOfDate },
    { section: 'Returns', metric: 'YTD (QE)', value: formatPercent(quarterEnd.ytd) },
    { section: 'Returns', metric: '1Y (QE)', value: formatPercent(quarterEnd.yr1) },
    { section: 'Returns', metric: '3Y CAGR (QE)', value: formatPercent(quarterEnd.yr3) },
    { section: 'Returns', metric: '5Y CAGR (QE)', value: formatPercent(quarterEnd.yr5) },
    { section: 'Returns', metric: '10Y CAGR (QE)', value: formatPercent(quarterEnd.yr10) },
    { section: 'Returns', metric: 'SI Ann. (QE)', value: formatPercent(quarterEnd.sinceInception) },
    { section: 'Distributions', metric: 'Frequency', value: fund.distributions ? fund.distributions.frequency : null },
    { section: 'Distributions', metric: 'Ex-Date', value: fund.distributions ? fund.distributions.exDate : null },
    { section: 'Distributions', metric: 'Latest Dividend', value: fund.distributions ? fund.distributions.dividend : null },
    { section: 'Distributions', metric: 'Dividend Yield', value: meta && meta.yields && meta.yields.dividendYieldText ? meta.yields.dividendYieldText : (fund.dividendYield === null || fund.dividendYield === undefined ? null : `${fund.dividendYield.toFixed(2)}%`) },
    { section: 'Distributions', metric: 'Distribution Yield (official)', value: meta && meta.yields ? meta.yields.distributionYieldText : null },
    { section: 'Distributions', metric: '12-Month Yield', value: meta && meta.yields ? meta.yields.yield12MText : null },
    { section: 'Distributions', metric: 'Indicated Yield', value: meta && meta.yields ? meta.yields.indicatedYieldText : null },
    { section: 'Distributions', metric: 'SEC Yield (30-day)', value: meta && meta.yields ? (meta.yields.secYieldText || '—') : (fund.secYield === null || fund.secYield === undefined ? 'not published by ProShares for its ETFs' : `${fund.secYield.toFixed(2)}%`) },
    { section: 'Distributions', metric: 'Dividend Yield Basis', value: meta && meta.yields ? meta.yields.dividendYieldKind : null },
    { section: 'Distributions', metric: 'SEC Yield Basis', value: meta && meta.yields ? meta.yields.secYieldKind : null },
    { section: 'Holdings', metric: 'Holdings Rows', value: fund.holdings },
    { section: 'Holdings', metric: 'Holdings As Of', value: meta && meta.holdings ? meta.holdings.asOfDate : null },
    { section: 'Holdings', metric: 'History Rows', value: fund.history },
  ];
  const rows = sortRows(filterRows(overview.map(item => ({
    section: item.section,
    metric: item.metric,
    value: item.value === null || item.value === undefined || item.value === '' ? '—' : item.value,
    searchIndex: `${item.section} ${item.metric} ${item.value}`.toLowerCase(),
  }))));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${sortHeader('Section', 'section')}
      ${sortHeader('Metric', 'metric')}
      ${sortHeader('Value', 'value')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="4" class="py-12 text-center text-slate-400 dark:text-slate-500">No overview metrics match your search.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        <td class="py-2.5 px-4 text-slate-500 dark:text-slate-400">${escapeHtml(row.section)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(row.metric)}</td>
        <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${
          /^https?:\/\//.test(String(row.value))
            ? `<a class="text-blue-600 dark:text-blue-400 hover:underline" href="${escapeHtml(row.value)}" target="_blank" rel="noopener noreferrer">open link</a>`
            : escapeHtml(row.value)
        }</td>
      </tr>
    `).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} overview · ${rows.length} metrics. Returns are derived from adjusted market-price closes, not official NAV returns.`);
}

function renderDistributionsTable(fund: FundRow): void {
  const meta = fundMetaCache.get(fund.ticker);
  const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
  const headers: string[] = Array.isArray(worksheet.headers) ? worksheet.headers : [];
  const sourceRows: string[][] = Array.isArray(worksheet.rows) ? worksheet.rows : [];
  const rows = sortRows(filterRows(sourceRows.map((row, sourceIndex) => {
    const cells: Record<string, unknown> = { values: row, searchIndex: row.join(' ').toLowerCase(), rank: sourceIndex };
    headers.forEach((header, index) => { cells[`col${index}`] = row[index] ?? ''; });
    return cells;
  })));

  el.tableHead.innerHTML = `
    <tr>
      ${indexHeader()}
      ${headers.map((header, index) => sortHeader(header, `col${index}`)).join('')}
    </tr>
  `;
  bindSortHeaders();

  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="py-12 text-center text-slate-400 dark:text-slate-500">No published distribution for ${escapeHtml(fund.ticker)}.</td></tr>`;
  } else {
    el.tableBody.innerHTML = rows.map((row, index) => {
      const values: string[] = row.values || [];
      return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
        <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
        ${values.map(cell => `<td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${escapeHtml(cell || '—')}</td>`).join('')}
      </tr>
    `;}).join('');
  }

  el.tickerCount.textContent = fund.ticker;
  renderSubtitle(`${fund.ticker} distributions · proshares.com publishes the full history through its own distribution summary endpoint (ex-date, record date, payable date, amount and capital-gain components), so these rows are official; funds with no distributions yet show an explanatory state instead of a blank table.`);
}

// =========================================================================
// 7. Subtitle
// =========================================================================

function renderSubtitle(text?: string): void {
  const generated = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : '';
  const countsText = state.counts
    ? `${state.counts.funds} ETFs · ${(state.counts.holdings || 0).toLocaleString('en-US')} holdings rows · ${(state.counts.history || 0).toLocaleString('en-US')} history rows`
    : '';
  const base = text ? String(text) : 'Search ProShares ETFs, select rows, then use the Watchlist tab.';
  // Selected ETF count and clickable ticker badges (active fund highlighted);
  // re-rendered by every selection writer so the count never lags.
  const selectedCount = state.selected.size;
  let selectionItem = '';
  if (selectedCount > 0) {
    const catalogFunds = state.funds.filter(fund => !state.blacklist.has(fund.ticker));
    if (catalogFunds.length > 0 && catalogFunds.length === selectedCount && catalogFunds.every(fund => state.selected.has(fund.ticker))) {
      selectionItem = ` · All ${catalogFunds.length} ETFs selected`;
    } else {
      const badges = [...state.selected].sort().map(ticker => {
        const isActive = ticker === state.activeFundTicker;
        return `<a href="javascript:void(0)" data-activate-fund="${escapeHtml(ticker)}" title="View ${escapeHtml(ticker)} details" class="font-semibold ${isActive ? 'text-blue-700 dark:text-blue-300 underline' : 'text-blue-600 dark:text-blue-400 hover:underline'}">${escapeHtml(ticker)}</a>`;
      }).join(', ');
      selectionItem = ` · ${selectedCount} selected: ${badges}`;
    }
  }
  el.subtitle.innerHTML = `
    <span class="block sm:inline">${escapeHtml(base)}${selectionItem}</span>
    <span class="block sm:inline">·${generated ? ` updated ${escapeHtml(generated)}` : ''}${countsText ? ` · ${escapeHtml(countsText)}.` : '.'} Data: <a href="./api/proshares/index.json" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">api/proshares/index.json</a> generated from <a href="https://www.proshares.com/our-etfs/find-proshares-etfs" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">the official ProShares ETF finder, fund pages and distribution summary</a> + <a href="https://accounts.profunds.com/etfdata/" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">the official daily holdings, NAV history and performance files</a></span>
  `;
  el.subtitle.querySelectorAll('a[data-activate-fund]').forEach((link: any) => {
    link.addEventListener('click', () => activateFund(link.dataset.activateFund || ''));
  });
}

function setStatusRow(message: string, tone: 'info' | 'error'): void {
  el.tableBody.innerHTML = `<tr><td colspan="10" class="py-12 text-center ${tone === 'error' ? 'text-rose-500 dark:text-rose-300' : 'text-slate-400 dark:text-slate-500'}">${escapeHtml(message)}</td></tr>`;
}

// =========================================================================
// 8. Selection & blacklist
// =========================================================================

/** Active fund fallback: if the active fund was deselected, fall back to the
 *  first remaining selected fund (or none). */
function updateActiveFundFallback(): void {
  // Bulk selection writers (the filtered header checkbox and the All ETFs
  // pill) can add the first selected fund without going through toggleFund.
  // Keep a selected fund active in that case too, otherwise the selected-tabs
  // panel renders as an empty shell until the next page reload restores the
  // fallback in loadCatalog().
  if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }
}

/** Shared trailer for every selection writer: keeps localStorage, tabs,
 *  subtitle badges, per-sheet counts and the Watchlist (visibility, loading
 *  state, count) in sync immediately — no extra click needed. */
function afterSelectionChange(): void {
  updateActiveFundFallback();
  persistSelection();
  ensureValidTab();
  render();
  void ensureHoldingsForSelection();
}

/** Row Use checkbox (or row click): toggles exactly one ETF. */
function toggleFund(ticker: string): void {
  const cleanTicker = sanitizeTicker(ticker);
  if (!cleanTicker) return;

  if (state.selected.has(cleanTicker)) {
    state.selected.delete(cleanTicker);
  } else {
    state.selected.add(cleanTicker);
    state.activeFundTicker = cleanTicker;
  }

  afterSelectionChange();
  const activeTicker = state.activeFundTicker;
  if (activeTicker && state.activeTab.startsWith('detail:')) {
    void loadFundMeta(activeTicker).then(meta => {
      // Refresh per-sheet counts once the meta arrives (e.g. Distributions).
      if (meta && state.activeFundTicker === activeTicker && state.activeTab.startsWith('detail:')) render();
    });
  }
}

/** Header Use checkbox: scope is exactly the rows currently rendered by the
 *  catalog table (catalog + active search filter + blacklist exclusion).
 *  Checking selects all visible rows; unchecking deselects visible rows only
 *  (hidden selections survive). */
function toggleVisibleSelection(selectAll: boolean): void {
  visibleCatalogRows().forEach(fund => {
    if (selectAll) state.selected.add(fund.ticker);
    else state.selected.delete(fund.ticker);
  });
  afterSelectionChange();
}

/** All ETFs pill checkbox: scope is always every non-blacklisted ETF in the
 *  entire catalog, operating from any tab under any filter. Toggle-only — it
 *  never navigates away from the current view. */
function toggleAllCatalogEfts(selectAll: boolean): void {
  state.funds.filter(fund => !state.blacklist.has(fund.ticker)).forEach(fund => {
    if (selectAll) state.selected.add(fund.ticker);
    else state.selected.delete(fund.ticker);
  });
  afterSelectionChange();
}

/** Activates a selected fund from a clickable ticker badge (subtitle or
 *  Watchlist ETF badges) without changing the selection. */
function activateFund(ticker: string): void {
  const clean = sanitizeTicker(ticker);
  if (!clean || !state.selected.has(clean)) return;
  state.activeFundTicker = clean;
  persistSelection();
  if (state.activeTab.startsWith('detail:')) {
    resetSheetPaging();
    render();
    maybeLoadMoreRows();
  } else {
    render();
  }
}

function clearSelectionAndSearch(): void {
  state.selected.clear();
  state.activeFundTicker = null;
  state.queryByTab = {};
  state.activeTab = 'All';
  // Sort preferences survive Clear: a sort configured in the past is always
  // kept (per tab, in browser localStorage) and reused. Clear only resets
  // the selection and the searches — never the sort order.
  applySortForTab('All');
  persistSelection();
  localStorage.removeItem(ACTIVE_FUND_KEY);
  el.searchInput.value = '';
  updateSearchClearBtn();
  persistSearches();
  persistSiteState();
  render();
}

function blacklistTickers(rawTickers: string[]): void {
  const known = new Set(state.funds.map(fund => fund.ticker));
  rawTickers
    .flatMap(raw => String(raw || '').split(/[\s,;]+/))
    .map(sanitizeTicker)
    .filter(Boolean)
    .filter(ticker => known.has(ticker))
    .forEach(ticker => state.blacklist.add(ticker));
  state.selected = new Set([...state.selected].filter(ticker => !state.blacklist.has(ticker)));
  if (state.activeFundTicker && state.blacklist.has(state.activeFundTicker)) {
    state.activeFundTicker = [...state.selected][0] || null;
  }
  persistBlacklist();
  persistSelection();
  ensureValidTab();
  render();
  void ensureHoldingsForSelection();
}

function submitBlacklistInput(): void {
  blacklistTickers([el.blacklistInput.value || '']);
  el.blacklistInput.value = '';
  fitTableHeight();
}

function unblacklistTicker(ticker: string): void {
  state.blacklist.delete(sanitizeTicker(ticker));
  persistBlacklist();
  render();
}

function clearBlacklist(): void {
  state.blacklist.clear();
  persistBlacklist();
  render();
}

function renderBlacklistPanel(): void {
  el.blacklistChips.innerHTML = '';
  const tickers = [...state.blacklist].sort();
  tickers.forEach(ticker => {
    const chip = document.createElement('span');
    chip.className = 'inline-flex items-center gap-1.5 bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-700/50 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium';
    chip.innerHTML = `${escapeHtml(ticker)}<button data-unblacklist="${escapeHtml(ticker)}" class="w-5 h-5 rounded-full hover:bg-rose-200 dark:hover:bg-rose-800 transition" title="Remove ${escapeHtml(ticker)} from blacklist">✕</button>`;
    el.blacklistChips.appendChild(chip);
  });
  el.blacklistEmpty.classList.toggle('hidden', tickers.length > 0);
  el.blacklistChips.querySelectorAll('button[data-unblacklist]').forEach((button: any) => {
    button.addEventListener('click', () => unblacklistTicker(button.dataset.unblacklist || ''));
  });
  syncBlacklistPanelHeight();
}

/**
 * The blacklist panel's max-height is content-driven (an unbounded number of
 * chips), unlike the fixed-height detail nav, so it can't use a static
 * max-height in CSS -- it's measured from scrollHeight instead, and
 * re-measured on every render so the panel resizes smoothly as chips are
 * added or removed while it's open.
 */
function syncBlacklistPanelHeight(): void {
  el.blacklistPanel.style.maxHeight = el.blacklistPanel.classList.contains('is-visible')
    ? `${el.blacklistPanel.scrollHeight}px`
    : '';
}

// =========================================================================
// 9. Actions & exports (CSV, TXT, Copy Tickers)
// =========================================================================

function currentExportRows(): { headers: string[]; rows: string[][]; scope: string } {
  if (state.activeTab === 'watchlist') {
    return {
      headers: ['Ticker', 'Name', 'ETFs', '# ETFs', 'Weight Sum (%)', 'Max Weight (%)', 'Identifiers'],
      rows: getVisibleWatchlistRows().map(row => [
        row.symbol,
        row.name,
        row.funds.join('|'),
        String(row.fundCount),
        row.weightSum.toFixed(6),
        row.maxWeight.toFixed(6),
        row.cusips.join('|'),
      ]),
      scope: 'watchlist',
    };
  }

  if (state.activeTab === 'detail:overview') {
    const fund = getActiveFund();
    const monthEnd = (fund && fund.returns && fund.returns.monthEnd) || {};
    const quarterEnd = (fund && fund.returns && fund.returns.quarterEnd) || {};
    return {
      headers: ['Ticker', 'Fund Name', 'Category', 'TER', 'NAV', 'Net Assets ($)', 'YTD (ME)', '1Y (ME)', '3Y (ME)', '5Y (ME)', '10Y (ME)', 'SI Ann. (ME)', 'ME As Of', '1Y (QE)', '3Y (QE)', 'Inception', 'Holdings', 'History'],
      rows: [[
        fund ? fund.ticker : '',
        fund ? fund.name : '',
        fund ? fund.category : '',
        fund ? fund.ter : '',
        fund ? fund.nav : '',
        fund ? numberCell(fund.aumValue) : '',
        numberCell(monthEnd.ytd),
        numberCell(monthEnd.yr1),
        numberCell(monthEnd.yr3),
        numberCell(monthEnd.yr5),
        numberCell(monthEnd.yr10),
        numberCell(monthEnd.sinceInception),
        monthEnd.asOfDate || '',
        numberCell(quarterEnd.yr1),
        numberCell(quarterEnd.yr3),
        fund ? fund.inceptionDate : '',
        fund ? String(fund.holdings) : '0',
        fund ? String(fund.history) : '0',
      ]],
      scope: fund ? `${fund.ticker}-overview` : 'overview',
    };
  }

  if (state.activeTab === 'detail:distributions') {
    const fund = getActiveFund();
    const meta = fund ? fundMetaCache.get(fund.ticker) : null;
    const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
    return {
      headers: worksheet.headers || [],
      rows: worksheet.rows || [],
      scope: fund ? `${fund.ticker}-distributions` : 'distributions',
    };
  }

  if (state.activeTab === 'detail:holdings' || state.activeTab === 'detail:history') {
    const sheet = state.activeTab === 'detail:history' ? 'history' : 'holdings';
    const fund = getActiveFund();
    const entry = fund ? sheetState.get(sheetKey(sheet)) : null;
    if (entry) {
      return {
        headers: entry.headers,
        rows: filterRows(entry.rows.map(row => ({ values: row, searchIndex: row.join(' ').toLowerCase() }))).map((row: any) => row.values),
        scope: fund ? `${fund.ticker}-${sheet}` : sheet,
      };
    }
    return { headers: [], rows: [], scope: sheet };
  }

  return {
    headers: ['Selected', 'Ticker', 'Fund Name', 'Type', 'NAV', 'Net Assets ($)', 'Expense (%)', 'Dividend Yield (%)', 'SEC Yield (%)', 'Frequency', 'YTD Return (%)', 'TR 1Y (%)', 'TR 3Y (%)', 'TR 5Y (%)', 'TR 10Y (%)', 'CAGR 3Y (%)', 'CAGR 5Y (%)', 'CAGR 10Y (%)', 'SI Ann. (%)', 'Return As Of', 'Inception', 'Holdings', 'History', 'As Of'],
    rows: filterRows(visibleFunds()).map(fund => [
      state.selected.has(fund.ticker) ? 'yes' : 'no',
      fund.ticker,
      fund.name,
      fund.category,
      fund.nav || '',
      numberCell(fund.aumValue),
      numberCell(fund.terValue),
      numberCell(fund.dividendYield),
      numberCell(fund.secYield),
      fund.dividendFrequency || '',
      numberCell(fund.ytd),
      numberCell(fund.yr1),
      numberCell(fund.tr3y),
      numberCell(fund.tr5y),
      numberCell(fund.tr10y),
      numberCell(fund.cagr3y),
      numberCell(fund.cagr5y),
      numberCell(fund.cagr10y),
      numberCell(fund.si),
      fund.returnAsOf || '',
      fund.inceptionDate || '',
      String(fund.holdings),
      String(fund.history),
      fund.asOfDate || '',
    ]),
    scope: 'etfs',
  };
}

function copyTickers(): void {
  let values: string[] = [];
  if (state.activeTab === 'watchlist') values = getVisibleWatchlistRows().map(row => row.symbol);
  else if (isDetailTab(state.activeTab)) values = currentExportRows().rows.map(row => String(row[0] ?? '')).filter(Boolean);
  else values = filterRows(visibleFunds()).map(fund => fund.ticker);
  values = values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!values.length) return;
  void copyText(values.join(', ')).then(() => {
    const oldText = el.copyBtn.textContent;
    el.copyBtn.textContent = 'Copied!';
    setTimeout(() => { el.copyBtn.textContent = oldText || 'Copy Tickers'; }, 1000);
  });
}

function exportCsv(): void {
  const exportData = currentExportRows();
  if (!exportData.rows.length) return;
  downloadText(
    toCsv([exportData.headers, ...exportData.rows.map(row => row.map(cell => String(cell ?? '')))]),
    exportFileName(exportData.scope, 'csv'),
    'text/csv;charset=utf-8;',
  );
}

function exportTxt(): void {
  const exportData = currentExportRows();
  if (!exportData.rows.length) return;
  downloadText(exportData.rows.map(row => row.join('\t')).join('\n'), exportFileName(exportData.scope, 'txt'), 'text/plain;charset=utf-8;');
}

// =========================================================================
// 10. Scroll fix: only the table scrolls (same fix as daggerok/iShares)
// =========================================================================

function fitTableHeight(): void {
  const rect = el.tableScroll.getBoundingClientRect();
  const bottomPad = window.innerWidth < 640 ? 12 : 24;
  const max = Math.max(240, window.innerHeight - rect.top - bottomPad);
  el.tableScroll.style.maxHeight = `${max}px`;
}

// =========================================================================
// 11. State persistence
// =========================================================================

function persistSelection(): void {
  localStorage.setItem(SELECTED_KEY, JSON.stringify([...state.selected]));
  if (state.activeFundTicker) localStorage.setItem(ACTIVE_FUND_KEY, state.activeFundTicker);
  else localStorage.removeItem(ACTIVE_FUND_KEY);
}

function persistBlacklist(): void {
  localStorage.setItem(BLACKLIST_KEY, JSON.stringify([...state.blacklist]));
}

function cleanFilterMap(source: Record<string, unknown>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [tab, query] of Object.entries(source)) {
    if (typeof query === 'string' && query.length > 0) clean[tab] = query;
  }
  return clean;
}

function persistSearches(): void {
  try {
    const clean = cleanFilterMap(state.queryByTab);
    if (Object.keys(clean).length > 0) {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(clean));
    } else {
      localStorage.removeItem(FILTERS_KEY);
    }
    localStorage.removeItem(LEGACY_FILTERS_KEY);
    persistSiteState();
  } catch {
    /* quota or private mode */
  }
}

function persistSiteState(): void {
  try {
    let saved: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(SITE_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
      }
    } catch {
      saved = {};
    }
    // sheetFilter mirrors the dedicated per-tab filter map so older sessions
    // can migrate without reintroducing a global search string.
    saved.sheetFilter = cleanFilterMap(state.queryByTab);
    saved.activeTab = state.activeTab;
    localStorage.setItem(SITE_STATE_KEY, JSON.stringify(saved));
  } catch {
    /* quota or private mode */
  }
}

function persistTabSorts(): void {
  localStorage.setItem(SORTS_KEY, JSON.stringify(state.sortByTab));
}

function restoreTabSorts(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SORTS_KEY) || '{}') || {};
    const sorts: Record<string, { key: string; dir: SortDirection }> = {};
    Object.keys(saved).forEach(tab => {
      const entry = saved[tab];
      // Keep only well-formed entries; stale keys from older schemas simply
      // sort a missing column (stable no-op) and never break rendering.
      if (entry && typeof entry.key === 'string' && entry.key !== '' && (entry.dir === 'asc' || entry.dir === 'desc')) {
        sorts[tab] = { key: entry.key, dir: entry.dir };
      }
    });
    state.sortByTab = sorts;
  } catch {
    state.sortByTab = {};
  }
}

function restoreSelectedEtfs(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTED_KEY) || '[]');
    state.selected = new Set((Array.isArray(saved) ? saved : []).map(sanitizeTicker).filter(Boolean));
    if (!state.selected.size && localStorage.getItem(SELECTED_KEY) === null) state.selected = new Set(DEFAULT_SELECTED_TICKERS);
  } catch {
    state.selected = new Set(DEFAULT_SELECTED_TICKERS);
  }
  const savedActive = sanitizeTicker(localStorage.getItem(ACTIVE_FUND_KEY) || '');
  state.activeFundTicker = savedActive && state.selected.has(savedActive) ? savedActive : ([...state.selected][0] || null);
}

function restoreBlacklist(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(BLACKLIST_KEY) || 'null');
    if (Array.isArray(saved)) state.blacklist = new Set(saved.map(sanitizeTicker));
  } catch {
    // Ignore malformed storage.
  }
}

/** Boot sanitization: only non-empty string values survive; malformed JSON
 *  or non-object payloads are dropped instead of crashing the app. */
function sanitizeFilterMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return cleanFilterMap(value as Record<string, unknown>);
}

function restoreSiteState(): { activeTab: string | null; sheetFilter: Record<string, string> } {
  let activeTab: string | null = null;
  let sheetFilter: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(SITE_STATE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        if (typeof saved.activeTab === 'string' && saved.activeTab) activeTab = saved.activeTab;
        sheetFilter = sanitizeFilterMap(saved.sheetFilter);
      }
    }
  } catch {
    /* corrupt storage: fall back to defaults */
  }
  return { activeTab, sheetFilter };
}

function restoreSearches(mirror: Record<string, string> = {}): void {
  // Priority (highest last): site-state sheetFilter mirror (oldest), the
  // legacy pre-rename key, then the dedicated per-tab filter key.
  const filters: Record<string, string> = { ...mirror };
  const ingest = (raw: string | null): void => {
    if (!raw) return;
    try {
      Object.assign(filters, sanitizeFilterMap(JSON.parse(raw)));
    } catch {
      /* corrupt entry: dropped */
    }
  };
  ingest(localStorage.getItem(LEGACY_FILTERS_KEY));
  ingest(localStorage.getItem(FILTERS_KEY));
  state.queryByTab = filters;
}

// =========================================================================
// 12. Bootstrap lifecycle
// =========================================================================

// =========================================================================
// 12. Official ProShares holdings file upload (drag & drop, client-side parse)
// =========================================================================

const DROPZONE_LABEL = 'Upload / Drop holdings CSV';

/** Splits one CSV line, honouring double quotes (same reader as the updater). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  const text = String(line ?? '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { current += '"'; i++; } else { quoted = false; }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { cells.push(current); current = ''; continue; }
    current += char;
  }
  cells.push(current);
  return cells.map(cell => cell.trim());
}

/**
 * Parses the official ProShares daily holdings download in the browser, with no
 * network access: either one fund's own file (`NOBL-psdlyhld.csv`, linked from
 * every fund page) or the all-funds file (`psdlyhld.csv`). The normalization is
 * the same one the Bun updater performs, so uploaded holdings merge into the
 * Watchlist exactly like the static feed's holdings do.
 */
function parseProSharesHoldingsUpload(text: string): { asOfDate: string; funds: Map<string, any> } {
  const lines = String(text ?? '').split(/\r?\n/);
  let headerIndex = -1;
  let asOfDate = '';
  for (let i = 0; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const first = String(cells[0] ?? '').trim();
    if (!asOfDate && /^as of/i.test(first)) asOfDate = first.replace(/^as of\s*/i, '').trim();
    if (first.toLowerCase() === 'fund ticker') { headerIndex = i; break; }
  }
  if (headerIndex < 0) throw new Error('no "Fund Ticker" header row found (is this a ProShares psdlyhld csv file?)');

  const buckets = new Map();
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (String(cells[0] ?? '').trim() === '') continue;
    const ticker = sanitizeTicker(cells[0]);
    if (!ticker) continue;
    const bucket = buckets.get(ticker) || { name: String(cells[1] ?? '').trim(), rows: [] };
    bucket.rows.push({
      ticker: String(cells[2] ?? '').trim(),
      identifier: String(cells[3] ?? '').trim(),
      name: String(cells[4] ?? '').trim(),
      coupon: String(cells[5] ?? '').trim(),
      maturity: String(cells[6] ?? '').trim(),
      shares: String(cells[7] ?? '').trim(),
      exposure: String(cells[8] ?? '').trim(),
      marketValue: String(cells[9] ?? '').trim(),
    });
    buckets.set(ticker, bucket);
  }
  if (!buckets.size) throw new Error('no holdings rows found in the file');

  // Weight = ProShares Exposure Weight: position value (market value, or notional
  // exposure for futures and swaps) / the fund's total net assets as reported by
  // the same file (Σ market values, including the Net Other Assets line). Cash
  // and payable lines carry no weight, exactly like the updater does for the feed.
  buckets.forEach(bucket => {
    let total = 0;
    bucket.rows.forEach((row: any) => { total += numberOrNull(row.marketValue) ?? 0; });
    const headers = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held'];
    if (bucket.rows.some((row: any) => row.exposure !== '')) headers.push('Exposure Value');
    if (bucket.rows.some((row: any) => row.coupon !== '')) headers.push('Coupon');
    if (bucket.rows.some((row: any) => row.maturity !== '')) headers.push('Maturity Date');
    bucket.headers = headers;
    bucket.rows = bucket.rows.map((row: any) => {
      const parsed = numberOrNull(row.marketValue) ?? numberOrNull(row.exposure);
      const otherAssets = /net\s+other\s+assets/i.test(String(row.name || ''));
      const weight = !otherAssets && total > 0 && parsed !== null ? (parsed / total) * 100 : null;
      const cells: Record<string, string> = {
        Name: row.name || '—',
        Ticker: row.ticker || '-',
        Identifier: row.identifier || '—',
        Weight: weight === null ? '—' : weight.toFixed(10),
        'Market Value': row.marketValue || '—',
        'Shares Held': row.shares || '—',
      };
      if (headers.includes('Exposure Value')) cells['Exposure Value'] = row.exposure || '—';
      if (headers.includes('Coupon')) cells['Coupon'] = row.coupon || '—';
      if (headers.includes('Maturity Date')) cells['Maturity Date'] = row.maturity || '—';
      return cells;
    });
  });

  return { asOfDate, funds: buckets };
}

const uploadedFunds = new Map(); // ticker -> { headers, rows }

function setDropzoneState(stateName: 'loaded' | 'error' | null, text?: string): void {
  if (!dropzone || !dropzoneText) return;
  dropzone.classList.remove('dz-loaded', 'dz-error');
  if (stateName) dropzone.classList.add(stateName);
  if (text) dropzoneText.textContent = text;
}

function mergeUploadedFund(ticker: string, bucket: any, asOfDate: string): void {
  const known = state.funds.find(fund => fund.ticker === ticker) || null;
  const indexFund: any = {
    ...(known || {
      ticker, name: bucket.name || ticker, category: 'Uploaded', fundPage: null, dataFile: null,
      ter: '—', terValue: null, nav: '—', navValue: null, aum: '—', aumValue: null,
      asOfDate: asOfDate || '—', inceptionDate: '—', exchange: '', closePrice: '—', closePriceValue: null,
      premiumDiscount: '—', premiumDiscountValue: null,
      distributions: { frequency: '—', exDate: '—', dividend: '—' },
      returns: { monthEnd: null, quarterEnd: null },
    }),
    ticker,
    name: (known && known.name) || bucket.name || ticker,
    category: known ? known.category : 'Uploaded',
    metrics: (known && known.metrics) || { dividendYield: null, secYield: null },
    holdings: bucket.rows.length,
    history: known ? known.history : 0,
  };
  const row = normalizeFundRow(indexFund);
  const existingIndex = state.funds.findIndex(fund => fund.ticker === ticker);
  if (existingIndex >= 0) state.funds[existingIndex] = row;
  else state.funds.push(row);

  // Uploaded holdings live in memory only: they feed the sheet cache and a
  // minimal meta so detail tabs, lazy paging and the Watchlist all work.
  uploadedFunds.set(ticker, { headers: bucket.headers, rows: bucket.rows });
  sheetState.set(`${ticker}:holdings`, { headers: bucket.headers, rows: bucket.rows, nextPage: 1, manifest: { pages: [], pageSize: bucket.rows.length, totalRows: bucket.rows.length }, loading: false });
  fundMetaCache.set(ticker, {
    ...fundMetaCache.get(ticker),
    ticker,
    name: row.name,
    category: row.category,
    source: { fundPage: row.fundPage, holdingsDownload: 'uploaded official ProShares psdlyhld file', provider: 'uploaded ProShares holdings file (session only)' },
    distributions: { frequency: known && known.distributions ? known.distributions.frequency : '—', headers: ['Ex-Date', 'Amount'], rows: [] },
    holdings: { pages: [], pageSize: bucket.rows.length, totalRows: bucket.rows.length, asOfDate: asOfDate || 'uploaded', source: 'uploaded official ProShares holdings file (session only)' },
    history: (known && fundMetaCache.get(ticker)) ? fundMetaCache.get(ticker).history : { pages: [], pageSize: 0, totalRows: 0, asOfDate: '—' },
    uploaded: true,
  });
}

function handleUploadedFile(file: File): void {
  if (!/\.csv$/i.test(file.name || '')) {
    setDropzoneState('error', 'Drop the official .csv holdings file');
    window.setTimeout(() => setDropzoneState(null, DROPZONE_LABEL), 2200);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseProSharesHoldingsUpload(String(reader.result || ''));
      let merged = 0;
      parsed.funds.forEach((bucket: any, ticker: string) => {
        mergeUploadedFund(ticker, bucket, parsed.asOfDate);
        merged += 1;
      });
      state.funds.sort((a, b) => a.ticker.localeCompare(b.ticker));

      setDropzoneState('loaded', `${merged} fund${merged === 1 ? '' : 's'} uploaded`);
      setStatus(`Loaded ${merged} fund${merged === 1 ? '' : 's'} from the official ProShares holdings file${parsed.asOfDate ? ` (as of ${parsed.asOfDate})` : ''}. Uploads live for this session.`, 'info');
      fitTableHeight();
      render();
    } catch (error) {
      console.error('Failed to parse the uploaded holdings file:', error);
      setDropzoneState('error', 'Invalid ProShares holdings file');
      window.setTimeout(() => setDropzoneState(null, DROPZONE_LABEL), 2200);
    }
  };
  reader.readAsText(file);
}

function bindEvents(): void {
  el.themeToggle.addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('dark');
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    applyTheme(dark);
  });

  el.searchInput.addEventListener('input', () => {
    setCurrentQuery(el.searchInput.value.trim());
    updateSearchClearBtn();
    render();
  });

  // 1-click clear: clears the active tab's filter from memory and storage,
  // clears the input, refocuses it and re-renders the current view.
  el.searchClearBtn.addEventListener('click', () => {
    el.searchInput.value = '';
    delete state.queryByTab[state.activeTab];
    persistSearches();
    updateSearchClearBtn();
    if (typeof el.searchInput.focus === 'function') el.searchInput.focus();
    render();
  });

  // Official holdings file dropzone (iShares dropzone parity)
  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (event: Event) => {
      event.preventDefault();
      dropzone.classList.add('dz-active');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dz-active'));
    dropzone.addEventListener('drop', (event: DragEvent) => {
      event.preventDefault();
      dropzone.classList.remove('dz-active');
      if (event.dataTransfer && event.dataTransfer.files.length) handleUploadedFile(event.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (event: Event) => {
      const target: any = event.target;
      if (target && target.files && target.files.length) handleUploadedFile(target.files[0]);
    });
  }

  el.copyBtn.addEventListener('click', copyTickers);
  el.exportCsvBtn.addEventListener('click', exportCsv);
  el.exportTxtBtn.addEventListener('click', exportTxt);
  el.resetBtn.addEventListener('click', clearSelectionAndSearch);

  el.blacklistBtn.addEventListener('click', () => {
    const visible = el.blacklistPanel.classList.toggle('is-visible');
    el.blacklistBtn.setAttribute('aria-expanded', String(visible));
    renderBlacklistPanel();
    fitTableHeight();
  });
  el.blacklistAddBtn.addEventListener('click', submitBlacklistInput);
  el.blacklistInput.addEventListener('keydown', (event: any) => {
    if (event.key === 'Enter') submitBlacklistInput();
  });
  el.blacklistClearBtn.addEventListener('click', clearBlacklist);

  // Paginated sheets: append more rows as the sentinel scrolls into view.
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) maybeLoadMoreRows();
      },
      { root: el.tableScroll, rootMargin: '600px 0px' },
    );
    observer.observe(el.staticLoadSentinel);
  }
  el.staticLoadSentinel.addEventListener('click', () => maybeLoadMoreRows());
  el.tableScroll.addEventListener('scroll', () => {
    if (state.activeTab === 'watchlist') {
      // Chunked Watchlist: scrolling near the bottom extends the rendered
      // 250-row chunk; the full deduplicated set is never mounted at once.
      const distanceToBottom = el.tableScroll.scrollHeight - el.tableScroll.scrollTop - el.tableScroll.clientHeight;
      if (distanceToBottom < 600) growWatchlistChunk();
      return;
    }
    const sheet = activeSheetTab();
    if (!sheet || !state.activeFundTicker) return;
    const entry = sheetState.get(sheetKey(sheet));
    if (!entry || entry.loading || entry.nextPage >= entry.manifest.pages.length) return;
    const distanceToBottom = el.tableScroll.scrollHeight - el.tableScroll.scrollTop - el.tableScroll.clientHeight;
    if (distanceToBottom < 600) void loadNextSheetPage(sheet);
  }, { passive: true });

  // Keep only the table scrolling: refit on viewport changes and whenever
  // the content above the table (wrapping toolbar, panels) changes height.
  window.addEventListener('resize', fitTableHeight);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => fitTableHeight()).observe(document.body);
  }
}

function init(): void {
  restoreSelectedEtfs();
  restoreBlacklist();
  const siteState = restoreSiteState();
  if (siteState.activeTab) state.activeTab = siteState.activeTab;
  restoreSearches(siteState.sheetFilter);
  restoreTabSorts();
  applyTheme(localStorage.getItem(THEME_KEY) === 'dark');
  bindEvents();
  syncSearchInput();
  fitTableHeight();
  renderSubtitle();
  void loadCatalog().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    el.tickerCount.textContent = 'Error';
    setStatusRow(`Unable to load api/proshares/index.json: ${message}. Run bun ./scripts/update-data.ts and serve the folder (for example bunx serve . -p 1234).`, 'error');
  });
}
