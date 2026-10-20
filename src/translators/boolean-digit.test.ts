/**
 * Boolean digit equality.
 *
 * `flag:1`, `flag:0` and `flag:2` are numbers. SQLite stores a boolean as
 * 1 or 0, so `1` matches boolean true and the number 1, `0` matches boolean
 * false and the number 0, and `2` matches nothing. Every engine binds the
 * number as itself, including a boolean-mode Drizzle column, whose encoder
 * would otherwise turn `2` into `1`.
 *
 * In memory equality treats boolean true as 1 and boolean false as 0.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; flag: unknown }> = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: 1 },
  { id: 4, flag: 0 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  flag: integer('flag', { mode: 'boolean' })
});

const cases: Array<[string, number, number[]]> = [
  ['flag:1', 1, [1, 3]],
  ['flag:0', 0, [2, 4]],
  ['flag:2', 2, []]
];

describe('boolean digit equality', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { flag: '' },
    rows
  });

  it.each(cases)(
    '%s binds the number on every SQL engine',
    (query, value, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'flag',
        operator: '==',
        value
      });
      const run = harness.expectSameSqlIds(query, expectedIds);
      expect(run.inlineSql).toBe(
        `("flag" IS NULL AND NULL) OR (typeof("flag") IN ('integer', 'real') AND "flag" = ${value})`
      );
      const bound = `("flag" IS NULL AND NULL) OR (typeof("flag") IN ('integer', 'real') AND "flag" = ?)`;
      expect(run.parameterized).toEqual({ sql: bound, params: [value] });
      expect(run.drizzle).toEqual({ sql: bound, params: [value] });
      expect(run.schemaDrizzle).toEqual({
        sql: `("items"."flag" IS NULL AND NULL) OR (typeof("items"."flag") IN ('integer', 'real') AND "items"."flag" = ?)`,
        params: [value]
      });
    }
  );

  // Equality treats boolean true as 1 and boolean false as 0, in either
  // direction; 2 still matches no boolean.
  describe('in memory', () => {
    it.each(cases)('%s matches the SQL engines', (query, _value, ids) => {
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    });
  });
});
