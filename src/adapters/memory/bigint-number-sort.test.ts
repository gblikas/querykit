/**
 * Bigint, number and string in one sorted column.
 *
 * A BLOB-affinity column keeps `10n` as an integer, `2` as a real and `'3'`
 * as text, so SQLite orders the two numbers numerically and the text after
 * them. Memory puts a bigint and a finite number in the same numeric class,
 * before every string, instead of comparing the bigint's digits as text.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../drizzle';
import { QueryParser } from '../../parser';
import { SqlTranslator } from '../../translators/sql';
import { inMemoryAdapter } from './in-memory-adapter';

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

type Direction = 'asc' | 'desc';

const rows: Array<{ id: number; value: unknown }> = [
  { id: 1, value: 10n },
  { id: 2, value: 2 },
  { id: 3, value: '3' }
];

// The schema names the column; the BLOB affinity of the table keeps the
// storage class of each inserted value, which is what ORDER BY sees.
const items = sqliteTable('items', {
  id: integer('id'),
  value: text('value')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value BLOB)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.value);
  }
  return database;
}

describe('bigint, number and string sort', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const adapter = new DrizzleAdapter({
    db: drizzle(database as never),
    schema: { items }
  });
  const memory = inMemoryAdapter({ records: { items: rows } });

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(
    statement: IParameterizedSql,
    direction: Direction
  ): number[] {
    return database
      .prepare(
        `SELECT id FROM items WHERE ${statement.sql} ORDER BY "value" ${direction.toUpperCase()}, id ASC`
      )
      .all(...statement.params)
      .map(row => row.id);
  }

  it.each([
    ['asc', [2, 1, 3]],
    ['desc', [3, 1, 2]]
  ] as Array<[Direction, number[]]>)(
    'orders numbers numerically before text %s on every engine',
    async (direction, expectedIds) => {
      const expression = parser.parse('id:>0');
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(idsOfSql({ sql: inline, params: [] }, direction)).toEqual(
        expectedIds
      );
      expect(idsOfSql(parameterized, direction)).toEqual(expectedIds);
      const options = { orderBy: { value: direction, id: 'asc' as const } };
      const viaDrizzle = await adapter.execute<{ id: number }>(
        'items',
        expression,
        options
      );
      expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
      const viaMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        options
      );
      expect(viaMemory.map(row => row.id)).toEqual(expectedIds);
    }
  );
});
