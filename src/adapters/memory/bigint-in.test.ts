/**
 * IN on a bigint column.
 *
 * `amount:in[10]` carries the number 10. SQLite sees two rows of integer 10
 * (`10n` and `10`) and one of 20, so IN keeps ids 1 and 3 and NOT IN keeps
 * id 2. Memory matches a bigint field to a numeric member when both name
 * the same integer.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; amount: bigint | number }> = [
  { id: 1, amount: 10n },
  { id: 2, amount: 20n },
  { id: 3, amount: 10 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  amount: integer('amount')
});

describe('IN on a bigint', () => {
  const harness = openSqliteHarness({
    table: items,
    columns: { amount: 'INTEGER' },
    rows
  });

  it.each([
    ['amount:in[10]', 'IN', '"amount" IN (10)', [1, 3]],
    ['amount:not in[10]', 'NOT IN', '"amount" NOT IN (10)', [2]],
    ['amount:in[10.5, 20]', 'IN', '"amount" IN (10.5, 20)', [2]]
  ])(
    '%s matches the same integers on every engine',
    (query, operator, inlineSql, expectedIds) => {
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.expression).toMatchObject({ field: 'amount', operator });
      expect(run.inlineSql).toBe(inlineSql);
    }
  );
});
