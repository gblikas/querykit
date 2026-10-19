/**
 * A `fieldMappings` alias in `denyFields` or `allowedFields`, through
 * `createQueryKit`.
 *
 * The parser rewrites the alias `hidden` to `secret` before the validator
 * compares a field with the lists, so a list entry naming the alias used to
 * match nothing: `denyFields: ['hidden']` denied neither `hidden:a` nor
 * `secret:a`, and `allowedFields: ['status', 'hidden']` permitted nothing.
 * The kit now closes both lists under the aliases, so an alias and its
 * target are one field: a deny list in either spelling rejects both, an
 * allowlist in either spelling permits both and still rejects an unlisted
 * field, on both adapters, as written and under `caseInsensitiveFields`.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, IQueryExecutor, QueryKit } from './index';
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

/** A query as the kit runs it: a filter and, for a sort case, one key. */
interface IRun {
  name: string;
  query: string;
  sortKey?: string;
}

const REJECTED = {
  name: 'QuerySecurityError',
  message: 'Invalid query parameters'
};

/** Names only `status`, so an allowlist of `status` cannot reject it. */
const MATCH_ALL = 'NOT status:none';

const ALIAS = { hidden: 'secret' };

const SECRET_ORDER = [3, 6, 5, 1, 4, 2];

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

const runs: Array<[IRun, number[]]> = [
  [{ name: 'hidden:a', query: 'hidden:a' }, [3]],
  [{ name: 'secret:a', query: 'secret:a' }, [3]],
  [
    { name: 'orderBy hidden', query: MATCH_ALL, sortKey: 'hidden' },
    SECRET_ORDER
  ],
  [
    { name: 'orderBy secret', query: MATCH_ALL, sortKey: 'secret' },
    SECRET_ORDER
  ]
];

const denyLists: Array<[string, ISecurityOptions]> = [
  ["denyFields: ['hidden']", { denyFields: ['hidden'] }],
  ["denyFields: ['secret']", { denyFields: ['secret'] }]
];

const allowLists: Array<[string, ISecurityOptions]> = [
  [
    "allowedFields: ['status', 'hidden']",
    { allowedFields: ['status', 'hidden'] }
  ],
  [
    "allowedFields: ['status', 'secret']",
    { allowedFields: ['status', 'secret'] }
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
  parserOptions: IParserOptions,
  kitSchema: KitSchema = { items }
): Array<QueryKit<Schema>> {
  return [
    new DrizzleAdapter({ db, schema: { items } }),
    inMemoryAdapter({ records: { items: rows } })
  ].map(adapter =>
    createQueryKit({
      adapter,
      schema: kitSchema as Schema,
      parserOptions: { fieldMappings: ALIAS, ...parserOptions },
      security
    })
  );
}

function runOf(kit: QueryKit<Schema>, run: IRun): IQueryExecutor<unknown> {
  const executor = kit.query('items').where(run.query);
  return run.sortKey === undefined
    ? executor
    : executor.orderBy(run.sortKey, 'asc');
}

async function expectRejected(
  security: ISecurityOptions,
  run: IRun,
  parserOptions: IParserOptions = {},
  kitSchema?: KitSchema
): Promise<void> {
  for (const kit of kits(security, parserOptions, kitSchema)) {
    await expect(runOf(kit, run).execute()).rejects.toEqual(
      expect.objectContaining(REJECTED)
    );
  }
  expect(logged).toHaveLength(0);
}

async function expectIds(
  security: ISecurityOptions,
  run: IRun,
  expected: number[],
  parserOptions: IParserOptions = {}
): Promise<void> {
  for (const kit of kits(security, parserOptions)) {
    expect(idsOf(await runOf(kit, run).execute())).toEqual(expected);
  }
  expect(logged).toHaveLength(1);
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
])('an alias in a field list, %s', (_name, parserOptions) => {
  describe.each(denyLists)('%s', (_list, security) => {
    it.each(runs.map(([run]) => [run.name, run]))(
      'rejects %s on both kits',
      async (_runName, run) => {
        await expectRejected(security, run, parserOptions);
      }
    );
  });

  describe.each(allowLists)('%s', (_list, security) => {
    it.each(runs.map(([run, ids]) => [run.name, run, ids]))(
      'permits %s on both kits',
      async (_runName, run, ids) => {
        await expectIds(security, run, ids, parserOptions);
      }
    );

    it.each<[string, IRun]>([
      ['id:3', { name: 'id:3', query: 'id:3' }],
      ['orderBy id', { name: 'orderBy id', query: MATCH_ALL, sortKey: 'id' }]
    ])('still rejects the unlisted %s on both kits', async (_runName, run) => {
      await expectRejected(security, run, parserOptions);
    });
  });
});

describe('another spelling of the alias in a list', () => {
  it.each<[ISecurityOptions, string, KitSchema | undefined]>([
    [{ denyFields: ['HIDDEN'] }, 'hidden:a', undefined],
    [{ denyFields: ['items.hidden'] }, 'hidden:a', undefined],
    [{ denyFields: ['hidden'] }, 'secret:a', { items: {} }],
    [
      { allowedFields: ['status', 'hidden'], denyFields: ['secret'] },
      'hidden:a',
      undefined
    ],
    [
      { allowedFields: ['status', 'secret'], denyFields: ['hidden'] },
      'secret:a',
      undefined
    ]
  ])('%j rejects %s on both kits', async (security, query, kitSchema) => {
    await expectRejected(security, { name: query, query }, {}, kitSchema);
  });

  it.each<[ISecurityOptions]>([
    [{ denyFields: ['hidden'] }],
    [{ allowedFields: ['status', 'hidden'] }]
  ])('%j still runs status:open', async security => {
    await expectIds(
      security,
      { name: 'status:open', query: 'status:open' },
      [1, 2, 4]
    );
  });
});
