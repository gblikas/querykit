/**
 * A boolean as a limit and as an offset.
 *
 * SQLite reads `TRUE` as 1 and `FALSE` as 0, so `LIMIT true` keeps one row
 * and `LIMIT false` keeps none. A JavaScript boolean is not an integer
 * (`Number.isInteger` and `Number.isFinite` are both false) and better-sqlite3
 * cannot bind one, so parameterized SQL inlines `TRUE` / `FALSE` the way the
 * SQL translator does. An offset with no limit is `LIMIT -1`, because SQLite
 * rejects a bare `OFFSET`. Every engine must return the same ids.
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
  limit?: boolean | number;
  offset?: boolean | number;
}

interface IItem {
  id: number;
  status: string;
}

interface ISqlWindow {
  sql: string;
  params: number[];
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
  ['a true limit', { limit: true }, [1]],
  ['a false limit', { limit: false }, []],
  ['a true offset', { offset: true }, [2, 3]],
  ['a false offset', { offset: false }, [1, 2, 3]],
  ['a true limit and offset', { limit: true, offset: true }, [2]],
  ['a false limit and offset', { limit: false, offset: false }, []],
  ['a true offset beside limit 2', { limit: 2, offset: true }, [2, 3]],
  ['a false offset beside limit 2', { limit: 2, offset: false }, [1, 2]],
  ['a true limit beside offset 1', { limit: true, offset: 1 }, [2]],
  ['a false limit beside offset 1', { limit: false, offset: 1 }, []]
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

/** Inline spelling: lowercase `true` / `false`, digits for a number. */
function inlineToken(value: boolean | number): string {
  return String(value);
}

/** Parameterized spelling: a boolean is `TRUE` / `FALSE` and is not bound. */
function parameterizedToken(value: boolean | number): string {
  if (value === true) {
    return 'TRUE';
  }
  if (value === false) {
    return 'FALSE';
  }
  return '?';
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
  const params: number[] = [];
  const limitValue = window.limit === undefined ? -1 : window.limit;
  const limitToken = parameterizedToken(limitValue);
  if (limitToken === '?') {
    params.push(limitValue as number);
  }
  const parts = [`LIMIT ${limitToken}`];
  if (window.offset !== undefined) {
    const offsetToken = parameterizedToken(window.offset);
    if (offsetToken === '?') {
      params.push(window.offset as number);
    }
    parts.push(`OFFSET ${offsetToken}`);
  }
  return { sql: parts.join(' '), params };
}

describe('a boolean as a limit and as an offset', () => {
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
          limit: window.limit,
          offset: window.offset
        }
      );
      expect(idsOf(ordered)).toEqual(expectedIds);
      const unordered = await adapter.execute<{ id: number }>(
        'items',
        expression,
        {
          limit: window.limit,
          offset: window.offset
        }
      );
      expect(idsOf(unordered)).toEqual(expectedIds);
      const orderedMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        {
          orderBy: { id: 'asc' },
          limit: window.limit,
          offset: window.offset
        }
      );
      expect(idsOf(orderedMemory)).toEqual(expectedIds);
      const unorderedMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        {
          limit: window.limit,
          offset: window.offset
        }
      );
      expect(idsOf(unorderedMemory)).toEqual(expectedIds);
    }
  );

  it('reads a boolean limit as 1 or 0 on both kits', async () => {
    const cases: Array<[boolean, number[]]> = [
      [true, [1]],
      [false, []]
    ];
    for (const [limit, expectedIds] of cases) {
      const drizzleRows = await drizzleKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .limit(limit as unknown as number)
        .execute();
      expect(idsOf(drizzleRows)).toEqual(expectedIds);
      const memoryRows = await memoryKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .limit(limit as unknown as number)
        .execute();
      expect(idsOf(memoryRows)).toEqual(expectedIds);
      const drizzleOffsetFirst = await drizzleKit
        .query('items')
        .where('status:a')
        .offset(1)
        .limit(limit as unknown as number)
        .execute();
      expect(idsOf(drizzleOffsetFirst)).toEqual(limit ? [2] : []);
      const memoryLimitFirst = await memoryKit
        .query('items')
        .where('status:a')
        .limit(limit as unknown as number)
        .offset(1)
        .execute();
      expect(idsOf(memoryLimitFirst)).toEqual(limit ? [2] : []);
    }
  });

  it('reads a boolean offset as 1 or 0 on both kits', async () => {
    const cases: Array<[boolean, number[]]> = [
      [true, [2, 3]],
      [false, [1, 2, 3]]
    ];
    for (const [offset, expectedIds] of cases) {
      const drizzleRows = await drizzleKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .offset(offset as unknown as number)
        .execute();
      expect(idsOf(drizzleRows)).toEqual(expectedIds);
      const memoryRows = await memoryKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .offset(offset as unknown as number)
        .execute();
      expect(idsOf(memoryRows)).toEqual(expectedIds);
      const besideLimit = offset ? [2, 3] : [1, 2];
      const drizzleBeside = await drizzleKit
        .query('items')
        .where('status:a')
        .limit(2)
        .offset(offset as unknown as number)
        .execute();
      expect(idsOf(drizzleBeside)).toEqual(besideLimit);
      const memoryBeside = await memoryKit
        .query('items')
        .where('status:a')
        .offset(offset as unknown as number)
        .limit(2)
        .execute();
      expect(idsOf(memoryBeside)).toEqual(besideLimit);
    }
  });
});
