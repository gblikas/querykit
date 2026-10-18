/**
 * Boolean equality values.
 *
 * Liqe reads only the lowercase words as booleans: `flag:true` is the
 * boolean and `flag:TRUE` is the string `TRUE`. A boolean inlines `TRUE` /
 * `FALSE` on parameterized SQL and schema-less Drizzle, and goes through the
 * encoder of a boolean-mode column, which binds `1` / `0`. A string is bound
 * as that text on every engine, including a boolean-mode column, whose
 * encoder would otherwise turn any truthy string into `1`.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
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

const rows: Array<{ id: number; flag: unknown }> = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: 'true' },
  { id: 4, flag: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  flag: integer('flag', { mode: 'boolean' })
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, flag)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    const stored =
      typeof row.flag === 'boolean' ? (row.flag ? 1 : 0) : row.flag;
    insert.run(row.id, stored);
  }
  return database;
}

describe('boolean equality values', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const db = drizzle(database as never);

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${statement.sql} ORDER BY id`)
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

  function idsOfBuilder(expression: QueryExpression): number[] {
    const condition = new DrizzleTranslator({ schema: { items } }).translate(
      expression,
      { tableName: 'items' }
    );
    return db
      .select({ id: items.id })
      .from(items)
      .where(condition)
      .orderBy(items.id)
      .all()
      .map(row => row.id as number);
  }

  it.each([
    ['flag:true', true, '"flag" = true', '"flag" = TRUE', [], [1], [1]],
    ['flag:false', false, '"flag" = false', '"flag" = FALSE', [], [0], [2]],
    [
      'flag:TRUE',
      'TRUE',
      `"flag" = 'TRUE'`,
      '"flag" = ?',
      ['TRUE'],
      ['TRUE'],
      []
    ],
    [
      'flag:FALSE',
      'FALSE',
      `"flag" = 'FALSE'`,
      '"flag" = ?',
      ['FALSE'],
      ['FALSE'],
      []
    ]
  ])(
    '%s returns the same ids on every engine',
    (
      query,
      value,
      inlineSql,
      parameterizedSql,
      params,
      booleanColumnParams,
      expectedIds
    ) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'flag',
        operator: '==',
        value
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const bare = compileDrizzle(expression);
      const schemaDrizzle = compileDrizzle(expression, { items });
      expect(inline).toBe(inlineSql);
      expect(parameterized).toEqual({ sql: parameterizedSql, params });
      expect(bare).toEqual({ sql: parameterizedSql, params });
      expect(schemaDrizzle).toEqual({
        sql: '"items"."flag" = ?',
        params: booleanColumnParams
      });
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(bare)).toEqual(expectedIds);
      expect(idsOfSql(schemaDrizzle)).toEqual(expectedIds);
      expect(idsOfBuilder(expression)).toEqual(expectedIds);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );
});
