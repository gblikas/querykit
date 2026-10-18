/**
 * Quoted field names that contain a dot.
 *
 * `"a.b":open` is the column `a.b`, not table `a` column `b`: a quoted name
 * with one dot is marked literal by the parser and quoted as one identifier
 * by every engine. `"a.b.c"`, `".."` and `"."` were already one identifier
 * because they are not a single `table.column`. Unquoted `a.b` stays a
 * qualifier on SQL and Drizzle, while memory reads the own key.
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

const specialColumns = ['a.b', 'a.b.c', '..', '.'];

/** Column `b` is closed on every row; row n + 1 is open in special column n. */
function buildRows(): Row[] {
  const shut: Row = { b: 'closed' };
  for (const column of specialColumns) {
    shut[column] = 'shut';
  }
  return specialColumns.map((openColumn, index): Row => {
    const row: Row = { ...shut, id: index + 1 };
    row[openColumn] = 'open';
    return row;
  });
}

const rows = buildRows();

const a = sqliteTable('a', {
  id: integer('id'),
  b: text('b'),
  ...Object.fromEntries(specialColumns.map(column => [column, text(column)]))
});

function quoteName(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  const columns = ['b', ...specialColumns];
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

describe('quoted field names that contain a dot', () => {
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

  it.each([
    ['"a.b":open', 'a.b', true, [1]],
    ["'a.b':open", 'a.b', true, [1]],
    ['"a.b.c":open', 'a.b.c', false, [2]],
    ["'a.b.c':open", 'a.b.c', false, [2]],
    ['"..":open', '..', false, [3]],
    ["'..':open", '..', false, [3]],
    ['".":open', '.', false, [4]],
    ["'.':open", '.', false, [4]]
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
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(inlineSql).toBe(`"a"."b" = 'open'`);
    expect(parameterized).toEqual({ sql: '"a"."b" = ?', params: ['open'] });
    expect(compileDrizzle(expression)).toEqual({
      sql: '"a"."b" = ?',
      params: ['open']
    });
    expect(compileDrizzle(expression, { a })).toEqual({
      sql: '"a"."b" = ?',
      params: ['open']
    });
    expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual([]);
    expect(idsOfSql(parameterized)).toEqual([]);
    expect(idsOfSql(compileDrizzle(expression, { a }))).toEqual([]);
    expect(idsOfBuilder(expression)).toEqual([]);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([1]);
  });

  it('keeps unquoted table. one identifier', () => {
    const expression = parser.parse('table.:open');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'table.',
      operator: '==',
      value: 'open',
      isLiteral: true
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"table." = 'open'`);
    expect(compileDrizzle(expression)).toEqual({
      sql: '"table." = ?',
      params: ['open']
    });
  });

  it('keeps unquoted .column incomplete and rejected', () => {
    const query = '.column:open';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(
      'Syntax error at line 1 column 1'
    );
    expect(() => filterInMemory(query, rows)).toThrow(
      'Syntax error at line 1 column 1'
    );
  });
});
