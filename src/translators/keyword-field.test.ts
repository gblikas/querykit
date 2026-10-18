/**
 * Keyword field names.
 *
 * `order:a`, `select:a`, `group:a` and `where:1` name columns spelled as
 * SQL keywords. Every engine quotes the identifier, so none of them is a
 * syntax error, and all of them return the same ids.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
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

const rows = [
  { id: 1, order: 'a', select: 'a', group: 'a', where: 1 },
  { id: 2, order: 'b', select: 'a', group: 'c', where: 1 },
  { id: 3, order: 'a', select: 'b', group: 'a', where: 2 },
  { id: 4, order: null, select: null, group: null, where: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  order: text('order'),
  select: text('select'),
  group: text('group'),
  where: integer('where')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, "order" TEXT, "select" TEXT, "group" TEXT, "where" INTEGER)'
  );
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.order, row.select, row.group, row.where);
  }
  return database;
}

describe('keyword field names', () => {
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
    ['order:a', 'order', 'a', `'a'`, [1, 3]],
    ['select:a', 'select', 'a', `'a'`, [1, 2]],
    ['group:a', 'group', 'a', `'a'`, [1, 3]],
    ['where:1', 'where', 1, '1', [1, 2]]
  ])(
    '%s quotes the keyword on every engine',
    (query, field, value, inlineValue, expectedIds) => {
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value
      });
      const inlineSql = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inlineSql).toBe(`"${field}" = ${inlineValue}`);
      expect(parameterized).toEqual({ sql: `"${field}" = ?`, params: [value] });
      expect(compileDrizzle(expression)).toEqual({
        sql: `"${field}" = ?`,
        params: [value]
      });
      expect(compileDrizzle(expression, { items })).toEqual({
        sql: `"items"."${field}" = ?`,
        params: [value]
      });
      expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(
        expectedIds
      );
      expect(idsOfBuilder(expression)).toEqual(expectedIds);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );

  it('would be a syntax error without the quotes', () => {
    for (const keyword of ['order', 'select', 'group', 'where']) {
      expect(() =>
        database.prepare(`SELECT id FROM items WHERE ${keyword} = 'a'`)
      ).toThrow(`near "${keyword}": syntax error`);
    }
  });
});
