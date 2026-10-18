/**
 * LIKE on a numeric column.
 *
 * SQLite applies a LIKE pattern to the decimal text of a stored number, so
 * `priority:*2*` keeps 12, 2, 21, -12 and 12.5. Memory matches a finite
 * number as `String(value)`, which is that same text. Null stays unknown,
 * so it is out of both the filter and its NOT.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { DrizzleTranslator } from '../../translators/drizzle';
import { SqlTranslator } from '../../translators/sql';
import { filterInMemory } from './filter-in-memory';

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

const rows: Array<{ id: number; priority: number | null }> = [
  { id: 1, priority: 12 },
  { id: 2, priority: 2 },
  { id: 3, priority: 1 },
  { id: 4, priority: 10 },
  { id: 5, priority: 21 },
  { id: 6, priority: 100 },
  { id: 7, priority: 0 },
  { id: 8, priority: -12 },
  { id: 9, priority: 12.5 },
  { id: 10, priority: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  priority: integer('priority')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, priority INTEGER)'
  );
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.priority);
  }
  return database;
}

describe('LIKE on a number', () => {
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

  it.each([
    ['priority:*2*', [1, 2, 5, 8, 9]],
    ['priority:"1*"', [1, 3, 4, 6, 9]],
    ['priority:?2', [1]],
    ['NOT priority:*2*', [3, 4, 6, 7]],
    ['NOT priority:"1*"', [2, 5, 7, 8]]
  ])('%s matches the decimal text on every engine', (query, expectedIds) => {
    const expression = parser.parse(query);
    expect(JSON.stringify(expression)).toContain('"LIKE"');
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
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(expectedIds);
  });
});
