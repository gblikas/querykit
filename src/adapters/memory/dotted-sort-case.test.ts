/**
 * A dotted sort key whose column is in another letter case.
 *
 * `ORDER BY "owner"."City"` sorts column `city` in SQLite. The in-memory
 * sort reader resolves the column by ASCII case the way the filter reader
 * does, after an own key of the whole name. A nested object stays unread.
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

const rows = [
  { id: 1, city: 'Chicago' },
  { id: 2, city: 'Austin' },
  { id: 3, city: 'Boston' }
];

const owner = sqliteTable('owner', {
  id: integer('id'),
  city: text('city')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE owner (id INTEGER PRIMARY KEY, city TEXT);
    INSERT INTO owner VALUES (1, 'Chicago'), (2, 'Austin'), (3, 'Boston');
  `);
  return database;
}

async function memoryOrder(
  records: object[],
  direction: Direction
): Promise<number[]> {
  const memory = inMemoryAdapter({ records: { owner: records } });
  const sorted = await memory.execute<{ id: number }>(
    'owner',
    new QueryParser().parse('id:>=0'),
    { orderBy: { 'owner.City': direction } }
  );
  return sorted.map(row => row.id);
}

describe('a dotted sort key in another letter case', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { owner } });

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each([
    ['asc', [2, 3, 1]],
    ['desc', [1, 3, 2]]
  ] as Array<[Direction, number[]]>)(
    'ORDER BY owner.City %s sorts column city on every engine',
    async (direction, expectedIds) => {
      const expression = parser.parse('id:>=0');
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const orderBy = `ORDER BY "owner"."City" ${direction.toUpperCase()}`;
      expect(
        database
          .prepare(`SELECT id FROM owner WHERE ${inline} ${orderBy}`)
          .all()
          .map(row => row.id)
      ).toEqual(expectedIds);
      expect(
        database
          .prepare(`SELECT id FROM owner WHERE ${parameterized.sql} ${orderBy}`)
          .all(...parameterized.params)
          .map(row => row.id)
      ).toEqual(expectedIds);
      const viaDrizzle = await adapter.execute<{ id: number }>(
        'owner',
        expression,
        { orderBy: { 'owner.City': direction } }
      );
      expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
      expect(logged[0]).toContain(`order by "owner"."city" ${direction}`);
      expect(await memoryOrder(rows, direction)).toEqual(expectedIds);
    }
  );

  it('sorts by an own key of the whole name first', async () => {
    const literalRows = [
      { id: 1, 'owner.city': 'Chicago', city: 'Austin' },
      { id: 2, 'owner.city': 'Austin', city: 'Boston' },
      { id: 3, 'owner.city': 'Boston', city: 'Chicago' }
    ];
    expect(await memoryOrder(literalRows, 'asc')).toEqual([2, 3, 1]);
    expect(await memoryOrder(literalRows, 'desc')).toEqual([1, 3, 2]);
  });

  it('leaves a nested object unread', async () => {
    const nestedRows = [
      { id: 1, owner: { city: 'Chicago' } },
      { id: 2, owner: { city: 'Austin' } },
      { id: 3, owner: { city: 'Boston' } }
    ];
    expect(await memoryOrder(nestedRows, 'asc')).toEqual([1, 2, 3]);
    expect(await memoryOrder(nestedRows, 'desc')).toEqual([1, 2, 3]);
    const mixedRows = [
      { id: 1, owner: { city: 'Chicago' } },
      { id: 2, city: 'Boston' },
      { id: 3, city: 'Austin' }
    ];
    expect(await memoryOrder(mixedRows, 'asc')).toEqual([1, 3, 2]);
    expect(await memoryOrder(mixedRows, 'desc')).toEqual([2, 3, 1]);
  });
});
