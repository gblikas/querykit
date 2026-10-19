/**
 * A string ordered against a number, and a number against a string.
 *
 * SQLite with no affinity orders every number below every text value, so
 * `label:>2` keeps every string including the empty one, `label:<10` keeps
 * none, `count:>"2"` keeps none and `count:<"10"` keeps every number. Memory
 * applies the same class order to a bare number against a string instead
 * of treating the pair as unordered; a quoted numeral against a number
 * takes the number's affinity there, as a typed column does.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
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

  // The SQLite table here has no column affinity, so the text `2` ranks
  // above every count. The in-memory adapter follows a typed column
  // instead (`docs/pglite-parity-survey.md`, group 4a: PGlite and a typed
  // SQLite table both read `"2"` against an integer column as 2), so
  // `count:>"2"` keeps the count above 2 and `count:<"10"` the counts
  // below 10 there. A bare number against a text value (group 4b) is
  // unchanged.
  it.each([
    ['label:>2', 'label', '>', 2, [1, 2, 3, 4], [1, 2, 3, 4]],
    ['label:<10', 'label', '<', 10, [], []],
    ['count:>"2"', 'count', '>', '2', [], [7]],
    ['count:<"10"', 'count', '<', '10', [5, 6, 7], [5, 6]]
  ])(
    '%s puts every string above every number on every engine',
    (query, field, operator, value, expectedIds, memoryIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator,
        value
      });
      const run = harness.expectSameSqlIds(query, expectedIds);
      expect(run.parameterized.params).toEqual([value]);
      expect(run.schemaDrizzle.params).toEqual([value]);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(memoryIds);
    }
  );
});
