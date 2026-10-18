/**
 * Limit and offset across the engines.
 *
 * A positive limit, limit 0, an offset in the middle and an offset past the
 * end return the same ids on inline SQL, parameterized SQL, the Drizzle
 * adapter and the in-memory adapter. SQLite rejects a bare OFFSET, so an
 * offset with no limit is the unbounded window `LIMIT -1 OFFSET n`: the
 * Drizzle adapter emits `limit -1 offset ?` and memory slices the same way.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
  limit?: number;
  offset?: number;
}

const rows = [
  { id: 1, status: 'open' },
  { id: 2, status: 'closed' },
  { id: 3, status: 'open' },
  { id: 4, status: 'open' },
  { id: 5, status: 'open' },
  { id: 6, status: 'closed' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT);
    INSERT INTO items VALUES
      (1, 'open'), (2, 'closed'), (3, 'open'), (4, 'open'), (5, 'open'), (6, 'closed');
  `);
  return database;
}

describe('limit and offset', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items } });
  const memory = inMemoryAdapter({ records: { items: rows } });
  const expression = parser.parse('status:open');
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

  /** The SQL window clause, with `LIMIT -1` standing in for no limit. */
  function windowClause(window: IWindow): string {
    const limit = window.limit ?? -1;
    return window.offset === undefined
      ? `LIMIT ${limit}`
      : `LIMIT ${limit} OFFSET ${window.offset}`;
  }

  /** Every engine must return the same ids for the window. */
  async function expectWindow(
    window: IWindow,
    expectedIds: number[]
  ): Promise<void> {
    const clause = windowClause(window);
    expect(
      idsOfSql(`SELECT id FROM items WHERE ${inline} ORDER BY id ASC ${clause}`)
    ).toEqual(expectedIds);
    expect(
      idsOfSql(
        `SELECT id FROM items WHERE ${parameterized.sql} ORDER BY id ASC ${clause.replace(/-?\d+/g, '?')}`,
        [...parameterized.params, ...clause.match(/-?\d+/g)!.map(Number)]
      )
    ).toEqual(expectedIds);
    const options = { orderBy: { id: 'asc' as const }, ...window };
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

  it.each([
    [{ limit: 2 }, [1, 3]],
    [{ limit: 0 }, []],
    [{ limit: 1, offset: 2 }, [4]],
    [{ limit: 2, offset: 100 }, []],
    [{ limit: 0, offset: 2 }, []],
    [{ limit: 2, offset: 0 }, [1, 3]]
  ] as Array<[IWindow, number[]]>)(
    'returns the same rows for %j on every engine',
    async (window, expectedIds) => {
      await expectWindow(window, expectedIds);
    }
  );

  it('rejects a bare OFFSET in SQLite', () => {
    expect(() =>
      idsOfSql(`SELECT id FROM items WHERE ${inline} ORDER BY id ASC OFFSET 2`)
    ).toThrow('near "OFFSET": syntax error');
  });

  it.each([
    [{ offset: 2 }, [4, 5]],
    [{ offset: 100 }, []]
  ] as Array<[IWindow, number[]]>)(
    'emits LIMIT -1 for %j, an offset with no limit, and matches memory',
    async (window, expectedIds) => {
      await expectWindow(window, expectedIds);
      expect(logged[0]).toContain('limit -1 offset ?');
    }
  );

  it('emits only the WHERE clause from the SQL translator', () => {
    expect(inline).toBe(`"status" = 'open'`);
    expect(parameterized).toEqual({ sql: '"status" = ?', params: ['open'] });
  });
});
