/**
 * Search-box parenthesis grouping.
 *
 * `parse` and `parseWithContext().ast` return the same tree, and the
 * in-memory filter follows it: a negated group stays one `NOT` over the
 * `OR`, an ungrouped `NOT` stops at its clause, and a parenthesized `OR`
 * stays the left side of `AND`.
 */

import { filterByExpression } from '../adapters/memory/match-expression';
import { isInputComplete } from './input-parser';
import { QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a', priority: 1 },
  { id: 2, status: 'b', priority: 1 },
  { id: 3, status: 'a', priority: 2 },
  { id: 4, status: 'b', priority: 2 },
  { id: 5, status: 'c', priority: 1 },
  { id: 6, status: 'c', priority: 2 }
];

describe('search-box grouping', () => {
  const parser = new QueryParser();

  it.each([
    ['NOT (status:a OR status:b)', [5, 6]],
    ['NOT status:a OR status:b', [2, 4, 5, 6]],
    ['(status:a OR status:b) AND priority:1', [1, 2]]
  ])('parses %p the same way everywhere and keeps ids %p', (query, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(true);
    expect(context.ast).toEqual(expression);
    expect(filterByExpression(expression, rows).map(row => row.id)).toEqual(
      ids
    );
  });
});
