/**
 * An unknown field or sort key through `createQueryKit` with a Drizzle
 * schema.
 *
 * The kit's schema-derived allowlist already rejected an unknown filter
 * field on both adapters. A sort key skipped the parser and reached the
 * adapters unchecked: Drizzle failed with `no such column` while the
 * in-memory adapter tied every row and returned the incoming order. The kit
 * now checks each `orderBy` key against the schema after folding and
 * mapping it: a key must name a schema property exactly or as the one
 * property that differs only by ASCII case, bare or as `table.property`,
 * and anything else is rejected with the allowlist's `QuerySecurityError`
 * before either adapter runs.
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

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status_col'),
  createdAt: text('created_at'),
  isDone: integer('is_done', { mode: 'boolean' })
});

type Schema = { items: typeof items };

type SortKeys = Array<[string, 'asc' | 'desc']>;

const REJECTED = {
  name: 'QuerySecurityError',
  message: 'Invalid query parameters'
};

const rows: IItem[] = [
  { id: 1, status: 'open', createdAt: '2024-03-01', isDone: false },
  { id: 2, status: 'open', createdAt: '2023-12-31', isDone: true },
  { id: 3, status: 'closed', createdAt: '2024-06-15', isDone: true },
  { id: 4, status: 'open', createdAt: null, isDone: false },
  { id: 5, status: 'closed', createdAt: '2024-01-01', isDone: true },
  { id: 6, status: 'pending', createdAt: '2022-05-05', isDone: false }
];

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
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

describe('an unknown field through the kit', () => {
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });

  function kits(parserOptions: IParserOptions = {}): Array<QueryKit<Schema>> {
    return [
      new DrizzleAdapter({ db, schema: { items } }),
      inMemoryAdapter({ records: { items: rows } })
    ].map(adapter =>
      createQueryKit({ adapter, schema: { items }, parserOptions })
    );
  }

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each<[string, IParserOptions]>([
    ['nope:open', {}],
    ['status:open AND nope:x', {}],
    ['NOT nope:x', {}],
    ['nope:null', {}],
    ['status:open', { fieldMappings: { status: 'nope' } }]
  ])('rejects the filter %s on both adapters', async (query, parserOptions) => {
    for (const kit of kits(parserOptions)) {
      await expect(
        kit.query('items').where(query).orderBy('id', 'asc').execute()
      ).rejects.toEqual(expect.objectContaining(REJECTED));
    }
    expect(logged).toHaveLength(0);
  });

  it.each<[string, SortKeys, IParserOptions]>([
    ['nope asc', [['nope', 'asc']], {}],
    ['nope desc', [['nope', 'desc']], {}],
    [
      'status mapped to nope',
      [['status', 'asc']],
      { fieldMappings: { status: 'nope' } }
    ],
    ['nope folded', [['nope', 'asc']], { caseInsensitiveFields: true }],
    ['items.nope', [['items.nope', 'asc']], {}],
    ['other.status', [['other.status', 'asc']], {}],
    ['constructor', [['constructor', 'asc']], {}],
    [
      'nope after status',
      [
        ['status', 'asc'],
        ['nope', 'asc']
      ],
      {}
    ]
  ])(
    'rejects the sort key %s on both adapters',
    async (_name, sorts, parserOptions) => {
      for (const kit of kits(parserOptions)) {
        await expect(
          applySorts(kit.query('items').where('id:>0'), sorts).execute()
        ).rejects.toEqual(expect.objectContaining(REJECTED));
      }
      expect(logged).toHaveLength(0);
    }
  );

  it.each<[string, SortKeys, number[]]>([
    [
      'items.status then id',
      [
        ['items.status', 'asc'],
        ['id', 'asc']
      ],
      [3, 5, 1, 2, 4, 6]
    ],
    ['CreatedAt desc', [['CreatedAt', 'desc']], [3, 1, 5, 2, 6, 4]]
  ])(
    'still sorts by the known key %s on both adapters',
    async (_name, sorts, expected) => {
      for (const kit of kits()) {
        const sorted = await applySorts(
          kit.query('items').where('id:>0'),
          sorts
        ).execute();
        expect(idsOf(sorted)).toEqual(expected);
      }
      expect(logged).toHaveLength(1);
    }
  );
});
