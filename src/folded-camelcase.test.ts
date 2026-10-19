/**
 * A camelCase property folded under `caseInsensitiveFields`, through
 * `createQueryKit`.
 *
 * On the table from `renamed-column-case.test.ts` the parser folds
 * `createdAt` and `isDone` to `createdat` and `isdone`. Both adapters
 * resolve that spelling by ASCII case, and the kit now respells it as the
 * one schema property that differs only by case before its allowlist
 * compares it, in the query, in `orderBy` and in the configured field lists,
 * so every engine returns the same ids. A name that folds onto two
 * properties differing only by case is rejected with the allowlist's error
 * on both adapters, as a filter and as a sort key.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import {
  createQueryBuilder,
  createQueryKit,
  QueryBuilder,
  QueryKit
} from './index';
import { QueryExpression } from './parser/types';
import { ISecurityOptions, QuerySecurityError } from './security';

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

interface INote {
  id: number;
  createdAt: string | null;
  CreatedAt: string | null;
}

interface ILoggedQuery {
  sql: string;
  params: unknown[];
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status_col'),
  createdAt: text('created_at'),
  isDone: integer('is_done', { mode: 'boolean' })
});

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  createdAt: text('created_at'),
  CreatedAt: text('created_at_2')
});

type ItemsSchema = { items: typeof items };

type NotesSchema = { notes: typeof notes };

const parserOptions = { caseInsensitiveFields: true };

const rows: IItem[] = [
  { id: 1, status: 'open', createdAt: '2024-03-01', isDone: false },
  { id: 2, status: 'open', createdAt: '2023-12-31', isDone: true },
  { id: 3, status: 'closed', createdAt: '2024-06-15', isDone: true },
  { id: 4, status: 'open', createdAt: null, isDone: false },
  { id: 5, status: 'closed', createdAt: '2024-01-01', isDone: true },
  { id: 6, status: 'pending', createdAt: '2022-05-05', isDone: false }
];

const noteRows: INote[] = [
  { id: 1, createdAt: null, CreatedAt: '2024-01-01' },
  { id: 2, createdAt: '2024-02-02', CreatedAt: null }
];

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

/** A folding builder with no row type, so any field name is accepted. */
function builder(): QueryBuilder<Record<string, unknown>> {
  return createQueryBuilder<Record<string, unknown>>(parserOptions);
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status_col TEXT, created_at TEXT, is_done INTEGER);
    INSERT INTO items VALUES
      (1, 'open', '2024-03-01', 0), (2, 'open', '2023-12-31', 1),
      (3, 'closed', '2024-06-15', 1), (4, 'open', NULL, 0),
      (5, 'closed', '2024-01-01', 1), (6, 'pending', '2022-05-05', 0);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, created_at TEXT, created_at_2 TEXT);
    INSERT INTO notes VALUES (1, NULL, '2024-01-01'), (2, '2024-02-02', NULL);
  `);
  return database;
}

const filters: Array<[string, QueryExpression, string, unknown[], number[]]> = [
  [
    'createdAt:null',
    builder().where('createdAt', '==', null).getExpression(),
    'where "items"."created_at" IS NULL order by "items"."id" asc limit ?',
    [100],
    [4]
  ],
  [
    'CreatedAt:null',
    builder().where('CreatedAt', '==', null).getExpression(),
    'where "items"."created_at" IS NULL order by "items"."id" asc limit ?',
    [100],
    [4]
  ],
  [
    'isDone:true',
    builder().where('isDone', '==', true).getExpression(),
    'where "items"."is_done" = ? order by "items"."id" asc limit ?',
    [1, 100],
    [2, 3, 5]
  ],
  [
    'status:open',
    builder().where('status', '==', 'open').getExpression(),
    'where "items"."status_col" = ? order by "items"."id" asc limit ?',
    ['open', 100],
    [1, 2, 4]
  ],
  [
    'ISDONE:false',
    builder().where('ISDONE', '==', false).getExpression(),
    'where "items"."is_done" = ? order by "items"."id" asc limit ?',
    [0, 100],
    [1, 4, 6]
  ]
];

describe('a camelCase property folded through the kit', () => {
  const database = openDatabase();
  const logged: ILoggedQuery[] = [];
  const db = drizzle(database as never, {
    logger: {
      logQuery: (sql: string, params: unknown[]): number =>
        logged.push({ sql, params })
    }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items, notes } });
  const memoryAdapter = inMemoryAdapter({
    records: { items: rows, notes: noteRows }
  });

  function kits(security: ISecurityOptions = {}): Array<QueryKit<ItemsSchema>> {
    return [adapter, memoryAdapter].map(kitAdapter =>
      createQueryKit({
        adapter: kitAdapter,
        schema: { items },
        parserOptions,
        security
      })
    );
  }

  /** Kits over `notes`, whose two properties differ only by case. */
  function noteKits(): Array<QueryKit<NotesSchema>> {
    return [adapter, memoryAdapter].map(kitAdapter =>
      createQueryKit({ adapter: kitAdapter, schema: { notes }, parserOptions })
    );
  }

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each(filters)(
    '%s reaches the property on every engine',
    async (query, built, expectedSql, expectedParams, expectedIds) => {
      const [drizzleKit, memoryKit] = kits();
      const viaDrizzleKit = await drizzleKit
        .query('items')
        .where(query)
        .orderBy('id', 'asc')
        .execute();
      expect(idsOf(viaDrizzleKit)).toEqual(expectedIds);
      expect(logged).toHaveLength(1);
      expect(logged[0].sql).toContain(expectedSql);
      expect(logged[0].params).toEqual(expectedParams);
      const viaMemoryKit = await memoryKit
        .query('items')
        .where(query)
        .orderBy('id', 'asc')
        .execute();
      expect(idsOf(viaMemoryKit)).toEqual(expectedIds);
      const builtOnDrizzle = await adapter.execute<IItem>('items', built, {
        orderBy: { id: 'asc' }
      });
      expect(builtOnDrizzle.map(row => row.id)).toEqual(expectedIds);
      const builtInMemory = await memoryAdapter.execute<IItem>('items', built, {
        orderBy: { id: 'asc' }
      });
      expect(builtInMemory.map(row => row.id)).toEqual(expectedIds);
    }
  );

  it.each<['asc' | 'desc', number[]]>([
    ['asc', [4, 6, 2, 5, 1, 3]],
    ['desc', [3, 1, 5, 2, 6, 4]]
  ])(
    'orderBy createdAt %s sorts by the property on both kits',
    async (direction, expected) => {
      const [drizzleKit, memoryKit] = kits();
      const viaDrizzleKit = await drizzleKit
        .query('items')
        .where('id:>0')
        .orderBy('createdAt', direction)
        .execute();
      expect(idsOf(viaDrizzleKit)).toEqual(expected);
      expect(logged[0].sql).toContain(
        `order by "items"."created_at" ${direction}`
      );
      const viaMemoryKit = await memoryKit
        .query('items')
        .where('id:>0')
        .orderBy('createdAt', direction)
        .execute();
      expect(idsOf(viaMemoryKit)).toEqual(expected);
    }
  );

  it.each([[['createdAt', 'id']], [['createdat', 'id']]])(
    'an allowlist spelled %j admits the folded property',
    async allowedFields => {
      for (const kit of kits({ allowedFields })) {
        const matched = await kit
          .query('items')
          .where('CreatedAt:null')
          .orderBy('id', 'asc')
          .execute();
        expect(idsOf(matched)).toEqual([4]);
      }
    }
  );

  it.each([[['isDone']], [['isdone']]])(
    'a deny list spelled %j rejects the folded property',
    async denyFields => {
      for (const kit of kits({ denyFields })) {
        await expect(
          kit.query('items').where('ISDONE:false').execute()
        ).rejects.toThrow(QuerySecurityError);
      }
      expect(logged).toHaveLength(0);
    }
  );

  it.each(['createdat:null', 'createdAt:null', 'CreatedAt:null'])(
    '%s is rejected on both adapters when it folds onto two properties',
    async query => {
      for (const kit of noteKits()) {
        await expect(kit.query('notes').where(query).execute()).rejects.toEqual(
          expect.objectContaining({
            name: 'QuerySecurityError',
            message: 'Invalid query parameters'
          })
        );
      }
      expect(logged).toHaveLength(0);
    }
  );

  it('rejects a sort key that folds onto two properties on both adapters', async () => {
    for (const kit of noteKits()) {
      await expect(
        kit.query('notes').where('id:>0').orderBy('createdAt').execute()
      ).rejects.toEqual(
        expect.objectContaining({
          name: 'QuerySecurityError',
          message: 'Invalid query parameters'
        })
      );
    }
    expect(logged).toHaveLength(0);
  });
});
