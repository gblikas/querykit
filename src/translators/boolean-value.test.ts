/**
 * Boolean equality values.
 *
 * Liqe reads only the lowercase words as booleans: `flag:true` is the
 * boolean and `flag:TRUE` is the string `TRUE`. A boolean inlines `TRUE` /
 * `FALSE` on parameterized SQL and schema-less Drizzle, and goes through the
 * encoder of a boolean-mode column, which binds `1` / `0`. A string is bound
 * as that text on every engine, including a boolean-mode column, whose
 * encoder would otherwise turn any truthy string into `1`.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; flag: unknown }> = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: 'true' },
  { id: 4, flag: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  flag: integer('flag', { mode: 'boolean' })
});

describe('boolean equality values', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { flag: '' },
    rows
  });

  it.each([
    ['flag:true', true, '"flag" = true', '"flag" = TRUE', [], [1], [1]],
    ['flag:false', false, '"flag" = false', '"flag" = FALSE', [], [0], [2]],
    [
      'flag:TRUE',
      'TRUE',
      `"flag" = 'TRUE'`,
      '"flag" = ?',
      ['TRUE'],
      ['TRUE'],
      []
    ],
    [
      'flag:FALSE',
      'FALSE',
      `"flag" = 'FALSE'`,
      '"flag" = ?',
      ['FALSE'],
      ['FALSE'],
      []
    ]
  ])(
    '%s returns the same ids on every engine',
    (
      query,
      value,
      inlineSql,
      parameterizedSql,
      params,
      booleanColumnParams,
      expectedIds
    ) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'flag',
        operator: '==',
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({ sql: parameterizedSql, params });
      expect(run.drizzle).toEqual({ sql: parameterizedSql, params });
      expect(run.schemaDrizzle).toEqual({
        sql: '"items"."flag" = ?',
        params: booleanColumnParams
      });
    }
  );
});
