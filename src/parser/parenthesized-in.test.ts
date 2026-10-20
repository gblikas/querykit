/**
 * Parenthesized membership, the form issue 9 showed returning no rows.
 *
 * `id:[2,3]` is a bracket list. `status in (todo, doing, done)` names the
 * same membership with the word `in` and parentheses. Both have to keep the
 * rows whose value is in the list, on the SQL translator and in memory.
 * A boolean word used as an operator inside the parentheses stays a syntax
 * error, and the same text inside a quoted value stays that value.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const nodeRequire = createRequire(__filename);

interface ISqliteDatabase {
  exec(sqlText: string): void;
  close(): void;
}

interface ITask {
  id: number;
  status: string;
}

const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey(),
  status: text('status')
});

const rows: ITask[] = [
  { id: 1, status: 'todo' },
  { id: 2, status: 'doing' },
  { id: 3, status: 'doing' },
  { id: 4, status: 'done' }
];

describe('parenthesized in', () => {
  const parser = new QueryParser();
  const Database = nodeRequire('better-sqlite3') as new (
    filename: string
  ) => ISqliteDatabase;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT);
    INSERT INTO tasks (id, status) VALUES
      (1, 'todo'), (2, 'doing'), (3, 'doing'), (4, 'done');
  `);
  const adapter = new DrizzleAdapter({
    db: drizzle(database as never, { schema: { tasks } }),
    schema: { tasks }
  });

  afterAll((): void => {
    database.close();
  });

  async function drizzleIds(query: string): Promise<number[]> {
    const expression = parser.parse(query);
    const found = await adapter.execute<ITask>('tasks', expression, {
      orderBy: { id: 'asc' }
    });
    return found.map(row => row.id);
  }

  it.each([
    [
      'id:[2,3]',
      '(("id" IS NULL AND NULL) OR (typeof("id") IN (\'integer\', \'real\') AND "id" = 2)) OR (("id" IS NULL AND NULL) OR (typeof("id") IN (\'integer\', \'real\') AND "id" = 3))',
      [2, 3]
    ],
    [
      'status in (todo, doing, done)',
      "\"status\" IN ('todo', 'doing', 'done')",
      [1, 2, 3, 4]
    ],
    ['status IN (doing)', '"status" IN (\'doing\')', [2, 3]],
    ['status not in (doing)', '"status" NOT IN (\'doing\')', [1, 4]],
    [
      'id in (2,3)',
      '(("id" IS NULL AND NULL) OR (typeof("id") IN (\'integer\', \'real\') AND "id" = 2)) OR (("id" IS NULL AND NULL) OR (typeof("id") IN (\'integer\', \'real\') AND "id" = 3))',
      [2, 3]
    ],
    ['status in ("doing")', '"status" IN (\'doing\')', [2, 3]],
    ['status in ("a)b", doing)', "\"status\" IN ('a)b', 'doing')", [2, 3]],
    ['status in (not)', '"status" IN (\'not\')', []],
    ['status in (/and/)', '"status" IN (\'/and/\')', []]
  ])(
    'keeps %p complete and returns the listed rows',
    async (query, sql, ids) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(
        new SqlTranslator({ useParameters: false }).translate(expression)
      ).toBe(sql);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
      await expect(drizzleIds(query)).resolves.toEqual(ids);
    }
  );

  it.each([
    'status in (todo AND doing)',
    'status in ((todo))',
    'status in (todo'
  ])('leaves %p rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('does not read membership out of a quoted value', () => {
    const query = 'status:"status in (todo, doing, done)"';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: 'status in (todo, doing, done)'
    });
    expect(filterInMemory(query, rows)).toEqual([]);
  });
});
