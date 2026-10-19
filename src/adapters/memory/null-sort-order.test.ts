/**
 * Null sort order across the engines.
 *
 * `ORDER BY` a nullable column puts nulls first ascending and last
 * descending, with `id` breaking ties. A column that mixes numbers and text
 * follows SQLite's storage classes: null, then numbers in numeric order,
 * then text in binary order, so `''` does not sort before `-1` and the text
 * `'2'` does not tie with the number `2`.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../drizzle';
import { QueryParser } from '../../parser';
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

const numberRows: Array<{ id: number; score: unknown }> = [
  { id: 1, score: 2 },
  { id: 2, score: null },
  { id: 3, score: -1 },
  { id: 4, score: 0 },
  { id: 5, score: null },
  { id: 6, score: 0.5 },
  { id: 7, score: 10 }
];

const stringRows: Array<{ id: number; score: unknown }> = [
  { id: 1, score: 'b' },
  { id: 2, score: '' },
  { id: 3, score: null },
  { id: 4, score: 'A' },
  { id: 5, score: '10' },
  { id: 6, score: ' ' },
  { id: 7, score: 'a' },
  { id: 8, score: '2' }
];

const mixedRows: Array<{ id: number; score: unknown }> = [
  { id: 1, score: 'b' },
  { id: 2, score: null },
  { id: 3, score: 10 },
  { id: 4, score: '2' },
  { id: 5, score: 2 },
  { id: 6, score: 'a' },
  { id: 7, score: null },
  { id: 8, score: -1 },
  { id: 9, score: '' }
];

const tables = {
  numbers: sqliteTable('numbers', { id: integer('id'), score: text('score') }),
  strings: sqliteTable('strings', { id: integer('id'), score: text('score') }),
  mixed: sqliteTable('mixed', { id: integer('id'), score: text('score') })
};

const records = { numbers: numberRows, strings: stringRows, mixed: mixedRows };

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  for (const [table, rows] of Object.entries(records)) {
    database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, score)`);
    const insert = database.prepare(`INSERT INTO ${table} VALUES (?, ?)`);
    for (const row of rows) {
      insert.run(row.id, row.score);
    }
  }
  return database;
}

describe('null sort order', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const adapter = new DrizzleAdapter({
    db: drizzle(database as never),
    schema: tables
  });
  const memory = inMemoryAdapter({ records });

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(
    table: string,
    statement: IParameterizedSql,
    direction: Direction
  ): number[] {
    return database
      .prepare(
        `SELECT id FROM ${table} WHERE ${statement.sql} ORDER BY "score" ${direction.toUpperCase()}, id ASC`
      )
      .all(...statement.params)
      .map(row => row.id);
  }

  /** Every engine must sort the table the same way. */
  async function expectOrder(
    table: keyof typeof tables,
    direction: Direction,
    expectedIds: number[]
  ): Promise<void> {
    const expression = parser.parse('id:>0');
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql(table, { sql: inline, params: [] }, direction)).toEqual(
      expectedIds
    );
    expect(idsOfSql(table, parameterized, direction)).toEqual(expectedIds);
    const options = { orderBy: { score: direction, id: 'asc' as const } };
    const viaDrizzle = await adapter.execute<{ id: number }>(
      table,
      expression,
      options
    );
    expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
    const viaMemory = await memory.execute<{ id: number }>(
      table,
      expression,
      options
    );
    expect(viaMemory.map(row => row.id)).toEqual(expectedIds);
  }

  it('sorts nulls first ascending and last descending among numbers', async () => {
    await expectOrder('numbers', 'asc', [2, 5, 3, 4, 6, 1, 7]);
    await expectOrder('numbers', 'desc', [7, 1, 6, 4, 3, 2, 5]);
  });

  it('sorts nulls first ascending and last descending among strings', async () => {
    await expectOrder('strings', 'asc', [3, 2, 6, 5, 8, 4, 7, 1]);
    await expectOrder('strings', 'desc', [1, 7, 4, 8, 5, 6, 2, 3]);
  });

  it('sorts null, then numbers, then text in a mixed column', async () => {
    await expectOrder('mixed', 'asc', [2, 7, 8, 5, 3, 9, 4, 6, 1]);
    await expectOrder('mixed', 'desc', [1, 6, 4, 9, 3, 5, 8, 2, 7]);
  });
});
