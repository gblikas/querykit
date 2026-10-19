/**
 * A string ordered against a boolean.
 *
 * SQLite with no affinity orders null, then numbers, then text, and stores a
 * boolean as 1 or 0, so every string is greater than both booleans.
 * `label:>true` inlines `TRUE` and keeps every text row; `flag:>"m"` binds
 * the text `m` on every engine, including a boolean-mode Drizzle column,
 * whose encoder would otherwise turn `m` into `1` inside the ordered
 * operators.
 *
 * In memory every string is greater than every boolean.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; label: string; flag: boolean | null }> = [
  { id: 1, label: 'a', flag: true },
  { id: 2, label: 'z', flag: false },
  { id: 3, label: '', flag: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  label: text('label'),
  flag: integer('flag', { mode: 'boolean' })
});

const cases: Array<
  [string, string, string, string, unknown[], string, number[]]
> = [
  [
    'label:>true',
    'label',
    '>',
    '"label" > true',
    [],
    '"label" > TRUE',
    [1, 2, 3]
  ],
  [
    'label:<=false',
    'label',
    '<=',
    '"label" <= false',
    [],
    '"label" <= FALSE',
    []
  ],
  ['flag:>"m"', 'flag', '>', `"flag" > 'm'`, ['m'], '"flag" > ?', []],
  ['flag:<"m"', 'flag', '<', `"flag" < 'm'`, ['m'], '"flag" < ?', [1, 2]]
];

describe('a string ordered against a boolean', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { label: '', flag: '' },
    rows
  });

  it.each(cases)(
    '%s binds text as text and inlines a boolean on every SQL engine',
    (query, field, operator, inlineSql, params, parameterizedSql, ids) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toMatchObject({ type: 'comparison', field, operator });
      const run = harness.expectSameSqlIds(query, ids);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({ sql: parameterizedSql, params });
      expect(run.drizzle).toEqual({ sql: parameterizedSql, params });
      expect(run.schemaDrizzle).toEqual({
        sql: parameterizedSql.replace(`"${field}"`, `"items"."${field}"`),
        params
      });
    }
  );

  // Every string, including the empty string, is greater than every boolean,
  // in either direction.
  describe('in memory', () => {
    it.each(cases)('%s matches the SQL engines', (query, ...rest) => {
      const ids = rest[rest.length - 1] as number[];
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    });
  });
});
