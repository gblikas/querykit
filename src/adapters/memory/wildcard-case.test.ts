/**
 * Letter case under a wildcard.
 *
 * SQLite's LIKE folds ASCII letters and leaves `ö` and `Ö` distinct, so
 * `status:open*` keeps `open`, `Open` and `OPEN` while `status:öpen*` keeps
 * only `öpen`. The in-memory matcher folds `A-Z` on both the pattern and
 * the value the same way. Equality stays case-sensitive on every engine.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryExpression } from '../../parser/types';
import { DrizzleTranslator } from '../../translators/drizzle';
import { SqlTranslator } from '../../translators/sql';
import { filterInMemory } from './filter-in-memory';

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

const rows: Array<{ id: number; status: string }> = [
  { id: 1, status: 'open' },
  { id: 2, status: 'Open' },
  { id: 3, status: 'OPEN' },
  { id: 4, status: 'öpen' },
  { id: 5, status: 'Öpen' },
  { id: 6, status: 'closed' }
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

describe('letter case under a wildcard', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const db = drizzle(database as never);

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${statement.sql} ORDER BY id`)
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

  function idsOfBuilder(expression: QueryExpression): number[] {
    const condition = new DrizzleTranslator({ schema: { items } }).translate(
      expression,
      { tableName: 'items' }
    );
    return db
      .select({ id: items.id })
      .from(items)
      .where(condition)
      .orderBy(items.id)
      .all()
      .map(row => row.id as number);
  }

  /** Every engine must return the same ids; returns the inline SQL. */
  function expectIds(query: string, expectedIds: number[]): string {
    expect(isInputComplete(query)).toBe(true);
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
    expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(
      expectedIds
    );
    expect(idsOfBuilder(expression)).toEqual(expectedIds);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(expectedIds);
    return inline;
  }

  it.each([
    ['status:open*', `"status" LIKE 'open%' ESCAPE '!'`, [1, 2, 3]],
    ['status:*PEN', `"status" LIKE '%PEN' ESCAPE '!'`, [1, 2, 3, 4, 5]],
    ['status:o?en', `"status" LIKE 'o_en' ESCAPE '!'`, [1, 2, 3]],
    ['status:"Open*"', `"status" LIKE 'Open%' ESCAPE '!'`, [1, 2, 3]],
    ['status:cl*ED', `"status" LIKE 'cl%ED' ESCAPE '!'`, [6]]
  ])('%s folds ASCII letters on every engine', (query, inlineSql, ids) => {
    expect(parser.parse(query)).toMatchObject({ operator: 'LIKE' });
    expect(expectIds(query, ids)).toBe(inlineSql);
  });

  it('negates the folded LIKE', () => {
    expectIds('-status:open*', [4, 5, 6]);
    expectIds('NOT status:open*', [4, 5, 6]);
  });

  it.each([
    ['status:öpen*', [4]],
    ['status:Öpen*', [5]]
  ])('%s keeps ö and Ö distinct', (query, ids) => {
    expectIds(query, ids);
  });

  it.each([
    ['status:open', { operator: '==' }, [1]],
    ['status:Open', { operator: '==' }, [2]],
    [
      'status:!=open',
      { operator: 'NOT', left: { operator: '==' } },
      [2, 3, 4, 5, 6]
    ]
  ])('%s stays case-sensitive equality', (query, shape, ids) => {
    expect(parser.parse(query)).toMatchObject(shape);
    expectIds(query, ids);
  });
});
