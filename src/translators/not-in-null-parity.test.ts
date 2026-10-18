/**
 * NOT IN with null in the list.
 *
 * `priority:in[1,null]` is `IS NULL OR IN (1)` and keeps the null row;
 * `priority:not in[1,null]` is `IS NOT NULL AND NOT IN (1)` and keeps the
 * other non-null rows. The null member never makes the predicate unknown,
 * on inline SQL, parameterized SQL, Drizzle or in memory.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
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

const rows: Array<{ id: number; priority: number | null }> = [
  { id: 1, priority: 1 },
  { id: 2, priority: 2 },
  { id: 3, priority: null },
  { id: 4, priority: 0 }
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

describe('NOT IN with null in the list', () => {
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
    [
      'priority:in[1,null]',
      'IN',
      '("priority" IS NULL) OR ("priority" IN (1))',
      [1, 3]
    ],
    [
      'priority:not in[1,null]',
      'NOT IN',
      '("priority" IS NOT NULL) AND ("priority" NOT IN (1))',
      [2, 4]
    ]
  ])(
    '%s keeps the same rows on every engine',
    (query, operator, inlineSql, ids) => {
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'priority',
        operator,
        value: [1, null]
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inline).toBe(inlineSql);
      expect(parameterized.params).toEqual([1]);
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(ids);
      expect(idsOfSql(parameterized)).toEqual(ids);
      expect(idsOfSql(compileDrizzle(expression))).toEqual(ids);
      expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(ids);
      expect(filterByExpression(expression, rows).map(row => row.id)).toEqual(
        ids
      );
    }
  );
});
