/**
 * Boolean sort order across the engines.
 *
 * SQLite stores `true` and `false` as 1 and 0; memory keeps booleans. Both
 * put null first, then false, then true ascending, and the reverse
 * descending, with `id` breaking ties.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
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

const rows: Array<{ id: number; active: boolean | null }> = [
  { id: 1, active: null },
  { id: 2, active: false },
  { id: 3, active: true },
  { id: 4, active: true },
  { id: 5, active: null },
  { id: 6, active: false }
];

const items = sqliteTable('items', {
  id: integer('id'),
  active: integer('active', { mode: 'boolean' })
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, active INTEGER)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.active === null ? null : Number(row.active));
  }
  return database;
}

describe('boolean sort order', () => {
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
        `SELECT id FROM items WHERE ${statement.sql} ORDER BY "active" ${direction.toUpperCase()}, id ASC`
      )
      .all(...statement.params)
      .map(row => row.id);
  }

  it.each([
    ['asc', [1, 5, 2, 6, 3, 4]],
    ['desc', [3, 4, 2, 6, 1, 5]]
  ] as Array<[Direction, number[]]>)(
    'orders null, false and true the same way %s on every engine',
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
      const options = { orderBy: { active: direction, id: 'asc' as const } };
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
