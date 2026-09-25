import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configEntries, printConfig, printFilter, fundLine, money, contentKey, createReporter, inspectFund, hasOutputFilters } from './update-output.ts';

describe('standard updater output', () => {
  test('exact progress, ticker, status and detail field order', () => {
    expect(fundLine(8, 81, 'BIV', 'updated', {
      portId: '0925', history: 761, officialHistoryCount: 539, yahooHistoryCount: 234,
      holdings: 2352, distributions: 233, netAssets: '$29.0B', totalFundNetAssets: '$52.1B',
      trailingYield: 4.75454727, secYield: 5.19, workplaceRaw: true,
    })).toBe('[  8/81  ] BIV   updated   port=0925 history=761 (official=539 yahoo=234) holdings=2352 divs=233 netAssets=$29.0B total=$52.1B div=4.75454727 sec=5.19 wp=true');
  });
  test('same fields for missing data, zero counts and false values', () => {
    const line = fundLine(1, 1, 'X', 'unchanged', {history: 0, holdings: {totalRows: 0}, distributions: [], workplaceRaw: false});
    expect(line).toContain('port=null history=0 (official=null yahoo=null) holdings=0 divs=0 netAssets=null total=null div=null sec=null wp=false');
    expect(line).not.toContain('undefined');
  });
  test('provider-specific nested metrics and identifiers', () => {
    expect(fundLine(1, 1000, 'LONGER', 'updated', {portfolioId: '123', history: {totalRows: 20}, yields: {dividendYield: 0, secYield: 2}, aum: {display: '$1,234.5 M'}, worksheets: {Distributions: {rows: [{}, {}]}}})).toContain('port=123 history=20 (official=null yahoo=null) holdings=null divs=2 netAssets=$1.2B total=null div=0 sec=2 wp=null');
  });
  test('failed/skipped reasons never create extra lines', () => {
    for (const status of ['failed', 'skipped']) {
      const line = fundLine(1, 2, 'ETF', status, {}, 'network\nfailed\r\nretry\tlater');
      expect(line.split('\n')).toHaveLength(1);
      expect(line).toContain('reason=network failed retry later');
    }
  });
  test('financial values share compact units', () => {
    expect(money(29000000000)).toBe('$29.0B');
    expect(money('$131.6 M')).toBe('$131.6M');
    expect(money(0)).toBe('$0.00');
    expect(money('—')).toBe('null');
  });
  test('all configuration fields use their supported environment names', () => {
    const rows = Object.fromEntries(configEntries({maxFetches: 0, requestSleepSeconds: 1.5, concurrency: 15,
      categories: [], aumRange: undefined, performanceRanges: {}, totalReturn: {'1Y': {min: 0}},
      skipVanEck: false, skipGoldmanSachs: true, tickers: new Set(['BIV']), historyPageSize: 1000, historyRange: 'max'}));
    expect(rows.MAX_FETCHES).toBe('0');
    expect(rows.REQUEST_SLEEP).toBe('1.5');
    expect(rows.CONCURRENCY).toBe('15');
    expect(rows.AUM).toBe(':');
    expect(rows.CATEGORY).toBe('all');
    expect(rows.PERFORMANCE_1Y).toBe(':');
    expect(rows.TOTAL_RETURN_1Y).toBe('0:');
    expect(rows.SKIP_VANECK).toBe('false');
    expect(rows.SKIP_GOLDMANSACHS).toBe('true');
    expect(rows.TICKERS).toBe('BIV');
    expect(rows.HISTORY_PAGE_SIZE).toBe('1000');
    expect(rows.HISTORY_RANGE).toBe('max');
    expect(rows.HISTORY).toBeUndefined();
    expect(hasOutputFilters({tickers: [], category: '', performanceRanges: {}})).toBe(false);
    expect(hasOutputFilters({tickers: ['BIV']})).toBe(true);
  });
  test('config header and empty/deferred filter output', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      printConfig('Test', {concurrency: 15, apiToken: 'do-not-print'});
      printFilter(0, 81);
      printFilter(10, 81, true);
      expect(log.mock.calls[0][0]).toBe('[ config ] Test updater:\n            CONCURRENCY=15\n            API_TOKEN=<redacted>');
      expect(log.mock.calls[1][0]).toBe('[ filter ] 0 of 81 funds pass filters');
      expect(log.mock.calls[2][0]).toContain('selected for evaluation');
    } finally { log.mockRestore(); }
  });
  test('semantic comparison ignores serialization order and generatedAt only', () => {
    expect(contentKey({a: 1, b: 2, generatedAt: 'old', catalogReadAt: 'old'})).toBe(contentKey({b: 2, a: 1, generatedAt: 'new', catalogReadAt: 'new'}));
    expect(contentKey({a: 1})).not.toBe(contentKey({a: 2}));
    expect(contentKey({asOfDate: 'old'})).not.toBe(contentKey({asOfDate: 'new'}));
  });
  test('reporter detects page-only changes, deletion, unchanged, skipped and failures without writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'updater-output-'));
    const dir = join(root, 'funds', 'ETF');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await mkdir(join(dir, 'history'), {recursive: true});
      const meta = JSON.stringify({history: {totalRows: 1}, holdings: {totalRows: 0}});
      await writeFile(join(dir, 'meta.json'), meta);
      const page = join(dir, 'history', '001.json');
      await writeFile(page, '{"rows":[1]}');
      const output = createReporter(root, 5);
      const before = await output.before('ETF');
      await output.result('ETF', before);
      await writeFile(page, '{"rows":[2]}');
      await output.result('ETF', before);
      const after = await output.before('ETF');
      await rm(page);
      await output.result('ETF', after);
      await output.result('ETF', before, 'skipped', 'filter');
      await output.result('ETF', before, 'failed', 'network');
      expect(log.mock.calls).toHaveLength(5);
      expect(log.mock.calls.map(call => String(call[0]).match(/ETF\s+(\w+)/)?.[1])).toEqual(['unchanged','updated','updated','skipped','failed']);
      expect(await readFile(join(dir, 'meta.json'), 'utf8')).toBe(meta);
    } finally { log.mockRestore(); await rm(root, {recursive: true, force: true}); }
  });
  test('concurrent completions receive distinct monotonically increasing counters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'updater-output-'));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const output = createReporter(root, 15);
      const before = await inspectFund(root, 'NONE');
      await Promise.all(Array.from({length: 15}, (_, i) => output.result(`ETF${i}`, before)));
      expect(log.mock.calls.map(call => Number(String(call[0]).match(/\[\s*(\d+)\//)?.[1]))).toEqual(Array.from({length: 15}, (_, i) => i + 1));
    } finally { log.mockRestore(); await rm(root, {recursive: true, force: true}); }
  });
});
