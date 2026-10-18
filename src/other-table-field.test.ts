/**
 * A field of another table through `createQueryKit` with two Drizzle tables.
 *
 * The kit's schema set used to span every table, so a property of `owners`
 * passed the kit on `query('items')` and the adapters split: Drizzle failed
 * with `no such column` while the in-memory adapter returned no rows, every
 * row for `name:null`, or an unsorted result. The kit now checks a filter
 * field and a sort key against the selected table only, and respells a
 * `table.` qualifier that differs from that table only by ASCII case as the
 * table, so a field of another table is rejected with `QuerySecurityError`
 * on both adapters before either runs, and `Items.status`,
 * `ITEMS.createdAt` and `orderBy('Items.createdAt')` read `items` on both.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, IQueryExecutor, QueryKit } from './index';
import { IParserOptions } from './parser/types';

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

interface IOwner {
  id: number;
  name: string | null;
  tier: string;
}

type Table = 'items' | 'owners';

type SortKeys = Array<[string, 'asc' | 'desc']>;

/** One query as the kit runs it. */
interface IRun {
  table: Table;
  query: string;
  sorts: SortKeys;
  parserOptions?: IParserOptions;
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

type Schema = { items: typeof items; owners: typeof owners };

const REJECTED = {
  name: 'QuerySecurityError',
  message: 'Invalid query parameters'
};

const BY_ID: SortKeys = [['id', 'asc']];

const itemRows: IItem[] = [
  { id: 1, status: 'open', createdAt: '2024-03-01', isDone: false },
  { id: 2, status: 'open', createdAt: '2023-12-31', isDone: true },
  { id: 3, status: 'closed', createdAt: '2024-06-15', isDone: true },
  { id: 4, status: 'open', createdAt: null, isDone: false },
  { id: 5, status: 'closed', createdAt: '2024-01-01', isDone: true },
  { id: 6, status: 'pending', createdAt: '2022-05-05', isDone: false }
];

const ownerRows: IOwner[] = [
  { id: 1, name: 'ann', tier: 'gold' },
  { id: 2, name: 'bob', tier: 'silver' },
  { id: 3, name: null, tier: 'gold' }
];

const rejectedFilters: Array<[string, IRun]> = [
  ['tier:gold', { table: 'items', query: 'tier:gold', sorts: BY_ID }],
  [
    'owners.tier:gold',
    { table: 'items', query: 'owners.tier:gold', sorts: BY_ID }
  ],
  ['name:null', { table: 'items', query: 'name:null', sorts: BY_ID }],
  [
    'status:open AND tier:gold',
    { table: 'items', query: 'status:open AND tier:gold', sorts: BY_ID }
  ],
  [
    'tier:gold folded',
    {
      table: 'items',
      query: 'tier:gold',
      sorts: BY_ID,
      parserOptions: { caseInsensitiveFields: true }
    }
  ],
  [
    'status:gold through an alias to tier',
    {
      table: 'items',
      query: 'status:gold',
      sorts: BY_ID,
      parserOptions: { fieldMappings: { status: 'tier' } }
    }
  ],
  [
    'status:open on owners',
    { table: 'owners', query: 'status:open', sorts: BY_ID }
  ]
];

const rejectedSorts: Array<[string, IRun]> = [
  ['tier', { table: 'items', query: 'id:>0', sorts: [['tier', 'asc']] }],
  [
    'owners.tier',
    { table: 'items', query: 'id:>0', sorts: [['owners.tier', 'asc']] }
  ],
  [
    'tier folded',
    {
      table: 'items',
      query: 'id:>0',
      sorts: [['tier', 'asc']],
      parserOptions: { caseInsensitiveFields: true }
    }
  ],
  [
    'tier after status',
    {
      table: 'items',
      query: 'id:>0',
      sorts: [
        ['status', 'asc'],
        ['tier', 'asc']
      ]
    }
  ],
  [
    'createdAt on owners',
    { table: 'owners', query: 'id:>0', sorts: [['createdAt', 'asc']] }
  ]
];

const resolved: Array<[string, IRun, string, number[]]> = [
  [
    'items.status:open',
    { table: 'items', query: 'items.status:open', sorts: BY_ID },
    'where "items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'Items.status:open',
    { table: 'items', query: 'Items.status:open', sorts: BY_ID },
    'where "items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'ITEMS.createdAt:null',
    { table: 'items', query: 'ITEMS.createdAt:null', sorts: BY_ID },
    'where "items"."created_at" IS NULL',
    [4]
  ],
  [
    'orderBy Items.createdAt',
    { table: 'items', query: 'id:>0', sorts: [['Items.createdAt', 'asc']] },
    'order by "items"."created_at" asc',
    [4, 6, 2, 5, 1, 3]
  ],
  [
    'orderBy ITEMS.status then id',
    {
      table: 'items',
      query: 'id:>0',
      sorts: [
        ['ITEMS.status', 'asc'],
        ['id', 'asc']
      ]
    },
    'order by "items"."status_col" asc, "items"."id" asc',
    [3, 5, 1, 2, 4, 6]
  ],
  [
    'name:null on owners',
    { table: 'owners', query: 'name:null', sorts: BY_ID },
    'where "owners"."name" IS NULL',
    [3]
  ]
];

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
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
    CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT, tier TEXT);
    INSERT INTO owners VALUES (1, 'ann', 'gold'), (2, 'bob', 'silver'), (3, NULL, 'gold');
  `);
  return database;
}

function applySorts<T>(
  executor: IQueryExecutor<T>,
  sorts: SortKeys
): IQueryExecutor<T> {
  return sorts.reduce(
    (chained, [field, direction]) => chained.orderBy(field, direction),
    executor
  );
}

describe('a field of another table through the kit', () => {
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });

  function kits(parserOptions: IParserOptions = {}): Array<QueryKit<Schema>> {
    return [
      new DrizzleAdapter({ db, schema: { items, owners } }),
      inMemoryAdapter({ records: { items: itemRows, owners: ownerRows } })
    ].map(adapter =>
      createQueryKit({ adapter, schema: { items, owners }, parserOptions })
    );
  }

  function executorOf(
    kit: QueryKit<Schema>,
    run: IRun
  ): IQueryExecutor<unknown> {
    return applySorts(kit.query(run.table).where(run.query), run.sorts);
  }

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each([...rejectedFilters, ...rejectedSorts])(
    'rejects %s on both adapters before either runs',
    async (_name, run) => {
      for (const kit of kits(run.parserOptions)) {
        await expect(executorOf(kit, run).execute()).rejects.toEqual(
          expect.objectContaining(REJECTED)
        );
      }
      expect(logged).toHaveLength(0);
    }
  );

  it.each(resolved)(
    'resolves %s to the selected table on both adapters',
    async (_name, run, expectedSql, expectedIds) => {
      for (const kit of kits(run.parserOptions)) {
        expect(idsOf(await executorOf(kit, run).execute())).toEqual(
          expectedIds
        );
      }
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(expectedSql);
    }
  );
});
