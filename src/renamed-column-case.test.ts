/**
 * A property in another letter case on a renamed Drizzle column.
 *
 * On a table whose property `status` is the column `status_col`,
 * `createdAt` is `created_at` and `isDone` is a boolean-mode `is_done`, a
 * field spelled in another ASCII case (`STATUS`, `CreatedAt`, `createdat`,
 * `ISDONE`), as written or folded under `caseInsensitiveFields`, resolves
 * the table's own property by ASCII case, so the SQL names the column
 * (`"items"."status_col"`) instead of leaking the spelling to SQLite. The
 * kit's schema-derived allowlist still rejects those spellings on every
 * adapter; only the sort keys and the direct adapters reach the column.
 *
 * The in-memory row reader and sort reader resolve the one key differing
 * only by ASCII case the same way.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryBuilder, createQueryKit, QueryBuilder } from './index';
import { QueryParser } from './parser';
import { IParserOptions, QueryExpression } from './parser/types';
import { QuerySecurityError } from './security';

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

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

/** A builder with no row type, so any field name is accepted. */
function builder(): QueryBuilder<Record<string, unknown>> {
  return createQueryBuilder<Record<string, unknown>>();
}

const rows: IItem[] = [
  { id: 1, status: 'open', createdAt: '2024-03-01', isDone: false },
  { id: 2, status: 'open', createdAt: '2023-12-31', isDone: true },
  { id: 3, status: 'closed', createdAt: '2024-06-15', isDone: true },
  { id: 4, status: 'open', createdAt: null, isDone: false },
  { id: 5, status: 'closed', createdAt: '2024-01-01', isDone: true },
  { id: 6, status: 'pending', createdAt: '2022-05-05', isDone: false }
];

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

const filters: Array<[string, string, number[]]> = [
  ['STATUS:open', '"items"."status_col" = ?', [1, 2, 4]],
  ['CreatedAt:null', '"items"."created_at" IS NULL', [4]],
  ['createdat:>"2024-01-01"', '"items"."created_at" > ?', [1, 3]],
  ['ISDONE:true', '"items"."is_done" = ?', [2, 3, 5]]
];

const builtFilters: Array<[string, QueryExpression, string, number[]]> = [
  [
    'STATUS == open',
    builder().where('STATUS', '==', 'open').getExpression(),
    '"items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'CreatedAt == null',
    builder().where('CreatedAt', '==', null).getExpression(),
    '"items"."created_at" IS NULL',
    [4]
  ],
  [
    'createdat > 2024-01-01',
    builder().where('createdat', '>', '2024-01-01').getExpression(),
    '"items"."created_at" > ?',
    [1, 3]
  ],
  [
    'ISDONE == true',
    builder().where('ISDONE', '==', true).getExpression(),
    '"items"."is_done" = ?',
    [2, 3, 5]
  ]
];

const sorts: Array<['asc' | 'desc', number[]]> = [
  ['asc', [4, 6, 2, 5, 1, 3]],
  ['desc', [3, 1, 5, 2, 6, 4]]
];

describe.each<[string, IParserOptions]>([
  ['as written', {}],
  ['under caseInsensitiveFields', { caseInsensitiveFields: true }]
])('a property in another letter case, %s', (_name, parserOptions) => {
  const parser = new QueryParser(parserOptions);
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items } });
  const drizzleKit = createQueryKit({
    adapter,
    schema: { items },
    parserOptions
  });
  const memoryAdapter = inMemoryAdapter({ records: { items: rows } });
  const memoryKit = createQueryKit({
    adapter: memoryAdapter,
    schema: { items },
    parserOptions
  });

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each(filters)(
    '%s names the column on the Drizzle adapter',
    async (query, expectedSql, expectedIds) => {
      const executed = await adapter.execute<IItem>(
        'items',
        parser.parse(query),
        { orderBy: { id: 'asc' } }
      );
      expect(executed.map(row => row.id)).toEqual(expectedIds);
      expect(logged[0]).toContain(expectedSql);
    }
  );

  it.each(builtFilters)(
    'builder %s names the column on the Drizzle adapter',
    async (_title, expression, expectedSql, expectedIds) => {
      const executed = await adapter.execute<IItem>('items', expression, {
        orderBy: { id: 'asc' }
      });
      expect(executed.map(row => row.id)).toEqual(expectedIds);
      expect(logged[0]).toContain(expectedSql);
    }
  );

  it.each(sorts)(
    'orderBy CreatedAt %s names the column on the Drizzle adapter and kit',
    async (direction, expectedIds) => {
      const executed = await adapter.execute<IItem>(
        'items',
        parser.parse('id:>0'),
        { orderBy: { CreatedAt: direction } }
      );
      expect(executed.map(row => row.id)).toEqual(expectedIds);
      expect(logged[0]).toContain(`order by "items"."created_at" ${direction}`);
      const viaKit = await drizzleKit
        .query('items')
        .where('id:>0')
        .orderBy('CreatedAt', direction)
        .execute();
      expect(idsOf(viaKit)).toEqual(expectedIds);
    }
  );

  it.each(filters.map(([query]) => query))(
    'the kit still rejects %s on both adapters unless it folds to the property',
    async query => {
      const foldsToProperty =
        parserOptions.caseInsensitiveFields === true && query === 'STATUS:open';
      for (const kit of [drizzleKit, memoryKit]) {
        const execution = kit.query('items').where(query).execute();
        if (foldsToProperty) {
          expect(idsOf(await execution)).toEqual([1, 2, 4]);
        } else {
          await expect(execution).rejects.toThrow(QuerySecurityError);
        }
      }
    }
  );

  // The row reader and the sort reader resolve the one key differing only
  // by ASCII case.
  describe('in memory', () => {
    it.each(filters)('%s reads the property', async (query, _sql, ids) => {
      const matched = await memoryAdapter.execute<IItem>(
        'items',
        parser.parse(query),
        { orderBy: { id: 'asc' } }
      );
      expect(matched.map(row => row.id)).toEqual(ids);
    });

    it.each(builtFilters)(
      'builder %s reads the property',
      async (_title, expression, _sql, ids) => {
        const matched = await memoryAdapter.execute<IItem>(
          'items',
          expression,
          { orderBy: { id: 'asc' } }
        );
        expect(matched.map(row => row.id)).toEqual(ids);
      }
    );

    it.each(sorts)(
      'orderBy CreatedAt %s sorts by the property',
      async (direction, ids) => {
        const sorted = await memoryAdapter.execute<IItem>(
          'items',
          parser.parse('id:>0'),
          { orderBy: { CreatedAt: direction } }
        );
        expect(sorted.map(row => row.id)).toEqual(ids);
        const viaKit = await memoryKit
          .query('items')
          .where('id:>0')
          .orderBy('CreatedAt', direction)
          .execute();
        expect(idsOf(viaKit)).toEqual(ids);
      }
    );
  });
});
