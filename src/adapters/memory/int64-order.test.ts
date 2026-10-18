/**
 * Ordered comparison at the signed 64-bit minimum.
 *
 * `count:>-9223372036854775808` keeps only the neighbour and `>=` keeps the
 * minimum too, as exact bigints on every engine. One past the minimum,
 * `-9223372036854775809`, would round onto the stored minimum, so the parser
 * rejects it, the search box marks it incomplete and no engine compares the
 * rounded number. A quoted spelling stays a complete string.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryParseError } from '../../parser/parser';
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

const MINIMUM = -9223372036854775808n;

const rows: Array<{ id: number; count: bigint }> = [
  { id: 1, count: MINIMUM },
  { id: 2, count: -9223372036854775807n }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, count INTEGER)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.count);
  }
  return database;
}

describe('ordered comparison at the signed 64-bit minimum', () => {
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
    ['count:>-9223372036854775808', '>', [2]],
    ['count:>=-9223372036854775808', '>=', [1, 2]],
    ['count:-9223372036854775808', '==', [1]]
  ])('%s keeps the exact minimum on every engine', (query, operator, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'count',
      operator,
      value: MINIMUM
    });
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(inline).toContain('-9223372036854775808');
    expect(parameterized.params).toEqual([MINIMUM]);
    expect(idsOfSql({ sql: inline, params: [] })).toEqual(ids);
    expect(idsOfSql(parameterized)).toEqual(ids);
    expect(idsOfSql(compileDrizzle(expression))).toEqual(ids);
    expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(ids);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('rejects one past the minimum instead of matching the minimum', () => {
    const query = 'count:-9223372036854775809';
    const message =
      'Integer is outside the signed 64-bit range: -9223372036854775809';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
  });

  it('keeps a quoted spelling a complete string', () => {
    const query = 'count:"-9223372036854775809"';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: '-9223372036854775809'
    });
  });
});
