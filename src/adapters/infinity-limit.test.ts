/**
 * Infinity and -Infinity as a limit and as an offset.
 *
 * SQLite rejects a limit or offset that is not a whole number. The in-memory
 * adapter rejects a window that is not an integer. Drizzle treats `-Infinity`
 * as a negative limit (`-Infinity >= 0` is false), so a bare `-Infinity`
 * limit is omitted and the matching rows come back, and a `-Infinity` limit
 * beside an offset is written as `LIMIT -1`. Every engine must reject the
 * window instead, and both kits must too.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createQueryKit } from '../index';
import { QueryParser } from '../parser';
import { QuerySecurityError } from '../security';
import { SqlTranslator } from '../translators/sql';
import { DrizzleAdapter, DrizzleAdapterError } from './drizzle';
import { InMemoryAdapterError, inMemoryAdapter } from './memory';

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
  limit?: number;
  offset?: number;
}

interface IItem {
  id: number;
  status: string;
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

const windows: Array<[string, IWindow]> = [
  ['an Infinity limit', { limit: Infinity }],
  ['a -Infinity limit', { limit: -Infinity }],
  ['an Infinity offset', { offset: Infinity }],
  ['a -Infinity offset', { offset: -Infinity }],
  ['an Infinity limit and offset', { limit: Infinity, offset: Infinity }],
  ['a -Infinity limit and offset', { limit: -Infinity, offset: -Infinity }],
  ['an Infinity offset beside limit 2', { limit: 2, offset: Infinity }],
  ['a -Infinity offset beside limit 2', { limit: 2, offset: -Infinity }],
  ['an Infinity limit beside offset 1', { limit: Infinity, offset: 1 }],
  ['a -Infinity limit beside offset 1', { limit: -Infinity, offset: 1 }]
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

function inlineClause(window: IWindow): string {
  const limit = window.limit === undefined ? '' : `LIMIT ${window.limit}`;
  const offset = window.offset === undefined ? '' : `OFFSET ${window.offset}`;
  return `${limit} ${offset}`.trim();
}

function inlineMessage(window: IWindow): string {
  return window.limit === undefined
    ? 'near "OFFSET": syntax error'
    : 'no such column: Infinity';
}

function parameterizedMessage(window: IWindow): string {
  return window.limit === undefined
    ? 'near "OFFSET": syntax error'
    : 'datatype mismatch';
}

function parameterizedClause(window: IWindow): {
  sql: string;
  params: number[];
} {
  const parts: string[] = [];
  const params: number[] = [];
  if (window.limit !== undefined) {
    parts.push('LIMIT ?');
    params.push(window.limit);
  }
  if (window.offset !== undefined) {
    parts.push('OFFSET ?');
    params.push(window.offset);
  }
  return { sql: parts.join(' '), params };
}

function windowMessage(window: IWindow): string {
  return window.limit !== undefined && !Number.isFinite(window.limit)
    ? 'Limit must be an integer'
    : 'Offset must be an integer';
}

describe('Infinity and -Infinity as a limit and as an offset', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
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

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(sqlText: string, params: unknown[] = []): number[] {
    return database
      .prepare(sqlText)
      .all(...params)
      .map(row => row.id);
  }

  it.each(windows)(
    'rejects %s on inline SQL, parameterized SQL, Drizzle, and in-memory',
    async (_label, window) => {
      const clause = inlineClause(window);
      expect(() =>
        idsOfSql(
          `SELECT id FROM items WHERE ${inline} ORDER BY id ASC ${clause}`
        )
      ).toThrow(inlineMessage(window));
      const bound = parameterizedClause(window);
      expect(() =>
        idsOfSql(
          `SELECT id FROM items WHERE ${parameterized.sql} ORDER BY id ASC ${bound.sql}`,
          [...parameterized.params, ...bound.params]
        )
      ).toThrow(parameterizedMessage(window));
      const message = windowMessage(window);
      const ordered = adapter.execute('items', expression, {
        orderBy: { id: 'asc' },
        limit: window.limit,
        offset: window.offset
      });
      await expect(ordered).rejects.toThrow(DrizzleAdapterError);
      await expect(ordered).rejects.toThrow(message);
      const unordered = adapter.execute('items', expression, {
        limit: window.limit,
        offset: window.offset
      });
      await expect(unordered).rejects.toThrow(DrizzleAdapterError);
      await expect(unordered).rejects.toThrow(message);
      await expect(
        memory.execute('items', expression, {
          orderBy: { id: 'asc' },
          limit: window.limit,
          offset: window.offset
        })
      ).rejects.toThrow(message);
      await expect(
        memory.execute('items', expression, {
          limit: window.limit,
          offset: window.offset
        })
      ).rejects.toThrow(message);
      expect(logged).toEqual([]);
    }
  );

  it('rejects an infinite limit on both kits before a query runs', async () => {
    for (const limit of [Infinity, -Infinity]) {
      const drizzleLimited = drizzleKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .limit(limit);
      await expect(drizzleLimited.execute()).rejects.toThrow(
        QuerySecurityError
      );
      await expect(drizzleLimited.execute()).rejects.toThrow(
        'Invalid query limit'
      );
      const memoryLimited = memoryKit
        .query('items')
        .where('status:a')
        .limit(limit)
        .offset(1);
      await expect(memoryLimited.execute()).rejects.toThrow(QuerySecurityError);
      const drizzleOffsetFirst = drizzleKit
        .query('items')
        .where('status:a')
        .offset(1)
        .limit(limit);
      await expect(drizzleOffsetFirst.execute()).rejects.toThrow(
        QuerySecurityError
      );
    }
    expect(logged).toEqual([]);
  });

  it('rejects an infinite offset on both kits', async () => {
    for (const offset of [Infinity, -Infinity]) {
      const drizzleOffset = drizzleKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .offset(offset);
      await expect(drizzleOffset.execute()).rejects.toThrow(
        DrizzleAdapterError
      );
      await expect(drizzleOffset.execute()).rejects.toThrow(
        'Offset must be an integer'
      );
      const drizzleBesideLimit = drizzleKit
        .query('items')
        .where('status:a')
        .limit(2)
        .offset(offset);
      await expect(drizzleBesideLimit.execute()).rejects.toThrow(
        DrizzleAdapterError
      );
      await expect(drizzleBesideLimit.execute()).rejects.toThrow(
        'Offset must be an integer'
      );
      const memoryOffset = memoryKit
        .query('items')
        .where('status:a')
        .orderBy('id', 'asc')
        .offset(offset);
      await expect(memoryOffset.execute()).rejects.toThrow(
        InMemoryAdapterError
      );
      await expect(memoryOffset.execute()).rejects.toThrow(
        'Offset must be an integer'
      );
      const memoryBesideLimit = memoryKit
        .query('items')
        .where('status:a')
        .offset(offset)
        .limit(2);
      await expect(memoryBesideLimit.execute()).rejects.toThrow(
        InMemoryAdapterError
      );
      await expect(memoryBesideLimit.execute()).rejects.toThrow(
        'Offset must be an integer'
      );
    }
    expect(logged).toEqual([]);
  });
});
