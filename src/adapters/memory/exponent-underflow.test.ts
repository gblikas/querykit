/**
 * An exponent that underflows to zero.
 *
 * `count:1e-400`, `count:1e-324` and `count:-1e-400` spell a decimal that
 * is not zero but whose `Number` is 0, so every engine would match the
 * stored 0. The parser rejects them and the search box marks them
 * incomplete. `count:0e-400` is exact zero and still matches 0,
 * `count:1e-2` is 0.01, `count:1e21` stays the signed-range rejection, and a
 * quoted `"1e-400"` stays a complete string.
 */

import { createRequire } from 'module';
import {
  integer,
  real,
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

const rows: Array<{ id: number; count: number }> = [
  { id: 1, count: 0 },
  { id: 2, count: 1 },
  { id: 3, count: 0.01 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: real('count')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, count REAL)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.count);
  }
  return database;
}

describe('an exponent that underflows to zero', () => {
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
    ['count:1e-400', 'Exponent underflows to zero: 1e-400'],
    ['count:1e-324', 'Exponent underflows to zero: 1e-324'],
    ['count:-1e-400', 'Exponent underflows to zero: -1e-400'],
    ['count:1e21', 'Integer is outside the signed 64-bit range: 1e21']
  ])('rejects %s instead of comparing the rounded number', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
  });

  it.each([
    ['count:1e-2', 0.01, '"count" = 0.01', [3]],
    ['count:0e-400', 0, '"count" = 0', [1]]
  ])(
    '%s stays the number it spells on every engine',
    (query, value, inlineSql, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'count',
        operator: '==',
        value
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inline).toBe(inlineSql);
      expect(parameterized).toEqual({ sql: '"count" = ?', params: [value] });
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(
        expectedIds
      );
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );

  it('keeps a quoted exponent a complete string', () => {
    const query = 'count:"1e-400"';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: '1e-400'
    });
  });
});
