/**
 * Virtual field `opened`, resolved to the timestamp column `created_at`.
 *
 * Equality uses a `Date` from the query context. Every SQL engine renders or
 * binds that instant as ISO-8601 text, which is what SQLite stores: inline
 * SQL quotes it, parameterized SQL and Drizzle bind the string, and a
 * Drizzle column whose encoder rewrites a `Date` (such as `timestamp_ms`)
 * still receives the `Date`. LIKE on a year prefix and a sort on the column
 * agree the same way.
 *
 * The in-memory assertions land with layer 5 (in-memory compare and sort),
 * where a `Date` field is its ISO instant in equality, LIKE and sort.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { filterByExpression } from '../adapters/memory/match-expression';
import { inMemoryAdapter } from '../adapters/memory';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { resolveVirtualFields } from './resolver';
import { IQueryContext, VirtualFieldsConfig } from './types';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
  run(...params: unknown[]): unknown;
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

interface IOpenedContext extends IQueryContext {
  then: Date;
}

type ItemSchema = { items: { id: number; created_at: string } };

const THEN = new Date('2020-01-02T03:04:05.000Z');
const THEN_ISO = '2020-01-02T03:04:05.000Z';

const rows: Array<{ id: number; created_at: Date | null }> = [
  { id: 1, created_at: THEN },
  { id: 2, created_at: new Date('2019-12-05T00:00:00.000Z') },
  { id: 3, created_at: new Date('2020-06-07T08:09:10.000Z') },
  { id: 4, created_at: null },
  { id: 5, created_at: new Date('2021-01-01T00:00:00.000Z') }
];

const items = sqliteTable('items', {
  id: integer('id'),
  created_at: text('created_at')
});

const stamped = sqliteTable('items', {
  id: integer('id'),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
});

const virtualFields: VirtualFieldsConfig<ItemSchema, IOpenedContext> = {
  opened: {
    allowedValues: ['then', 'year'],
    resolve: (input, context) => {
      if (input.value === 'year') {
        return {
          type: 'comparison',
          field: 'created_at',
          operator: 'LIKE',
          value: '2020*'
        };
      }
      return {
        type: 'comparison',
        field: 'created_at',
        operator: '==',
        value: context.then as unknown as string
      };
    }
  }
};

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, created_at TEXT)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.created_at ? row.created_at.toISOString() : null);
  }
  return database;
}

describe('virtual field opened', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const db = drizzle(database as never);
  const context: IOpenedContext = { then: THEN };

  afterAll((): void => {
    database.close();
  });

  function resolve(query: string): QueryExpression {
    return resolveVirtualFields(parser.parse(query), virtualFields, context);
  }

  function idsOfSql(statement: IParameterizedSql, orderBy = 'id'): number[] {
    return database
      .prepare(
        `SELECT id FROM items WHERE ${statement.sql} ORDER BY ${orderBy}, id`
      )
      .all(...statement.params)
      .map(row => row.id);
  }

  function compileDrizzle(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): IParameterizedSql {
    const translator = new DrizzleTranslator(schema ? { schema } : {});
    const compiled = dialect.sqlToQuery(translator.translate(expression));
    return { sql: compiled.sql, params: compiled.params };
  }

  function idsOfBuilder(
    expression: QueryExpression,
    orderBy: 'id' | 'created_at' = 'id'
  ): number[] {
    const condition = new DrizzleTranslator({ schema: { items } }).translate(
      expression,
      { tableName: 'items' }
    );
    return db
      .select({ id: items.id })
      .from(items)
      .where(condition)
      .orderBy(items[orderBy], items.id)
      .all()
      .map(row => row.id as number);
  }

  it('binds the Date as ISO-8601 text for equality', () => {
    const expression = resolve('opened:then');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'created_at',
      operator: '==',
      value: THEN
    });
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    const bare = compileDrizzle(expression);
    const textColumn = compileDrizzle(expression, { items });
    expect(inline).toBe(`"created_at" = '${THEN_ISO}'`);
    expect(parameterized).toEqual({
      sql: '"created_at" = ?',
      params: [THEN_ISO]
    });
    expect(bare).toEqual({ sql: '"created_at" = ?', params: [THEN_ISO] });
    expect(textColumn).toEqual({
      sql: '"items"."created_at" = ?',
      params: [THEN_ISO]
    });
    expect(idsOfSql({ sql: inline, params: [] })).toEqual([1]);
    expect(idsOfSql(parameterized)).toEqual([1]);
    expect(idsOfSql(bare)).toEqual([1]);
    expect(idsOfSql(textColumn)).toEqual([1]);
    expect(idsOfBuilder(expression)).toEqual([1]);
  });

  it('matches a year prefix with LIKE in column order', () => {
    const expression = resolve('opened:year');
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(inline).toBe(`"created_at" LIKE '2020%' ESCAPE '!'`);
    expect(idsOfSql({ sql: inline, params: [] }, 'created_at')).toEqual([1, 3]);
    expect(idsOfSql(parameterized, 'created_at')).toEqual([1, 3]);
    expect(idsOfSql(compileDrizzle(expression), 'created_at')).toEqual([1, 3]);
    expect(
      idsOfSql(compileDrizzle(expression, { items }), 'created_at')
    ).toEqual([1, 3]);
    expect(idsOfBuilder(expression, 'created_at')).toEqual([1, 3]);
  });

  it('sorts the column chronologically with nulls first', () => {
    const everything = parser.parse('id:>0');
    const parameterized = new SqlTranslator().translate(
      everything
    ) as IParameterizedSql;
    expect(idsOfSql(parameterized, 'created_at')).toEqual([4, 2, 1, 3, 5]);
    expect(idsOfBuilder(everything, 'created_at')).toEqual([4, 2, 1, 3, 5]);
  });

  it('still hands the Date to a column encoder that rewrites it', () => {
    const expression = resolve('opened:then');
    expect(compileDrizzle(expression, { items: stamped })).toEqual({
      sql: '"items"."created_at" = ?',
      params: [1577934245000]
    });
  });

  // Layer 5 (in-memory compare and sort): a Date field is its ISO instant in
  // equality, LIKE, membership and sort.
  describe.skip('in memory (layer 5)', () => {
    it('matches a Date at the same instant', () => {
      expect(
        filterByExpression(resolve('opened:then'), rows).map(row => row.id)
      ).toEqual([1]);
    });

    it('matches a year prefix with LIKE', async () => {
      const adapter = inMemoryAdapter({ records: { items: rows } });
      const matched = await adapter.execute<{ id: number }>(
        'items',
        resolve('opened:year'),
        { orderBy: { created_at: 'asc' } }
      );
      expect(matched.map(row => row.id)).toEqual([1, 3]);
    });

    it('sorts a Date column chronologically with nulls first', async () => {
      const adapter = inMemoryAdapter({ records: { items: rows } });
      const sorted = await adapter.execute<{ id: number }>(
        'items',
        parser.parse('id:>0'),
        { orderBy: { created_at: 'asc' } }
      );
      expect(sorted.map(row => row.id)).toEqual([4, 2, 1, 3, 5]);
    });
  });
});
