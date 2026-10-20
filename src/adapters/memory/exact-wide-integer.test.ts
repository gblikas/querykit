/**
 * A plain integer outside the signed 64-bit range that `Number` keeps.
 *
 * `1000000000000000000000` is the exact double 10^21, so the rounding check
 * alone would let it through and every engine would compare that double.
 * The parser rejects it under equality and `<=`, and the search box marks
 * it incomplete. `count:1e2` and `2^63` are left in place, and a quoted
 * spelling stays a complete string.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryParseError } from '../../parser/parser';
import { filterInMemory } from './filter-in-memory';
import { openSqliteHarness } from '../../test-support';

const WIDE = '1000000000000000000000';

const rows: Array<{ id: number; count: bigint }> = [
  { id: 1, count: 9223372036854775807n }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

describe('an exact integer outside the signed 64-bit range', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: 'INTEGER' },
    rows
  });

  it.each([`count:${WIDE}`, `count:<=${WIDE}`])(
    'rejects %s instead of comparing the double',
    query => {
      const message = `Integer is outside the signed 64-bit range: ${WIDE}`;
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(message);
      expect(() => filterInMemory(query, rows)).toThrow(message);
    }
  );

  it.each([
    [
      'count:1e2',
      '==',
      100,
      '("count" IS NULL AND NULL) OR (typeof("count") IN (\'integer\', \'real\') AND "count" = 100)',
      []
    ],
    [
      'count:<=9223372036854775808',
      '<=',
      9223372036854775808,
      '("count" IS NULL AND NULL) OR (typeof("count") IN (\'integer\', \'real\') AND "count" <= 9223372036854776000)',
      [1]
    ]
  ])(
    '%s stays a number on every engine',
    (query, operator, value, inlineSql, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'count',
        operator,
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized.params).toEqual([value]);
    }
  );

  it('keeps a quoted spelling a complete string', () => {
    const query = `count:"${WIDE}"`;
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: WIDE
    });
  });
});
