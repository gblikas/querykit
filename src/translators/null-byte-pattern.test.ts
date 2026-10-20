/**
 * A null byte inside a wildcard pattern.
 *
 * `title:"a` + U+0000 + `*"` is a LIKE pattern, not a syntax error. The
 * null is one character the wildcard has to see, on inline SQL,
 * parameterized SQL, Drizzle on a text column, and in memory. The row
 * `a` + U+0000 + `b` matches. `ab` and `a` do not.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { openSqliteHarness } from '../test-support';
import { withNulSafeLike } from './nul-safe-like';

const ZERO = '\u0000';
const STAND_IN = '\u0001';

const rows = [
  { id: 1, title: `a${ZERO}b` },
  { id: 2, title: 'ab' },
  { id: 3, title: 'a' }
];

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  title: text('title')
});

describe('null byte inside a wildcard pattern', () => {
  const harness = openSqliteHarness({
    table: items,
    columns: { title: 'TEXT' },
    rows
  });

  it('returns the same ids on every engine', () => {
    const query = `title:"a${ZERO}*"`;
    const pattern = `a${STAND_IN}%`;
    const run = harness.expectSameIds(query, [1]);
    expect(run.expression).toEqual({
      type: 'comparison',
      field: 'title',
      operator: 'LIKE',
      value: `a${ZERO}*`
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
  });
});
