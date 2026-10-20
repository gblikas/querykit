/**
 * A sort direction other than asc or desc.
 *
 * `SIDEWAYS` and an empty string are not directions. Inline SQL,
 * parameterized SQL, Drizzle, and in-memory must each reject both
 * spellings. An empty direction is not ascending: SQLite would read
 * `ORDER BY status` with no keyword as ascending and return 2, 1.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../drizzle';
import { inMemoryAdapter } from './in-memory-adapter';
import { createQueryKit } from '../../query-kit';
import { QueryParser } from '../../parser';
import { QueryBuilder } from '../../query';
import { SqlTranslator } from '../../translators/sql';
import { QueryExpression } from '../../parser/types';

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

interface IEngineOutcome {
  rejected: boolean;
  ids: number[];
}

const rows = [
  { id: 1, status: 'b' },
  { id: 2, status: 'a' }
];

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status')
});

const rejected: IEngineOutcome = { rejected: true, ids: [] };

/** The ORDER BY clause the public query builder writes for this direction. */
function orderClause(direction: string): string {
  const written = new QueryBuilder<{ status: string }>()
    .where('id:>0')
    .orderBy('status', direction as 'asc')
    .toString();
  const marker = 'ORDER BY ';
  const start = written.indexOf(marker);
  if (start < 0) {
    throw new Error('QueryBuilder.orderBy wrote no ORDER BY clause');
  }
  return written.slice(start);
}

function outcomeOf(run: () => number[]): IEngineOutcome {
  try {
    return { rejected: false, ids: run() };
  } catch {
    return rejected;
  }
}

async function outcomeOfAsync(
  run: () => Promise<number[]>
): Promise<IEngineOutcome> {
  try {
    return { rejected: false, ids: await run() };
  } catch {
    return rejected;
  }
}

function idsOf(value: unknown[]): number[] {
  return (value as Array<{ id: number }>).map(row => row.id);
}

describe('a sort direction other than asc or desc', () => {
  const database = openDatabase();
  const parser = new QueryParser();
  const expression = parser.parse('id:>0');
  const drizzleAdapter = new DrizzleAdapter({
    db: drizzle(database as never),
    schema: { items }
  });
  const memory = inMemoryAdapter({ records: { items: rows } });
  const drizzleKit = createQueryKit({
    adapter: drizzleAdapter,
    schema: { items }
  });
  const memoryKit = createQueryKit({
    adapter: memory,
    schema: { items }
  });

  afterAll((): void => {
    database.close();
  });

  it.each(['SIDEWAYS', ''])(
    'rejects orderBy direction %j on every engine',
    async direction => {
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const actual = {
        inline: outcomeOf(() =>
          idsOfStatement(database, inline, [], direction)
        ),
        parameterized: outcomeOf(() =>
          idsOfStatement(
            database,
            parameterized.sql,
            parameterized.params,
            direction
          )
        ),
        drizzle: await outcomeOfAsync(() =>
          drizzleIds(drizzleAdapter, expression, direction)
        ),
        memory: await outcomeOfAsync(() =>
          memoryIds(memory, expression, direction)
        ),
        drizzleKit: await outcomeOfAsync(() => kitIds(drizzleKit, direction)),
        memoryKit: await outcomeOfAsync(() => kitIds(memoryKit, direction))
      };
      expect(actual).toEqual({
        inline: rejected,
        parameterized: rejected,
        drizzle: rejected,
        memory: rejected,
        drizzleKit: rejected,
        memoryKit: rejected
      });
    }
  );
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO items VALUES (1, 'b'), (2, 'a');"
  );
  return database;
}

function idsOfStatement(
  database: ISqliteDatabase,
  whereSql: string,
  params: unknown[],
  direction: string
): number[] {
  const order = orderClause(direction);
  return database
    .prepare(`SELECT id FROM items WHERE ${whereSql} ${order}`)
    .all(...params)
    .map(row => row.id);
}

async function drizzleIds(
  adapter: DrizzleAdapter,
  expression: QueryExpression,
  direction: string
): Promise<number[]> {
  const sorted = await adapter.execute<{ id: number }>('items', expression, {
    orderBy: { status: direction as 'asc' }
  });
  return sorted.map(row => row.id);
}

async function memoryIds(
  adapter: ReturnType<typeof inMemoryAdapter>,
  expression: QueryExpression,
  direction: string
): Promise<number[]> {
  const sorted = await adapter.execute<{ id: number }>('items', expression, {
    orderBy: { status: direction as 'asc' }
  });
  return sorted.map(row => row.id);
}

async function kitIds(
  kit: ReturnType<typeof createQueryKit>,
  direction: string
): Promise<number[]> {
  const sorted = await kit
    .query('items')
    .where('id:>0')
    .orderBy('status', direction as 'asc')
    .execute();
  return idsOf(sorted);
}
