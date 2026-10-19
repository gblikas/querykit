/**
 * A bare numeral in a membership list against text and integer storage.
 *
 * `year in (2023, 2024)`, `year not in (2024)`, and `year:[2023, 2024]`
 * name the numbers 2023 and 2024. On a TEXT column the strings `2023`,
 * `2024`, and `2025` follow storage class: a number does not equal text.
 * Inline SQL, parameterized SQL, Drizzle, and in-memory return the same
 * ids. An INTEGER column that stores those numbers still matches the
 * numbers that are in the list.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { isInputComplete } from '../parser/input-parser';
import { QueryExpression } from '../parser/types';
import { openSqliteHarness } from '../test-support';
import { ISqliteHarness } from '../test-support/types';

interface ITextRow {
  id: number;
  year: string;
}

interface INumberRow {
  id: number;
  year: number;
}

const textRows: ITextRow[] = [
  { id: 1, year: '2023' },
  { id: 2, year: '2024' },
  { id: 3, year: '2025' }
];

const numberRows: INumberRow[] = [
  { id: 1, year: 2023 },
  { id: 2, year: 2024 },
  { id: 3, year: 2025 }
];

const textItems = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  year: text('year')
});

const integerItems = sqliteTable('counts', {
  id: integer('id').primaryKey(),
  year: integer('year')
});

const inQuery = 'year in (2023, 2024)';
const excludedQuery = 'year not in (2024)';
const bracketQuery = 'year:[2023, 2024]';

/**
 * The expression each membership query parses to.
 *
 * @param query - One of the three membership queries
 * @returns The parsed expression
 */
function expressionOf(query: string): QueryExpression {
  if (query === inQuery) {
    return {
      type: 'comparison',
      field: 'year',
      operator: 'IN',
      value: [2023, 2024]
    };
  }
  if (query === excludedQuery) {
    return {
      type: 'comparison',
      field: 'year',
      operator: 'NOT IN',
      value: [2024]
    };
  }
  return {
    type: 'logical',
    operator: 'OR',
    left: {
      type: 'comparison',
      field: 'year',
      operator: '==',
      value: 2023
    },
    right: {
      type: 'comparison',
      field: 'year',
      operator: '==',
      value: 2024
    }
  };
}

describe('a bare numeral in a membership list', () => {
  const textual = openSqliteHarness({
    table: textItems,
    columns: { year: 'TEXT' },
    rows: textRows
  });
  const numeric = openSqliteHarness({
    table: integerItems,
    columns: { year: 'INTEGER' },
    rows: numberRows
  });
  const harnesses: Record<string, ISqliteHarness<ITextRow | INumberRow>> = {
    TEXT: textual,
    INTEGER: numeric
  };
  const cases: Array<[string, string, number[]]> = [
    ['TEXT', inQuery, []],
    ['TEXT', excludedQuery, [1, 2, 3]],
    ['TEXT', bracketQuery, []],
    ['INTEGER', inQuery, [1, 2]],
    ['INTEGER', excludedQuery, [1, 3]],
    ['INTEGER', bracketQuery, [1, 2]]
  ];

  it.each(cases)(
    '%s %s returns the same ids on every engine',
    (affinity, query, expectedIds) => {
      const harness = harnesses[affinity];
      expect(isInputComplete(query)).toBe(true);
      expect(harness.parser.parse(query)).toEqual(expressionOf(query));
      harness.expectSameIds(query, expectedIds);
    }
  );
});
