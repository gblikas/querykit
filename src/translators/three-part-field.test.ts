/**
 * Three-part field names.
 *
 * `a.b.c` is one identifier, `"a.b.c"`, on inline SQL, parameterized SQL
 * and Drizzle, in a filter and in a sort. Exactly one dot is `table.column`;
 * any other count of dots is one name. Drizzle accepts the name instead of
 * rejecting it, and the quoted column `"a.b.c"` is read rather than column
 * `c`. Memory reads the own key spelled `a.b.c`.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { filterInMemory, inMemoryAdapter } from '../adapters/memory';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from './drizzle';
import { SqlTranslator } from './sql';

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

interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

const item = sqliteTable('item', {
  id: integer('id'),
  c: integer('c'),
  abc: text('a.b.c')
});

const literalRows = [
  { id: 1, 'a.b.c': 1 },
  { id: 2, 'a.b.c': 2 },
  { id: 3, c: 1 }
];

const columnRows = [
  { id: 1, c: 1 },
  { id: 2, c: 2 },
  { id: 3, c: 0 }
];

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE item (id INTEGER PRIMARY KEY, c INTEGER, "a.b.c" INTEGER);
    INSERT INTO item VALUES (1, 9, 1), (2, 1, 2), (3, 0, 0);
  `);
  return database;
}

describe('three-part field names', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { item } });

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql, orderBy = 'id'): number[] {
    return database
      .prepare(`SELECT id FROM item WHERE ${statement.sql} ORDER BY ${orderBy}`)
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

  it('reads a.b.c as one quoted identifier on every engine', async () => {
    const expression = parser.parse('a.b.c:1');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'a.b.c',
      operator: '==',
      value: 1
    });
    const inlineSql = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(inlineSql).toBe('"a.b.c" = 1');
    expect(parameterized).toEqual({ sql: '"a.b.c" = ?', params: [1] });
    expect(compileDrizzle(expression)).toEqual({
      sql: '"a.b.c" = ?',
      params: [1]
    });
    expect(compileDrizzle(expression, { item })).toEqual({
      sql: '"a.b.c" = ?',
      params: [1]
    });
    expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual([1]);
    expect(idsOfSql(parameterized)).toEqual([1]);
    expect(idsOfSql(compileDrizzle(expression))).toEqual([1]);
    logged.length = 0;
    const rows = await adapter.execute<{ id: number }>('item', expression);
    expect(rows.map(row => row.id)).toEqual([1]);
    expect(logged[0]).toContain('where "a.b.c" = ?');
    expect(filterInMemory('a.b.c:1', literalRows).map(row => row.id)).toEqual([
      1
    ]);
    expect(filterInMemory('a.b.c:1', columnRows)).toEqual([]);
  });

  it('sorts by a.b.c as one quoted identifier', async () => {
    const expression = parser.parse('id:>=0');
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql(parameterized, '"a.b.c" ASC')).toEqual([3, 1, 2]);
    logged.length = 0;
    const rows = await adapter.execute<{ id: number }>('item', expression, {
      orderBy: { 'a.b.c': 'asc' }
    });
    expect(rows.map(row => row.id)).toEqual([3, 1, 2]);
    expect(logged[0]).toContain('order by "a.b.c" ASC');
    const memory = inMemoryAdapter({ records: { item: literalRows } });
    const sorted = await memory.execute<{ id: number }>('item', expression, {
      orderBy: { 'a.b.c': 'asc' }
    });
    expect(sorted.map(row => row.id)).toEqual([3, 1, 2]);
  });

  it('still quotes a single table.column as two identifiers', () => {
    const expression = parser.parse('owner.city:Austin');
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"owner"."city" = 'Austin'`);
    expect(compileDrizzle(expression)).toEqual({
      sql: '"owner"."city" = ?',
      params: ['Austin']
    });
  });
});
