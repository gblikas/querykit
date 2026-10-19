/**
 * A number field ordered against a boolean literal.
 *
 * `count:>true`, `count:>=false`, `count:<true` and `count:<=false` inline
 * `TRUE` and `FALSE`, which SQLite reads as 1 and 0. Memory compares the
 * number field with that integer, so the engines return the same ids.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; count: number }> = [
  { id: 1, count: 1 },
  { id: 2, count: 0 },
  { id: 3, count: 2 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

describe('a number field ordered against a boolean', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: '' },
    rows
  });

  it.each([
    ['count:>true', '>', true, '"count" > TRUE', [3]],
    ['count:>=false', '>=', false, '"count" >= FALSE', [1, 2, 3]],
    ['count:<true', '<', true, '"count" < TRUE', [2]],
    ['count:<=false', '<=', false, '"count" <= FALSE', [2]]
  ])(
    '%s compares the number with the integer on every engine',
    (query, operator, value, parameterizedSql, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'count',
        operator,
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.parameterized).toEqual({ sql: parameterizedSql, params: [] });
      expect(run.schemaDrizzle).toEqual({
        sql: `"items".${parameterizedSql}`,
        params: []
      });
    }
  );
});
