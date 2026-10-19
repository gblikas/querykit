/**
 * Range bounds across the engines.
 *
 * `field:[a TO b]` is rewritten to `>= a AND <= b`, `*` drops a side, a
 * blank side is rejected and swapped bounds match nothing. Two strings
 * compare by Unicode code point, which is SQLite's binary order, so a range
 * whose bounds cross from the basic multilingual plane into a supplementary
 * character (`U+FFFF` to `😀`) keeps both ends in memory as well.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { QueryParseError } from '../parser/parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{
  id: number;
  priority: number | null;
  label: string | null;
}> = [
  { id: 1, priority: 1, label: '\uFFFF' },
  { id: 2, priority: 2, label: '😀' },
  { id: 3, priority: 0, label: 'a' },
  { id: 4, priority: 11, label: '🚀' },
  { id: 5, priority: null, label: null },
  { id: 6, priority: 10, label: 'm' },
  { id: 7, priority: -1, label: 'b' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  priority: integer('priority'),
  label: text('label')
});

describe('range bounds', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { priority: 'INTEGER', label: 'TEXT' },
    rows
  });

  /** Every engine must return the same ids for the query. */
  function expectIds(query: string, expectedIds: number[]): void {
    harness.expectSameIds(query, expectedIds);
  }

  it('keeps an inclusive numeric range and matches nothing when swapped', () => {
    expect(parser.parse('priority:[1 TO 10]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: { type: 'comparison', field: 'priority', operator: '>=', value: 1 },
      right: {
        type: 'comparison',
        field: 'priority',
        operator: '<=',
        value: 10
      }
    });
    expectIds('priority:[1 TO 10]', [1, 2, 6]);
    expectIds('priority:[10 TO 1]', []);
    expectIds('label:[m TO b]', []);
  });

  it.each(['priority:[ TO 10]', 'priority:[1 TO ]', 'label:[ TO m]'])(
    'rejects the blank side of %s',
    query => {
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    }
  );

  it('drops the side written as *', () => {
    expect(parser.parse('priority:[* TO 10]')).toEqual({
      type: 'comparison',
      field: 'priority',
      operator: '<=',
      value: 10
    });
    expectIds('priority:[* TO 10]', [1, 2, 3, 6, 7]);
    expectIds('priority:[1 TO *]', [1, 2, 4, 6]);
  });

  it('orders strings by code point across the supplementary plane', () => {
    expect(parser.parse('label:[* TO 😀]')).toEqual({
      type: 'comparison',
      field: 'label',
      operator: '<=',
      value: '😀'
    });
    expectIds('label:[* TO 😀]', [1, 2, 3, 6, 7]);
    expectIds('label:[\uFFFF TO 😀]', [1, 2]);
  });
});
