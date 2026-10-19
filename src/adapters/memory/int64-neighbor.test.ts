/**
 * One past 2^63.
 *
 * `9223372036854775809` is not an exact double: `Number` rounds it onto
 * 2^63, so every engine would compare the wrong integer. The parser rejects
 * it under every operator and the search box marks it incomplete. The exact
 * maximum and the exact 2^63 are left in place: `>` the maximum matches
 * nothing and `<=` 2^63 matches the maximum row on every engine.
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

describe('one past 2^63', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: 'INTEGER' },
    rows
  });

  it.each([
    'count:9223372036854775809',
    'count:>9223372036854775809',
    'count:<=9223372036854775809'
  ])('rejects %s instead of comparing 2^63', query => {
    const message =
      'Integer is outside the signed 64-bit range: 9223372036854775809';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
  });

  it.each([
    [
      'count:>9223372036854775807',
      '>',
      9223372036854775807n,
      '"count" > 9223372036854775807',
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
    '%s keeps the exact literal on every engine',
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

  it('keeps a quoted neighbour a complete string', () => {
    const query = 'count:"9223372036854775809"';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: '9223372036854775809'
    });
  });
});
