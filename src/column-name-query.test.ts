/**
 * A query that names the database column instead of the Drizzle property,
 * on the bare adapters.
 *
 * On the renamed `items` table (property `status` on column `status_col`,
 * `createdAt` on `created_at`, `isDone` on `is_done`) a query-side name is
 * a property of the selected table. `status_col:open`, `created_at:null`,
 * `items.created_at:null`, the quoted literal `"Items.status":open` and
 * `orderBy('created_at')` name no property, exactly or by ASCII case, so
 * each adapter rejects them with its typed error before any row is read.
 * The Drizzle adapter used to quote such a name as a raw identifier that
 * SQLite accepted and return rows, while the in-memory adapter, whose rows
 * are keyed by property, returned none, every row for the null test, or
 * the incoming order. The control `status:open` still names the column on
 * Drizzle and reads the property in memory.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter, DrizzleAdapterError } from './adapters/drizzle';
import {
  InMemoryAdapter,
  InMemoryAdapterError,
  inMemoryAdapter
} from './adapters/memory';
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
  status: string | null;
  createdAt: string | null;
  isDone: boolean | null;
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status_col'),
  createdAt: text('created_at'),
  isDone: integer('is_done', { mode: 'boolean' })
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status_col TEXT, created_at TEXT, is_done INTEGER);
    INSERT INTO items VALUES
      (1, 'open', '2024-03-01', 0), (2, 'open', '2023-12-31', 1),
      (3, 'closed', '2024-06-15', 1), (4, 'open', NULL, 0),
      (5, 'closed', '2024-01-01', 1), (6, 'pending', '2022-05-05', 0);
  `);
  return database;
}

function built(field: string, value: string | null): QueryExpression {
  return createQueryBuilder<Record<string, unknown>>()
    .where(field, '==', value)
    .getExpression();
}

function rejection(field: string): string {
  return `Field ${field} does not name a property of table items`;
}

/** Query, builder expression and the name each adapter reports. */
const columnNamedFilters: Array<[string, QueryExpression, string]> = [
  ['status_col:open', built('status_col', 'open'), 'status_col'],
  ['created_at:null', built('created_at', null), 'created_at'],
  ['items.created_at:null', built('items.created_at', null), 'items.created_at']
];

describe('a query that names the column instead of the property', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items } });
  let memoryAdapter: InMemoryAdapter;

  beforeAll(async (): Promise<void> => {
    const selected: IItem[] = await db.select().from(items);
    memoryAdapter = inMemoryAdapter({ records: { items: selected } });
  });

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  async function expectDrizzleRejection(
    execution: Promise<unknown>,
    field: string
  ): Promise<void> {
    await expect(execution).rejects.toThrow(DrizzleAdapterError);
    await expect(execution).rejects.toThrow(rejection(field));
    expect(logged).toHaveLength(0);
  }

  async function expectMemoryRejection(
    execution: Promise<unknown>,
    field: string
  ): Promise<void> {
    await expect(execution).rejects.toThrow(InMemoryAdapterError);
    await expect(execution).rejects.toThrow(rejection(field));
  }

  describe.each([
    ['parsed', (query: string): QueryExpression => parser.parse(query)],
    [
      'built',
      (_query: string, expression: QueryExpression): QueryExpression =>
        expression
    ]
  ])('%s filters', (_form, toExpression) => {
    it('status:open, the control, names the column on Drizzle and reads the property in memory', async () => {
      const expression = toExpression('status:open', built('status', 'open'));
      const executed = await adapter.execute<IItem>('items', expression, {
        orderBy: { id: 'asc' }
      });
      expect(executed.map(row => row.id)).toEqual([1, 2, 4]);
      expect(logged[0]).toContain('where "items"."status_col" = ?');
      const matched = await memoryAdapter.execute<IItem>('items', expression, {
        orderBy: { id: 'asc' }
      });
      expect(matched.map(row => row.id)).toEqual([1, 2, 4]);
    });

    it.each(columnNamedFilters)(
      '%s is rejected by the Drizzle adapter without a logged query',
      async (query, expression, field) => {
        await expectDrizzleRejection(
          adapter.execute('items', toExpression(query, expression), {
            orderBy: { id: 'asc' }
          }),
          field
        );
      }
    );

    it.each(columnNamedFilters)(
      '%s is rejected in memory before a row is read',
      async (query, expression, field) => {
        await expectMemoryRejection(
          memoryAdapter.execute('items', toExpression(query, expression), {
            orderBy: { id: 'asc' }
          }),
          field
        );
      }
    );
  });

  it('the quoted literal "Items.status":open is one name neither adapter resolves', async () => {
    const expression = parser.parse('"Items.status":open');
    expect(expression).toMatchObject({
      field: 'Items.status',
      isLiteral: true
    });
    await expectDrizzleRejection(
      adapter.execute('items', expression),
      'Items.status'
    );
    await expectMemoryRejection(
      memoryAdapter.execute('items', expression),
      'Items.status'
    );
  });

  it.each(['asc', 'desc'] as const)(
    'orderBy created_at %s is rejected by both adapters',
    async direction => {
      await expectDrizzleRejection(
        adapter.execute('items', parser.parse('id:>0'), {
          orderBy: { created_at: direction }
        }),
        'created_at'
      );
      await expectMemoryRejection(
        memoryAdapter.execute('items', parser.parse('id:>0'), {
          orderBy: { created_at: direction }
        }),
        'created_at'
      );
    }
  );

  it('orderBy createdAt still sorts by the column on Drizzle and by the property in memory', async () => {
    const sorted = await adapter.execute<IItem>(
      'items',
      parser.parse('id:>0'),
      { orderBy: { createdAt: 'asc' } }
    );
    expect(sorted.map(row => row.id)).toEqual([4, 6, 2, 5, 1, 3]);
    expect(logged[0]).toContain('order by "items"."created_at" asc');
    const inMemory = await memoryAdapter.execute<IItem>(
      'items',
      parser.parse('id:>0'),
      { orderBy: { createdAt: 'asc' } }
    );
    expect(inMemory.map(row => row.id)).toEqual([4, 6, 2, 5, 1, 3]);
  });
});
