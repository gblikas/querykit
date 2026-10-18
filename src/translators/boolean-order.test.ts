/**
 * A boolean field ordered against a number.
 *
 * `flag:>0`, `flag:>=1`, `flag:<1` and `flag:<=0` carry the numbers 0 and 1.
 * SQLite stores a boolean as that integer, so a boolean-mode column, a
 * no-affinity column and memory all keep boolean true beside the number 1
 * and boolean false beside the number 0. Equality uses the same integers.
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

const rows: Array<{ id: number; flag: boolean | number }> = [
  { id: 1, flag: true },
  { id: 2, flag: false },
  { id: 3, flag: 1 },
  { id: 4, flag: 0 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  flag: integer('flag', { mode: 'boolean' })
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, flag)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, Number(row.flag));
  }
  return database;
}

describe('a boolean field ordered against a number', () => {
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
    ['flag:>0', '>', 0, [1, 3]],
    ['flag:>=1', '>=', 1, [1, 3]],
    ['flag:<1', '<', 1, [2, 4]],
    ['flag:<=0', '<=', 0, [2, 4]],
    ['flag:1', '==', 1, [1, 3]],
    ['flag:0', '==', 0, [2, 4]]
  ])(
    '%s keeps the boolean beside its integer on every engine',
    (query, operator, value, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'flag',
        operator,
        value
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const schemaDrizzle = compileDrizzle(expression, { items });
      expect(parameterized.params).toEqual([value]);
      expect(schemaDrizzle.params).toEqual([value]);
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
      expect(idsOfSql(schemaDrizzle)).toEqual(expectedIds);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );
});
