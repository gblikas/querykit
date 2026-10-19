/**
 * An exponent that underflows to zero.
 *
 * `count:1e-400`, `count:1e-324` and `count:-1e-400` spell a decimal that
 * is not zero but whose `Number` is 0, so every engine would match the
 * stored 0. The parser rejects them and the search box marks them
 * incomplete. `count:0e-400` is exact zero and still matches 0,
 * `count:1e-2` is 0.01, `count:1e21` stays the signed-range rejection, and a
 * quoted `"1e-400"` stays a complete string.
 */

import { integer, real, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryParseError } from '../../parser/parser';
import { filterInMemory } from './filter-in-memory';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; count: number }> = [
  { id: 1, count: 0 },
  { id: 2, count: 1 },
  { id: 3, count: 0.01 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: real('count')
});

describe('an exponent that underflows to zero', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: 'REAL' },
    rows
  });

  it.each([
    ['count:1e-400', 'Exponent underflows to zero: 1e-400'],
    ['count:1e-324', 'Exponent underflows to zero: 1e-324'],
    ['count:-1e-400', 'Exponent underflows to zero: -1e-400'],
    ['count:1e21', 'Integer is outside the signed 64-bit range: 1e21']
  ])('rejects %s instead of comparing the rounded number', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
  });

  it.each([
    [
      'count:1e-2',
      0.01,
      '("count" IS NULL AND NULL) OR (typeof("count") IN (\'integer\', \'real\') AND "count" = 0.01)',
      [3]
    ],
    [
      'count:0e-400',
      0,
      '("count" IS NULL AND NULL) OR (typeof("count") IN (\'integer\', \'real\') AND "count" = 0)',
      [1]
    ]
  ])(
    '%s stays the number it spells on every engine',
    (query, value, inlineSql, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'count',
        operator: '==',
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = ?)`,
        params: [value]
      });
    }
  );

  it('keeps a quoted exponent a complete string', () => {
    const query = 'count:"1e-400"';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: '1e-400'
    });
  });
});
