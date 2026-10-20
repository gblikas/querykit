/**
 * A padded or decimal string as a limit.
 *
 * SQLite reads `LIMIT ' 2'`, `LIMIT '2 '`, and `LIMIT '2.0'` as 2 rows.
 * A JavaScript string is not an integer (`Number.isInteger` and
 * `Number.isFinite` are both false), so an entry that leaves the text
 * unchanged throws while the SQL forms return rows. Parameterized SQL
 * binds the string. Every engine must return the same ids.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createQueryKit } from '../index';
import { QueryParser } from '../parser';
import { SqlTranslator } from '../translators/sql';
import { DrizzleAdapter } from './drizzle';
import { inMemoryAdapter } from './memory';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
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

interface IWindow {
  limit: string;
}

interface IItem {
  id: number;
  status: string;
}

interface ISqlWindow {
  sql: string;
  params: string[];
}

const rows: IItem[] = [
  { id: 1, status: 'a' },
  { id: 2, status: 'a' },
  { id: 3, status: 'a' }
];

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status')
});

const windows: Array<[string, IWindow, number[]]> = [
  ['a padded limit " 2"', { limit: ' 2' }, [1, 2]],
  ['a padded limit "2 "', { limit: '2 ' }, [1, 2]],
  ['a decimal limit "2.0"', { limit: '2.0' }, [1, 2]]
];

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT);
    INSERT INTO items VALUES (1, 'a'), (2, 'a'), (3, 'a');
  `);
  return database;
}

/** Inline spelling: a string is a SQL string literal. */
function inlineToken(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parameterizedWindow(window: IWindow): ISqlWindow {
  return { sql: 'LIMIT ?', params: [window.limit] };
}

describe('a padded or decimal string limit', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const db = drizzle(database as never);
  const adapter = new DrizzleAdapter({ db, schema: { items } });
  const memory = inMemoryAdapter({ records: { items: rows } });
  const drizzleKit = createQueryKit({ adapter, schema: { items } });
  const memoryKit = createQueryKit({
    adapter: memory,
    schema: { items }
  });
  const expression = parser.parse('status:a');
  const inline = new SqlTranslator({ useParameters: false }).translate(
    expression
  ) as string;
  const parameterized = new SqlTranslator().translate(
    expression
  ) as IParameterizedSql;

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(sqlText: string, params: unknown[] = []): number[] {
    return database
      .prepare(sqlText)
      .all(...params)
      .map(row => row.id);
  }

  function idsOf(result: readonly unknown[]): number[] {
    return result.map(row => (row as { id: number }).id);
  }

  it.each(windows)(
    'returns the same ids for %s on inline SQL, parameterized SQL, Drizzle, and in-memory',
    async (_label, window, expectedIds) => {
      const clause = `LIMIT ${inlineToken(window.limit)}`;
      expect(
        idsOfSql(
          `SELECT id FROM items WHERE ${inline} ORDER BY id ASC ${clause}`
        )
      ).toEqual(expectedIds);
      expect(
        idsOfSql(`SELECT id FROM items WHERE ${inline} ${clause}`)
      ).toEqual(expectedIds);
      const bound = parameterizedWindow(window);
      expect(
        idsOfSql(
          `SELECT id FROM items WHERE ${parameterized.sql} ORDER BY id ASC ${bound.sql}`,
          [...parameterized.params, ...bound.params]
        )
      ).toEqual(expectedIds);
      const ordered = await adapter.execute<{ id: number }>(
        'items',
        expression,
        {
          orderBy: { id: 'asc' },
          limit: window.limit as unknown as number
        }
      );
      expect(idsOf(ordered)).toEqual(expectedIds);
      const unordered = await adapter.execute<{ id: number }>(
        'items',
        expression,
        {
          limit: window.limit as unknown as number
        }
      );
      expect(idsOf(unordered)).toEqual(expectedIds);
      const orderedMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        {
          orderBy: { id: 'asc' },
          limit: window.limit as unknown as number
        }
      );
      expect(idsOf(orderedMemory)).toEqual(expectedIds);
      const unorderedMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        {
          limit: window.limit as unknown as number
        }
      );
      expect(idsOf(unorderedMemory)).toEqual(expectedIds);
    }
  );

  it.each(windows)(
    'reads %s as 2 on both kits',
    async (_label, window, expectedIds) => {
      const drizzleRows = await drizzleKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .limit(window.limit as unknown as number)
        .execute();
      expect(idsOf(drizzleRows)).toEqual(expectedIds);
      const memoryRows = await memoryKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .limit(window.limit as unknown as number)
        .execute();
      expect(idsOf(memoryRows)).toEqual(expectedIds);
      const drizzleUnordered = await drizzleKit
        .query('items')
        .where('status:a')
        .limit(window.limit as unknown as number)
        .execute();
      expect(idsOf(drizzleUnordered)).toEqual(expectedIds);
      const memoryUnordered = await memoryKit
        .query('items')
        .where('status:a')
        .limit(window.limit as unknown as number)
        .execute();
      expect(idsOf(memoryUnordered)).toEqual(expectedIds);
    }
  );
});
