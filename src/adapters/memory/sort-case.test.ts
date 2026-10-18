/**
 * A sort key in another letter case.
 *
 * `ORDER BY "Status"` sorts the column `status` in SQLite. The in-memory
 * sort reader uses the same rule as the filter reader: an exact own key,
 * else the one own key differing only by ASCII case. A row with both
 * spellings sorts each by its own key, and letters outside ASCII stay
 * distinct; a spelling that resolves to no key, because two keys fold
 * alike or the difference is outside ASCII, is rejected as the Drizzle
 * adapter rejects a sort key that is not a property of the table.
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

const rows: Array<{ id: number; status: string | null }> = [
  { id: 1, status: 'open' },
  { id: 2, status: 'closed' },
  { id: 3, status: null },
  { id: 4, status: 'Open' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.status);
  }
  return database;
}

describe('a sort key in another letter case', () => {
  const parser = new QueryParser();
  const database = openDatabase();
  const adapter = new DrizzleAdapter({
    db: drizzle(database as never),
    schema: { items }
  });
  const memory = inMemoryAdapter({ records: { items: rows } });

  afterAll((): void => {
    database.close();
  });

  it.each([
    ['Status', 'asc', [3, 4, 2, 1]],
    ['Status', 'desc', [1, 2, 4, 3]],
    ['status', 'asc', [3, 4, 2, 1]]
  ] as Array<[string, Direction, number[]]>)(
    'ORDER BY %s %s sorts the stored column on every engine',
    async (field, direction, expectedIds) => {
      const expression = parser.parse('id:>=0');
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const orderBy = `ORDER BY "${field}" ${direction.toUpperCase()}`;
      expect(inline).toBe('"id" >= 0');
      expect(
        database
          .prepare(`SELECT id FROM items WHERE ${inline} ${orderBy}`)
          .all()
          .map(row => row.id)
      ).toEqual(expectedIds);
      expect(
        database
          .prepare(`SELECT id FROM items WHERE ${parameterized.sql} ${orderBy}`)
          .all(...parameterized.params)
          .map(row => row.id)
      ).toEqual(expectedIds);
      const options = { orderBy: { [field]: direction } };
      const viaDrizzle = await adapter.execute<{ id: number }>(
        'items',
        expression,
        options
      );
      expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
      const viaMemory = await memory.execute<{ id: number }>(
        'items',
        expression,
        options
      );
      expect(viaMemory.map(row => row.id)).toEqual(expectedIds);
    }
  );

  it('sorts each spelling by its own key and rejects an ambiguous one', async () => {
    const twoSpellings = [
      { id: 1, status: 'b', Status: 'a' },
      { id: 2, status: 'a', Status: 'b' }
    ];
    const both = inMemoryAdapter({ records: { items: twoSpellings } });
    const expression = parser.parse('id:>=0');
    const byLower = await both.execute<{ id: number }>('items', expression, {
      orderBy: { status: 'asc' }
    });
    expect(byLower.map(row => row.id)).toEqual([2, 1]);
    const byUpper = await both.execute<{ id: number }>('items', expression, {
      orderBy: { Status: 'asc' }
    });
    expect(byUpper.map(row => row.id)).toEqual([1, 2]);
    await expect(
      both.execute<{ id: number }>('items', expression, {
        orderBy: { STATUS: 'desc' }
      })
    ).rejects.toThrow('Field STATUS does not name a property of table items');
  });

  it('does not fold letters outside ASCII', async () => {
    const greek = inMemoryAdapter({
      records: {
        items: [
          { id: 1, σtatus: 'b' },
          { id: 2, σtatus: 'a' }
        ]
      }
    });
    const expression = parser.parse('id:>=0');
    const exact = await greek.execute<{ id: number }>('items', expression, {
      orderBy: { σtatus: 'asc' }
    });
    expect(exact.map(row => row.id)).toEqual([2, 1]);
    await expect(
      greek.execute<{ id: number }>('items', expression, {
        orderBy: { Σtatus: 'asc' }
      })
    ).rejects.toThrow('Field Σtatus does not name a property of table items');
  });
});
