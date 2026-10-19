/**
 * NOT IN with null in the list.
 *
 * `priority:in[1,null]` keeps the null row and the row whose priority is 1.
 * `priority:not in[1,null]` keeps the other non-null rows. Inline SQL
 * compares the number 1 by storage class. The null member never makes the
 * predicate unknown, on inline SQL, parameterized SQL, Drizzle or in memory.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { filterByExpression } from '../adapters/memory/match-expression';
import { QueryParser } from '../parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; priority: number | null }> = [
  { id: 1, priority: 1 },
  { id: 2, priority: 2 },
  { id: 3, priority: null },
  { id: 4, priority: 0 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  priority: integer('priority')
});

describe('NOT IN with null in the list', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { priority: 'INTEGER' },
    rows
  });

  it.each([
    [
      'priority:in[1,null]',
      'IN',
      '("priority" IS NULL) OR (("priority" IS NULL AND NULL) OR (typeof("priority") IN (\'integer\', \'real\') AND "priority" = 1))',
      [1, 3]
    ],
    [
      'priority:not in[1,null]',
      'NOT IN',
      '("priority" IS NOT NULL) AND (NOT (("priority" IS NULL AND NULL) OR (typeof("priority") IN (\'integer\', \'real\') AND "priority" = 1)))',
      [2, 4]
    ]
  ])(
    '%s keeps the same rows on every engine',
    (query, operator, inlineSql, ids) => {
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'priority',
        operator,
        value: [1, null]
      });
      const run = harness.expectSameSqlIds(query, ids);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized.params).toEqual([1]);
      expect(filterByExpression(expression, rows).map(row => row.id)).toEqual(
        ids
      );
    }
  );
});
