/**
 * A bigint field compared with a number.
 *
 * SQLite stores `10n` and `10` as the same integer, so `amount:>2` and
 * `amount:10` keep both rows and `amount:<3` keeps neither. Memory compares
 * a bigint field with a finite number by integer value instead of `===`.
 * A bigint query value cannot be written in the language; `amount:10n` is a
 * syntax error.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
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

const rows: Array<{ id: number; amount: bigint | number }> = [
  { id: 1, amount: 10n },
  { id: 2, amount: 10 }
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

describe('a bigint field compared with a number', () => {
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
    ['amount:>2', [1, 2]],
    ['amount:10', [1, 2]],
    ['amount:<3', []],
    ['amount:>=10.5', []],
    ['amount:<10.5', [1, 2]]
  ])('%s matches the same rows on every engine', (query, expectedIds) => {
    const expression = parser.parse(query);
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
    expect(idsOfSql(parameterized)).toEqual(expectedIds);
    expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
    expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(
      expectedIds
    );
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(expectedIds);
  });

  it.each(['amount:10n', 'amount:>10n', 'amount:<3n'])(
    'cannot write a bigint query value as %s',
    query => {
      expect(() => parser.parse(query)).toThrow(QueryParseError);
    }
  );
});
