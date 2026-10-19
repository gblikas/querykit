/**
 * LIKE on a numeric column.
 *
 * SQLite applies a LIKE pattern to the decimal text of a stored number, so
 * `priority:*2*` keeps 12, 2, 21, -12 and 12.5. Memory matches a finite
 * number as `String(value)`, which is that same text. Null stays unknown,
 * so it is out of both the filter and its NOT.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; priority: number | null }> = [
  { id: 1, priority: 12 },
  { id: 2, priority: 2 },
  { id: 3, priority: 1 },
  { id: 4, priority: 10 },
  { id: 5, priority: 21 },
  { id: 6, priority: 100 },
  { id: 7, priority: 0 },
  { id: 8, priority: -12 },
  { id: 9, priority: 12.5 },
  { id: 10, priority: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  priority: integer('priority')
});

describe('LIKE on a number', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { priority: 'INTEGER' },
    rows
  });

  it.each([
    ['priority:*2*', [1, 2, 5, 8, 9]],
    ['priority:"1*"', [1, 3, 4, 6, 9]],
    ['priority:?2', [1]],
    ['NOT priority:*2*', [3, 4, 6, 7]],
    ['NOT priority:"1*"', [2, 5, 7, 8]]
  ])('%s matches the decimal text on every engine', (query, expectedIds) => {
    const expression = parser.parse(query);
    expect(JSON.stringify(expression)).toContain('"LIKE"');
    harness.expectSameIds(query, expectedIds);
  });
});
