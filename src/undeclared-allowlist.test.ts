/**
 * A listed filter field the selected table does not declare.
 *
 * A non-empty `allowedFields` used to replace the kit's schema check, so a
 * listed but undeclared `nope` reached the adapters, where Drizzle failed
 * with `no such column` while the in-memory adapter returned no rows, or
 * every row for `nope:null`. The list now narrows the schema instead: a
 * listed field must name a declared property of the selected table,
 * exactly or as the one name that differs only by ASCII case, bare or as
 * `table.property`, or be a dotted path whose first segment is a declared
 * property, the form the README gives a JSON path such as `metadata.tags`.
 * Anything else is rejected with `QuerySecurityError` on both adapters
 * before either runs. A listed path into a declared column is forwarded,
 * and neither built-in adapter evaluates it as a path: both read
 * `metadata.tags` as `table.column` and reject it, while a name with two
 * dots is one identifier that names no property of `items`, which both
 * adapters reject with their own error.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { IAdapter, IQueryExecutionOptions } from './adapters';
import { inMemoryAdapter } from './adapters/memory';
import { InMemoryAdapterError } from './adapters/memory/in-memory-adapter-error';
import { createQueryKit, QueryKit } from './index';
import { IParserOptions, QueryExpression } from './parser/types';

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
  metadata: string | null;
}

/** One case: the allowlist, the query, an optional sort key and parser options. */
interface ICase {
  allowedFields: string[];
  query: string;
  sortKey?: string;
  parserOptions?: IParserOptions;
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status_col'),
  createdAt: text('created_at'),
  isDone: integer('is_done', { mode: 'boolean' }),
  metadata: text('metadata')
});

type Schema = { items: typeof items };

const REJECTED = {
  name: 'QuerySecurityError',
  message: 'Invalid query parameters'
};

const rows: IItem[] = [
  {
    id: 1,
    status: 'open',
    createdAt: '2024-03-01',
    isDone: false,
    metadata: '{"tags":["x"]}'
  },
  {
    id: 2,
    status: 'open',
    createdAt: '2023-12-31',
    isDone: true,
    metadata: '{"tags":["y"]}'
  },
  {
    id: 3,
    status: 'closed',
    createdAt: '2024-06-15',
    isDone: true,
    metadata: '{"tags":["x","y"]}'
  },
  { id: 4, status: 'open', createdAt: null, isDone: false, metadata: null },
  {
    id: 5,
    status: 'closed',
    createdAt: '2024-01-01',
    isDone: true,
    metadata: '{"tags":[]}'
  },
  {
    id: 6,
    status: 'pending',
    createdAt: '2022-05-05',
    isDone: false,
    metadata: '{}'
  }
];

const rejected: Array<[string, ICase]> = [
  ['nope:1', { allowedFields: ['status', 'nope'], query: 'nope:1' }],
  ['nope:null', { allowedFields: ['status', 'nope'], query: 'nope:null' }],
  [
    'status:open AND nope:1',
    { allowedFields: ['status', 'nope'], query: 'status:open AND nope:1' }
  ],
  [
    'a sort by nope',
    { allowedFields: ['status', 'nope'], query: 'status:open', sortKey: 'nope' }
  ],
  [
    'nope:1 folded',
    {
      allowedFields: ['status', 'nope'],
      query: 'nope:1',
      parserOptions: { caseInsensitiveFields: true }
    }
  ],
  [
    'status:1 through an alias to nope',
    {
      allowedFields: ['status', 'nope'],
      query: 'status:1',
      parserOptions: { fieldMappings: { status: 'nope' } }
    }
  ],
  [
    'metadata:null with only the path listed',
    { allowedFields: ['status', 'metadata.tags'], query: 'metadata:null' }
  ],
  [
    'nope.tags:x',
    { allowedFields: ['status', 'nope.tags'], query: 'nope.tags:x' }
  ],
  [
    'items.nope:1',
    { allowedFields: ['status', 'items.nope'], query: 'items.nope:1' }
  ],
  [
    'Metadata.tags:x',
    { allowedFields: ['status', 'Metadata.tags'], query: 'Metadata.tags:x' }
  ]
];

const resolved: Array<[string, ICase, string, number[]]> = [
  [
    'status:open',
    { allowedFields: ['status'], query: 'status:open' },
    'where "items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'items.status:open',
    { allowedFields: ['status', 'items.status'], query: 'items.status:open' },
    'where "items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'STATUS:open',
    { allowedFields: ['STATUS'], query: 'STATUS:open' },
    'where "items"."status_col" = ?',
    [1, 2, 4]
  ],
  [
    'metadata:null with metadata listed',
    { allowedFields: ['status', 'metadata'], query: 'metadata:null' },
    'where "items"."metadata" IS NULL',
    [4]
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
    CREATE TABLE items (id INTEGER PRIMARY KEY, status_col TEXT, created_at TEXT, is_done INTEGER, metadata TEXT);
    INSERT INTO items VALUES
      (1, 'open', '2024-03-01', 0, '{"tags":["x"]}'), (2, 'open', '2023-12-31', 1, '{"tags":["y"]}'),
      (3, 'closed', '2024-06-15', 1, '{"tags":["x","y"]}'), (4, 'open', NULL, 0, NULL),
      (5, 'closed', '2024-01-01', 1, '{"tags":[]}'), (6, 'pending', '2022-05-05', 0, '{}');
  `);
  return database;
}

/**
 * Count the calls the kit makes to an adapter: SQLite rejects an unknown
 * column at prepare time, before Drizzle's logger sees the query.
 */
function countingAdapter(adapter: IAdapter, calls: number[]): IAdapter {
  return {
    initialize: (options): void => adapter.initialize(options),
    canExecute: (expression: QueryExpression): boolean =>
      adapter.canExecute(expression),
    execute: <T>(
      tableName: string,
      expression: QueryExpression,
      options?: IQueryExecutionOptions
    ): Promise<T[]> => {
      calls.push(1);
      return adapter.execute<T>(tableName, expression, options);
    }
  };
}

describe('a listed field the table does not declare', () => {
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const drizzleCalls: number[] = [];
  const memoryCalls: number[] = [];
  const drizzleAdapter = countingAdapter(
    new DrizzleAdapter({ db, schema: { items } }),
    drizzleCalls
  );
  const memoryAdapter = countingAdapter(
    inMemoryAdapter({ records: { items: rows } }),
    memoryCalls
  );

  function kits(testCase: ICase): Array<QueryKit<Schema>> {
    return [drizzleAdapter, memoryAdapter].map(adapter =>
      createQueryKit({
        adapter,
        schema: { items },
        security: { allowedFields: testCase.allowedFields },
        parserOptions: testCase.parserOptions
      })
    );
  }

  async function runOf(
    kit: QueryKit<Schema>,
    testCase: ICase
  ): Promise<unknown> {
    const executor = kit.query('items').where(testCase.query);
    return (
      testCase.sortKey === undefined
        ? executor
        : executor.orderBy(testCase.sortKey)
    )
      .execute()
      .then(idsOf, (error: unknown) => error);
  }

  beforeEach((): void => {
    logged.length = 0;
    drizzleCalls.length = 0;
    memoryCalls.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it.each(rejected)(
    'rejects %s on both adapters before either runs',
    async (_name, testCase) => {
      for (const kit of kits(testCase)) {
        expect(await runOf(kit, testCase)).toEqual(
          expect.objectContaining(REJECTED)
        );
      }
      expect(drizzleCalls).toHaveLength(0);
      expect(memoryCalls).toHaveLength(0);
    }
  );

  it.each(resolved)(
    'resolves %s on both adapters',
    async (_name, testCase, expectedSql, expectedIds) => {
      for (const kit of kits(testCase)) {
        expect(await runOf(kit, testCase)).toEqual(expectedIds);
      }
      expect(drizzleCalls).toHaveLength(1);
      expect(memoryCalls).toHaveLength(1);
      expect(logged[0]).toContain(expectedSql);
    }
  );

  it('forwards the listed path metadata.tags, which both adapters read as table.column and reject', async () => {
    const testCase = {
      allowedFields: ['status', 'metadata.tags'],
      query: 'metadata.tags:x'
    };
    const [drizzleKit, memoryKit] = kits(testCase);
    expect(await runOf(drizzleKit, testCase)).toEqual(
      expect.objectContaining({
        name: 'DrizzleAdapterError',
        message: expect.stringContaining('no such column')
      })
    );
    const inMemory = await runOf(memoryKit, testCase);
    expect(inMemory).toBeInstanceOf(InMemoryAdapterError);
    expect((inMemory as Error).message).toBe(
      'Field metadata.tags does not name the selected table items'
    );
    expect(drizzleCalls).toHaveLength(1);
    expect(memoryCalls).toHaveLength(1);
  });

  it('forwards the listed path metadata.dimensions.width, one identifier both adapters reject as no property of items', async () => {
    const testCase = {
      allowedFields: ['status', 'metadata.dimensions.width'],
      query: 'metadata.dimensions.width:1'
    };
    const unknown =
      'Field metadata.dimensions.width does not name a property of table items';
    const [drizzleKit, memoryKit] = kits(testCase);
    expect(await runOf(drizzleKit, testCase)).toEqual(
      expect.objectContaining({
        name: 'DrizzleAdapterError',
        message: expect.stringContaining(unknown)
      })
    );
    const inMemory = await runOf(memoryKit, testCase);
    expect(inMemory).toBeInstanceOf(InMemoryAdapterError);
    expect((inMemory as Error).message).toBe(unknown);
    expect(logged).toHaveLength(0);
    expect(drizzleCalls).toHaveLength(1);
    expect(memoryCalls).toHaveLength(1);
  });
});
