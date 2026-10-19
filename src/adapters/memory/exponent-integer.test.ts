/**
 * An exponent that spells an integer outside the signed 64-bit range.
 *
 * `count:1e21`, `count:1e+21` and `count:1E21` spell 10^21, which no
 * stored int64 can equal and whose double every engine would otherwise
 * share, so the parser rejects them and the search box marks them
 * incomplete. `count:1e2` stays the number 100, `2^63` written as digits
 * still matches the maximum row with `<=`, and a quoted `"1e21"` stays a
 * complete string.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryParseError } from '../../parser/parser';
import { filterInMemory } from './filter-in-memory';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; count: bigint }> = [
  { id: 1, count: 9223372036854775807n }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

describe('an exponent outside the signed 64-bit range', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: 'INTEGER' },
    rows
  });

  it.each(['count:1e21', 'count:1e+21', 'count:1E21', 'count:<=1e21'])(
    'rejects %s instead of comparing the double',
    query => {
      const written = query.slice(query.search(/[-\d]/));
      const message = `Integer is outside the signed 64-bit range: ${written}`;
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
      '"count" <= 9223372036854776000',
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

  it('keeps a quoted exponent a complete string', () => {
    const query = 'count:"1e21"';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: '1e21'
    });
  });
});
