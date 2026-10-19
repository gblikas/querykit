/**
 * Mixed-type sort order across the engines.
 *
 * A column holding null, numbers, booleans and strings sorts the way SQLite
 * orders storage classes: null, then numbers with a boolean as its integer
 * (false ties with 0, true sits between 0 and 2), then text in binary order.
 * `id` breaks ties, so the lower id stays first in both directions.
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
  { id: 1, value: null },
  { id: 2, value: 0 },
  { id: 3, value: 2 },
  { id: 4, value: false },
  { id: 5, value: true },
  { id: 6, value: '' },
  { id: 7, value: '10' },
  { id: 8, value: 'a' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  value: text('value')
});

function storedValue(value: unknown): unknown {
  return typeof value === 'boolean' ? Number(value) : value;
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, storedValue(row.value));
  }
  return database;
}

describe('mixed-type sort order', () => {
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
    ['asc', [1, 2, 4, 5, 3, 6, 7, 8]],
    ['desc', [8, 7, 6, 3, 5, 2, 4, 1]]
  ] as Array<[Direction, number[]]>)(
    'sorts a boolean as 0 or 1 among numbers %s on every engine',
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
