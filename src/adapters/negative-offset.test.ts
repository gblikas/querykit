/**
 * A negative offset or limit from the caller.
 *
 * SQLite reads a negative OFFSET as zero when a LIMIT is present and a
 * negative LIMIT as no limit. The Drizzle adapter writes `limit -1` for a
 * negative limit beside an offset (Drizzle drops a negative number) and the
 * in-memory adapter slices the same windows. A negative offset with no
 * limit is still rejected everywhere, since SQLite has no clause for it.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
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

describe('a negative offset or limit', () => {
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

  function windowClause(window: IWindow): string {
    const limit = window.limit === undefined ? '' : `LIMIT ${window.limit}`;
    const offset = window.offset === undefined ? '' : `OFFSET ${window.offset}`;
    return `${limit} ${offset}`.trim();
  }

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
        [...parameterized.params, ...(clause.match(/-?\d+/g) ?? []).map(Number)]
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
    [{ limit: 2, offset: -1 }, [1, 3]],
    [{ limit: 2, offset: -5 }, [1, 3]],
    [{ limit: 1, offset: -1 }, [1]],
    [{ limit: 0, offset: -1 }, []]
  ] as Array<[IWindow, number[]]>)(
    'reads the negative offset of %j as zero beside a limit',
    async (window, expectedIds) => {
      await expectWindow(window, expectedIds);
    }
  );

  it.each([
    [{ limit: -1 }, [1, 3, 4, 5]],
    [{ limit: -2 }, [1, 3, 4, 5]]
  ] as Array<[IWindow, number[]]>)(
    'reads the negative limit of %j as no limit',
    async (window, expectedIds) => {
      await expectWindow(window, expectedIds);
      expect(logged[0]).not.toContain('limit');
    }
  );

  it.each([
    [{ limit: -2, offset: 1 }, [3, 4, 5]],
    [{ limit: -1, offset: 2 }, [4, 5]],
    [{ limit: -5, offset: 1 }, [3, 4, 5]]
  ] as Array<[IWindow, number[]]>)(
    'writes LIMIT -1 for the negative limit of %j beside an offset',
    async (window, expectedIds) => {
      await expectWindow(window, expectedIds);
      expect(logged[0]).toContain('limit -1 offset ?');
    }
  );

  it('still rejects a negative offset with no limit everywhere', async () => {
    expect(() =>
      idsOfSql(`SELECT id FROM items WHERE ${inline} ORDER BY id ASC OFFSET -1`)
    ).toThrow('near "OFFSET": syntax error');
    const viaDrizzle = adapter.execute('items', expression, { offset: -1 });
    await expect(viaDrizzle).rejects.toThrow(DrizzleAdapterError);
    await expect(viaDrizzle).rejects.toThrow('near "offset": syntax error');
    const viaMemory = memory.execute('items', expression, { offset: -1 });
    await expect(viaMemory).rejects.toThrow(InMemoryAdapterError);
    await expect(viaMemory).rejects.toThrow(
      'Offset must be a non-negative integer'
    );
  });

  it('still rejects a fractional limit or offset in memory', async () => {
    await expect(
      memory.execute('items', expression, { limit: 1.5 })
    ).rejects.toThrow('Limit must be an integer');
    await expect(
      memory.execute('items', expression, { limit: 2, offset: 0.5 })
    ).rejects.toThrow('Offset must be an integer');
  });
});
