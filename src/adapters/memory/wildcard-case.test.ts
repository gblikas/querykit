/**
 * Letter case under a wildcard.
 *
 * SQLite's LIKE folds ASCII letters and leaves `ö` and `Ö` distinct, so
 * `status:open*` keeps `open`, `Open` and `OPEN` while `status:öpen*` keeps
 * only `öpen`. The in-memory matcher folds `A-Z` on both the pattern and
 * the value the same way. Equality stays case-sensitive on every engine.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { withNulSafeLike } from '../../translators/nul-safe-like';
import { isInputComplete } from '../../parser/input-parser';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; status: string }> = [
  { id: 1, status: 'open' },
  { id: 2, status: 'Open' },
  { id: 3, status: 'OPEN' },
  { id: 4, status: 'öpen' },
  { id: 5, status: 'Öpen' },
  { id: 6, status: 'closed' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status')
});

describe('letter case under a wildcard', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { status: 'TEXT' },
    rows
  });

  /** Every engine must return the same ids; returns the inline SQL. */
  function expectIds(query: string, expectedIds: number[]): string {
    expect(isInputComplete(query)).toBe(true);
    const run = harness.expectSameIds(query, expectedIds);
    return run.inlineSql;
  }

  it.each([
    ['status:open*', `"status" LIKE 'open%' ESCAPE '!'`, [1, 2, 3]],
    ['status:*PEN', `"status" LIKE '%PEN' ESCAPE '!'`, [1, 2, 3, 4, 5]],
    ['status:o?en', `"status" LIKE 'o_en' ESCAPE '!'`, [1, 2, 3]],
    ['status:"Open*"', `"status" LIKE 'Open%' ESCAPE '!'`, [1, 2, 3]],
    ['status:cl*ED', `"status" LIKE 'cl%ED' ESCAPE '!'`, [6]]
  ])('%s folds ASCII letters on every engine', (query, inlineSql, ids) => {
    expect(parser.parse(query)).toMatchObject({ operator: 'LIKE' });
    expect(expectIds(query, ids)).toBe(withNulSafeLike(inlineSql));
  });

  it('negates the folded LIKE', () => {
    expectIds('-status:open*', [4, 5, 6]);
    expectIds('NOT status:open*', [4, 5, 6]);
  });

  it.each([
    ['status:öpen*', [4]],
    ['status:Öpen*', [5]]
  ])('%s keeps ö and Ö distinct', (query, ids) => {
    expectIds(query, ids);
  });

  it.each([
    ['status:open', { operator: '==' }, [1]],
    ['status:Open', { operator: '==' }, [2]],
    [
      'status:!=open',
      { operator: 'NOT', left: { operator: '==' } },
      [2, 3, 4, 5, 6]
    ]
  ])('%s stays case-sensitive equality', (query, shape, ids) => {
    expect(parser.parse(query)).toMatchObject(shape);
    expectIds(query, ids);
  });
});
