/**
 * The empty string against null.
 *
 * `name:""` matches only the empty string and `name:null` only null, on
 * inline SQL, parameterized SQL, Drizzle and in memory. Inequality with `""`
 * leaves the null row out (unknown stays unknown under NOT), inequality
 * with null keeps every non-null value including `""`, and `LIKE '%'`
 * matches every non-null string including the empty one.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { filterByExpression } from '../adapters/memory/match-expression';
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

const rows: Array<{ id: number; name: string | null }> = [
  { id: 1, name: '' },
  { id: 2, name: null },
  { id: 3, name: 'a' },
  { id: 4, name: ' ' },
  { id: 5, name: 'ab' },
  { id: 6, name: '%' },
  { id: 7, name: '_' },
  { id: 8, name: '!' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  name: text('name')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.name);
  }
  return database;
}

describe('the empty string against null', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();

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

  function expectIds(expression: QueryExpression, expectedIds: number[]): void {
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
    expect(idsOfSql(parameterized)).toEqual(expectedIds);
    expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
    expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(
      expectedIds
    );
    expect(filterByExpression(expression, rows).map(row => row.id)).toEqual(
      expectedIds
    );
  }

  it.each([
    ['name:""', [1]],
    ["name:''", [1]],
    ['name:null', [2]],
    ['name:!=""', [3, 4, 5, 6, 7, 8]],
    ['NOT name:""', [3, 4, 5, 6, 7, 8]],
    ['name:!=null', [1, 3, 4, 5, 6, 7, 8]],
    ['NOT name:null', [1, 3, 4, 5, 6, 7, 8]],
    ['name:*', [1, 3, 4, 5, 6, 7, 8]],
    ['NOT name:*', []],
    ['name:"" OR name:null', [1, 2]],
    ['name:"" AND name:null', []]
  ])(
    '%s keeps the empty string and null apart on every engine',
    (query, ids) => {
      expectIds(parser.parse(query), ids);
    }
  );

  it('matches only the empty string with an empty LIKE pattern', () => {
    expectIds(
      { type: 'comparison', field: 'name', operator: 'LIKE', value: '' },
      [1]
    );
  });
});
