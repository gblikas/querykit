/**
 * Unquoted field names with an empty side of a dot.
 *
 * `.column:open` is a syntax error and incomplete; no engine rewrites it to
 * `column:open`. `column.:open` is the column `column.`: an unquoted name
 * with one dot and an empty side is marked literal and quoted as one
 * identifier on every engine. `a..b` has two dots and is one identifier
 * already; it never reads column `b`.
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

const columns = ['column', 'b', 'column.', 'a..b', 'a.b', '.'];

/** Row n + 1 is open in column n and shut everywhere else. */
function buildRows(): Row[] {
  const shut: Row = {};
  for (const column of columns) {
    shut[column] = 'shut';
  }
  return columns.map((openColumn, index): Row => {
    const row: Row = { ...shut, id: index + 1 };
    row[openColumn] = 'open';
    return row;
  });
}

const rows = buildRows();

const a = sqliteTable('a', {
  id: integer('id'),
  ...Object.fromEntries(columns.map(column => [column, text(column)]))
});

function quoteName(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    `CREATE TABLE a (id INTEGER PRIMARY KEY, ${columns
      .map(column => `${quoteName(column)} TEXT`)
      .join(', ')})`
  );
  const insert = database.prepare(
    `INSERT INTO a (id, ${columns.map(quoteName).join(', ')}) VALUES (${[
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

describe('unquoted field names with an empty side of a dot', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const db = drizzle(database as never);

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM a WHERE ${statement.sql} ORDER BY id`)
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
    const condition = new DrizzleTranslator({ schema: { a } }).translate(
      expression,
      { tableName: 'a' }
    );
    return db
      .select({ id: a.id })
      .from(a)
      .where(condition)
      .orderBy(a.id)
      .all()
      .map(row => row.id as number);
  }

  it('keeps .column:open incomplete and rejected without an autofix', () => {
    const query = '.column:open';
    const message = 'Syntax error at line 1 column 1';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['column.:open', 'column.', true, [3]],
    ['a..b:open', 'a..b', false, [4]],
    ['"a.b":open', 'a.b', true, [5]],
    ['".":open', '.', false, [6]]
  ])(
    '%s is one identifier on every engine',
    (query, field, isLiteral, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value: 'open',
        ...(isLiteral ? { isLiteral: true } : {})
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
      expect(compileDrizzle(expression, { a })).toEqual({
        sql: `"a".${quoted} = ?`,
        params: ['open']
      });
      expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression, { a }))).toEqual(expectedIds);
      expect(idsOfBuilder(expression)).toEqual(expectedIds);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );

  it('keeps unquoted a.b a qualifier on SQL and Drizzle while memory reads the own key', () => {
    const query = 'a.b:open';
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'a.b',
      operator: '==',
      value: 'open'
    });
    const inlineSql = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    expect(inlineSql).toBe(`"a"."b" = 'open'`);
    expect(compileDrizzle(expression, { a })).toEqual({
      sql: '"a"."b" = ?',
      params: ['open']
    });
    expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual([2]);
    expect(idsOfSql(compileDrizzle(expression))).toEqual([2]);
    expect(idsOfBuilder(expression)).toEqual([2]);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([5]);
  });

  it('drops the literal flag when a field mapping replaces the name', () => {
    const expression = new QueryParser({
      fieldMappings: { 'column.': 'b' }
    }).parse('column.:open');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'b',
      operator: '==',
      value: 'open'
    });
    const mappedByTranslator = new SqlTranslator({
      useParameters: false,
      fieldMappings: { 'column.': 'a.b' }
    }).translate(parser.parse('column.:open'));
    expect(mappedByTranslator).toBe(`"a"."b" = 'open'`);
  });
});
