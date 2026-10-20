/**
 * A bare numeral ordered against text, integer, and real storage.
 *
 * `year:>2024`, `year:<2024` and `year:>=2024` compare the number 2024.
 * On a TEXT column the strings `2024` and `2023` follow storage class:
 * every text value is greater than every number. Inline SQL, parameterized
 * SQL, Drizzle, and in-memory return the same ids. An INTEGER column and a
 * REAL column that store those numbers still compare them numerically.
 */

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { isInputComplete } from '../parser/input-parser';
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
  { id: 2, year: '2023' }
];

const numberRows: INumberRow[] = [
  { id: 1, year: 2024 },
  { id: 2, year: 2023 }
];

const textItems = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  year: text('year')
});

const integerItems = sqliteTable('counts', {
  id: integer('id').primaryKey(),
  year: integer('year')
});

const realItems = sqliteTable('measures', {
  id: integer('id').primaryKey(),
  year: real('year')
});

type OrderOperator = '>' | '<' | '>=';

describe('a bare numeral ordered against text, integer, and real storage', () => {
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
  const decimal = openSqliteHarness({
    table: realItems,
    columns: { year: 'REAL' },
    rows: numberRows
  });
  const harnesses: Record<string, ISqliteHarness<ITextRow | INumberRow>> = {
    TEXT: textual,
    INTEGER: numeric,
    REAL: decimal
  };
  const cases: Array<[string, string, OrderOperator, number[]]> = [
    ['TEXT', 'year:>2024', '>', [1, 2]],
    ['TEXT', 'year:<2024', '<', []],
    ['TEXT', 'year:>=2024', '>=', [1, 2]],
    ['INTEGER', 'year:>2024', '>', []],
    ['INTEGER', 'year:<2024', '<', [2]],
    ['INTEGER', 'year:>=2024', '>=', [1]],
    ['REAL', 'year:>2024', '>', []],
    ['REAL', 'year:<2024', '<', [2]],
    ['REAL', 'year:>=2024', '>=', [1]]
  ];

  it.each(cases)(
    '%s %s returns the same ids on every engine',
    (affinity, query, operator, expectedIds) => {
      const harness = harnesses[affinity];
      expect(isInputComplete(query)).toBe(true);
      expect(harness.parser.parse(query)).toEqual({
        type: 'comparison',
        field: 'year',
        operator,
        value: 2024
      });
      harness.expectSameIds(query, expectedIds);
    }
  );
});
