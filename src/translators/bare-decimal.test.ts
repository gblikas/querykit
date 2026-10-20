/**
 * A bare decimal against text and real storage.
 *
 * `year:2024.0`, `year:>2024.0`, and `year in (2024.0)` compare the number
 * 2024. On a TEXT column the strings `2024`, `2024.0`, and `2025` follow
 * storage class: a number does not equal text, and every text value is
 * greater than every number. Inline SQL, parameterized SQL, Drizzle, and
 * in-memory return the same ids. A REAL column that stores 2024 and 2024.0
 * still matches that number.
 */

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
  { id: 1, year: '2024' },
  { id: 2, year: '2024.0' },
  { id: 3, year: '2025' }
];

const numberRows: INumberRow[] = [
  { id: 1, year: 2024 },
  { id: 2, year: 2024.0 },
  { id: 3, year: 2025 }
];

const textItems = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  year: text('year')
});

const realItems = sqliteTable('measures', {
  id: integer('id').primaryKey(),
  year: real('year')
});

const equalQuery = 'year:2024.0';
const greaterQuery = 'year:>2024.0';
const inQuery = 'year in (2024.0)';

/**
 * The expression each bare-decimal query parses to.
 *
 * @param query - One of the three decimal queries
 * @returns The parsed expression
 */
function expressionOf(query: string): QueryExpression {
  if (query === greaterQuery) {
    return {
      type: 'comparison',
      field: 'year',
      operator: '>',
      value: 2024
    };
  }
  if (query === inQuery) {
    return {
      type: 'comparison',
      field: 'year',
      operator: 'IN',
      value: [2024]
    };
  }
  return {
    type: 'comparison',
    field: 'year',
    operator: '==',
    value: 2024
  };
}

describe('a bare decimal against text and real storage', () => {
  const textual = openSqliteHarness({
    table: textItems,
    columns: { year: 'TEXT' },
    rows: textRows
  });
  const decimal = openSqliteHarness({
    table: realItems,
    columns: { year: 'REAL' },
    rows: numberRows
  });
  const harnesses: Record<string, ISqliteHarness<ITextRow | INumberRow>> = {
    TEXT: textual,
    REAL: decimal
  };
  const cases: Array<[string, string, number[]]> = [
    ['TEXT', equalQuery, []],
    ['TEXT', greaterQuery, [1, 2, 3]],
    ['TEXT', inQuery, []],
    ['REAL', equalQuery, [1, 2]],
    ['REAL', greaterQuery, [3]],
    ['REAL', inQuery, [1, 2]]
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
