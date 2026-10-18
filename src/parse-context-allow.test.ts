/**
 * The `field_not_allowed` pre-check of `parseWithContext` against the kit's
 * allowlist.
 *
 * `createQueryKit` closes `allowedFields` under the parser's `fieldMappings`,
 * so an entry naming the alias `hidden` also permits `secret`, the only
 * spelling the parser emits, and under `caseInsensitiveFields` it respells
 * the list and the field by the schema. The pre-check used to compare the
 * list as written and reported `field_not_allowed` for `hidden:a` and
 * `secret:a` that the kit ran. It now resolves both lists once with the
 * validator's own closure and folds `A-Z` on both sides under
 * `caseInsensitiveFields`, so every query the kit runs is reported clean and
 * every query it rejects as not allowed is reported `field_not_allowed`.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, QueryKit } from './index';
import { QueryParser } from './parser';
import { IParserOptions, ISecurityCheckResult } from './parser/types';
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

/** One case: the lists, the alias target, the query, and what each parser reports. */
interface ICase {
  security: ISecurityOptions;
  target?: string;
  query: string;
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

const CLEAN: ISecurityCheckResult = {
  passed: true,
  violations: [],
  warnings: []
};

const STATUS_HIDDEN = { allowedFields: ['status', 'hidden'] };
const STATUS_SECRET = { allowedFields: ['status', 'secret'] };

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

const permitted: Array<[ICase, number[]]> = [
  [{ security: STATUS_HIDDEN, query: 'hidden:a' }, [3]],
  [{ security: STATUS_HIDDEN, query: 'secret:a' }, [3]],
  [{ security: STATUS_HIDDEN, query: 'status:open' }, [1, 2, 4]],
  [{ security: STATUS_SECRET, query: 'hidden:a' }, [3]],
  [{ security: STATUS_SECRET, query: 'secret:a' }, [3]],
  [{ security: STATUS_SECRET, query: 'status:open' }, [1, 2, 4]],
  [{ security: STATUS_HIDDEN, query: '"hidden":a' }, [3]],
  [{ security: STATUS_HIDDEN, query: 'status:closed AND hidden:a' }, [3]],
  [{ security: STATUS_HIDDEN, target: 'SECRET', query: 'hidden:a' }, [3]]
];

/** Rejected under both parsers; the field as written and folded. */
const rejected: Array<[ICase, string, string]> = [
  [
    { security: STATUS_HIDDEN, query: 'items.status:open' },
    'items.status',
    'items.status'
  ],
  [
    { security: STATUS_SECRET, query: 'items.status:open' },
    'items.status',
    'items.status'
  ],
  [
    { security: STATUS_HIDDEN, query: 'Items.status:open' },
    'Items.status',
    'items.status'
  ],
  [{ security: STATUS_HIDDEN, query: 'id:3' }, 'id', 'id'],
  [
    { security: STATUS_HIDDEN, query: 'items.hidden:a' },
    'items.hidden',
    'items.hidden'
  ],
  [
    { security: STATUS_HIDDEN, query: 'items.secret:a' },
    'items.secret',
    'items.secret'
  ]
];

/** Rejected as written, with the field named; permitted under the option. */
const caseDependent: Array<[ICase, string, number[]]> = [
  [{ security: STATUS_HIDDEN, query: 'STATUS:open' }, 'STATUS', [1, 2, 4]],
  [{ security: STATUS_SECRET, query: 'STATUS:open' }, 'STATUS', [1, 2, 4]],
  [{ security: STATUS_HIDDEN, query: 'Hidden:a' }, 'Hidden', [3]],
  [
    { security: { allowedFields: ['STATUS', 'hidden'] }, query: 'status:open' },
    'status',
    [1, 2, 4]
  ],
  [
    { security: { allowedFields: ['status', 'HIDDEN'] }, query: 'hidden:a' },
    'secret',
    [3]
  ],
  [
    { security: { allowedFields: ['status', 'HIDDEN'] }, query: 'secret:a' },
    'secret',
    [3]
  ],
  [
    { security: STATUS_HIDDEN, target: 'SECRET', query: 'secret:a' },
    'secret',
    [3]
  ],
  [
    { security: STATUS_SECRET, target: 'SECRET', query: 'hidden:a' },
    'SECRET',
    [3]
  ]
];

const denyAndAllow: ICase[] = [
  { security: { ...STATUS_HIDDEN, denyFields: ['secret'] }, query: 'hidden:a' },
  { security: { ...STATUS_HIDDEN, denyFields: ['hidden'] }, query: 'secret:a' }
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
  parserOptions: IParserOptions
): Array<QueryKit<Schema>> {
  return [
    new DrizzleAdapter({ db, schema: { items } }),
    inMemoryAdapter({ records: { items: rows } })
  ].map(adapter =>
    createQueryKit({ adapter, schema: { items }, parserOptions, security })
  );
}

/** Run one case through both kits and the pre-check with the same options. */
async function outcomeOf(
  testCase: ICase,
  parserOptions: IParserOptions
): Promise<IOutcome> {
  const options: IParserOptions = {
    ...parserOptions,
    fieldMappings: { hidden: testCase.target ?? 'secret' }
  };
  const settled: unknown[] = [];
  for (const kit of kits(testCase.security, options)) {
    settled.push(
      await kit
        .query('items')
        .where(testCase.query)
        .execute()
        .then(idsOf, (error: unknown) => error)
    );
  }
  const security = new QueryParser(options).parseWithContext(testCase.query, {
    securityOptions: {
      allowedFields: testCase.security.allowedFields,
      denyFields: testCase.security.denyFields
    }
  }).security;
  return {
    drizzleKit: settled[0],
    memoryKit: settled[1],
    queries: logged.length,
    security
  };
}

function rejectedOutcome(
  type: 'field_not_allowed' | 'denied_field',
  field: string
): IOutcome {
  const message =
    type === 'field_not_allowed'
      ? `Field "${field}" is not in the list of allowed fields`
      : `Field "${field}" is not allowed in queries`;
  return {
    drizzleKit: expect.objectContaining(REJECTED),
    memoryKit: expect.objectContaining(REJECTED),
    queries: 0,
    security: {
      passed: false,
      violations: [{ type, message, field }],
      warnings: []
    }
  };
}

function permittedOutcome(ids: number[]): IOutcome {
  return { drizzleKit: ids, memoryKit: ids, queries: 1, security: CLEAN };
}

beforeEach((): void => {
  logged.length = 0;
});

afterAll((): void => {
  database.close();
});

describe.each<[string, IParserOptions, boolean]>([
  ['as written', {}, false],
  ['under caseInsensitiveFields', { caseInsensitiveFields: true }, true]
])('the allowlist pre-check, %s', (_name, parserOptions, foldsCase) => {
  it.each(permitted.map(([testCase, ids]) => [testCase.query, testCase, ids]))(
    'reports %s clean as the kit runs it',
    async (_query, testCase, ids) => {
      expect(await outcomeOf(testCase, parserOptions)).toEqual(
        permittedOutcome(ids)
      );
    }
  );

  it.each(
    rejected.map(([testCase, asWritten, folded]) => [
      testCase.query,
      testCase,
      foldsCase ? folded : asWritten
    ])
  )(
    'reports %s not allowed as the kit rejects it',
    async (_query, testCase, field) => {
      expect(await outcomeOf(testCase, parserOptions)).toEqual(
        rejectedOutcome('field_not_allowed', field)
      );
    }
  );

  it.each(
    caseDependent.map(([testCase, field, ids]) => [
      testCase.query,
      testCase,
      field,
      ids
    ])
  )(
    'decides %s by case the way the kit does',
    async (_query, testCase, field, ids) => {
      expect(await outcomeOf(testCase, parserOptions)).toEqual(
        foldsCase
          ? permittedOutcome(ids)
          : rejectedOutcome('field_not_allowed', field)
      );
    }
  );

  it.each(denyAndAllow.map(testCase => [testCase.query, testCase]))(
    'reports %s denied once when the deny list wins',
    async (_query, testCase) => {
      expect(await outcomeOf(testCase, parserOptions)).toEqual(
        rejectedOutcome('denied_field', 'secret')
      );
    }
  );
});

describe('an incomplete term the parser rejects', () => {
  const parser = new QueryParser({ fieldMappings: { hidden: 'secret' } });

  it('passes the allowed alias', () => {
    const result = parser.parseWithContext('hidden:', {
      securityOptions: STATUS_HIDDEN
    });
    expect(result.success).toBe(false);
    expect(result.security).toEqual(CLEAN);
  });

  it('names an unlisted field', () => {
    const result = parser.parseWithContext('id:', {
      securityOptions: STATUS_HIDDEN
    });
    expect(result.success).toBe(false);
    expect(result.security).toEqual({
      passed: false,
      violations: [
        {
          type: 'field_not_allowed',
          message: 'Field "id" is not in the list of allowed fields',
          field: 'id'
        }
      ],
      warnings: []
    });
  });
});
