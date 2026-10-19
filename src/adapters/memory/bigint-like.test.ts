/**
 * LIKE on a bigint column.
 *
 * better-sqlite3 binds `10n`, `20n` and `-12n` as integers and SQLite applies
 * a LIKE pattern to their decimal text. Memory matches a bigint as
 * `toString()`, including the leading minus, and never as `10n`.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; amount: bigint }> = [
  { id: 1, amount: 10n },
  { id: 2, amount: 20n },
  { id: 3, amount: -12n }
];

const items = sqliteTable('items', {
  id: integer('id'),
  amount: integer('amount')
});

describe('LIKE on a bigint', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { amount: 'INTEGER' },
    rows
  });

  it.each([
    ['amount:*0*', [1, 2]],
    ['amount:"1*"', [1]],
    ['amount:"-*"', [3]],
    ['amount:*n*', []],
    ['NOT amount:*0*', [3]]
  ])('%s matches the decimal text on every engine', (query, expectedIds) => {
    const expression = parser.parse(query);
    expect(JSON.stringify(expression)).toContain('"LIKE"');
    harness.expectSameIds(query, expectedIds);
  });
});
