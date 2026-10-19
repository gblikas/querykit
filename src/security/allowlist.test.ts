/**
 * Field allowlist on every engine.
 *
 * `allowedFields: ['status']` lets `status:open` run and rejects `secret:1`
 * and `status:open OR secret:1` with the validator's `QuerySecurityError`
 * before any SQL is built or any row is read, on inline SQL, parameterized
 * SQL, the Drizzle translator and the Drizzle adapter, as `createQueryKit`
 * already did. An omitted or empty list allows every field.
 *
 * The in-memory adapter, `filterByExpression` and `filterInMemory` take the
 * list on their options and reject before any row is read.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { filterInMemory, inMemoryAdapter } from '../adapters/memory';
import { filterByExpression } from '../adapters/memory/match-expression';
import { createQueryKit } from '../index';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { QuerySecurityError } from './validator';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
}

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): ISqliteStatement;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

const REJECTED = 'Invalid query parameters';

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

const rows = [
  { id: 1, status: 'open', secret: 1 },
  { id: 2, status: 'closed', secret: 1 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  secret: integer('secret')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, secret INTEGER);
    INSERT INTO items VALUES (1, 'open', 1), (2, 'closed', 1);
  `);
  return database;
}

describe('field allowlist', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items } });
  const allowedFields = ['status'];

  beforeEach((): void => {
    logged.length = 0;
  });

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${statement.sql} ORDER BY id`)
      .all(...statement.params)
      .map(row => row.id);
  }

  function compileDrizzle(
    expression: QueryExpression,
    translator: DrizzleTranslator,
    context?: { allowedFields?: string[] }
  ): IParameterizedSql {
    const compiled = dialect.sqlToQuery(
      translator.translate(expression, context)
    );
    return { sql: compiled.sql, params: compiled.params };
  }

  it('matches a query that only uses allowed fields', async () => {
    const expression = parser.parse('status:open');
    const inline = new SqlTranslator({
      useParameters: false,
      allowedFields
    }).translate(expression) as string;
    const parameterized = new SqlTranslator({ allowedFields }).translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql({ sql: inline, params: [] })).toEqual([1]);
    expect(idsOfSql(parameterized)).toEqual([1]);
    expect(
      idsOfSql(
        compileDrizzle(expression, new DrizzleTranslator({ allowedFields }))
      )
    ).toEqual([1]);
    expect(
      idsOfSql(
        compileDrizzle(expression, new DrizzleTranslator(), { allowedFields })
      )
    ).toEqual([1]);
    const executed = await adapter.execute<{ id: number }>(
      'items',
      expression,
      { allowedFields }
    );
    expect(executed.map(row => row.id)).toEqual([1]);
    expect(logged).toHaveLength(1);
  });

  it.each(['secret:1', 'status:open OR secret:1'])(
    'rejects %s before rows are read',
    async query => {
      const expression = parser.parse(query);
      expect(() =>
        new SqlTranslator({ useParameters: false, allowedFields }).translate(
          expression
        )
      ).toThrow(QuerySecurityError);
      expect(() =>
        new SqlTranslator({ allowedFields }).translate(expression)
      ).toThrow(REJECTED);
      expect(() =>
        new DrizzleTranslator({ allowedFields }).translate(expression)
      ).toThrow(QuerySecurityError);
      expect(() =>
        new DrizzleTranslator().translate(expression, { allowedFields })
      ).toThrow(REJECTED);
      await expect(
        adapter.execute('items', expression, { allowedFields })
      ).rejects.toThrow(QuerySecurityError);
      await expect(
        adapter.execute('items', expression, { allowedFields })
      ).rejects.toThrow(REJECTED);
      expect(logged).toHaveLength(0);
      const drizzleKit = createQueryKit({
        adapter,
        schema: { items },
        security: { allowedFields }
      });
      await expect(
        drizzleKit.query('items').where(query).execute()
      ).rejects.toThrow(QuerySecurityError);
      const memoryKit = createQueryKit({
        adapter: inMemoryAdapter({ records: { items: rows } }),
        schema: { items },
        security: { allowedFields }
      });
      await expect(
        memoryKit.query('items').where(query).execute()
      ).rejects.toThrow(QuerySecurityError);
      expect(logged).toHaveLength(0);
    }
  );

  it('still runs with no list, an empty list, or a list that names the field', () => {
    const expression = parser.parse('secret:1');
    expect(
      idsOfSql(new SqlTranslator().translate(expression) as IParameterizedSql)
    ).toEqual([1, 2]);
    expect(
      idsOfSql(
        new SqlTranslator({ allowedFields: [] }).translate(
          expression
        ) as IParameterizedSql
      )
    ).toEqual([1, 2]);
    expect(
      idsOfSql(
        compileDrizzle(
          expression,
          new DrizzleTranslator({ allowedFields: ['status', 'secret'] })
        )
      )
    ).toEqual([1, 2]);
  });

  it('still matches status:open when a server exclusion names the hidden field', async () => {
    const security = {
      allowedFields,
      enforceExcludedValues: { secret: [0] }
    };
    const drizzleKit = createQueryKit({ adapter, schema: { items }, security });
    const open = await drizzleKit.query('items').where('status:open').execute();
    expect(idsOf(open)).toEqual([1]);
    const memoryKit = createQueryKit({
      adapter: inMemoryAdapter({ records: { items: rows } }),
      schema: { items },
      security
    });
    const inMemory = await memoryKit
      .query('items')
      .where('status:open')
      .execute();
    expect(idsOf(inMemory)).toEqual([1]);
    await expect(
      drizzleKit.query('items').where('secret:1').execute()
    ).rejects.toThrow(QuerySecurityError);
  });

  describe('in memory', () => {
    it.each(['secret:1', 'status:open OR secret:1'])(
      'rejects %s before rows are read',
      async query => {
        const expression = parser.parse(query);
        const memory = inMemoryAdapter({ records: { items: rows } });
        await expect(
          memory.execute('items', expression, { allowedFields })
        ).rejects.toThrow(QuerySecurityError);
        await expect(
          memory.execute('items', expression, { allowedFields })
        ).rejects.toThrow(REJECTED);
        expect(() =>
          filterByExpression(expression, rows, { allowedFields })
        ).toThrow(QuerySecurityError);
        expect(() =>
          filterInMemory(query, rows, undefined, { allowedFields })
        ).toThrow(REJECTED);
      }
    );

    it('rejects before a row is read on an empty table', () => {
      const reads: string[] = [];
      const watched = [
        new Proxy(rows[0] as Record<string, unknown>, {
          get(target, property): unknown {
            reads.push(String(property));
            return target[property as string];
          }
        })
      ];
      expect(() =>
        filterByExpression(parser.parse('secret:1'), watched, {
          allowedFields
        })
      ).toThrow(QuerySecurityError);
      expect(reads).toEqual([]);
    });

    it('still matches status:open with the list', async () => {
      const expression = parser.parse('status:open');
      const memory = inMemoryAdapter({ records: { items: rows } });
      const executed = await memory.execute<{ id: number }>(
        'items',
        expression,
        { allowedFields }
      );
      expect(executed.map(row => row.id)).toEqual([1]);
      expect(
        filterByExpression(expression, rows, { allowedFields }).map(
          row => row.id
        )
      ).toEqual([1]);
      expect(
        filterInMemory('status:open', rows, undefined, { allowedFields }).map(
          row => row.id
        )
      ).toEqual([1]);
    });

    it('still reads rows with no list', () => {
      expect(filterInMemory('secret:1', rows).map(row => row.id)).toEqual([
        1, 2
      ]);
      expect(
        filterByExpression(parser.parse('secret:1'), rows).map(row => row.id)
      ).toEqual([1, 2]);
      expect(
        filterByExpression(parser.parse('secret:1'), rows, {
          allowedFields: []
        }).map(row => row.id)
      ).toEqual([1, 2]);
    });
  });
});
