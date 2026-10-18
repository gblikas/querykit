/**
 * A question mark in a field name.
 *
 * `"sta?tus":open` and `'sta?tus':open` parse as a comparison on the field
 * `sta?tus`. The mark stays inside the quoted identifier on every engine,
 * is not a bind parameter, and is not dropped to make the query
 * `status:open`. Unquoted forms with a stray `?` stay incomplete, and a
 * `?` in a value stays a one-character wildcard.
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
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { QueryExpression } from './types';

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
  { id: 1, status: 'open', 'sta?tus': 'shut' },
  { id: 2, status: 'openX', 'sta?tus': 'open' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  'sta?tus': text('sta?tus')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, "sta?tus" TEXT)'
  );
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.status, row['sta?tus']);
  }
  return database;
}

describe('question mark in a field name', () => {
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

  /** Every engine must agree on the ids; returns the compiled forms. */
  function runEverywhere(
    query: string,
    expectedIds: number[]
  ): {
    inlineSql: string;
    parameterized: IParameterizedSql;
    drizzle: IParameterizedSql;
    schemaDrizzle: IParameterizedSql;
  } {
    const expression = parser.parse(query);
    const inlineSql = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    const bare = compileDrizzle(expression);
    const schemaDrizzle = compileDrizzle(expression, { items });
    expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual(expectedIds);
    expect(idsOfSql(parameterized)).toEqual(expectedIds);
    expect(idsOfSql(bare)).toEqual(expectedIds);
    expect(idsOfSql(schemaDrizzle)).toEqual(expectedIds);
    expect(idsOfBuilder(expression)).toEqual(expectedIds);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(expectedIds);
    return { inlineSql, parameterized, drizzle: bare, schemaDrizzle };
  }

  it.each(['"sta?tus":open', "'sta?tus':open"])(
    '%s keeps the question mark inside the quoted identifier',
    query => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toEqual({
        type: 'comparison',
        field: 'sta?tus',
        operator: '==',
        value: 'open'
      });
      const run = runEverywhere(query, [2]);
      expect(run.inlineSql).toBe(`"sta?tus" = 'open'`);
      expect(run.parameterized).toEqual({
        sql: '"sta?tus" = ?',
        params: ['open']
      });
      expect(run.drizzle).toEqual({ sql: '"sta?tus" = ?', params: ['open'] });
      expect(run.schemaDrizzle).toEqual({
        sql: '"items"."sta?tus" = ?',
        params: ['open']
      });
    }
  );

  it.each([
    ['sta?tus:open', 'Syntax error at line 1 column 8'],
    ['status:open AND ?', 'Implicit field search is not supported'],
    ['(?status:open)', 'Syntax error at line 1 column 9'],
    ['?status:open', 'Syntax error at line 1 column 8']
  ])('%s stays incomplete and is not rewritten', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['status:open?', 'open?', 'open_', [2]],
    ['status:?open', '?open', '_open', []]
  ])(
    '%s keeps the question mark as a one-character wildcard',
    (query, value, pattern, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toEqual({
        type: 'comparison',
        field: 'status',
        operator: 'LIKE',
        value
      });
      const run = runEverywhere(query, expectedIds);
      expect(run.inlineSql).toBe(`"status" LIKE '${pattern}' ESCAPE '!'`);
      expect(run.parameterized).toEqual({
        sql: `"status" LIKE ? ESCAPE '!'`,
        params: [pattern]
      });
      expect(run.drizzle).toEqual({
        sql: `"status" LIKE ? ESCAPE '!'`,
        params: [pattern]
      });
      expect(run.schemaDrizzle).toEqual({
        sql: `"items"."status" LIKE ? ESCAPE '!'`,
        params: [pattern]
      });
    }
  );
});
