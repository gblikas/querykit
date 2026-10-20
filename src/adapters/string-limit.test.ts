/**
 * A string `"2"` as a limit and a string `"0"` as an offset.
 *
 * SQLite reads `LIMIT '2'` as 2 rows and `OFFSET '0'` as no skip. A
 * JavaScript string is not an integer (`Number.isInteger` and
 * `Number.isFinite` are both false), so the adapters throw while the SQL
 * forms return rows. Parameterized SQL binds the string. An offset with no
 * limit is `LIMIT -1`, because SQLite rejects a bare `OFFSET`. Every engine
 * must return the same ids.
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
  limit?: string | number;
  offset?: string | number;
}

interface IItem {
  id: number;
  status: string;
}

interface ISqlWindow {
  sql: string;
  params: Array<string | number>;
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
  ['a string limit "2"', { limit: '2' }, [1, 2]],
  ['a string offset "0"', { offset: '0' }, [1, 2, 3]],
  ['a string limit "2" and offset "0"', { limit: '2', offset: '0' }, [1, 2]]
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

/** Inline spelling: a string is a SQL string literal, a number is digits. */
function inlineToken(value: string | number): string {
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return String(value);
}

function inlineWindow(window: IWindow): string {
  const limit =
    window.limit === undefined
      ? 'LIMIT -1'
      : `LIMIT ${inlineToken(window.limit)}`;
  if (window.offset === undefined) {
    return limit;
  }
  return `${limit} OFFSET ${inlineToken(window.offset)}`;
}

function parameterizedWindow(window: IWindow): ISqlWindow {
  const params: Array<string | number> = [];
  const limitValue = window.limit === undefined ? -1 : window.limit;
  params.push(limitValue);
  const parts = ['LIMIT ?'];
  if (window.offset !== undefined) {
    params.push(window.offset);
    parts.push('OFFSET ?');
  }
  return { sql: parts.join(' '), params };
}

describe('a string "2" limit and a string "0" offset', () => {
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
      const clause = inlineWindow(window);
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
          limit: window.limit as number | undefined,
          offset: window.offset as number | undefined
        }
      );
      expect(idsOf(ordered)).toEqual(expectedIds);
      const unordered = await adapter.execute<{ id: number }>(
        'items',
        expression,
        {
          limit: window.limit as number | undefined,
          offset: window.offset as number | undefined
        }
      );
      expect(idsOf(unordered)).toEqual(expectedIds);
      const orderedMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        {
          orderBy: { id: 'asc' },
          limit: window.limit as number | undefined,
          offset: window.offset as number | undefined
        }
      );
      expect(idsOf(orderedMemory)).toEqual(expectedIds);
      const unorderedMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        {
          limit: window.limit as number | undefined,
          offset: window.offset as number | undefined
        }
      );
      expect(idsOf(unorderedMemory)).toEqual(expectedIds);
    }
  );

  it('reads a string limit "2" as 2 on both kits', async () => {
    const drizzleRows = await drizzleKit
      .query('items')
      .where('status:a')
      .orderBy('id', 'asc')
      .limit('2' as unknown as number)
      .execute();
    expect(idsOf(drizzleRows)).toEqual([1, 2]);
    const memoryRows = await memoryKit
      .query('items')
      .where('status:a')
      .orderBy('id', 'asc')
      .limit('2' as unknown as number)
      .execute();
    expect(idsOf(memoryRows)).toEqual([1, 2]);
    const drizzleOffsetFirst = await drizzleKit
      .query('items')
      .where('status:a')
      .offset('0' as unknown as number)
      .limit('2' as unknown as number)
      .execute();
    expect(idsOf(drizzleOffsetFirst)).toEqual([1, 2]);
    const memoryLimitFirst = await memoryKit
      .query('items')
      .where('status:a')
      .limit('2' as unknown as number)
      .offset('0' as unknown as number)
      .execute();
    expect(idsOf(memoryLimitFirst)).toEqual([1, 2]);
  });

  it('reads a string offset "0" as 0 on both kits', async () => {
    const drizzleRows = await drizzleKit
      .query('items')
      .where('status:a')
      .orderBy('id', 'asc')
      .offset('0' as unknown as number)
      .execute();
    expect(idsOf(drizzleRows)).toEqual([1, 2, 3]);
    const memoryRows = await memoryKit
      .query('items')
      .where('status:a')
      .orderBy('id', 'asc')
      .offset('0' as unknown as number)
      .execute();
    expect(idsOf(memoryRows)).toEqual([1, 2, 3]);
    const drizzleUnordered = await drizzleKit
      .query('items')
      .where('status:a')
      .offset('0' as unknown as number)
      .execute();
    expect(idsOf(drizzleUnordered)).toEqual([1, 2, 3]);
    const memoryUnordered = await memoryKit
      .query('items')
      .where('status:a')
      .offset('0' as unknown as number)
      .execute();
    expect(idsOf(memoryUnordered)).toEqual([1, 2, 3]);
  });
});
