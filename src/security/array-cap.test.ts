/**
 * Array item cap on every engine.
 *
 * A membership list of 100 items matches; a list of 101 items is rejected
 * with the validator's `QuerySecurityError` before any SQL is built or any
 * row is read, on inline SQL, parameterized SQL, the Drizzle translator and
 * the Drizzle adapter, as `createQueryKit` already did. The cap is not an
 * option and does not move with `maxValueLength`.
 *
 * The in-memory assertions land with layer 5 (in-memory compare and sort).
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { inMemoryAdapter } from '../adapters/memory';
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

const MESSAGE = 'Array values cannot exceed 100 items';

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

const rows = [{ id: 1, label: 1 }];

const items = sqliteTable('items', {
  id: integer('id'),
  label: integer('label')
});

/** `label:in[1,2,...,count]`; every list includes 1, so an allowed list matches id 1. */
function membershipQuery(count: number): string {
  return `label:in[${Array.from(
    { length: count },
    (_, index) => index + 1
  ).join(',')}]`;
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, label INTEGER);
    INSERT INTO items VALUES (1, 1);
  `);
  return database;
}

describe('array item cap', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items } });

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

  function compileDrizzle(expression: QueryExpression): IParameterizedSql {
    const compiled = dialect.sqlToQuery(
      new DrizzleTranslator().translate(expression)
    );
    return { sql: compiled.sql, params: compiled.params };
  }

  it('matches a 100-item list on every engine', async () => {
    const query = membershipQuery(100);
    const expression = parser.parse(query);
    expect((expression as { value: unknown[] }).value).toHaveLength(100);
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql({ sql: inline, params: [] })).toEqual([1]);
    expect(idsOfSql(parameterized)).toEqual([1]);
    expect(idsOfSql(compileDrizzle(expression))).toEqual([1]);
    const executed = await adapter.execute<{ id: number }>('items', expression);
    expect(executed.map(row => row.id)).toEqual([1]);
    expect(logged).toHaveLength(1);
    for (const kitAdapter of [
      adapter,
      inMemoryAdapter({ records: { items: rows } })
    ]) {
      const kit = createQueryKit({ adapter: kitAdapter, schema: { items } });
      const matched = await kit.query('items').where(query).execute();
      expect(idsOf(matched)).toEqual([1]);
    }
  });

  it('rejects a 101-item list before rows are read', async () => {
    const query = membershipQuery(101);
    const expression = parser.parse(query);
    expect((expression as { value: unknown[] }).value).toHaveLength(101);
    expect(() =>
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toThrow(QuerySecurityError);
    expect(() => new SqlTranslator().translate(expression)).toThrow(MESSAGE);
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      QuerySecurityError
    );
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      MESSAGE
    );
    await expect(adapter.execute('items', expression)).rejects.toThrow(
      QuerySecurityError
    );
    await expect(adapter.execute('items', expression)).rejects.toThrow(MESSAGE);
    expect(logged).toHaveLength(0);
    for (const kitAdapter of [
      adapter,
      inMemoryAdapter({ records: { items: rows } })
    ]) {
      const kit = createQueryKit({ adapter: kitAdapter, schema: { items } });
      await expect(kit.query('items').where(query).execute()).rejects.toThrow(
        MESSAGE
      );
    }
    expect(logged).toHaveLength(0);
  });

  it('does not move the cap with maxValueLength', () => {
    const expression = parser.parse(membershipQuery(101));
    expect(() =>
      new SqlTranslator({ maxValueLength: 5000 }).translate(expression)
    ).toThrow(MESSAGE);
    expect(() =>
      new DrizzleTranslator().translate(expression, { maxValueLength: 5000 })
    ).toThrow(MESSAGE);
  });

  // Layer 5 (in-memory compare and sort): the in-memory adapter rejects the
  // list before it walks the table.
  describe.skip('in memory (layer 5)', () => {
    it('rejects a 101-item list before rows are read', async () => {
      const memory = inMemoryAdapter({ records: { items: rows } });
      await expect(
        memory.execute('items', parser.parse(membershipQuery(101)))
      ).rejects.toThrow(MESSAGE);
    });
  });
});
