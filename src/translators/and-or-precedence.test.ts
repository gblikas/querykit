/**
 * AND/OR precedence.
 *
 * AND and OR are one precedence level and associate left, so
 * `status:a OR status:b AND priority:1` is an AND whose left child is the
 * OR. Each translator parenthesizes every operand, so SQLite follows the
 * tree rather than binding AND tighter, and every engine returns the ids
 * the tree selects. `NOT NOT status:a` does not parse.
 */

import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { filterByExpression } from '../adapters/memory/match-expression';
import { QueryParseError, QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { openSqliteHarness } from '../test-support';

const rows = [
  { id: 1, status: 'a', priority: 1 },
  { id: 2, status: 'b', priority: 1 },
  { id: 3, status: 'a', priority: 2 },
  { id: 4, status: 'b', priority: 2 },
  { id: 5, status: 'c', priority: 1 },
  { id: 6, status: 'c', priority: 2 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  priority: integer('priority')
});

const rawSchema = {
  items: { status: sql.raw('status'), priority: sql.raw('priority') }
};

function comparison(field: string, value: string | number): QueryExpression {
  return { type: 'comparison', field, operator: '==', value };
}

describe('AND/OR precedence', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { status: 'TEXT', priority: 'INTEGER' },
    rows
  });

  it.each([
    [
      'status:a OR status:b AND priority:1',
      {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'OR',
          left: comparison('status', 'a'),
          right: comparison('status', 'b')
        },
        right: comparison('priority', 1)
      },
      `(("status" = 'a') OR ("status" = 'b')) AND (("priority" IS NULL AND NULL) OR (typeof("priority") IN ('integer', 'real') AND "priority" = 1))`,
      '(("status" = ?) OR ("status" = ?)) AND ("priority" = ?)',
      [1, 2]
    ],
    [
      'status:a AND status:b OR priority:1',
      {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'logical',
          operator: 'AND',
          left: comparison('status', 'a'),
          right: comparison('status', 'b')
        },
        right: comparison('priority', 1)
      },
      `(("status" = 'a') AND ("status" = 'b')) OR (("priority" IS NULL AND NULL) OR (typeof("priority") IN ('integer', 'real') AND "priority" = 1))`,
      '(("status" = ?) AND ("status" = ?)) OR ("priority" = ?)',
      [1, 2, 5]
    ]
  ])(
    '%s groups left to right on every engine',
    (query, tree, inlineSql, parameterizedSql, expectedIds) => {
      const expression = parser.parse(query);
      expect(expression).toEqual(tree);
      expect(parser.parseWithContext(query).ast).toEqual(tree);
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: parameterizedSql,
        params: ['a', 'b', 1]
      });
      expect(run.drizzle).toEqual({
        sql: parameterizedSql,
        params: ['a', 'b', 1]
      });
      expect(
        harness.idsOfSql(harness.compileDrizzle(expression, rawSchema))
      ).toEqual(expectedIds);
      expect(filterByExpression(expression, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );

  it('differs from bare SQLite precedence only where the translators add parentheses', () => {
    expect(
      harness.idsOfSql({
        sql: `"status" = 'a' OR "status" = 'b' AND "priority" = 1`,
        params: []
      })
    ).toEqual([1, 2, 3]);
    expect(
      harness.idsOfSql({
        sql: `"status" = 'a' AND "status" = 'b' OR "priority" = 1`,
        params: []
      })
    ).toEqual([1, 2, 5]);
  });

  it('does not parse NOT NOT status:a', () => {
    const query = 'NOT NOT status:a';
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(
      'Syntax error at line 1 column 8'
    );
    expect(parser.validate(query)).toBe(false);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });
});
