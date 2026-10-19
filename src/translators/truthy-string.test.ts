/**
 * Truthy string equality.
 *
 * `flag:yes`, `flag:YES`, `flag:"1"` and `flag:"0"` are the strings `yes`,
 * `YES`, `1` and `0`. A word stays text, including on a boolean-mode
 * Drizzle column, whose encoder would otherwise turn `yes` into `1`. A
 * quoted numeral takes numeric affinity against a stored boolean, so
 * `"1"` matches true and `"0"` matches false on every engine.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
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

  it.each([
    ['flag:yes', 'yes', [3], `"flag" = 'yes'`, '"flag" = ?', ['yes']],
    ['flag:YES', 'YES', [], `"flag" = 'YES'`, '"flag" = ?', ['YES']],
    [
      'flag:"1"',
      '1',
      [1],
      `("flag" IS NULL AND NULL) OR (typeof("flag") IN ('integer', 'real') AND "flag" = 1) OR (typeof("flag") = 'text' AND "flag" = '1')`,
      `("flag" IS NULL AND NULL) OR (typeof("flag") IN ('integer', 'real') AND "flag" = ?) OR (typeof("flag") = 'text' AND "flag" = ?)`,
      [1, '1']
    ],
    [
      'flag:"0"',
      '0',
      [2],
      `("flag" IS NULL AND NULL) OR (typeof("flag") IN ('integer', 'real') AND "flag" = 0) OR (typeof("flag") = 'text' AND "flag" = '0')`,
      `("flag" IS NULL AND NULL) OR (typeof("flag") IN ('integer', 'real') AND "flag" = ?) OR (typeof("flag") = 'text' AND "flag" = ?)`,
      [0, '0']
    ]
  ] as const)(
    '%s agrees on every engine',
    (query, value, expectedIds, inlineSql, parameterizedSql, params) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'flag',
        operator: '==',
        value
      });
      const run = harness.expectSameIds(query, [...expectedIds]);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: parameterizedSql,
        params: [...params]
      });
      expect(run.drizzle).toEqual({
        sql: parameterizedSql,
        params: [...params]
      });
      expect(run.schemaDrizzle.sql.split('"items".').join('')).toBe(
        parameterizedSql
      );
      expect(run.schemaDrizzle.params).toEqual([...params]);
    }
  );
});
