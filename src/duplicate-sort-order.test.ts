/**
 * A repeated `orderBy` key on every engine.
 *
 * SQLite keeps the first direction of a repeated `ORDER BY` key and lets a
 * later key break ties. `createQueryKit` keeps the direction of the first
 * `.orderBy` call for a name, so the Drizzle and in-memory adapters sort
 * the way inline and parameterized SQL do.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, IQueryExecutor } from './index';
import { QueryParser } from './parser';
import { SqlTranslator } from './translators/sql';

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
  priority: number;
  name: string;
}

type SortList = Array<[string, 'asc' | 'desc']>;

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  priority: integer('priority'),
  name: text('name')
});

const rows: IItem[] = [
  { id: 1, priority: 1, name: 'b' },
  { id: 2, priority: 1, name: 'a' },
  { id: 3, priority: 2, name: 'c' },
  { id: 4, priority: 2, name: 'a' }
];

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, priority INTEGER, name TEXT);
    INSERT INTO items VALUES (1, 1, 'b'), (2, 1, 'a'), (3, 2, 'c'), (4, 2, 'a');
  `);
  return database;
}

function orderByClause(sorts: SortList): string {
  return sorts
    .map(([field, direction]) => `"${field}" ${direction.toUpperCase()}`)
    .join(', ');
}

function applySorts<T>(
  executor: IQueryExecutor<T>,
  sorts: SortList
): IQueryExecutor<T> {
  return sorts.reduce(
    (chained, [field, direction]) => chained.orderBy(field, direction),
    executor
  );
}

describe('a repeated sort key', () => {
  const database = openDatabase();
  const parser = new QueryParser();
  const expression = parser.parse('id:>0');
  const kits = [
    createQueryKit({
      adapter: new DrizzleAdapter({
        db: drizzle(database as never),
        schema: { items }
      }),
      schema: { items }
    }),
    createQueryKit({
      adapter: inMemoryAdapter({ records: { items: rows } }),
      schema: { items }
    })
  ];

  afterAll((): void => {
    database.close();
  });

  it.each<[string, SortList, number[]]>([
    [
      'priority DESC, priority ASC, name ASC',
      [
        ['priority', 'desc'],
        ['priority', 'asc'],
        ['name', 'asc']
      ],
      [4, 3, 2, 1]
    ],
    [
      'name ASC, priority DESC, priority ASC',
      [
        ['name', 'asc'],
        ['priority', 'desc'],
        ['priority', 'asc']
      ],
      [4, 2, 1, 3]
    ]
  ])('keeps the first direction for %s', async (_name, sorts, expected) => {
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    expect(inline).toBe('"id" > 0');
    expect(
      database
        .prepare(
          `SELECT id FROM items WHERE ${inline} ORDER BY ${orderByClause(sorts)}`
        )
        .all()
        .map(row => row.id)
    ).toEqual(expected);
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(parameterized).toEqual({ sql: '"id" > ?', params: [0] });
    expect(
      database
        .prepare(
          `SELECT id FROM items WHERE ${parameterized.sql} ORDER BY ${orderByClause(sorts)}`
        )
        .all(...parameterized.params)
        .map(row => row.id)
    ).toEqual(expected);
    for (const kit of kits) {
      const sorted = await applySorts(
        kit.query('items').where('id:>0'),
        sorts
      ).execute();
      expect(idsOf(sorted)).toEqual(expected);
    }
  });
});
