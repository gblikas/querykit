/**
 * QueryBuilder AND / OR / NOT grouping.
 *
 * The builder splices a query string into `andWhere`, `orWhere` and
 * `notWhere`. Liqe gives AND and OR one precedence and associates left, so
 * an ungrouped `(priority:1) AND status:"a" OR status:"b"` read as
 * `(priority == 1 AND status == a) OR status == b` and `NOT status:"a" OR
 * status:"b"` as `(NOT status == a) OR status == b`. A string clause with a
 * top-level AND or OR is now parenthesized, outside quotes, regex literals
 * and parentheses, so the emitted text parses as the caller grouped it and
 * inline SQL, parameterized SQL, Drizzle and the in-memory adapter return
 * the grouped rows. A simple comparison is spliced in unchanged.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { inMemoryAdapter } from '../adapters/memory';
import { QueryParser } from '../parser';
import { SqlTranslator } from '../translators/sql';
import { QueryBuilder } from './builder';

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

interface IItem {
  id: number;
  status: string;
  priority: number;
}

type Row = Record<string, unknown>;

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status'),
  priority: integer('priority')
});

const rows: IItem[] = [
  { id: 1, status: 'a', priority: 1 },
  { id: 2, status: 'b', priority: 1 },
  { id: 3, status: 'a', priority: 2 },
  { id: 4, status: 'b', priority: 2 },
  { id: 5, status: 'c', priority: 1 },
  { id: 6, status: 'c', priority: 2 }
];

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, priority INTEGER);
    INSERT INTO items VALUES
      (1, 'a', 1), (2, 'b', 1), (3, 'a', 2), (4, 'b', 2), (5, 'c', 1), (6, 'c', 2);
  `);
  return database;
}

function builder(): QueryBuilder<Row> {
  return new QueryBuilder<Row>();
}

describe('builder grouping', () => {
  const database = openDatabase();
  const db = drizzle(database as never);
  const drizzleAdapter = new DrizzleAdapter({ db, schema: { items } });
  const memoryAdapter = inMemoryAdapter({ records: { items: rows } });

  afterAll((): void => {
    database.close();
  });

  /** Parse the emitted text with a fresh parser and run it on every engine. */
  async function idsOnEveryEngine(text: string): Promise<number[][]> {
    const expression = new QueryParser().parse(text);
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    return [
      database
        .prepare(`SELECT id FROM items WHERE ${inline} ORDER BY id`)
        .all()
        .map(row => row.id),
      database
        .prepare(`SELECT id FROM items WHERE ${parameterized.sql} ORDER BY id`)
        .all(...parameterized.params)
        .map(row => row.id),
      (
        await drizzleAdapter.execute<IItem>('items', expression, {
          orderBy: { id: 'asc' }
        })
      ).map(row => row.id),
      (
        await memoryAdapter.execute<IItem>('items', expression, {
          orderBy: { id: 'asc' }
        })
      ).map(row => row.id)
    ];
  }

  it('keeps an OR group under AND, under NOT, and beside NOT', async () => {
    const cases: Array<[string, string, number[]]> = [
      [
        builder()
          .where('priority', '==', 1)
          .andWhere('status:"a" OR status:"b"')
          .toString(),
        '(priority:1) AND (status:"a" OR status:"b")',
        [1, 2]
      ],
      [
        builder().notWhere('status:"a" OR status:"b"').toString(),
        'NOT (status:"a" OR status:"b")',
        [5, 6]
      ],
      [
        builder()
          .notWhere('status', '==', 'a')
          .orWhere('status', '==', 'b')
          .toString(),
        '(NOT status:"a") OR status:"b"',
        [2, 4, 5, 6]
      ],
      [
        builder()
          .where('status', '==', 'a')
          .orWhere('status', '==', 'b')
          .andWhere('priority', '==', 1)
          .toString(),
        '((status:"a") OR status:"b") AND priority:1',
        [1, 2]
      ],
      [
        builder()
          .where('priority', '==', 2)
          .orWhere('status:"a" AND priority:1')
          .toString(),
        '(priority:2) OR (status:"a" AND priority:1)',
        [1, 3, 4, 6]
      ],
      [
        builder()
          .where('priority', '==', 1)
          .andWhere('(status:"a" OR status:"b")')
          .toString(),
        '(priority:1) AND (status:"a" OR status:"b")',
        [1, 2]
      ],
      [
        builder()
          .where('priority', '==', 1)
          .andWhere('status:"a OR b"')
          .toString(),
        '(priority:1) AND status:"a OR b"',
        []
      ],
      [
        builder()
          .where('priority', '==', 1)
          .andWhere('status:/a OR b/')
          .toString(),
        '(priority:1) AND status:/a OR b/',
        []
      ],
      [
        builder().where('priority', '==', 1).andWhere('status:a').toString(),
        '(priority:1) AND status:a',
        [1]
      ]
    ];
    for (const [emitted, expectedText, expectedIds] of cases) {
      expect(emitted).toBe(expectedText);
      if (emitted.includes('/a OR b/')) {
        // REGEX parses but no engine runs it
        expect(() => new QueryParser().parse(emitted)).not.toThrow();
        continue;
      }
      for (const ids of await idsOnEveryEngine(emitted)) {
        expect({ emitted, ids }).toEqual({ emitted, ids: expectedIds });
      }
    }
  });
});
