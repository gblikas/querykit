/**
 * A denied field reached through another spelling, through `createQueryKit`.
 *
 * Both adapters resolve a field to a column ignoring ASCII case and a single
 * `table.` qualifier, so `items.secret`, `Items.secret`, `SECRET` and the
 * quoted `"items.secret"` all reach `secret_col`. The deny list matches the
 * same way, on the field and on each entry, for a filter and for a sort
 * key, so every spelling of a denied field is rejected with
 * `QuerySecurityError` on both kits before either adapter runs, a list
 * spelled `SECRET` or `items.secret` denies `secret`, and the schema the kit
 * is given does not matter. The allowlist keeps matching as written.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, QueryKit } from './index';
import { IParserOptions } from './parser/types';
import { ISecurityOptions } from './security';

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
  secret: string;
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status_col'),
  createdAt: text('created_at'),
  isDone: integer('is_done', { mode: 'boolean' }),
  secret: text('secret_col')
});

type Schema = { items: typeof items };

type KitSchema = Record<'items', object>;

const REJECTED = {
  name: 'QuerySecurityError',
  message: 'Invalid query parameters'
};

/** Names only `status`, so `allowedFields: ['status']` cannot reject it. */
const MATCH_ALL = 'NOT status:none';

const rows: IItem[] = [
  {
    id: 1,
    status: 'open',
    createdAt: '2024-03-01',
    isDone: false,
    secret: 'd'
  },
  { id: 2, status: 'open', createdAt: '2023-12-31', isDone: true, secret: 'f' },
  {
    id: 3,
    status: 'closed',
    createdAt: '2024-06-15',
    isDone: true,
    secret: 'a'
  },
  { id: 4, status: 'open', createdAt: null, isDone: false, secret: 'e' },
  {
    id: 5,
    status: 'closed',
    createdAt: '2024-01-01',
    isDone: true,
    secret: 'c'
  },
  {
    id: 6,
    status: 'pending',
    createdAt: '2022-05-05',
    isDone: false,
    secret: 'b'
  }
];

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

/** Statuses of rows the kit returned, in result order. */
function statusesOf(rows: unknown[]): string[] {
  return (rows as Array<{ status: string }>).map(row => row.status);
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status_col TEXT, created_at TEXT, is_done INTEGER, secret_col TEXT);
    INSERT INTO items VALUES
      (1, 'open', '2024-03-01', 0, 'd'), (2, 'open', '2023-12-31', 1, 'f'),
      (3, 'closed', '2024-06-15', 1, 'a'), (4, 'open', NULL, 0, 'e'),
      (5, 'closed', '2024-01-01', 1, 'c'), (6, 'pending', '2022-05-05', 0, 'b');
  `);
  return database;
}

const database = openDatabase();
const logged: string[] = [];
const db = drizzle(database as never, {
  logger: { logQuery: (query: string): number => logged.push(query) }
});

function kits(
  security: ISecurityOptions,
  parserOptions: IParserOptions = {},
  kitSchema: KitSchema = { items }
): Array<QueryKit<Schema>> {
  return [
    new DrizzleAdapter({ db, schema: { items } }),
    inMemoryAdapter({ records: { items: rows } })
  ].map(adapter =>
    createQueryKit({
      adapter,
      schema: kitSchema as Schema,
      parserOptions,
      security
    })
  );
}

async function expectRejected(
  security: ISecurityOptions,
  query: string,
  sortKey?: string,
  parserOptions: IParserOptions = {},
  kitSchema: KitSchema = { items }
): Promise<void> {
  for (const kit of kits(security, parserOptions, kitSchema)) {
    const executor = kit.query('items').where(query);
    await expect(
      (sortKey === undefined ? executor : executor.orderBy(sortKey)).execute()
    ).rejects.toEqual(expect.objectContaining(REJECTED));
  }
  expect(logged).toHaveLength(0);
}

beforeEach((): void => {
  logged.length = 0;
});

afterAll((): void => {
  database.close();
});

describe.each<[string, IParserOptions]>([
  ['as written', {}],
  ['under caseInsensitiveFields', { caseInsensitiveFields: true }]
])('another spelling of a denied field, %s', (_name, parserOptions) => {
  const denySecret = { denyFields: ['secret'] };

  it.each(['items.secret:a', 'Items.secret:a', 'SECRET:a', '"items.secret":a'])(
    'rejects the filter %s on both kits',
    async query => {
      await expectRejected(denySecret, query, undefined, parserOptions);
    }
  );

  it.each(['items.secret', 'Items.secret', 'SECRET'])(
    'rejects orderBy %s on both kits',
    async key => {
      await expectRejected(denySecret, MATCH_ALL, key, parserOptions);
    }
  );

  it('still runs status:open', async () => {
    for (const kit of kits(denySecret, parserOptions)) {
      const matched = await kit
        .query('items')
        .where('status:open')
        .orderBy('id')
        .execute();
      expect(idsOf(matched)).toEqual([1, 2, 4]);
    }
    expect(logged).toHaveLength(1);
  });

  it('still sorts by status', async () => {
    for (const kit of kits(denySecret, parserOptions)) {
      const sorted = await kit
        .query('items')
        .where(MATCH_ALL)
        .orderBy('status')
        .execute();
      expect(statusesOf(sorted)).toEqual([
        'closed',
        'closed',
        'open',
        'open',
        'open',
        'pending'
      ]);
    }
    expect(logged).toHaveLength(1);
  });
});

describe('another spelling of the list entry', () => {
  it.each<[ISecurityOptions, string, string | undefined]>([
    [{ denyFields: ['SECRET'] }, 'secret:a', undefined],
    [{ denyFields: ['SECRET'] }, MATCH_ALL, 'secret'],
    [{ denyFields: ['items.secret'] }, 'secret:a', undefined],
    [{ denyFields: ['items.secret'] }, MATCH_ALL, 'secret'],
    [
      { allowedFields: ['SECRET', 'status'], denyFields: ['secret'] },
      'SECRET:a',
      undefined
    ],
    [
      { allowedFields: ['items.secret', 'status'], denyFields: ['secret'] },
      'items.secret:a',
      undefined
    ]
  ])(
    '%j rejects %s sorted by %s on both kits',
    async (security, query, sortKey) => {
      await expectRejected(security, query, sortKey);
    }
  );

  it.each<[string, string | undefined]>([
    ['SECRET:a', undefined],
    ['items.secret:a', undefined],
    [MATCH_ALL, 'SECRET']
  ])(
    'rejects %s sorted by %s with a kit schema that declares no property',
    async (query, sortKey) => {
      await expectRejected(
        { denyFields: ['secret'] },
        query,
        sortKey,
        {},
        {
          items: {}
        }
      );
    }
  );

  it.each(['items.status:open', 'STATUS:open'])(
    "still rejects %s under allowedFields: ['status'], which matches as written",
    async query => {
      await expectRejected({ allowedFields: ['status'] }, query);
    }
  );
});
