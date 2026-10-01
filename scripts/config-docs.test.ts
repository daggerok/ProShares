/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, USAGE, readConfig, resolveControls, runtimeControls } from './update-data';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json')) as Record<string, unknown>;

describe('resolveControls', () => {
  test('precedence: file < advanced < nonblank input < environment', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'NOBL' }, { CONCURRENCY: 3, TICKERS: 'TQQQ' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
    expect(c.CONCURRENCY).toBe('5');
    expect(c.TICKERS).toBe('TQQQ');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
  });

  test('blank input inherits the file value; advanced may deliberately blank a key', () => {
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'NOBL' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ STORE_RAW_DOWNLOADS: true }, {}, {}, { STORE_RAW_DOWNLOADS: 'false' }).STORE_RAW_DOWNLOADS).toBe('false');
  });

  test('legacy environment aliases still work and the canonical name wins', () => {
    expect(resolveControls({}, {}, {}, { PROSHARES_TICKERS: 'NOBL' }).TICKERS).toBe('NOBL');
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
    expect(resolveControls({}, {}, {}, { AUM_RANGE: '1B:' }).AUM).toBe('1B:');
    expect(resolveControls({}, {}, {}, { EXPENSE_RATIO: '0:1' }).TER).toBe('0:1');
    expect(resolveControls({}, {}, {}, { SKIP_PROSHARES_ETF: 'true' }).SKIP_PROSHARES).toBe('true');
    expect(resolveControls({}, {}, {}, { TICKERS: 'TQQQ', PROSHARES_TICKERS: 'NOBL' }).TICKERS).toBe('TQQQ');
  });

  test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
    const defaults = file();
    const scheduled = resolveControls(defaults, JSON.parse('{}'), {}, {});
    expect(scheduled).toEqual(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])));
    const blankInputs = Object.fromEntries(CONTROL_NAMES.map(name => [name, '']));
    expect(resolveControls(defaults, {}, blankInputs, {})).toEqual(scheduled);
  });

  test('provider-specific defaults', () => {
    const config = readConfig(resolveControls(file()));
    expect(config.tickers).toEqual([]);
    expect(config.maxFetches).toBe(0);
    expect(config.concurrency).toBe(2);
    expect(config.requestSleep).toBe(2);
    expect(config.holdingsPageSize).toBe(250);
    expect(config.historyPageSize).toBe(1000);
    expect(config.historyRange).toBe('max');
    expect(config.distributionYears).toBe(10);
    expect(config.maxRetries).toBe(3);
    expect(config.storeRawDownloads).toBe(false);
    expect(config.skipProShares).toBe(false);
    expect(config.offlineSeed).toBe(false);
    expect(config.aumRange).toEqual({ min: undefined, max: undefined });
    expect(config.terRange).toEqual({ min: undefined, max: undefined });
    expect(config.performanceRanges).toEqual({});
    expect(config.totalReturnRanges).toEqual({});
  });

  test('advanced reaches controls with no dedicated workflow input', () => {
    const c = readConfig(resolveControls(file(), { PERFORMANCE_1Y: '5:', TOTAL_RETURN_YTD: ':20', OFFLINE_SEED: true }));
    expect(c.performanceRanges['1Y']).toEqual({ min: 5, max: undefined });
    expect(c.totalReturnRanges.YTD).toEqual({ min: undefined, max: 20 });
    expect(c.offlineSeed).toBe(true);
  });

  test('rejects invalid JSON shapes, unknown keys, non-scalars and control characters', () => {
    for (const value of [{ UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { TICKERS: ['NOBL'] }, { TICKERS: { a: 1 } }, { TICKERS: null }, null, [], 'text', 7]) {
      expect(() => resolveControls(value)).toThrow();
    }
    expect(() => resolveControls({}, [])).toThrow();
    expect(() => resolveControls({}, 'x')).toThrow();
    expect(() => resolveControls({}, {}, null)).toThrow();
    expect(() => resolveControls({}, { TICKERS: 'NOBL\nEVIL=yes' })).toThrow(/multiline/);
    expect(() => resolveControls({}, {}, { CATEGORY: 'a\rb' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { TICKERS: 'x\0y' })).toThrow();
    expect(() => JSON.parse('{bad')).toThrow();
  });

  test('rejects invalid values per control', () => {
    for (const value of [
      { CONCURRENCY: 0 }, { CONCURRENCY: 'x' }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { DISTRIBUTION_YEARS: -1 },
      { HOLDINGS_PAGE_SIZE: 0 }, { HISTORY_PAGE_SIZE: '1e3' }, { REQUEST_SLEEP: '-1' }, { REQUEST_SLEEP: 'fast' },
      { VERBOSE: 'maybe' }, { STORE_RAW_DOWNLOADS: 'sometimes' }, { OFFLINE_SEED: '2' }, { HISTORY_RANGE: 'forever' },
      { AUM: '1:2:3' }, { AUM: 'huge:' }, { TER: 'x' }, { DIVIDEND_YIELD: '5:1' }, { SEC_YIELD: '1' }, { PERFORMANCE_5Y: 'a:b' }, { TOTAL_RETURN_10Y: '9:1' },
    ]) {
      expect(() => resolveControls({}, value)).toThrow();
    }
  });

  test('runtimeControls reads the config file and lets the environment win', async () => {
    expect(await runtimeControls({})).toEqual(resolveControls(file()));
    const c = await runtimeControls({ TICKERS: 'NOBL', REQUEST_SLEEP: '0' });
    expect(c.TICKERS).toBe('NOBL');
    expect(c.REQUEST_SLEEP).toBe('0');
    expect(c.CONCURRENCY).toBe('2');
  });
});

describe('documentation parity', () => {
  const tenors = ['YTD', '1Y', '3Y', '5Y', '10Y'];
  const readmeControls = (): string[] => {
    const doc = read('README.md');
    const start = doc.indexOf('### Update controls');
    const section = doc.slice(start, doc.indexOf('\n#', start + 5));
    const names: string[] = [];
    for (const row of section.split('\n').filter(line => line.startsWith('| `'))) {
      let prefix = '';
      for (const token of [...row.split('|')[1].matchAll(/`([^`]+)`/g)].map(m => m[1])) {
        const grouped = token.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD)$/);
        if (grouped) prefix = grouped[1];
        names.push(token.startsWith('_') ? `${prefix}${token}` : token);
      }
    }
    return names;
  };

  test('config file keys == CONTROL_NAMES == README rows == --help', () => {
    expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(Object.values(file()).every(value => typeof value === 'string')).toBe(true);
    expect(readmeControls().sort()).toEqual([...CONTROL_NAMES].sort());
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(.+)$/);
      if (tenor) expect(tenors).toContain(tenor[2]);
      expect(USAGE).toContain(tenor ? `${tenor[1]}_YTD|1Y|3Y|5Y|10Y` : name);
    }
    expect(read('README.md')).toContain('scripts/update-data.config.json');
  });

  test('config file carries no personal contact', () => {
    expect(read('scripts/update-data.config.json')).not.toMatch(/@|https?:\/\//);
  });
});

describe('update-data workflow', () => {
  const workflow = read('.github/workflows/update-data.yml');
  const inputsBlock = workflow.slice(workflow.indexOf('    inputs:'), workflow.indexOf('\npermissions:'));
  const names = [...inputsBlock.matchAll(/^      (\w+):$/gm)].map(m => m[1]);

  test('dispatch inputs: at most 25, advanced defaults to {}, each maps to a control', () => {
    expect(names.length).toBeLessThanOrEqual(25);
    expect(names).toContain('advanced');
    expect(inputsBlock).toMatch(/advanced:[\s\S]*?default: '\{\}'/);
    for (const name of names.filter(n => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
    expect(names).not.toContain('output_dir');
  });

  test('schedule, resolver reuse and fixed output directory', () => {
    expect(workflow).toContain("cron: '0 0 * * 0'");
    expect(workflow).not.toMatch(/^  push:/m);
    expect(workflow).toContain('toJSON(inputs)');
    expect(workflow).toContain('import { resolveControls } from "./scripts/update-data.ts"');
    expect(workflow).not.toMatch(/\$\{\{\s*inputs\./);
    expect(workflow).not.toMatch(/OUTPUT_DIR/);
    expect(workflow).toContain('git add api/proshares');
    expect([...workflow.matchAll(/git add ([^\n]+)/g)].map(m => m[1].trim())).toEqual(['api/proshares']);
    expect(workflow).not.toMatch(/bunx tsc/);
  });
});
