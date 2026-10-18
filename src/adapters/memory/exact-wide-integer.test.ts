/**
 * A plain integer outside the signed 64-bit range that `Number` keeps.
 *
 * `1000000000000000000000` is the exact double 10^21, so the rounding check
 * alone would let it through and every engine would compare that double.
 * The parser rejects it under equality and `<=`, and the search box marks
 * it incomplete. `count:1e2` and `2^63` are left in place, and a quoted
 * spelling stays a complete string.
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

const WIDE = '1000000000000000000000';

const rows: Array<{ id: number; count: bigint }> = [
  { id: 1, count: 9223372036854775807n }
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

describe('an exact integer outside the signed 64-bit range', () => {
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

  it.each([`count:${WIDE}`, `count:<=${WIDE}`])(
    'rejects %s instead of comparing the double',
    query => {
      const message = `Integer is outside the signed 64-bit range: ${WIDE}`;
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(message);
      expect(() => filterInMemory(query, rows)).toThrow(message);
    }
  );

  it.each([
    ['count:1e2', '==', 100, '"count" = 100', []],
    [
      'count:<=9223372036854775808',
      '<=',
      9223372036854775808,
      '"count" <= 9223372036854776000',
      [1]
    ]
  ])(
    '%s stays a number on every engine',
    (query, operator, value, inlineSql, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'count',
        operator,
        value
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inline).toBe(inlineSql);
      expect(parameterized.params).toEqual([value]);
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

  it('keeps a quoted spelling a complete string', () => {
    const query = `count:"${WIDE}"`;
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: WIDE
    });
  });
});
