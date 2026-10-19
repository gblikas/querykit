/**
 * A bare numeral against text, integer, and real storage.
 *
 * `year:2024` is the number 2024. A TEXT column that holds the strings
 * `2024` and `2023` must not treat the integer literal as that string.
 * Inline SQL, parameterized SQL, Drizzle, and in-memory return the same
 * ids. An INTEGER column and a REAL column that store the number 2024
 * still match it.
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

const equalQuery = 'year:2024';
const unequalQuery = 'year:!=2024';

describe('a bare numeral against text, integer, and real storage', () => {
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
  const cases: Array<
    [string, ISqliteHarness<ITextRow | INumberRow>, number[], number[]]
  > = [
    ['TEXT', textual, [], [1, 2]],
    ['INTEGER', numeric, [1], [2]],
    ['REAL', decimal, [1], [2]]
  ];

  it.each(cases)(
    'year:2024 on %s returns the same ids on every engine',
    (_affinity, harness, equalIds) => {
      expect(isInputComplete(equalQuery)).toBe(true);
      expect(harness.parser.parse(equalQuery)).toEqual({
        type: 'comparison',
        field: 'year',
        operator: '==',
        value: 2024
      });
      const run = harness.expectSameIds(equalQuery, equalIds);
      expect(run.inlineSql).toBe(
        `("year" IS NULL AND NULL) OR (typeof("year") IN ('integer', 'real') AND "year" = 2024)`
      );
      expect(run.parameterized).toEqual({
        sql: `("year" IS NULL AND NULL) OR (typeof("year") IN ('integer', 'real') AND "year" = ?)`,
        params: [2024]
      });
    }
  );

  it.each(cases)(
    'year:!=2024 on %s returns the same ids on every engine',
    (_affinity, harness, _equalIds, unequalIds) => {
      expect(isInputComplete(unequalQuery)).toBe(true);
      expect(harness.parser.parse(unequalQuery)).toEqual({
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'comparison',
          field: 'year',
          operator: '==',
          value: 2024
        }
      });
      const run = harness.expectSameIds(unequalQuery, unequalIds);
      expect(run.inlineSql).toBe(
        `NOT (("year" IS NULL AND NULL) OR (typeof("year") IN ('integer', 'real') AND "year" = 2024))`
      );
      expect(run.parameterized).toEqual({
        sql: `NOT (("year" IS NULL AND NULL) OR (typeof("year") IN ('integer', 'real') AND "year" = ?))`,
        params: [2024]
      });
    }
  );
});
