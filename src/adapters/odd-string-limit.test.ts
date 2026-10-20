/**
 * A leading-zero string, a leading plus, and a fractional string as a limit.
 *
 * SQLite reads `LIMIT '02'` and `LIMIT '+2'` as 2 rows, and rejects
 * `LIMIT '2.5'` with `datatype mismatch`. A JavaScript string is not an
 * integer, so an entry that leaves `'02'` or `'+2'` unchanged throws while
 * the SQL forms return rows. `'2.5'` must throw on every entry. Parameterized
 * SQL binds the string. No entry may return ids while another throws.
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
  ['a leading-zero limit "02"', { limit: '02' }, [1, 2]],
  ['a signed limit "+2"', { limit: '+2' }, [1, 2]]
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

describe('a leading-zero or signed string limit', () => {
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
      expect(
        idsOfSql(
          `SELECT id FROM items WHERE ${parameterized.sql} ${bound.sql}`,
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

  it('rejects a fractional limit "2.5" on every entry', async () => {
    const clause = `LIMIT ${inlineToken('2.5')}`;
    expect(() =>
      idsOfSql(`SELECT id FROM items WHERE ${inline} ORDER BY id ASC ${clause}`)
    ).toThrow('datatype mismatch');
    expect(() =>
      idsOfSql(`SELECT id FROM items WHERE ${inline} ${clause}`)
    ).toThrow('datatype mismatch');
    const bound = parameterizedWindow({ limit: '2.5' });
    expect(() =>
      idsOfSql(
        `SELECT id FROM items WHERE ${parameterized.sql} ORDER BY id ASC ${bound.sql}`,
        [...parameterized.params, ...bound.params]
      )
    ).toThrow('datatype mismatch');
    expect(() =>
      idsOfSql(`SELECT id FROM items WHERE ${parameterized.sql} ${bound.sql}`, [
        ...parameterized.params,
        ...bound.params
      ])
    ).toThrow('datatype mismatch');
    const ordered = adapter.execute('items', expression, {
      orderBy: { id: 'asc' },
      limit: '2.5' as unknown as number
    });
    await expect(ordered).rejects.toThrow(DrizzleAdapterError);
    await expect(ordered).rejects.toThrow('Limit must be an integer');
    const unordered = adapter.execute('items', expression, {
      limit: '2.5' as unknown as number
    });
    await expect(unordered).rejects.toThrow(DrizzleAdapterError);
    await expect(unordered).rejects.toThrow('Limit must be an integer');
    await expect(
      memory.execute('items', expression, {
        orderBy: { id: 'asc' },
        limit: '2.5' as unknown as number
      })
    ).rejects.toThrow(InMemoryAdapterError);
    await expect(
      memory.execute('items', expression, {
        orderBy: { id: 'asc' },
        limit: '2.5' as unknown as number
      })
    ).rejects.toThrow('Limit must be an integer');
    await expect(
      memory.execute('items', expression, {
        limit: '2.5' as unknown as number
      })
    ).rejects.toThrow(InMemoryAdapterError);
    const drizzleLimited = drizzleKit
      .query('items')
      .where('status:a')
      .orderBy('id', 'asc')
      .limit('2.5' as unknown as number);
    await expect(drizzleLimited.execute()).rejects.toThrow(QuerySecurityError);
    await expect(drizzleLimited.execute()).rejects.toThrow(
      'Invalid query limit'
    );
    const memoryLimited = memoryKit
      .query('items')
      .where('status:a')
      .orderBy('id', 'asc')
      .limit('2.5' as unknown as number);
    await expect(memoryLimited.execute()).rejects.toThrow(QuerySecurityError);
    await expect(memoryLimited.execute()).rejects.toThrow(
      'Invalid query limit'
    );
    const drizzleUnordered = drizzleKit
      .query('items')
      .where('status:a')
      .limit('2.5' as unknown as number);
    await expect(drizzleUnordered.execute()).rejects.toThrow(
      QuerySecurityError
    );
    const memoryUnordered = memoryKit
      .query('items')
      .where('status:a')
      .limit('2.5' as unknown as number);
    await expect(memoryUnordered.execute()).rejects.toThrow(QuerySecurityError);
    expect(logged).toEqual([]);
  });
});
