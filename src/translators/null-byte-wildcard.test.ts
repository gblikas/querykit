/**
 * A wildcard across a stored U+0000.
 *
 * Equality already keeps the bytes after a null. `*` has to see them too,
 * on inline SQL, parameterized SQL, Drizzle on a text column, and in memory.
 * `title:a*` keeps every row. `title:*b` keeps the row that ends in `b`,
 * including the one with a null between `a` and `b`, and leaves `a` out.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { openSqliteHarness } from '../test-support';
import { withNulSafeLike } from './nul-safe-like';

const ZERO = '\u0000';

const rows = [
  { id: 1, title: `a${ZERO}b` },
  { id: 2, title: 'ab' },
  { id: 3, title: 'a' }
];

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  title: text('title')
});

describe('wildcard across a null byte', () => {
  const harness = openSqliteHarness({
    table: items,
    columns: { title: 'TEXT' },
    rows
  });

  it.each([
    ['title:a*', 'a*', 'a%', [1, 2, 3]],
    ['title:*b', '*b', '%b', [1, 2]]
  ])(
    '%s returns the same ids on every engine',
    (query, value, pattern, expectedIds) => {
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.expression).toEqual({
        type: 'comparison',
        field: 'title',
        operator: 'LIKE',
        value
      });
      expect(run.inlineSql).toBe(
        withNulSafeLike(`"title" LIKE '${pattern}' ESCAPE '!'`)
      );
      expect(run.inlineSql).not.toContain(ZERO);
      expect(run.parameterized).toEqual({
        sql: withNulSafeLike(`"title" LIKE ? ESCAPE '!'`),
        params: [pattern]
      });
      expect(run.drizzle).toEqual(run.parameterized);
      expect(run.schemaDrizzle).toEqual({
        sql: withNulSafeLike(`"items"."title" LIKE ? ESCAPE '!'`),
        params: [pattern]
      });
    }
  );
});
