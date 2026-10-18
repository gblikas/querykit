/**
 * Boolean parity across the translators.
 *
 * A boolean is never bound as a JavaScript boolean, which better-sqlite3
 * cannot bind: parameterized SQL and Drizzle inline `TRUE` and `FALSE`
 * (inline SQL keeps its lowercase `true` / `false`). SQLite stores the
 * booleans as 1 and 0, so false orders before true and null stays unknown,
 * including under NOT. On mixed rows the engines follow SQLite: a boolean is
 * its integer, and every string is greater than every number.
 *
 * The in-memory matcher applies the same order to real booleans.
 */

import { createRequire } from 'module';
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from './drizzle';
import { SqlTranslator } from './sql';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
  run(...params: unknown[]): unknown;
}

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): ISqliteStatement;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

const flagRows = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: null }
];

const mixedRows: Array<{ id: number; flag: unknown }> = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: null },
  { id: 4, flag: 0 },
  { id: 5, flag: 'false' },
  { id: 6, flag: 1 }
];

const rawSchema = { items: { flag: sql.raw('flag') } };

function storedFlag(flag: unknown): unknown {
  if (typeof flag === 'boolean') {
    return flag ? 1 : 0;
  }
  return flag;
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE flags (id INTEGER PRIMARY KEY, flag);
    CREATE TABLE mixed (id INTEGER PRIMARY KEY, flag);
  `);
  const insertFlag = database.prepare('INSERT INTO flags VALUES (?, ?)');
  for (const row of flagRows) {
    insertFlag.run(row.id, storedFlag(row.flag));
  }
  const insertMixed = database.prepare('INSERT INTO mixed VALUES (?, ?)');
  for (const row of mixedRows) {
    insertMixed.run(row.id, storedFlag(row.flag));
  }
  return database;
}

describe('boolean parity', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(table: string, statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM ${table} WHERE ${statement.sql} ORDER BY id`)
      .all(...statement.params)
      .map(row => row.id);
  }

  function compileDrizzle(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): IParameterizedSql {
    const translator = new DrizzleTranslator(schema ? { schema } : {});
    const compiled = dialect.sqlToQuery(translator.translate(expression));
    return { sql: compiled.sql, params: compiled.params };
  }

  /** Every SQL engine must agree on the ids; returns the compiled forms. */
  function runSqlEngines(
    table: string,
    query: string,
    expectedIds: number[]
  ): {
    inlineSql: string;
    parameterized: IParameterizedSql;
    drizzle: IParameterizedSql;
    rawDrizzle: IParameterizedSql;
  } {
    const expression = parser.parse(query);
    const inlineSql = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    const bare = compileDrizzle(expression);
    const rawDrizzle = compileDrizzle(expression, rawSchema);
    expect(idsOfSql(table, { sql: inlineSql, params: [] })).toEqual(
      expectedIds
    );
    expect(idsOfSql(table, parameterized)).toEqual(expectedIds);
    expect(idsOfSql(table, bare)).toEqual(expectedIds);
    expect(idsOfSql(table, rawDrizzle)).toEqual(expectedIds);
    return { inlineSql, parameterized, drizzle: bare, rawDrizzle };
  }

  const orderedCases: Array<[string, string, number[]]> = [
    ['flag:>false', '"flag" > FALSE', [1]],
    ['NOT flag:>false', 'NOT ("flag" > FALSE)', [2]],
    ['flag:<true', '"flag" < TRUE', [2]],
    ['flag:>=false', '"flag" >= FALSE', [1, 2]],
    ['flag:<=true', '"flag" <= TRUE', [1, 2]],
    ['flag:true', '"flag" = TRUE', [1]],
    ['flag:!=true', 'NOT ("flag" = TRUE)', [2]],
    ['flag:in[true]', '"flag" IN (TRUE)', [1]],
    ['flag:not in[false]', '"flag" NOT IN (FALSE)', [1]]
  ];

  it.each(orderedCases)(
    '%s orders false before true and keeps null unknown',
    (query, parameterizedSql, expectedIds) => {
      const run = runSqlEngines('flags', query, expectedIds);
      expect(run.inlineSql).toBe(
        parameterizedSql.replace(/TRUE/g, 'true').replace(/FALSE/g, 'false')
      );
      expect(run.parameterized).toEqual({ sql: parameterizedSql, params: [] });
      expect(run.drizzle.params).toEqual([]);
      expect(run.rawDrizzle.params).toEqual([]);
      // Drizzle writes `!=` and a lowercase `in`; the shape is otherwise the same.
      expect(run.drizzle.sql.toUpperCase()).toBe(
        parameterizedSql.replace(' <> ', ' != ').toUpperCase()
      );
    }
  );

  it('inlines TRUE and FALSE instead of binding a JavaScript boolean', () => {
    const expression = parser.parse('flag:>false');
    expect(new SqlTranslator().translate(expression)).toEqual({
      sql: '"flag" > FALSE',
      params: []
    });
    expect(compileDrizzle(expression)).toEqual({
      sql: '"flag" > FALSE',
      params: []
    });
    expect(compileDrizzle(expression, rawSchema)).toEqual({
      sql: 'flag > FALSE',
      params: []
    });
  });

  // SQLite orders every number, including a stored boolean, below every
  // string, so the text row `false` is greater than 0 and less than `true`.
  const mixedCases: Array<[string, number[]]> = [
    ['flag:>0', [1, 5, 6]],
    ['flag:1', [1, 6]],
    ['flag:<"true"', [1, 2, 4, 5, 6]],
    ['flag:"false"', [5]]
  ];

  it.each(mixedCases)(
    '%s follows SQLite on mixed rows',
    (query, expectedIds) => {
      runSqlEngines('mixed', query, expectedIds);
    }
  );

  // False orders before true, a boolean is its integer in equality and
  // order, and every string is greater than every number and every boolean.
  describe('in memory', () => {
    it.each(orderedCases)('%s matches the SQL engines', (query, _sql, ids) => {
      expect(filterInMemory(query, flagRows).map(row => row.id)).toEqual(ids);
    });

    it.each(mixedCases)('%s matches the SQL engines', (query, ids) => {
      expect(filterInMemory(query, mixedRows).map(row => row.id)).toEqual(ids);
    });
  });
});
