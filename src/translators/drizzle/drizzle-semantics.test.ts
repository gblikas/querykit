/**
 * Semantic oracles for the Drizzle translator.
 *
 * Same patterns as the SQL translator suite: property checks against
 * equality, SQLite execution of the compiled statement, and differential
 * comparison with the SQL translator where both should accept a query.
 */

import { createRequire } from 'module';
import { sql } from 'drizzle-orm';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { QueryExpression, QueryValue } from '../../parser/types';
import { SqlTranslator } from '../sql';
import { ITranslationContext } from '../types';
import { DrizzleTranslationError, DrizzleTranslator } from './index';

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

interface ICompiledSql {
  sql: string;
  params: unknown[];
}

const FIXTURE_SQL = `
  CREATE TABLE items (
    id INTEGER,
    name TEXT,
    priority INTEGER,
    status TEXT
  );
  INSERT INTO items (id, name, priority, status) VALUES
    (1, '100%', 1, 'open'),
    (2, '100X', 2, NULL),
    (3, 'foo\\bar', 3, 'closed'),
    (4, 'fooXbar', NULL, 'open'),
    (5, 'a_b', 5, 'pending'),
    (6, 'ab', 0, 'open'),
    (7, 'axb', 7, 'open');
`;

const dialect = new SQLiteSyncDialect();

function openItemsDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(FIXTURE_SQL);
  return database;
}

function comparison(
  field: string,
  operator: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'IN' | 'NOT IN' | 'LIKE',
  value: QueryValue
): QueryExpression {
  return { type: 'comparison', field, operator, value };
}

function compile(
  expression: QueryExpression,
  schema?: Record<string, Record<string, unknown>>,
  context?: ITranslationContext
): ICompiledSql {
  const translator = new DrizzleTranslator(schema ? { schema } : {});
  const compiled = dialect.sqlToQuery(
    translator.translate(expression, context)
  );
  return { sql: compiled.sql, params: compiled.params };
}

describe('DrizzleTranslator semantics', () => {
  const database = openItemsDatabase();
  const itemSchema = {
    items: {
      id: sql.raw('id'),
      name: sql.raw('name'),
      priority: sql.raw('priority'),
      status: sql.raw('status')
    }
  };

  afterAll((): void => {
    database.close();
  });

  function matchingIds(compiled: ICompiledSql): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${compiled.sql} ORDER BY id`)
      .all(...compiled.params)
      .map(row => row.id);
  }

  it('matches null rows for equality with null', (): void => {
    const expression = comparison('status', '==', null);
    expect(matchingIds(compile(expression))).toEqual([2]);
    expect(matchingIds(compile(expression, itemSchema))).toEqual([2]);
  });

  it('matches non-null rows for inequality with null', (): void => {
    const expression = comparison('status', '!=', null);
    expect(matchingIds(compile(expression))).toEqual([1, 3, 4, 5, 6, 7]);
    expect(matchingIds(compile(expression, itemSchema))).toEqual([
      1, 3, 4, 5, 6, 7
    ]);
  });

  it('compiles multi-value IN as a list rather than a row constructor', (): void => {
    const expression = comparison('status', 'IN', ['open', 'pending']);
    const compiled = compile(expression);
    expect(compiled.sql).toBe('"status" in (?, ?)');
    expect(compiled.params).toEqual(['open', 'pending']);
    expect(matchingIds(compiled)).toEqual([1, 4, 5, 6, 7]);
  });

  it('treats a one-element IN list like equality when the member is null', (): void => {
    const expression = comparison('status', 'IN', [null]);
    expect(matchingIds(compile(expression))).toEqual([2]);
    expect(matchingIds(compile(expression, itemSchema))).toEqual([2]);
  });

  it('does not let a null member make NOT IN match nothing', (): void => {
    const expression = comparison('status', 'NOT IN', [null, 'closed']);
    expect(matchingIds(compile(expression))).toEqual([1, 4, 5, 6, 7]);
    expect(matchingIds(compile(expression, itemSchema))).toEqual([
      1, 4, 5, 6, 7
    ]);
  });

  it('compiles an empty IN list to FALSE and an empty NOT IN list to TRUE', (): void => {
    const emptyIn = compile(comparison('status', 'IN', []), itemSchema);
    const emptyNotIn = compile(comparison('status', 'NOT IN', []), itemSchema);
    expect(emptyIn.sql).toBe('FALSE');
    expect(emptyNotIn.sql).toBe('TRUE');
    expect(matchingIds(emptyIn)).toEqual([]);
    expect(matchingIds(emptyNotIn)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('treats % and _ in LIKE patterns as literals', (): void => {
    expect(matchingIds(compile(comparison('name', 'LIKE', '100%')))).toEqual([
      1
    ]);
    expect(
      matchingIds(compile(comparison('name', 'LIKE', '100%'), itemSchema))
    ).toEqual([1]);
    expect(matchingIds(compile(comparison('name', 'LIKE', 'a_b')))).toEqual([
      5
    ]);
    expect(
      matchingIds(compile(comparison('name', 'LIKE', 'a_b'), itemSchema))
    ).toEqual([5]);
  });

  it('does not let a literal backslash escape the following wildcard', (): void => {
    const compiled = compile(comparison('name', 'LIKE', 'foo\\*'));
    expect(compiled.sql).toContain("ESCAPE '!'");
    expect(compiled.params).toEqual(['foo\\%']);
    expect(matchingIds(compiled)).toEqual([3]);
    expect(
      matchingIds(compile(comparison('name', 'LIKE', 'foo\\*'), itemSchema))
    ).toEqual([3]);
  });

  it('quotes each part of a table-qualified field', (): void => {
    const compiled = compile(comparison('items.priority', '>', 2));
    expect(compiled.sql).toBe('"items"."priority" > ?');
    expect(compiled.params).toEqual([2]);
    expect(matchingIds(compiled)).toEqual([3, 5, 7]);
  });

  it('does not bind a bare field to the first table when several tables exist', (): void => {
    const compiled = compile(comparison('id', '==', 1), {
      users: { id: sql.raw('users.id') },
      todos: { id: sql.raw('todos.id') }
    });
    expect(compiled.sql).toBe('"id" = ?');
    expect(compiled.sql).not.toContain('users');
    expect(matchingIds(compiled)).toEqual([1]);
  });

  it('does not treat inherited object properties as schema columns', (): void => {
    const translator = new DrizzleTranslator({
      schema: { items: { id: sql.raw('id'), name: sql.raw('name') } }
    });
    const expression = comparison('toString', '==', 'x');
    expect(() => translator.translate(expression)).toThrow(
      DrizzleTranslationError
    );
    expect(() => translator.translate(expression)).toThrow(
      'Field toString does not name a property of table items'
    );
  });

  it('rejects non-finite numbers instead of binding them as null', (): void => {
    const translator = new DrizzleTranslator();
    const values = [Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of values) {
      expect(() =>
        translator.translate(comparison('priority', '==', value))
      ).toThrow(DrizzleTranslationError);
      expect(() =>
        translator.translate(comparison('priority', '==', value))
      ).toThrow(/Non-finite numbers are not supported/);
      expect(() =>
        translator.translate(comparison('priority', 'IN', [1, value]))
      ).toThrow(/Non-finite numbers are not supported/);
    }
  });

  it('agrees with the SQL translator on null equality and literal LIKE', (): void => {
    const databaseRows = (whereSql: string, params: unknown[]): number[] =>
      database
        .prepare(`SELECT id FROM items WHERE ${whereSql} ORDER BY id`)
        .all(...params)
        .map(row => row.id);
    const expressions = [
      comparison('status', '==', null),
      comparison('status', '!=', null),
      comparison('name', 'LIKE', '100%'),
      comparison('name', 'LIKE', 'a_b'),
      comparison('status', 'IN', [null, 'open'])
    ];
    for (const expression of expressions) {
      const sqlTranslated = new SqlTranslator({
        useParameters: true
      }).translate(expression) as { sql: string; params: unknown[] };
      const drizzleTranslated = compile(expression);
      expect(
        databaseRows(drizzleTranslated.sql, drizzleTranslated.params)
      ).toEqual(databaseRows(sqlTranslated.sql, sqlTranslated.params));
    }
  });
});

describe('DrizzleTranslator schema table lookup', () => {
  it('does not resolve inherited object properties as schema tables', (): void => {
    const schema = { items: { name: sql.raw('name') } };
    for (const field of [
      'constructor.name',
      'toString.name',
      'hasOwnProperty.name'
    ]) {
      const compiled = compile(comparison(field, '==', 'x'), schema);
      const [tableName, columnName] = field.split('.');
      expect(compiled.sql).toBe(`"${tableName}"."${columnName}" = ?`);
      expect(compiled.params).toEqual(['x']);
    }
    expect(compile(comparison('items.name', '==', 'x'), schema).sql).toBe(
      'name = ?'
    );
  });
});

describe('DrizzleTranslator membership encoding', () => {
  const flags = sqliteTable('flags', {
    id: integer('id'),
    done: integer('done', { mode: 'boolean' })
  });
  const flagSchema = { flags } as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE flags (id INTEGER, done INTEGER);
    INSERT INTO flags (id, done) VALUES (1, 1), (2, 0), (3, NULL);
  `);

  afterAll((): void => {
    database.close();
  });

  function matchingFlagIds(compiled: ICompiledSql): number[] {
    return database
      .prepare(`SELECT id FROM flags WHERE ${compiled.sql} ORDER BY id`)
      .all(...compiled.params)
      .map(row => row.id);
  }

  it('binds boolean members through the column encoder like equality does', (): void => {
    const compiled = compile(comparison('done', 'IN', [true]), flagSchema);
    expect(compiled.params).toEqual([1]);
    expect(matchingFlagIds(compiled)).toEqual([1]);
  });

  it('keeps the encoder when a null member is rewritten to IS NULL', (): void => {
    const withNull = compile(
      comparison('done', 'IN', [true, null]),
      flagSchema
    );
    expect(withNull.params).toEqual([1]);
    expect(matchingFlagIds(withNull)).toEqual([1, 3]);
    const negated = compile(
      comparison('done', 'NOT IN', [false, null]),
      flagSchema
    );
    expect(negated.params).toEqual([0]);
    expect(matchingFlagIds(negated)).toEqual([1]);
  });
});

describe('DrizzleTranslator table context', () => {
  const users = sqliteTable('users', {
    id: integer('id'),
    displayName: text('display_name'),
    active: integer('active', { mode: 'boolean' })
  });
  const teams = sqliteTable('teams', {
    id: integer('id'),
    name: text('name')
  });
  const twoTables = { users, teams } as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE users (id INTEGER, display_name TEXT, active INTEGER);
    INSERT INTO users (id, display_name, active) VALUES (1, 'Ada', 1), (2, 'Bob', 0);
  `);

  afterAll((): void => {
    database.close();
  });

  function matchingUserIds(compiled: ICompiledSql): number[] {
    return database
      .prepare(`SELECT id FROM users WHERE ${compiled.sql} ORDER BY id`)
      .all(...compiled.params)
      .map(row => row.id);
  }

  it('resolves a bare field against the selected table', (): void => {
    const compiled = compile(
      comparison('displayName', '==', 'Ada'),
      twoTables,
      { tableName: 'users' }
    );
    expect(compiled.sql).toBe('"users"."display_name" = ?');
    expect(matchingUserIds(compiled)).toEqual([1]);
  });

  it('keeps the column encoder for a bare field on the selected table', (): void => {
    const compiled = compile(comparison('active', '==', true), twoTables, {
      tableName: 'users'
    });
    expect(compiled.params).toEqual([1]);
    expect(matchingUserIds(compiled)).toEqual([1]);
  });

  it('quotes a bare field when several tables exist and none is selected', (): void => {
    const compiled = compile(comparison('displayName', '==', 'Ada'), twoTables);
    expect(compiled.sql).toBe('"displayName" = ?');
  });

  it('rejects a bare field the selected table does not have', (): void => {
    const translate = (): ICompiledSql =>
      compile(comparison('displayName', '==', 'Ada'), twoTables, {
        tableName: 'teams'
      });
    expect(translate).toThrow(DrizzleTranslationError);
    expect(translate).toThrow(
      'Field displayName does not name a property of table teams'
    );
  });

  it('reads a qualified field from the full schema whatever table is selected', (): void => {
    const compiled = compile(
      comparison('teams.name', '==', 'core'),
      twoTables,
      {
        tableName: 'users'
      }
    );
    expect(compiled.sql).toBe('"teams"."name" = ?');
  });
});
