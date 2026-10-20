/**
 * Quoted numerals in inequality and ordered comparison.
 *
 * `count:"2"` already matches the number 2. The same numeric affinity
 * applies to `!=`, `>`, `>=` and `<`: a quoted decimal is that number
 * against a number, and it stays text against a string. Inline SQL,
 * parameterized SQL, Drizzle on an integer column and on a text column,
 * and in-memory filtering return the same ids. The SQLite columns have
 * no affinity, so the numbers stay numbers and the strings stay strings.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; count: number | string }> = [
  { id: 1, count: 2 },
  { id: 2, count: 2.0 },
  { id: 3, count: 10 },
  { id: 4, count: '2' },
  { id: 5, count: '2.0' },
  { id: 6, count: '10' }
];

const numericItems = sqliteTable('counts', {
  id: integer('id').primaryKey(),
  count: integer('count')
});

const textItems = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  count: text('count')
});

describe('quoted numeral comparisons', () => {
  const parser = new QueryParser();
  const numeric = openSqliteHarness({
    table: numericItems,
    columns: { count: '' },
    rows
  });
  const textual = openSqliteHarness({
    table: textItems,
    columns: { count: '' },
    rows
  });

  it.each([
    ['count:!="2"', '2', [3, 5, 6]],
    ['count:>"2"', '2', [3, 5]],
    ['count:>="2.0"', '2.0', [1, 2, 3, 5]],
    ['count:<"10"', '10', [1, 2]]
  ] as const)(
    '%s returns the same ids on every engine',
    (query, value, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      const operator = query.includes('!=')
        ? 'NOT'
        : query.includes('>=')
          ? '>='
          : query.includes('>')
            ? '>'
            : '<';
      if (operator === 'NOT') {
        expect(expression).toEqual({
          type: 'logical',
          operator: 'NOT',
          left: {
            type: 'comparison',
            field: 'count',
            operator: '==',
            value
          }
        });
      } else {
        expect(expression).toEqual({
          type: 'comparison',
          field: 'count',
          operator,
          value
        });
      }
      numeric.expectSameIds(query, [...expectedIds]);
      textual.expectSameIds(query, [...expectedIds]);
    }
  );
});
