/**
 * A virtual field as a sort key, through `createQueryKit`.
 *
 * A virtual field resolves to a predicate, not a column, so `orderBy('my')`
 * cannot be expressed on any engine: SQLite rejects the unknown column
 * while the in-memory adapter used to tie every row and return the incoming
 * order. The kit now rejects a virtual sort key with `QueryParseError`
 * before `createContext` or either adapter runs, including a name that
 * reaches the virtual field through `fieldMappings` or
 * `caseInsensitiveFields`. Filters on the virtual field and a sort on the
 * resolved column still agree on both adapters.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { inMemoryAdapter } from '../adapters/memory';
import { createQueryKit, QueryKit } from '../index';
import { ComparisonOperator, IParserOptions } from '../parser/types';
import { QueryParseError } from '../parser/parser';
import { VirtualFieldsConfig } from './types';

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
  assignee_id: number | null;
  creator_id: number | null;
}

interface IContext {
  currentUserId: number;
  [key: string]: unknown;
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  assignee_id: integer('assignee_id'),
  creator_id: integer('creator_id')
});

type Schema = { items: typeof items };

const rows: IItem[] = [
  { id: 1, assignee_id: 7, creator_id: 9 },
  { id: 2, assignee_id: 9, creator_id: 7 },
  { id: 3, assignee_id: null, creator_id: 7 },
  { id: 4, assignee_id: 7, creator_id: null },
  { id: 5, assignee_id: 12, creator_id: 12 }
];

const REJECTION =
  'Virtual field "my" cannot be used in orderBy. It resolves to a filter, not a column.';

const virtualFields: VirtualFieldsConfig<Schema, IContext> = {
  my: {
    allowedValues: ['assigned', 'created'] as const,
    allowOperators: true,
    resolve: (input, ctx, { fields }) => ({
      type: 'comparison',
      field: fields({ assigned: 'assignee_id', created: 'creator_id' })[
        input.value as 'assigned' | 'created'
      ],
      operator: input.operator as ComparisonOperator,
      value: ctx.currentUserId
    })
  }
};

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, assignee_id INTEGER, creator_id INTEGER);
    INSERT INTO items VALUES (1, 7, 9), (2, 9, 7), (3, NULL, 7), (4, 7, NULL), (5, 12, 12);
  `);
  return database;
}

describe('a virtual field as a sort key', () => {
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  let contextCalls = 0;

  function kits(parserOptions: IParserOptions = {}): Array<QueryKit<Schema>> {
    const adapters = [
      new DrizzleAdapter({ db, schema: { items } }),
      inMemoryAdapter({ records: { items: rows } })
    ];
    return adapters.map(adapter =>
      createQueryKit<Schema, IContext>({
        adapter,
        schema: { items },
        parserOptions,
        virtualFields,
        createContext: (): IContext => {
          contextCalls += 1;
          return { currentUserId: 7 };
        }
      })
    );
  }

  beforeEach((): void => {
    logged.length = 0;
    contextCalls = 0;
  });

  afterAll((): void => {
    database.close();
  });

  it('filters on the virtual field the same way on both adapters', async () => {
    for (const kit of kits()) {
      const assigned = await kit
        .query('items')
        .where('my:assigned')
        .orderBy('id')
        .execute();
      expect(idsOf(assigned)).toEqual([1, 4]);
      const created = await kit
        .query('items')
        .where('my:created')
        .orderBy('id')
        .execute();
      expect(idsOf(created)).toEqual([2, 3]);
    }
  });

  it('sorts on the resolved column the same way on both adapters', async () => {
    for (const kit of kits()) {
      const sorted = await kit
        .query('items')
        .where('id:>0')
        .orderBy('assignee_id', 'asc')
        .orderBy('id', 'asc')
        .execute();
      expect(idsOf(sorted)).toEqual([3, 1, 4, 2, 5]);
    }
  });

  it.each<['asc' | 'desc']>([['asc'], ['desc']])(
    'rejects orderBy my %s before the context or an adapter runs',
    async direction => {
      for (const kit of kits()) {
        await expect(
          kit
            .query('items')
            .where('id:>0')
            .orderBy('my', direction)
            .orderBy('id', 'asc')
            .execute()
        ).rejects.toThrow(QueryParseError);
        await expect(
          kit
            .query('items')
            .where('my:assigned')
            .orderBy('my', direction)
            .execute()
        ).rejects.toThrow(REJECTION);
      }
      expect(logged).toHaveLength(0);
      expect(contextCalls).toBe(0);
    }
  );

  it('rejects a mapped name that resolves to the virtual field', async () => {
    for (const kit of kits({ fieldMappings: { mine: 'my' } })) {
      const filtered = await kit
        .query('items')
        .where('mine:assigned')
        .orderBy('id')
        .execute();
      expect(idsOf(filtered)).toEqual([1, 4]);
      await expect(
        kit.query('items').where('id:>0').orderBy('mine').execute()
      ).rejects.toThrow(REJECTION);
    }
  });

  it('rejects a folded name that resolves to the virtual field', async () => {
    for (const kit of kits({ caseInsensitiveFields: true })) {
      const filtered = await kit
        .query('items')
        .where('MY:assigned')
        .orderBy('id')
        .execute();
      expect(idsOf(filtered)).toEqual([1, 4]);
      await expect(
        kit.query('items').where('id:>0').orderBy('MY').execute()
      ).rejects.toThrow(REJECTION);
    }
  });
});
