/**
 * Semantic oracles for the SQL translator.
 *
 * The checks follow three public bug-finding patterns:
 * - property tests (Anthropic, "Finding bugs with property-based testing"):
 *   membership agrees with equality, including null
 * - ternary-logic partitioning (SQLancer TLP): a predicate and its negation
 *   must not both match rows when the comparison is unknown
 * - differential execution against SQLite, the same idea as compiler
 *   miscompile fuzzing: translate, run, compare to the intended row set
 */

import { createRequire } from 'module';
import { QueryExpression, QueryValue } from '../../parser/types';
import { SqlTranslationError, SqlTranslator } from './index';
import { withNulSafeLike } from '../nul-safe-like';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
}

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): ISqliteStatement;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

const FIXTURE_SQL = `
  CREATE TABLE items (
    id INTEGER,
    name TEXT,
    priority INTEGER,
    status TEXT
  );
  INSERT INTO items (id, name, priority, status) VALUES
    (1, '100%', 1, 'open'),
    (2, '100X', 2, NULL),
    (3, 'foo\\bar', 3, 'closed'),
    (4, 'fooXbar', NULL, 'open'),
    (5, 'a_b', 5, 'pending'),
    (6, 'ab', 0, 'open'),
    (7, 'axb', 7, 'open');
`;

function openItemsDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(FIXTURE_SQL);
  return database;
}

function comparison(
  field: string,
  operator: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'IN' | 'NOT IN' | 'LIKE',
  value: QueryValue
): QueryExpression {
  return { type: 'comparison', field, operator, value };
}

function negation(expression: QueryExpression): QueryExpression {
  return { type: 'logical', operator: 'NOT', left: expression };
}

describe('SqlTranslator semantics', () => {
  const database = openItemsDatabase();

  afterAll((): void => {
    database.close();
  });

  function matchingIds(
    expression: QueryExpression,
    useParameters: boolean
  ): number[] {
    const translator = new SqlTranslator({ useParameters });
    const translated = translator.translate(expression);
    const whereSql =
      typeof translated === 'string' ? translated : translated.sql;
    const params = typeof translated === 'string' ? [] : translated.params;
    return database
      .prepare(`SELECT id FROM items WHERE ${whereSql} ORDER BY id`)
      .all(...params)
      .map(row => row.id);
  }

  it('matches no rows for ordered comparisons with null, including under NOT', (): void => {
    const operators = ['>', '>=', '<', '<='] as const;
    for (const operator of operators) {
      for (const useParameters of [true, false]) {
        const expression = comparison('priority', operator, null);
        expect(matchingIds(expression, useParameters)).toEqual([]);
        expect(matchingIds(negation(expression), useParameters)).toEqual([]);
      }
    }
  });

  it('treats a one-element IN and NOT IN list like equality, including null', (): void => {
    const samples: Array<{ field: string; value: QueryValue }> = [
      { field: 'status', value: null },
      { field: 'status', value: 'open' },
      { field: 'priority', value: null },
      { field: 'priority', value: 2 }
    ];
    for (const sample of samples) {
      for (const useParameters of [true, false]) {
        expect(
          matchingIds(
            comparison(sample.field, 'IN', [sample.value]),
            useParameters
          )
        ).toEqual(
          matchingIds(
            comparison(sample.field, '==', sample.value),
            useParameters
          )
        );
        expect(
          matchingIds(
            comparison(sample.field, 'NOT IN', [sample.value]),
            useParameters
          )
        ).toEqual(
          matchingIds(
            comparison(sample.field, '!=', sample.value),
            useParameters
          )
        );
      }
    }
  });

  it('does not let a null member make NOT IN match nothing', (): void => {
    const expression = comparison('status', 'NOT IN', [null, 'closed']);
    for (const useParameters of [true, false]) {
      expect(matchingIds(expression, useParameters)).toEqual([1, 4, 5, 6, 7]);
    }
  });

  it('treats % in a LIKE pattern as a literal percent', (): void => {
    const expression = comparison('name', 'LIKE', '100%');
    for (const useParameters of [true, false]) {
      expect(matchingIds(expression, useParameters)).toEqual([1]);
    }
  });

  it('treats _ in a LIKE pattern as a literal underscore', (): void => {
    const expression = comparison('name', 'LIKE', 'a_b');
    for (const useParameters of [true, false]) {
      expect(matchingIds(expression, useParameters)).toEqual([5]);
    }
  });

  it('does not let a literal backslash escape the following wildcard', (): void => {
    const expression = comparison('name', 'LIKE', 'foo\\*');
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    );
    const parameterized = new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as { sql: string; params: unknown[] };
    expect(inline).toBe(withNulSafeLike("\"name\" LIKE 'foo\\%' ESCAPE '!'"));
    expect(parameterized.sql).toBe(
      withNulSafeLike('"name" LIKE ? ESCAPE \'!\'')
    );
    expect(parameterized.params).toEqual(['foo\\%']);
    expect(matchingIds(expression, false)).toEqual([3]);
    expect(matchingIds(expression, true)).toEqual([3]);
  });

  it('quotes inherited property names instead of reading them from the mapping object', (): void => {
    const translator = new SqlTranslator({ useParameters: false });
    expect(translator.translate(comparison('toString', '==', 'x'))).toBe(
      '"toString" = \'x\''
    );
    expect(translator.translate(comparison('constructor', '==', 'x'))).toBe(
      '"constructor" = \'x\''
    );
  });

  it('rejects non-finite numbers instead of emitting invalid SQL', (): void => {
    const values = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ];
    for (const value of values) {
      for (const useParameters of [true, false]) {
        const translator = new SqlTranslator({ useParameters });
        expect(() =>
          translator.translate(comparison('priority', '==', value))
        ).toThrow(SqlTranslationError);
        expect(() =>
          translator.translate(comparison('priority', '==', value))
        ).toThrow(/Non-finite numbers are not supported/);
        expect(() =>
          translator.translate(comparison('priority', 'IN', [value, 1]))
        ).toThrow(/Non-finite numbers are not supported/);
      }
    }
  });
});
