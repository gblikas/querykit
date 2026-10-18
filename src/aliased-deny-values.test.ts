/**
 * `denyValues` keyed by a `fieldMappings` alias or by another spelling,
 * through `createQueryKit`.
 *
 * The parser rewrites the alias `hidden` to `secret`, and the validator used
 * to read `denyValues` by that mapped field as an exact key, so a key that
 * was the alias, another ASCII case or a qualified name of the field denied
 * nothing. `denyValues` now fails closed the way `denyFields` does: a value
 * listed under any spelling, alias or alias target of a field is denied for
 * every spelling of that field, on both adapters, as written and under
 * `caseInsensitiveFields`, while an unlisted value still runs. An
 * `enforceExcludedValues` key that names the alias is injected under the
 * alias's target, so both adapters drop the same rows instead of one
 * failing on an unknown column and the other dropping every row.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, QueryKit } from './index';
import { IParserOptions } from './parser/types';
import { DeniedValue, ISecurityOptions } from './security';

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

type ValueMap = Record<string, DeniedValue[]>;

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

const keys: Array<[string, ValueMap]> = [
  ['hidden', { hidden: ['a'] }],
  ['secret', { secret: ['a'] }],
  ['SECRET', { SECRET: ['a'] }],
  ['items.secret', { 'items.secret': ['a'] }]
];

const deniedFilters = [
  'hidden:a',
  'secret:a',
  'items.secret:a',
  'SECRET:a',
  'hidden:in [a, b]',
  'NOT hidden:a'
];

const excludedRuns: Array<[string, number[]]> = [
  ['hidden:a', []],
  ['secret:a', []],
  ['items.secret:a', []],
  ['hidden:in [a, b]', [6]],
  ['NOT hidden:a', [1, 2, 4, 5, 6]],
  ['NOT status:none', [1, 2, 4, 5, 6]]
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

async function expectRejected(
  security: ISecurityOptions,
  query: string,
  parserOptions: IParserOptions = {},
  kitSchema?: KitSchema
): Promise<void> {
  for (const kit of kits(security, parserOptions, kitSchema)) {
    await expect(
      kit.query('items').where(query).orderBy('id', 'asc').execute()
    ).rejects.toEqual(expect.objectContaining(REJECTED));
  }
  expect(logged).toHaveLength(0);
}

async function expectIds(
  security: ISecurityOptions,
  query: string,
  expected: number[],
  parserOptions: IParserOptions = {}
): Promise<void> {
  for (const kit of kits(security, parserOptions)) {
    const matched = await kit
      .query('items')
      .where(query)
      .orderBy('id', 'asc')
      .execute();
    expect(idsOf(matched)).toEqual(expected);
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
])(
  'a value listed under another spelling of its field, %s',
  (_name, parserOptions) => {
    describe.each(keys)('denyValues keyed %s', (_key, denyValues) => {
      it.each(deniedFilters)('rejects %s on both kits', async query => {
        await expectRejected({ denyValues }, query, parserOptions);
      });

      it('still runs hidden:c', async () => {
        await expectIds({ denyValues }, 'hidden:c', [5], parserOptions);
      });
    });

    describe.each(keys)(
      'enforceExcludedValues keyed %s',
      (_key, enforceExcludedValues) => {
        it.each(excludedRuns)(
          'drops row 3 for %s on both kits',
          async (query, expected) => {
            await expectIds(
              { enforceExcludedValues },
              query,
              expected,
              parserOptions
            );
          }
        );
      }
    );
  }
);

describe('the alias in another spelling', () => {
  it.each<[ValueMap, string, KitSchema | undefined]>([
    [{ HIDDEN: ['a'] }, 'hidden:a', undefined],
    [{ HIDDEN: ['a'] }, 'secret:a', undefined],
    [{ 'items.hidden': ['a'] }, 'hidden:a', undefined],
    [{ 'items.hidden': ['a'] }, 'secret:a', undefined],
    [{ hidden: ['a'] }, 'secret:a', { items: {} }]
  ])(
    'denyValues %j rejects %s on both kits',
    async (denyValues, query, kitSchema) => {
      await expectRejected({ denyValues }, query, {}, kitSchema);
    }
  );

  it.each<[ValueMap]>([[{ HIDDEN: ['a'] }], [{ 'items.hidden': ['a'] }]])(
    'enforceExcludedValues %j drops row 3 on both kits',
    async enforceExcludedValues => {
      await expectIds(
        { enforceExcludedValues },
        'NOT status:none',
        [1, 2, 4, 5, 6]
      );
    }
  );
});
