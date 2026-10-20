/**
 * A wildcard must not return a row whose value `denyValues` already rejects
 * as an exact comparison.
 *
 * `createQueryKit` rejects `secret:hidden` before either adapter runs.
 * `secret:hid*` and `secret:*hidden*` are the same value written as SQL
 * LIKE, and they must be rejected there too. A wildcard that cannot match
 * the denied value still runs. Translators that only emit SQL are not given
 * this check.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { inMemoryAdapter } from '../adapters/memory';
import { createQueryKit } from '../index';
import { QuerySecurityError } from './validator';

const nodeRequire = createRequire(__filename);

interface ISqliteDatabase {
  exec(sqlText: string): void;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

interface IItem {
  id: number;
}

const REJECTED = 'Invalid query parameters';

const row = { id: 1, status: 'todo', secret: 'hidden' };

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status'),
  secret: text('secret')
});

const security = { denyValues: { secret: ['hidden'] } };

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, secret TEXT);
    INSERT INTO items VALUES (1, 'todo', 'hidden');
  `);
  return database;
}

function idsOf(rows: unknown[]): number[] {
  return (rows as IItem[]).map(item => item.id);
}

describe('denied value wildcards', () => {
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const drizzleKit = createQueryKit({
    adapter: new DrizzleAdapter({ db, schema: { items } }),
    schema: { items },
    security
  });
  const memoryKit = createQueryKit({
    adapter: inMemoryAdapter({ records: { items: [row] } }),
    schema: { items },
    security
  });

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each([
    'secret:hidden',
    'secret:"hidden"',
    'status:todo OR secret:hidden',
    'secret:hid*',
    'secret:*hidden*',
    'secret:HID*',
    'secret:"*hidden*"',
    'secret:h?dden',
    'NOT secret:hid*',
    'status:todo OR secret:hid*'
  ])('rejects %s on both kits before a row is read', async query => {
    await expect(
      drizzleKit.query('items').where(query).execute()
    ).rejects.toThrow(QuerySecurityError);
    await expect(
      drizzleKit.query('items').where(query).execute()
    ).rejects.toThrow(REJECTED);
    await expect(
      memoryKit.query('items').where(query).execute()
    ).rejects.toThrow(QuerySecurityError);
    await expect(
      memoryKit.query('items').where(query).execute()
    ).rejects.toThrow(REJECTED);
    expect(logged).toHaveLength(0);
  });

  it('still runs a query that cannot match the denied value', async () => {
    const byStatus = await drizzleKit
      .query('items')
      .where('status:todo')
      .execute();
    expect(idsOf(byStatus)).toEqual([1]);
    expect(logged).toHaveLength(1);
    const byOther = await drizzleKit
      .query('items')
      .where('secret:other*')
      .execute();
    expect(idsOf(byOther)).toEqual([]);
    expect(logged).toHaveLength(2);
    const inMemory = await memoryKit
      .query('items')
      .where('status:t*')
      .execute();
    expect(idsOf(inMemory)).toEqual([1]);
    const missed = await memoryKit
      .query('items')
      .where('secret:other*')
      .execute();
    expect(idsOf(missed)).toEqual([]);
  });
});
