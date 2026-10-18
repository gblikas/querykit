/**
 * IN on a bigint column.
 *
 * `amount:in[10]` carries the number 10. SQLite sees two rows of integer 10
 * (`10n` and `10`) and one of 20, so IN keeps ids 1 and 3 and NOT IN keeps
 * id 2. Memory matches a bigint field to a numeric member when both name
 * the same integer.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
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

const rows: Array<{ id: number; amount: bigint | number }> = [
  { id: 1, amount: 10n },
  { id: 2, amount: 20n },
  { id: 3, amount: 10 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  amount: integer('amount')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, amount INTEGER)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.amount);
  }
  return database;
}

describe('IN on a bigint', () => {
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
    ['amount:in[10]', 'IN', '"amount" IN (10)', [1, 3]],
    ['amount:not in[10]', 'NOT IN', '"amount" NOT IN (10)', [2]],
    ['amount:in[10.5, 20]', 'IN', '"amount" IN (10.5, 20)', [2]]
  ])(
    '%s matches the same integers on every engine',
    (query, operator, inlineSql, expectedIds) => {
      const expression = parser.parse(query);
      expect(expression).toMatchObject({ field: 'amount', operator });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inline).toBe(inlineSql);
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
