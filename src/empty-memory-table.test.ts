/**
 * An empty in-memory table and an unknown field.
 *
 * On current `main` the kit and Drizzle already agree for a name the schema
 * does not declare: `nope:open`, `status_col:open` and `orderBy('created_at')`
 * are `QuerySecurityError`, and `status:open` and `orderBy('status')` return
 * no rows. They disagree where `schemaFieldNames` walks a Drizzle table with
 * `for...in` and takes the enumerable prototype method `getSQL` as a field,
 * and where an adapter `fieldMappings` entry renames `status` to `nope` after
 * the kit has accepted `status`: Drizzle throws
 * `Field <field> does not name a property of table items` and the empty
 * memory table returns no rows. The bare adapters disagree the same way for
 * every unknown name, including when memory is given the schema object
 * Drizzle already takes. An empty table checks the own keys of a schema
 * given to the adapter or passed through by `createQueryKit`.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter, DrizzleAdapterError } from './adapters/drizzle';
import { InMemoryAdapterError, inMemoryAdapter } from './adapters/memory';
import { createQueryKit, QueryKit } from './index';
import { QueryParser } from './parser';
import { QueryExpression } from './parser/types';

const nodeRequire = createRequire(__filename);

interface ISqliteDatabase {
  exec(sqlText: string): void;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status_col'),
  createdAt: text('created_at'),
  isDone: integer('is_done', { mode: 'boolean' })
});

type Schema = { items: typeof items };

const REJECTED = {
  name: 'QuerySecurityError',
  message: 'Invalid query parameters'
};

const FIELD_MAPPINGS = { status: 'nope' };

function propertyMessage(field: string): string {
  return `Field ${field} does not name a property of table items`;
}

function drizzleFilterMessage(field: string): string {
  return `Failed to execute query: Failed to translate expression: ${propertyMessage(field)}`;
}

function drizzleSortMessage(field: string): string {
  return `Failed to execute query: ${propertyMessage(field)}`;
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      status_col TEXT,
      created_at TEXT,
      is_done INTEGER
    );
  `);
  return database;
}

function ascending(field: string): Record<string, 'asc' | 'desc'> {
  return { [field]: 'asc' };
}

describe('an empty in-memory table and an unknown field', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const drizzleAdapter = new DrizzleAdapter({ db, schema: { items } });
  const memoryAdapter = inMemoryAdapter({
    records: { items: [] },
    schema: { items }
  });

  function kits(): Array<QueryKit<Schema>> {
    return [
      new DrizzleAdapter({ db, schema: { items } }),
      inMemoryAdapter({ records: { items: [] } })
    ].map(adapter => createQueryKit({ adapter, schema: { items } }));
  }

  function mappedKits(): Array<QueryKit<Schema>> {
    return [
      new DrizzleAdapter({
        db,
        schema: { items },
        fieldMappings: FIELD_MAPPINGS
      }),
      inMemoryAdapter({
        records: { items: [] },
        fieldMappings: FIELD_MAPPINGS
      })
    ].map(adapter => createQueryKit({ adapter, schema: { items } }));
  }

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  describe('through createQueryKit', () => {
    it.each(['nope:open', 'status_col:open'])(
      'rejects %s on both adapters',
      async query => {
        for (const kit of kits()) {
          await expect(
            kit.query('items').where(query).execute()
          ).rejects.toEqual(expect.objectContaining(REJECTED));
        }
        expect(logged).toHaveLength(0);
      }
    );

    it('rejects orderBy created_at on both adapters', async () => {
      for (const kit of kits()) {
        await expect(
          kit.query('items').where('id:>0').orderBy('created_at').execute()
        ).rejects.toEqual(expect.objectContaining(REJECTED));
      }
      expect(logged).toHaveLength(0);
    });

    it('returns no rows for status:open on both adapters', async () => {
      for (const kit of kits()) {
        await expect(
          kit.query('items').where('status:open').execute()
        ).resolves.toEqual([]);
      }
    });

    it('returns no rows for orderBy status on both adapters', async () => {
      for (const kit of kits()) {
        await expect(
          kit.query('items').where('id:>0').orderBy('status').execute()
        ).resolves.toEqual([]);
      }
    });

    it('rejects getSQL:1 on both adapters', async () => {
      for (const kit of kits()) {
        await expect(
          kit.query('items').where('getSQL:1').execute()
        ).rejects.toEqual(expect.objectContaining(REJECTED));
      }
      expect(logged).toHaveLength(0);
    });

    it('rejects orderBy getSQL on both adapters', async () => {
      for (const kit of kits()) {
        await expect(
          kit.query('items').where('id:>0').orderBy('getSQL').execute()
        ).rejects.toEqual(expect.objectContaining(REJECTED));
      }
      expect(logged).toHaveLength(0);
    });

    it('rejects status:open when the adapter maps status to nope', async () => {
      const [drizzleKit, memoryKit] = mappedKits();
      await expect(
        drizzleKit.query('items').where('status:open').execute()
      ).rejects.toThrow(DrizzleAdapterError);
      await expect(
        drizzleKit.query('items').where('status:open').execute()
      ).rejects.toThrow(drizzleFilterMessage('nope'));
      await expect(
        memoryKit.query('items').where('status:open').execute()
      ).rejects.toThrow(InMemoryAdapterError);
      await expect(
        memoryKit.query('items').where('status:open').execute()
      ).rejects.toThrow(propertyMessage('nope'));
      expect(logged).toHaveLength(0);
    });

    it('rejects orderBy status when the adapter maps status to nope', async () => {
      const [drizzleKit, memoryKit] = mappedKits();
      await expect(
        drizzleKit.query('items').where('id:>0').orderBy('status').execute()
      ).rejects.toThrow(DrizzleAdapterError);
      await expect(
        drizzleKit.query('items').where('id:>0').orderBy('status').execute()
      ).rejects.toThrow(drizzleSortMessage('nope'));
      await expect(
        memoryKit.query('items').where('id:>0').orderBy('status').execute()
      ).rejects.toThrow(InMemoryAdapterError);
      await expect(
        memoryKit.query('items').where('id:>0').orderBy('status').execute()
      ).rejects.toThrow(propertyMessage('nope'));
      expect(logged).toHaveLength(0);
    });
  });

  describe('on the bare adapters', () => {
    async function expectBothReject(
      expression: QueryExpression,
      field: string,
      drizzleMessage: string,
      orderBy?: Record<string, 'asc' | 'desc'>
    ): Promise<void> {
      const options = orderBy === undefined ? undefined : { orderBy };
      await expect(
        drizzleAdapter.execute('items', expression, options)
      ).rejects.toThrow(DrizzleAdapterError);
      await expect(
        drizzleAdapter.execute('items', expression, options)
      ).rejects.toThrow(drizzleMessage);
      await expect(
        memoryAdapter.execute('items', expression, options)
      ).rejects.toThrow(InMemoryAdapterError);
      await expect(
        memoryAdapter.execute('items', expression, options)
      ).rejects.toThrow(propertyMessage(field));
      expect(logged).toHaveLength(0);
    }

    it.each<[string, string]>([
      ['nope:open', 'nope'],
      ['status_col:open', 'status_col'],
      ['created_at:null', 'created_at'],
      ['"Items.status":open', 'Items.status']
    ])(
      '%s is rejected by both adapters and logs nothing',
      async (query, field) => {
        await expectBothReject(
          parser.parse(query),
          field,
          drizzleFilterMessage(field)
        );
      }
    );

    it.each(['nope', 'created_at', 'getSQL'])(
      'orderBy %s is rejected by both adapters and logs nothing',
      async field => {
        await expectBothReject(
          parser.parse('id:>0'),
          field,
          drizzleSortMessage(field),
          ascending(field)
        );
      }
    );

    it('returns no rows for status:open on both adapters', async () => {
      const expression = parser.parse('status:open');
      await expect(
        drizzleAdapter.execute('items', expression)
      ).resolves.toEqual([]);
      await expect(memoryAdapter.execute('items', expression)).resolves.toEqual(
        []
      );
    });

    it('returns no rows for orderBy status on both adapters', async () => {
      const expression = parser.parse('id:>0');
      const orderBy = ascending('status');
      await expect(
        drizzleAdapter.execute('items', expression, { orderBy })
      ).resolves.toEqual([]);
      await expect(
        memoryAdapter.execute('items', expression, { orderBy })
      ).resolves.toEqual([]);
    });
  });
});
