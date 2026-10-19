/**
 * Truthy string equality.
 *
 * `flag:yes`, `flag:YES`, `flag:"1"` and `flag:"0"` are the strings `yes`,
 * `YES`, `1` and `0`. Every engine binds that text, including a boolean-mode
 * Drizzle column, whose encoder would otherwise turn each of them into `1`
 * and match the boolean-true row. Only the exact string `yes` matches the
 * string row on the typeless table; in memory a quoted numeral against a
 * stored boolean takes its numeric affinity, as a typed column does.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; flag: unknown }> = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: 'yes' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  flag: integer('flag', { mode: 'boolean' })
});

describe('truthy string equality', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { flag: '' },
    rows
  });

  // The SQLite table here has no column affinity, so `flag = '1'` compares
  // the integer 1 with the text `1` and matches nothing. The in-memory
  // adapter follows a typed column instead (`docs/pglite-parity-survey.md`,
  // group 4a: PGlite and a typed SQLite table both read `"1"` against a
  // numeric column as 1), so `flag:"1"` keeps the true row and `flag:"0"`
  // the false row there.
  it.each([
    ['flag:yes', 'yes', [3], [3]],
    ['flag:YES', 'YES', [], []],
    ['flag:"1"', '1', [], [1]],
    ['flag:"0"', '0', [], [2]]
  ])(
    '%s binds the text on every engine',
    (query, value, expectedIds, memoryIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'flag',
        operator: '==',
        value
      });
      const run = harness.expectSameSqlIds(query, expectedIds);
      expect(run.inlineSql).toBe(`"flag" = '${value}'`);
      expect(run.parameterized).toEqual({ sql: '"flag" = ?', params: [value] });
      expect(run.drizzle).toEqual({ sql: '"flag" = ?', params: [value] });
      expect(run.schemaDrizzle).toEqual({
        sql: '"items"."flag" = ?',
        params: [value]
      });
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(memoryIds);
    }
  );
});
