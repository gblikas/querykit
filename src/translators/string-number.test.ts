/**
 * A string ordered against a number, and a number against a string.
 *
 * SQLite with no affinity orders every number below every text value, so
 * `label:>2` keeps every string including the empty one and `label:<10`
 * keeps none. A quoted numeral takes a number's affinity, as a typed
 * column does, so `count:>"2"` keeps the count above 2 and `count:<"10"`
 * keeps the counts below 10, on SQL and in memory.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; label: string | null; count: number | null }> =
  [
    { id: 1, label: '10', count: null },
    { id: 2, label: '2', count: null },
    { id: 3, label: 'a', count: null },
    { id: 4, label: '', count: null },
    { id: 5, label: null, count: 1 },
    { id: 6, label: null, count: 2 },
    { id: 7, label: null, count: 10 }
  ];

const items = sqliteTable('items', {
  id: integer('id'),
  label: text('label'),
  count: integer('count')
});

describe('a string ordered against a number', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { label: '', count: '' },
    rows
  });

  // A bare number against text keeps the class order (group 4b). A quoted
  // numeral against a number is that number on every engine (group 4a).
  it.each([
    ['label:>2', 'label', '>', 2, [1, 2, 3, 4], [2]],
    ['label:<10', 'label', '<', 10, [], [10]],
    ['count:>"2"', 'count', '>', '2', [7], [2, '2']],
    ['count:<"10"', 'count', '<', '10', [5, 6], [10, '10']]
  ])(
    '%s orders a string and a number the same way on every engine',
    (query, field, operator, value, expectedIds, params) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator,
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.parameterized.params).toEqual(params);
      expect(run.schemaDrizzle.params).toEqual(params);
    }
  );
});
