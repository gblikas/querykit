/**
 * A dotted field `owner.city`.
 *
 * The SQL names two identifiers, `"owner"."city"`: column `city` of table
 * `owner`. The in-memory reader reads an own key `owner.city` when the row
 * has one and otherwise the own key `city`, the column SQL addresses. A
 * nested `{ owner: { city } }` is not walked.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from './drizzle';
import { SqlTranslator } from './sql';

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

const owner = sqliteTable('owner', {
  id: integer('id'),
  city: text('city')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE owner (id INTEGER PRIMARY KEY, city TEXT);
    INSERT INTO owner VALUES (1, 'Austin'), (2, 'Boston'), (3, NULL);
  `);
  return database;
}

describe('a dotted field', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const db = drizzle(database as never);
  const query = 'owner.city:Austin';

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM owner WHERE ${statement.sql} ORDER BY id`)
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

  it('names column city of table owner on every SQL engine', () => {
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'owner.city',
      operator: '==',
      value: 'Austin'
    });
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    const bare = compileDrizzle(expression);
    const schemaDrizzle = compileDrizzle(expression, { owner });
    expect(inline).toBe(`"owner"."city" = 'Austin'`);
    expect(parameterized).toEqual({
      sql: '"owner"."city" = ?',
      params: ['Austin']
    });
    expect(bare).toEqual({ sql: '"owner"."city" = ?', params: ['Austin'] });
    expect(schemaDrizzle).toEqual({
      sql: '"owner"."city" = ?',
      params: ['Austin']
    });
    expect(idsOfSql({ sql: inline, params: [] })).toEqual([1]);
    expect(idsOfSql(parameterized)).toEqual([1]);
    expect(idsOfSql(bare)).toEqual([1]);
    expect(idsOfSql(schemaDrizzle)).toEqual([1]);
    const condition = new DrizzleTranslator({ schema: { owner } }).translate(
      expression,
      { tableName: 'owner' }
    );
    expect(
      db
        .select({ id: owner.id })
        .from(owner)
        .where(condition)
        .orderBy(owner.id)
        .all()
        .map(row => row.id)
    ).toEqual([1]);
  });

  it('reads the column in memory when the row has no key of the whole name', () => {
    const columnRows = [
      { id: 1, city: 'Austin' },
      { id: 2, city: 'Boston' },
      { id: 3, city: null }
    ];
    expect(filterInMemory(query, columnRows).map(row => row.id)).toEqual([1]);
    expect(
      filterInMemory('owner.city:null', columnRows).map(r => r.id)
    ).toEqual([3]);
  });

  it('reads an own key of the whole name first', () => {
    const literalRows = [
      { id: 1, 'owner.city': 'Austin', city: 'Boston' },
      { id: 2, 'owner.city': 'Boston', city: 'Austin' }
    ];
    expect(filterInMemory(query, literalRows).map(row => row.id)).toEqual([1]);
  });

  it('does not walk a nested object', () => {
    const nestedRows = [
      { id: 1, owner: { city: 'Austin' } },
      { id: 2, owner: { city: 'Boston' } }
    ];
    expect(filterInMemory(query, nestedRows)).toEqual([]);
  });
});
