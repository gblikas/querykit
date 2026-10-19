/**
 * The `denied_field` pre-check of `parseWithContext` against the kit's deny
 * list.
 *
 * `createQueryKit` rejects a denied field by any ASCII case, a single
 * `table.` qualifier, a quoted literal spelling, or a `fieldMappings` alias
 * of the field or of the list entry. The pre-check used to compare the
 * resolved field with each entry as exact strings and told a search box
 * that `SECRET:a` and `items.secret:a` passed. It now closes the list under
 * the parser's `fieldMappings` and matches each field with the validator's
 * own matcher, so every query the kit rejects as denied is reported
 * `denied_field`, as written and under `caseInsensitiveFields`, including
 * an incomplete term the parser cannot parse.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, QueryKit } from './index';
import { QueryParser } from './parser';
import { IParserOptions, ISecurityCheckResult } from './parser/types';

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

/** One denied case: the list, the alias if any, the query, and the field the pre-check names per parser. */
interface IDeniedCase {
  denyFields: string[];
  fieldMappings?: Record<string, string>;
  query: string;
  asWritten: string;
  folded: string;
}

/** What one run of a query produced on the kits and in the pre-check. */
interface IOutcome {
  drizzleKit: unknown;
  memoryKit: unknown;
  queries: number;
  security: ISecurityCheckResult | undefined;
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

const ALIAS = { hidden: 'secret' };

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

const deniedCases: IDeniedCase[] = [
  {
    denyFields: ['secret'],
    query: 'secret:a',
    asWritten: 'secret',
    folded: 'secret'
  },
  {
    denyFields: ['secret'],
    query: 'SECRET:a',
    asWritten: 'SECRET',
    folded: 'secret'
  },
  {
    denyFields: ['secret'],
    query: 'items.secret:a',
    asWritten: 'items.secret',
    folded: 'items.secret'
  },
  {
    denyFields: ['secret'],
    query: 'Items.secret:a',
    asWritten: 'Items.secret',
    folded: 'items.secret'
  },
  {
    denyFields: ['secret'],
    query: '"items.secret":a',
    asWritten: 'items.secret',
    folded: 'items.secret'
  },
  {
    denyFields: ['secret'],
    fieldMappings: ALIAS,
    query: 'hidden:a',
    asWritten: 'secret',
    folded: 'secret'
  },
  {
    denyFields: ['hidden'],
    fieldMappings: ALIAS,
    query: 'hidden:a',
    asWritten: 'secret',
    folded: 'secret'
  },
  {
    denyFields: ['hidden'],
    fieldMappings: ALIAS,
    query: 'secret:a',
    asWritten: 'secret',
    folded: 'secret'
  },
  {
    denyFields: ['hidden'],
    fieldMappings: ALIAS,
    query: 'Hidden:a',
    asWritten: 'Hidden',
    folded: 'secret'
  },
  {
    denyFields: ['SECRET'],
    query: 'secret:a',
    asWritten: 'secret',
    folded: 'secret'
  },
  {
    denyFields: ['items.secret'],
    query: 'secret:a',
    asWritten: 'secret',
    folded: 'secret'
  },
  {
    denyFields: ['HIDDEN'],
    fieldMappings: ALIAS,
    query: 'secret:a',
    asWritten: 'secret',
    folded: 'secret'
  },
  {
    denyFields: ['items.hidden'],
    fieldMappings: ALIAS,
    query: 'hidden:a',
    asWritten: 'secret',
    folded: 'secret'
  }
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
  denyFields: string[],
  parserOptions: IParserOptions
): Array<QueryKit<Schema>> {
  return [
    new DrizzleAdapter({ db, schema: { items } }),
    inMemoryAdapter({ records: { items: rows } })
  ].map(adapter =>
    createQueryKit({
      adapter,
      schema: { items },
      parserOptions,
      security: { denyFields }
    })
  );
}

/** Run one query through both kits and the pre-check with the same options. */
async function outcomeOf(
  denyFields: string[],
  parserOptions: IParserOptions,
  query: string
): Promise<IOutcome> {
  const settled: unknown[] = [];
  for (const kit of kits(denyFields, parserOptions)) {
    settled.push(
      await kit
        .query('items')
        .where(query)
        .orderBy('id', 'asc')
        .execute()
        .then(idsOf, (error: unknown) => error)
    );
  }
  const security = new QueryParser(parserOptions).parseWithContext(query, {
    securityOptions: { denyFields }
  }).security;
  return {
    drizzleKit: settled[0],
    memoryKit: settled[1],
    queries: logged.length,
    security
  };
}

beforeEach((): void => {
  logged.length = 0;
});

afterAll((): void => {
  database.close();
});

describe.each<[string, IParserOptions, keyof IDeniedCase]>([
  ['as written', {}, 'asWritten'],
  ['under caseInsensitiveFields', { caseInsensitiveFields: true }, 'folded']
])('the deny pre-check, %s', (_name, parserOptions, spelling) => {
  it.each(deniedCases.map(denied => [denied.query, denied.denyFields, denied]))(
    'reports %s denied under %j as the kit rejects it',
    async (_query, _list, denied) => {
      const field = denied[spelling] as string;
      const outcome = await outcomeOf(
        denied.denyFields,
        { ...parserOptions, fieldMappings: denied.fieldMappings },
        denied.query
      );
      expect(outcome).toEqual({
        drizzleKit: expect.objectContaining(REJECTED),
        memoryKit: expect.objectContaining(REJECTED),
        queries: 0,
        security: {
          passed: false,
          violations: [
            {
              type: 'denied_field',
              message: `Field "${field}" is not allowed in queries`,
              field
            }
          ],
          warnings: []
        }
      });
    }
  );

  it.each<[string[], Record<string, string> | undefined]>([
    [['secret'], undefined],
    [['hidden'], ALIAS]
  ])(
    'reports status:open clean under %j as the kit runs it',
    async (denyFields, fieldMappings) => {
      const outcome = await outcomeOf(
        denyFields,
        { ...parserOptions, fieldMappings },
        'status:open'
      );
      expect(outcome).toEqual({
        drizzleKit: [1, 2, 4],
        memoryKit: [1, 2, 4],
        queries: 1,
        security: { passed: true, violations: [], warnings: [] }
      });
    }
  );
});

it('reports a denied field in an incomplete term the parser rejects', () => {
  const result = new QueryParser().parseWithContext('items.secret:', {
    securityOptions: { denyFields: ['secret'] }
  });
  expect(result.success).toBe(false);
  expect(result.security).toEqual({
    passed: false,
    violations: [
      {
        type: 'denied_field',
        message: 'Field "items.secret" is not allowed in queries',
        field: 'items.secret'
      }
    ],
    warnings: []
  });
});
