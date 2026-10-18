/**
 * A number field ordered against a boolean literal.
 *
 * `count:>true`, `count:>=false`, `count:<true` and `count:<=false` inline
 * `TRUE` and `FALSE`, which SQLite reads as 1 and 0. Memory compares the
 * number field with that integer, so the engines return the same ids.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
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

const rows: Array<{ id: number; count: number }> = [
  { id: 1, count: 1 },
  { id: 2, count: 0 },
  { id: 3, count: 2 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, count)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.count);
  }
  return database;
}

describe('a number field ordered against a boolean', () => {
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
    ['count:>true', '>', true, '"count" > TRUE', [3]],
    ['count:>=false', '>=', false, '"count" >= FALSE', [1, 2, 3]],
    ['count:<true', '<', true, '"count" < TRUE', [2]],
    ['count:<=false', '<=', false, '"count" <= FALSE', [2]]
  ])(
    '%s compares the number with the integer on every engine',
    (query, operator, value, parameterizedSql, expectedIds) => {
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
      expect(parameterized).toEqual({ sql: parameterizedSql, params: [] });
      expect(compileDrizzle(expression, { items })).toEqual({
        sql: `"items".${parameterizedSql}`,
        params: []
      });
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
});
