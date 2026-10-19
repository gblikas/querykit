/**
 * A boolean field ordered against a number.
 *
 * `flag:>0`, `flag:>=1`, `flag:<1` and `flag:<=0` carry the numbers 0 and 1.
 * SQLite stores a boolean as that integer, so a boolean-mode column, a
 * no-affinity column and memory all keep boolean true beside the number 1
 * and boolean false beside the number 0. Equality uses the same integers.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; flag: boolean | number }> = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: 1 },
  { id: 4, flag: 0 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  flag: integer('flag', { mode: 'boolean' })
});

describe('a boolean field ordered against a number', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { flag: '' },
    rows
  });

  it.each([
    ['flag:>0', '>', 0, [1, 3]],
    ['flag:>=1', '>=', 1, [1, 3]],
    ['flag:<1', '<', 1, [2, 4]],
    ['flag:<=0', '<=', 0, [2, 4]],
    ['flag:1', '==', 1, [1, 3]],
    ['flag:0', '==', 0, [2, 4]]
  ])(
    '%s keeps the boolean beside its integer on every engine',
    (query, operator, value, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'flag',
        operator,
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.parameterized.params).toEqual([value]);
      expect(run.schemaDrizzle.params).toEqual([value]);
    }
  );
});
