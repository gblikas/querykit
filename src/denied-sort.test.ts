/**
 * A sort key the allowlist or deny list blocks, through `createQueryKit`.
 *
 * The kit rejected a filter on `secret` under `allowedFields: ['status']`
 * and under `denyFields: ['secret']`, but `orderBy('secret')` ran on both
 * adapters and returned every row in the order of the blocked field, which
 * reveals that order. The kit now holds a sort key to both lists after
 * resolving it to the schema's spelling, so `secret`, `SECRET` and an alias
 * that maps to it are rejected with the filter's `QuerySecurityError` on
 * both adapters with no query run, as written and under
 * `caseInsensitiveFields`, while `orderBy('status')` under either list
 * still sorts.
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

const lists: Array<[string, ISecurityOptions]> = [
  ["allowedFields: ['status']", { allowedFields: ['status'] }],
  ["denyFields: ['secret']", { denyFields: ['secret'] }]
];

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

describe.each<[string, IParserOptions]>([
  ['as written', {}],
  ['under caseInsensitiveFields', { caseInsensitiveFields: true }]
])('a blocked sort key, %s', (_name, parserOptions) => {
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });

  function kits(
    security: ISecurityOptions,
    fieldMappings?: Record<string, string>
  ): Array<QueryKit<Schema>> {
    return [
      new DrizzleAdapter({ db, schema: { items } }),
      inMemoryAdapter({ records: { items: rows } })
    ].map(adapter =>
      createQueryKit({
        adapter,
        schema: { items },
        parserOptions: { ...parserOptions, fieldMappings },
        security
      })
    );
  }

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each(lists)(
    'rejects the filter secret:a under %s',
    async (_list, security) => {
      for (const kit of kits(security)) {
        await expect(
          kit.query('items').where('secret:a').execute()
        ).rejects.toEqual(expect.objectContaining(REJECTED));
      }
      expect(logged).toHaveLength(0);
    }
  );

  describe.each(lists)('under %s', (_list, security) => {
    it.each<[string, Record<string, string> | undefined]>([
      ['secret', undefined],
      ['SECRET', undefined],
      ['hidden', { hidden: 'secret' }]
    ])(
      'rejects orderBy %s before either adapter runs',
      async (key, fieldMappings) => {
        for (const kit of kits(security, fieldMappings)) {
          await expect(
            kit.query('items').where(MATCH_ALL).orderBy(key, 'asc').execute()
          ).rejects.toEqual(expect.objectContaining(REJECTED));
        }
        expect(logged).toHaveLength(0);
      }
    );

    it('still sorts by status', async () => {
      for (const kit of kits(security)) {
        const sorted = await kit
          .query('items')
          .where(MATCH_ALL)
          .orderBy('status', 'asc')
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
});
