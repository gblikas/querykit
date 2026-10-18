/**
 * Quoted field names with a space or a double quote.
 *
 * The parser accepts `"full name":alpha` as the field `full name` and
 * `"say\"hi":alpha` as the field `say"hi`. Every engine quotes the name as
 * one identifier, doubling an embedded quote so it cannot end the
 * identifier early, and Drizzle without a schema accepts the name instead
 * of rejecting it as an invalid field.
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

interface IRow {
  id: number;
  'full name': string | null;
  'say"hi': string | null;
}

const rows: IRow[] = [
  { id: 1, 'full name': 'alpha', 'say"hi': 'alpha' },
  { id: 2, 'full name': 'beta', 'say"hi': 'alpha' },
  { id: 3, 'full name': 'alpha', 'say"hi': 'beta' },
  { id: 4, 'full name': null, 'say"hi': null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  'full name': text('full name'),
  'say"hi': text('say"hi')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, "full name" TEXT, "say""hi" TEXT)'
  );
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row['full name'], row['say"hi']);
  }
  return database;
}

describe('quoted field names with a space or a double quote', () => {
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
    ['"full name":alpha', 'full name', '"full name"', [1, 3]],
    ['"say\\"hi":alpha', 'say"hi', '"say""hi"', [1, 2]]
  ])(
    '%s reads one identifier on every engine',
    (query, field, quoted, expectedIds) => {
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value: 'alpha'
      });
      const inlineSql = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inlineSql).toBe(`${quoted} = 'alpha'`);
      expect(parameterized).toEqual({
        sql: `${quoted} = ?`,
        params: ['alpha']
      });
      expect(compileDrizzle(expression)).toEqual({
        sql: `${quoted} = ?`,
        params: ['alpha']
      });
      expect(compileDrizzle(expression, { items })).toEqual({
        sql: `"items".${quoted} = ?`,
        params: ['alpha']
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
});
