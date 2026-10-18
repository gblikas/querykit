/**
 * A table qualifier in another letter case on the bare adapters.
 *
 * On the renamed `items` table, a single `table.column` whose table part
 * differs from `items` only by ASCII case (`Items.status`, `ITEMS.createdAt`,
 * `orderBy('Items.createdAt')`) resolves the schema key the way the column
 * key is resolved, so the Drizzle adapter names the column
 * (`"items"."status_col"`) instead of quoting the qualifier as written. A
 * qualifier that is not the selected table (`Other.status`, or `owners.tier`
 * with `owners` a second table) is rejected: SQLite has no such column in
 * the FROM clause, and nothing is logged.
 *
 * The in-memory adapter resolves a qualifier against its records the same
 * way and rejects one that is not the selected table with an
 * `InMemoryAdapterError` before any row is read.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter, DrizzleAdapterError } from './adapters/drizzle';
import { InMemoryAdapterError, inMemoryAdapter } from './adapters/memory';
import { createQueryBuilder } from './index';
import { QueryParser } from './parser';
import { QueryExpression } from './parser/types';

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
  status: string;
  createdAt: string | null;
  isDone: boolean;
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status_col'),
  createdAt: text('created_at'),
  isDone: integer('is_done', { mode: 'boolean' })
});

const owners = sqliteTable('owners', {
  id: integer('id').primaryKey(),
  name: text('name'),
  tier: text('tier')
});

const rows: IItem[] = [
  { id: 1, status: 'open', createdAt: '2024-03-01', isDone: false },
  { id: 2, status: 'open', createdAt: '2023-12-31', isDone: true },
  { id: 3, status: 'closed', createdAt: '2024-06-15', isDone: true },
  { id: 4, status: 'open', createdAt: null, isDone: false },
  { id: 5, status: 'closed', createdAt: '2024-01-01', isDone: true },
  { id: 6, status: 'pending', createdAt: '2022-05-05', isDone: false }
];

const ownerRows = [{ id: 1, name: 'Ada', tier: 'gold' }];

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status_col TEXT, created_at TEXT, is_done INTEGER);
    INSERT INTO items VALUES
      (1, 'open', '2024-03-01', 0), (2, 'open', '2023-12-31', 1),
      (3, 'closed', '2024-06-15', 1), (4, 'open', NULL, 0),
      (5, 'closed', '2024-01-01', 1), (6, 'pending', '2022-05-05', 0);
    CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT, tier TEXT);
    INSERT INTO owners VALUES (1, 'Ada', 'gold');
  `);
  return database;
}

function built(field: string, value: string | null): QueryExpression {
  return createQueryBuilder<Record<string, unknown>>()
    .where(field, '==', value)
    .getExpression();
}

const resolvedFilters: Array<[string, QueryExpression, string, number[]]> = [
  [
    'items.status:open',
    built('items.status', 'open'),
    '"items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'Items.status:open',
    built('Items.status', 'open'),
    '"items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'ITEMS.createdAt:null',
    built('ITEMS.createdAt', null),
    '"items"."created_at" IS NULL',
    [4]
  ],
  [
    'items.STATUS:open',
    built('items.STATUS', 'open'),
    '"items"."status_col" = ?',
    [1, 2, 4]
  ]
];

const rejectedFilters: Array<[string, QueryExpression, string]> = [
  ['Other.status:open', built('Other.status', 'open'), 'Other.status'],
  ['owners.tier:gold', built('owners.tier', 'gold'), 'owners.tier']
];

describe('a table qualifier in another letter case', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items, owners } });
  const memoryAdapter = inMemoryAdapter({
    records: { items: rows, owners: ownerRows }
  });

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  describe.each([
    ['parsed', (query: string): QueryExpression => parser.parse(query)],
    [
      'built',
      (_query: string, expression: QueryExpression): QueryExpression =>
        expression
    ]
  ])('%s filters', (_form, toExpression) => {
    it.each(resolvedFilters)(
      '%s names the column on the Drizzle adapter',
      async (query, expression, expectedSql, expectedIds) => {
        const executed = await adapter.execute<IItem>(
          'items',
          toExpression(query, expression),
          { orderBy: { id: 'asc' } }
        );
        expect(executed.map(row => row.id)).toEqual(expectedIds);
        expect(logged[0]).toContain(`where ${expectedSql}`);
      }
    );

    it.each(rejectedFilters)(
      '%s is rejected by the Drizzle adapter without a logged query',
      async (query, expression, field) => {
        const execution = adapter.execute(
          'items',
          toExpression(query, expression)
        );
        await expect(execution).rejects.toThrow(DrizzleAdapterError);
        await expect(execution).rejects.toThrow(
          expect.objectContaining({
            message: expect.stringContaining(`no such column: ${field}`)
          })
        );
        expect(logged).toHaveLength(0);
      }
    );
  });

  it.each([
    ['asc', [4, 6, 2, 5, 1, 3]],
    ['desc', [3, 1, 5, 2, 6, 4]]
  ] as Array<['asc' | 'desc', number[]]>)(
    'orderBy Items.createdAt %s names the column on the Drizzle adapter',
    async (direction, expectedIds) => {
      const executed = await adapter.execute<IItem>(
        'items',
        parser.parse('id:>0'),
        { orderBy: { 'Items.createdAt': direction } }
      );
      expect(executed.map(row => row.id)).toEqual(expectedIds);
      expect(logged[0]).toContain(`order by "items"."created_at" ${direction}`);
    }
  );

  it.each(['Other.createdAt', 'owners.tier'])(
    'orderBy %s is rejected by the Drizzle adapter without a logged query',
    async field => {
      const execution = adapter.execute('items', parser.parse('id:>0'), {
        orderBy: { [field]: 'asc' }
      });
      await expect(execution).rejects.toThrow(DrizzleAdapterError);
      await expect(execution).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining(`no such column: ${field}`)
        })
      );
      expect(logged).toHaveLength(0);
    }
  );

  // The in-memory adapter reads the column of a qualifier that resolves to
  // the selected table and rejects any other qualifier before a row is read.
  describe('in memory', () => {
    it.each(resolvedFilters)(
      '%s reads the column',
      async (query, expression, _sql, expectedIds) => {
        for (const form of [parser.parse(query), expression]) {
          const matched = await memoryAdapter.execute<IItem>('items', form, {
            orderBy: { id: 'asc' }
          });
          expect(matched.map(row => row.id)).toEqual(expectedIds);
        }
      }
    );

    it.each(rejectedFilters)(
      '%s is rejected before a row is read',
      async (query, expression, field) => {
        for (const form of [parser.parse(query), expression]) {
          await expect(memoryAdapter.execute('items', form)).rejects.toThrow(
            InMemoryAdapterError
          );
          await expect(memoryAdapter.execute('items', form)).rejects.toThrow(
            `Field ${field} does not name the selected table items`
          );
        }
      }
    );

    it('sorts by Items.createdAt and rejects a foreign qualifier', async () => {
      const sorted = await memoryAdapter.execute<IItem>(
        'items',
        parser.parse('id:>0'),
        { orderBy: { 'Items.createdAt': 'asc' } }
      );
      expect(sorted.map(row => row.id)).toEqual([4, 6, 2, 5, 1, 3]);
      for (const field of ['Other.createdAt', 'owners.tier']) {
        await expect(
          memoryAdapter.execute('items', parser.parse('id:>0'), {
            orderBy: { [field]: 'asc' }
          })
        ).rejects.toThrow(
          `Field ${field} does not name the selected table items`
        );
      }
    });
  });
});
