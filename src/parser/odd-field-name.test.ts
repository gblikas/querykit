/**
 * Quoted field names with driver marks.
 *
 * `"?status":open`, `"sta$tus":open` and `"sta:tus":open` name columns whose
 * names hold the marks drivers use for placeholders. Each mark stays inside
 * the quoted identifier on every engine, the bound parameter list stays
 * `['open']`, and the normal `status` row is never selected. Unquoted
 * `sta?tus:open` stays incomplete.
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

type Row = Record<string, string | number>;

const specialColumns = ['?status', 'sta$tus', 'sta:tus', 'sta?tus'];

/** Row 1 is shut everywhere; row n + 2 is open in special column n only. */
function buildRows(): Row[] {
  const shut: Row = { id: 1, status: 'closed' };
  for (const column of specialColumns) {
    shut[column] = 'shut';
  }
  return [
    shut,
    ...specialColumns.map((openColumn, index): Row => {
      const row: Row = { ...shut, id: index + 2 };
      row[openColumn] = 'open';
      return row;
    })
  ];
}

const rows = buildRows();

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  ...Object.fromEntries(specialColumns.map(column => [column, text(column)]))
});

function quoteName(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  const columns = ['status', ...specialColumns];
  database.exec(
    `CREATE TABLE items (id INTEGER PRIMARY KEY, ${columns
      .map(column => `${quoteName(column)} TEXT`)
      .join(', ')})`
  );
  const insert = database.prepare(
    `INSERT INTO items (id, ${columns.map(quoteName).join(', ')}) VALUES (${[
      'id',
      ...columns
    ]
      .map(() => '?')
      .join(', ')})`
  );
  for (const row of rows) {
    insert.run(row.id, ...columns.map(column => row[column]));
  }
  return database;
}

describe('quoted field names with driver marks', () => {
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
    ['"?status":open', '?status', 2],
    ['"sta$tus":open', 'sta$tus', 3],
    ['"sta:tus":open', 'sta:tus', 4],
    ['"sta?tus":open', 'sta?tus', 5]
  ])('%s selects only its own column', (query, field, expectedId) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field,
      operator: '==',
      value: 'open'
    });
    const quoted = quoteName(field);
    const inlineSql = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(inlineSql).toBe(`${quoted} = 'open'`);
    expect(parameterized).toEqual({ sql: `${quoted} = ?`, params: ['open'] });
    expect(compileDrizzle(expression)).toEqual({
      sql: `${quoted} = ?`,
      params: ['open']
    });
    expect(compileDrizzle(expression, { items })).toEqual({
      sql: `"items".${quoted} = ?`,
      params: ['open']
    });
    expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual([expectedId]);
    expect(idsOfSql(parameterized)).toEqual([expectedId]);
    expect(idsOfSql(compileDrizzle(expression))).toEqual([expectedId]);
    expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual([
      expectedId
    ]);
    expect(idsOfBuilder(expression)).toEqual([expectedId]);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([
      expectedId
    ]);
  });

  it('keeps unquoted sta?tus:open incomplete and rejected', () => {
    const query = 'sta?tus:open';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(
      'Syntax error at line 1 column 8'
    );
    expect(() => filterInMemory(query, rows)).toThrow(
      'Syntax error at line 1 column 8'
    );
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(context.recovery?.autofix).toBeUndefined();
  });
});
