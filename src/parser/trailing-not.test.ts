/**
 * Trailing NOT.
 *
 * `status:open NOT` is incomplete and `parse` rejects it, but recovery used
 * to offer the autofix `status:open`, so tolerant execution dropped the word
 * and returned every open row. A trailing `NOT` still reports
 * `trailing_operator` with its suggestion and has no autofix; a trailing
 * `AND` or `OR` keeps the autofix that removes the word. The engines are
 * never built for a rejected query, so none of them returns an id.
 */

import { createRequire } from 'module';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { createQueryKit } from '../index';
import { filterInMemory, inMemoryAdapter } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { QueryExpression } from './types';

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

interface IItem {
  id: number;
  status: string;
  label: string | null;
}

interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

const rows: IItem[] = [
  { id: 1, status: 'open', label: null },
  { id: 2, status: 'closed', label: 'x' },
  { id: 3, status: 'open', label: 'x' },
  { id: 4, status: 'open', label: 'y' }
];

const NO_PARSINGS = 'Failed to parse query: Found no parsings.';

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, label TEXT)'
  );
  const insert = database.prepare(
    'INSERT INTO items (id, status, label) VALUES (?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, row.status, row.label);
  }
  return database;
}

describe('trailing NOT', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const tolerantKit = createQueryKit({
    adapter: inMemoryAdapter({ records: { items: rows } }),
    schema: { items: { id: 'number', status: 'string', label: 'string' } },
    tolerant: true
  });

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${statement.sql} ORDER BY id`)
      .all(...statement.params)
      .map(row => row.id);
  }

  function inlineSql(expression: QueryExpression): string {
    return new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
  }

  function parameterizedSql(expression: QueryExpression): IParameterizedSql {
    return new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as IParameterizedSql;
  }

  function drizzleSql(expression: QueryExpression): IParameterizedSql {
    const compiled = dialect.sqlToQuery(
      new DrizzleTranslator().translate(expression)
    );
    return { sql: compiled.sql, params: compiled.params };
  }

  async function tolerantIds(query: string): Promise<number[]> {
    const results = await tolerantKit.query('items').where(query).execute();
    return (results as IItem[]).map(row => row.id);
  }

  it.each([
    'status:open NOT',
    'status:open AND NOT',
    'NOT',
    'status:open not',
    'status:open AND not',
    'not',
    'status:open NOT ',
    'status:open AND NOT ',
    'NOT ',
    '(status:open) NOT'
  ])('keeps %p rejected and offers no autofix', async query => {
    expect(isInputComplete(query)).toBe(false);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(context.recovery?.issue).toBe('trailing_operator');
    expect(context.recovery?.suggestion).toBe(
      'Add a condition after the operator or remove it'
    );
    expect(context.recovery?.autofix).toBeUndefined();
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(NO_PARSINGS);
    expect(() => filterInMemory(query, rows)).toThrow(NO_PARSINGS);
    expect(() => inlineSql(parser.parse(query))).toThrow(NO_PARSINGS);
    expect(() => parameterizedSql(parser.parse(query))).toThrow(NO_PARSINGS);
    expect(() => drizzleSql(parser.parse(query))).toThrow(NO_PARSINGS);
    await expect(tolerantIds(query)).rejects.toThrow('Failed to parse query');
  });

  it('still drops a trailing AND or OR through the autofix', async () => {
    expect(parser.parseWithContext('status:open AND').recovery?.autofix).toBe(
      'status:open'
    );
    expect(parser.parseWithContext('status:open OR').recovery?.autofix).toBe(
      'status:open'
    );
    await expect(tolerantIds('status:open AND')).resolves.toEqual([1, 3, 4]);
  });

  it('keeps NOT NOT status:open rejected with no autofix', () => {
    // Completeness for a stacked NOT is the search box's rule (layer 3).
    const context = parser.parseWithContext('NOT NOT status:open');
    expect(context.success).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
    expect(() => parser.parse('NOT NOT status:open')).toThrow(
      'Failed to parse query: Syntax error at line 1 column 8'
    );
    expect(() => filterInMemory('NOT NOT status:open', rows)).toThrow(
      'Syntax error at line 1 column 8'
    );
  });

  it('matches only the open row labelled y for status:open AND NOT label:x', async () => {
    const query = 'status:open AND NOT label:x';
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'logical',
      operator: 'AND',
      left: {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'open'
      },
      right: {
        type: 'logical',
        operator: 'NOT',
        left: { type: 'comparison', field: 'label', operator: '==', value: 'x' }
      }
    });
    expect(inlineSql(expression)).toBe(
      `("status" = 'open') AND (NOT ("label" = 'x'))`
    );
    expect(parameterizedSql(expression)).toEqual({
      sql: '("status" = ?) AND (NOT ("label" = ?))',
      params: ['open', 'x']
    });
    expect(drizzleSql(expression)).toEqual({
      sql: '("status" = ?) AND (NOT ("label" = ?))',
      params: ['open', 'x']
    });
    expect(idsOfSql({ sql: inlineSql(expression), params: [] })).toEqual([4]);
    expect(idsOfSql(parameterizedSql(expression))).toEqual([4]);
    expect(idsOfSql(drizzleSql(expression))).toEqual([4]);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([4]);
    await expect(tolerantIds(query)).resolves.toEqual([4]);
  });

  it('matches the three open rows for status:open', async () => {
    const expression = parser.parse('status:open');
    expect(inlineSql(expression)).toBe(`"status" = 'open'`);
    expect(parameterizedSql(expression)).toEqual({
      sql: '"status" = ?',
      params: ['open']
    });
    expect(drizzleSql(expression)).toEqual({
      sql: '"status" = ?',
      params: ['open']
    });
    expect(idsOfSql(parameterizedSql(expression))).toEqual([1, 3, 4]);
    expect(idsOfSql(drizzleSql(expression))).toEqual([1, 3, 4]);
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([
      1, 3, 4
    ]);
    await expect(tolerantIds('status:open')).resolves.toEqual([1, 3, 4]);
  });
});
