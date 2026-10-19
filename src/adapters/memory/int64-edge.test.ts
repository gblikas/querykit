/**
 * Signed 64-bit integer edges.
 *
 * The maximum `9223372036854775807` and the minimum `-9223372036854775808`
 * are read as exact bigints, so inline SQL writes their digits, the other
 * engines bind them, and memory compares bigint to bigint. One past the
 * maximum, `9223372036854775808`, is the exact double 2^63 and stays a
 * number that no stored int64 equals.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; count: bigint }> = [
  { id: 1, count: 9223372036854775807n },
  { id: 2, count: 9223372036854775806n },
  { id: 3, count: -9223372036854775808n }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

describe('signed 64-bit integer edges', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: 'INTEGER' },
    rows
  });

  it.each([
    [
      'count:9223372036854775807',
      9223372036854775807n,
      '"count" = 9223372036854775807',
      [1]
    ],
    [
      'count:-9223372036854775808',
      -9223372036854775808n,
      '"count" = -9223372036854775808',
      [3]
    ],
    [
      'count:9223372036854775808',
      9223372036854775808,
      '("count" IS NULL AND NULL) OR (typeof("count") IN (\'integer\', \'real\') AND "count" = 9223372036854776000)',
      []
    ]
  ])(
    '%s keeps the written integer on every engine',
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
        sql: '"count" = ?',
        params: [value]
      });
    }
  );
});
