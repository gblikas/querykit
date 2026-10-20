/**
 * Portable LIKE escape shared by the SQL translator, the Drizzle translator,
 * and the in-memory matcher.
 */

import { createRequire } from 'module';
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { inMemoryAdapter } from '../adapters/memory';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from './drizzle';
import { toSqlLikePattern } from './like-pattern';
import { withNulSafeLike } from './nul-safe-like';
import { SqlTranslator } from './sql';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
  run(...params: unknown[]): void;
}

interface ISqliteDatabase {
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

const INPUT_PATTERN = 'a!b%c_d*e?';
const SQL_PATTERN = 'a!!b!%c!_d%e_';

const FIXTURE_ROWS: Array<{ id: number; name: string }> = [
  { id: 1, name: 'a!b%c_deX' },
  { id: 2, name: 'a!b%c_dZZZeQ' },
  { id: 3, name: 'a!!b%c_deX' },
  { id: 4, name: 'ab%c_deX' },
  { id: 5, name: 'a!bXc_deX' },
  { id: 6, name: 'a!b%cXdeX' },
  { id: 7, name: 'a!b%c_de' }
];

const EXPECTED_IDS = [1, 2];

function likeExpression(): QueryExpression {
  return {
    type: 'comparison',
    field: 'name',
    operator: 'LIKE',
    value: INPUT_PATTERN
  };
}

function openNamesDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.prepare('CREATE TABLE items (id INTEGER, name TEXT)').run();
  const insert = database.prepare('INSERT INTO items (id, name) VALUES (?, ?)');
  FIXTURE_ROWS.forEach(row => {
    insert.run(row.id, row.name);
  });
  return database;
}

function matchingIds(
  database: ISqliteDatabase,
  compiled: ICompiledSql
): number[] {
  return database
    .prepare(`SELECT id FROM items WHERE ${compiled.sql} ORDER BY id`)
    .all(...compiled.params)
    .map(row => row.id);
}

function escapeCharacter(sqlText: string): string {
  const match = /ESCAPE '(.*)'/.exec(sqlText);
  return match?.[1] ?? '';
}

describe('portable LIKE escape', () => {
  it('escapes the escape character, %, _, *, and ?', (): void => {
    expect(toSqlLikePattern(INPUT_PATTERN)).toBe(SQL_PATTERN);
  });

  it('emits a one-character ESCAPE that SQLite and memory both honor', async (): Promise<void> => {
    const expression = likeExpression();
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    );
    const parameterized = new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as ICompiledSql;
    expect(inline).toBe(
      withNulSafeLike(`"name" LIKE '${SQL_PATTERN}' ESCAPE '!'`)
    );
    expect(parameterized.sql).toBe(
      withNulSafeLike('"name" LIKE ? ESCAPE \'!\'')
    );
    expect(parameterized.params).toEqual([SQL_PATTERN]);
    expect(escapeCharacter(parameterized.sql)).toBe('!');
    expect(escapeCharacter(parameterized.sql)).toHaveLength(1);
    const database = openNamesDatabase();
    try {
      expect(matchingIds(database, parameterized)).toEqual(EXPECTED_IDS);
    } finally {
      database.close();
    }
    const rowsAdapter = inMemoryAdapter({ records: { items: FIXTURE_ROWS } });
    const actual = await rowsAdapter.execute<{ id: number; name: string }>(
      'items',
      expression
    );
    expect(actual.map(row => row.id)).toEqual(EXPECTED_IDS);
  });

  it('emits the same ESCAPE from the Drizzle translator', (): void => {
    const translator = new DrizzleTranslator({
      schema: { items: { name: sql.raw('name') } }
    });
    const compiled = new SQLiteSyncDialect().sqlToQuery(
      translator.translate(likeExpression())
    );
    expect(compiled.sql).toContain("ESCAPE '!'");
    expect(compiled.params).toEqual([SQL_PATTERN]);
    expect(escapeCharacter(compiled.sql)).toBe('!');
    expect(escapeCharacter(compiled.sql)).toHaveLength(1);
    const database = openNamesDatabase();
    try {
      expect(
        matchingIds(database, { sql: compiled.sql, params: compiled.params })
      ).toEqual(EXPECTED_IDS);
    } finally {
      database.close();
    }
  });
});
