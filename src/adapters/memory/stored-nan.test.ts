/**
 * A stored NaN.
 *
 * A bound NaN is NULL in SQLite. Memory treats a numeric NaN the same way:
 * `amount:null` matches it, every other comparison is unknown, and it sorts
 * with the nulls. No statement can carry a NaN literal: SQLite reads `NaN`
 * as a column name and the translators reject a non-finite number.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  real,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../drizzle';
import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { DrizzleTranslator } from '../../translators/drizzle';
import { SqlTranslator } from '../../translators/sql';
import { inMemoryAdapter } from './in-memory-adapter';

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

type Direction = 'asc' | 'desc';

const rows: Array<{ id: number; amount: number | null }> = [
  { id: 1, amount: NaN },
  { id: 2, amount: null },
  { id: 3, amount: 0 },
  { id: 4, amount: 1 }
];

const amounts = sqliteTable('amounts', {
  id: integer('id'),
  amount: real('amount')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE amounts (id INTEGER PRIMARY KEY, amount REAL)');
  const insert = database.prepare('INSERT INTO amounts VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.amount);
  }
  return database;
}

describe('a stored NaN', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const adapter = new DrizzleAdapter({
    db: drizzle(database as never),
    schema: { amounts }
  });
  const memory = inMemoryAdapter({ records: { amounts: rows } });

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(
    statement: IParameterizedSql,
    orderBy = 'id ASC'
  ): number[] {
    return database
      .prepare(
        `SELECT id FROM amounts WHERE ${statement.sql} ORDER BY ${orderBy}`
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

  it('is stored as NULL', () => {
    expect(
      database
        .prepare('SELECT id FROM amounts WHERE amount IS NULL ORDER BY id')
        .all()
        .map(row => row.id)
    ).toEqual([1, 2]);
  });

  it('cannot be written into a statement', () => {
    expect(() =>
      database.prepare('SELECT id FROM amounts WHERE "amount" = NaN').all()
    ).toThrow('no such column: NaN');
    const expression: QueryExpression = {
      type: 'comparison',
      field: 'amount',
      operator: '==',
      value: NaN
    };
    expect(() => new SqlTranslator().translate(expression)).toThrow(
      'Non-finite numbers are not supported'
    );
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      'Non-finite numbers are not supported'
    );
  });

  it.each([
    ['amount:null', [1, 2]],
    ['amount:0', [3]],
    ['amount:>0', [4]],
    ['amount:>=0', [3, 4]],
    ['amount:<0', []],
    ['amount:<=0', [3]],
    ['amount:>1', []],
    ['amount:>=1', [4]],
    ['amount:<1', [3]],
    ['amount:<=1', [3, 4]]
  ])('%s matches the same rows on every engine', async (query, expectedIds) => {
    const expression = parser.parse(query);
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
    expect(idsOfSql(parameterized)).toEqual(expectedIds);
    expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
    const viaDrizzle = await adapter.execute<{ id: number }>(
      'amounts',
      expression,
      { orderBy: { id: 'asc' } }
    );
    expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
    const viaMemory = await memory.execute<{ id: number }>(
      'amounts',
      expression,
      { orderBy: { id: 'asc' } }
    );
    expect(viaMemory.map(row => row.id)).toEqual(expectedIds);
  });

  it.each([
    ['asc', [1, 2, 3, 4]],
    ['desc', [4, 3, 1, 2]]
  ] as Array<[Direction, number[]]>)(
    'sorts with the nulls %s on every engine',
    async (direction, expectedIds) => {
      const expression = parser.parse('id:>=0');
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const orderBy = `"amount" ${direction.toUpperCase()}, id ASC`;
      expect(idsOfSql({ sql: inline, params: [] }, orderBy)).toEqual(
        expectedIds
      );
      expect(idsOfSql(parameterized, orderBy)).toEqual(expectedIds);
      const options = { orderBy: { amount: direction, id: 'asc' as const } };
      const viaDrizzle = await adapter.execute<{ id: number }>(
        'amounts',
        expression,
        options
      );
      expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
      const viaMemory = await memory.execute<{ id: number }>(
        'amounts',
        expression,
        options
      );
      expect(viaMemory.map(row => row.id)).toEqual(expectedIds);
    }
  );
});
