/**
 * Truthy string equality.
 *
 * `flag:yes`, `flag:YES`, `flag:"1"` and `flag:"0"` are the strings `yes`,
 * `YES`, `1` and `0`. Every engine binds that text, including a boolean-mode
 * Drizzle column, whose encoder would otherwise turn each of them into `1`
 * and match the boolean-true row. Only the exact string `yes` matches the
 * string row.
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
  { id: 3, flag: 'yes' }
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

describe('truthy string equality', () => {
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
    ['flag:yes', 'yes', [3]],
    ['flag:YES', 'YES', []],
    ['flag:"1"', '1', []],
    ['flag:"0"', '0', []]
  ])('%s binds the text on every engine', (query, value, expectedIds) => {
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
    expect(inline).toBe(`"flag" = '${value}'`);
    expect(parameterized).toEqual({ sql: '"flag" = ?', params: [value] });
    expect(bare).toEqual({ sql: '"flag" = ?', params: [value] });
    expect(schemaDrizzle).toEqual({
      sql: '"items"."flag" = ?',
      params: [value]
    });
    expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
    expect(idsOfSql(parameterized)).toEqual(expectedIds);
    expect(idsOfSql(bare)).toEqual(expectedIds);
    expect(idsOfSql(schemaDrizzle)).toEqual(expectedIds);
    expect(idsOfBuilder(expression)).toEqual(expectedIds);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(expectedIds);
  });
});
