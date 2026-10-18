/**
 * AND/OR precedence.
 *
 * AND and OR are one precedence level and associate left, so
 * `status:a OR status:b AND priority:1` is an AND whose left child is the
 * OR. Each translator parenthesizes every operand, so SQLite follows the
 * tree rather than binding AND tighter, and every engine returns the ids
 * the tree selects. `NOT NOT status:a` does not parse.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { filterByExpression } from '../adapters/memory/match-expression';
import { QueryParseError, QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from './drizzle';
import { SqlTranslator } from './sql';

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

const rows = [
  { id: 1, status: 'a', priority: 1 },
  { id: 2, status: 'b', priority: 1 },
  { id: 3, status: 'a', priority: 2 },
  { id: 4, status: 'b', priority: 2 },
  { id: 5, status: 'c', priority: 1 },
  { id: 6, status: 'c', priority: 2 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  priority: integer('priority')
});

const rawSchema = {
  items: { status: sql.raw('status'), priority: sql.raw('priority') }
};

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, priority INTEGER)'
  );
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.status, row.priority);
  }
  return database;
}

function comparison(field: string, value: string | number): QueryExpression {
  return { type: 'comparison', field, operator: '==', value };
}

describe('AND/OR precedence', () => {
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

  it.each([
    [
      'status:a OR status:b AND priority:1',
      {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'OR',
          left: comparison('status', 'a'),
          right: comparison('status', 'b')
        },
        right: comparison('priority', 1)
      },
      `(("status" = 'a') OR ("status" = 'b')) AND ("priority" = 1)`,
      '(("status" = ?) OR ("status" = ?)) AND ("priority" = ?)',
      [1, 2]
    ],
    [
      'status:a AND status:b OR priority:1',
      {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'logical',
          operator: 'AND',
          left: comparison('status', 'a'),
          right: comparison('status', 'b')
        },
        right: comparison('priority', 1)
      },
      `(("status" = 'a') AND ("status" = 'b')) OR ("priority" = 1)`,
      '(("status" = ?) AND ("status" = ?)) OR ("priority" = ?)',
      [1, 2, 5]
    ]
  ])(
    '%s groups left to right on every engine',
    (query, tree, inlineSql, parameterizedSql, expectedIds) => {
      const expression = parser.parse(query);
      expect(expression).toEqual(tree);
      expect(parser.parseWithContext(query).ast).toEqual(tree);
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inline).toBe(inlineSql);
      expect(parameterized).toEqual({
        sql: parameterizedSql,
        params: ['a', 'b', 1]
      });
      expect(compileDrizzle(expression)).toEqual({
        sql: parameterizedSql,
        params: ['a', 'b', 1]
      });
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression, rawSchema))).toEqual(
        expectedIds
      );
      expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(
        expectedIds
      );
      expect(idsOfBuilder(expression)).toEqual(expectedIds);
      expect(filterByExpression(expression, rows).map(row => row.id)).toEqual(
        expectedIds
      );
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );

  it('differs from bare SQLite precedence only where the translators add parentheses', () => {
    expect(
      idsOfSql({
        sql: `"status" = 'a' OR "status" = 'b' AND "priority" = 1`,
        params: []
      })
    ).toEqual([1, 2, 3]);
    expect(
      idsOfSql({
        sql: `"status" = 'a' AND "status" = 'b' OR "priority" = 1`,
        params: []
      })
    ).toEqual([1, 2, 5]);
  });

  it('does not parse NOT NOT status:a', () => {
    const query = 'NOT NOT status:a';
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(
      'Syntax error at line 1 column 8'
    );
    expect(parser.validate(query)).toBe(false);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });
});
