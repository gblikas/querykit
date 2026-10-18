/**
 * Secondary sort key across the engines.
 *
 * `ORDER BY priority ASC, name DESC` consults the second key only where the
 * first ties. SQLite stores a bigint `name` as an integer, so the tie breaks
 * numerically (`100n`, `20n`, `3n`), and memory compares two bigints the
 * same way instead of as text.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
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

interface IRow {
  id: number;
  priority: number;
  name: bigint;
}

const tiedRows: IRow[] = [
  { id: 1, priority: 1, name: 20n },
  { id: 2, priority: 1, name: 3n },
  { id: 3, priority: 1, name: 100n },
  { id: 4, priority: 2, name: 5n }
];

const uniqueRows: IRow[] = [
  { id: 1, priority: 1, name: 3n },
  { id: 2, priority: 2, name: 100n },
  { id: 3, priority: 3, name: 20n }
];

const tables = {
  tied: sqliteTable('tied', {
    id: integer('id'),
    priority: integer('priority'),
    name: integer('name')
  }),
  unique: sqliteTable('unique', {
    id: integer('id'),
    priority: integer('priority'),
    name: integer('name')
  })
};

const records = { tied: tiedRows, unique: uniqueRows };

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  for (const [table, rows] of Object.entries(records)) {
    database.exec(
      `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, priority INTEGER, name INTEGER)`
    );
    const insert = database.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`);
    for (const row of rows) {
      insert.run(row.id, row.priority, row.name);
    }
  }
  return database;
}

describe('secondary sort order', () => {
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

  function idsOfSql(table: string, statement: IParameterizedSql): number[] {
    return database
      .prepare(
        `SELECT id FROM "${table}" WHERE ${statement.sql} ORDER BY "priority" ASC, "name" DESC`
      )
      .all(...statement.params)
      .map(row => row.id);
  }

  it.each([
    ['tied', [3, 1, 2, 4]],
    ['unique', [1, 2, 3]]
  ] as Array<[keyof typeof tables, number[]]>)(
    'breaks a priority tie with the bigint name on the %s rows',
    async (table, expectedIds) => {
      const expression = parser.parse('id:>0');
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(idsOfSql(table, { sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(table, parameterized)).toEqual(expectedIds);
      const options = {
        orderBy: { priority: 'asc' as const, name: 'desc' as const }
      };
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
  );
});
