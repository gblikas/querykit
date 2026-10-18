/**
 * A dotted name in another letter case.
 *
 * SQLite resolves `"Owner"."city"` and `"owner"."City"` to column `city` of
 * table `owner`. The SQL translator quotes the name as written; the Drizzle
 * translator resolves the table and column keys by ASCII case and names
 * `"owner"."city"`; the in-memory reader reads an own key of the whole name
 * first and otherwise the column by the same case rule.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { filterInMemory, inMemoryAdapter } from '../adapters/memory';
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

const rows = [
  { id: 1, city: 'Chicago' },
  { id: 2, city: 'Austin' },
  { id: 3, city: 'Boston' }
];

const owner = sqliteTable('owner', {
  id: integer('id'),
  city: text('city')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE owner (id INTEGER PRIMARY KEY, city TEXT);
    INSERT INTO owner VALUES (1, 'Chicago'), (2, 'Austin'), (3, 'Boston');
  `);
  return database;
}

describe('a dotted name in another letter case', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { owner } });
  const memory = inMemoryAdapter({ records: { owner: rows } });

  beforeEach((): void => {
    logged.length = 0;
  });

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

  it.each(['Owner.city:Austin', 'owner.City:Austin'])(
    '%s reads column city on every engine',
    async query => {
      const expression = parser.parse(query);
      const field = query.split(':')[0];
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value: 'Austin'
      });
      const quoted = field
        .split('.')
        .map(part => `"${part}"`)
        .join('.');
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      expect(inline).toBe(`${quoted} = 'Austin'`);
      expect(parameterized).toEqual({
        sql: `${quoted} = ?`,
        params: ['Austin']
      });
      expect(compileDrizzle(expression)).toEqual({
        sql: `${quoted} = ?`,
        params: ['Austin']
      });
      expect(compileDrizzle(expression, { owner })).toEqual({
        sql: '"owner"."city" = ?',
        params: ['Austin']
      });
      expect(idsOfSql({ sql: inline, params: [] })).toEqual([2]);
      expect(idsOfSql(parameterized)).toEqual([2]);
      expect(idsOfSql(compileDrizzle(expression))).toEqual([2]);
      const viaDrizzle = await adapter.execute<{ id: number }>(
        'owner',
        expression
      );
      expect(viaDrizzle.map(row => row.id)).toEqual([2]);
      expect(logged[0]).toContain('where "owner"."city" = ?');
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual([2]);
      const viaMemory = await memory.execute<{ id: number }>(
        'owner',
        expression
      );
      expect(viaMemory.map(row => row.id)).toEqual([2]);
    }
  );

  it('sorts by Owner.city on every engine', async () => {
    const expression = parser.parse('id:>=0');
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    expect(
      database
        .prepare(
          `SELECT id FROM owner WHERE ${inline} ORDER BY "Owner"."city" ASC`
        )
        .all()
        .map(row => row.id)
    ).toEqual([2, 3, 1]);
    const viaDrizzle = await adapter.execute<{ id: number }>(
      'owner',
      expression,
      { orderBy: { 'Owner.city': 'asc' } }
    );
    expect(viaDrizzle.map(row => row.id)).toEqual([2, 3, 1]);
    expect(logged[0]).toContain('order by "owner"."city" asc');
    const viaMemory = await memory.execute<{ id: number }>(
      'owner',
      expression,
      { orderBy: { 'Owner.city': 'asc' } }
    );
    expect(viaMemory.map(row => row.id)).toEqual([2, 3, 1]);
  });

  it('reads an own key of the whole name before the column', () => {
    const literalRows = [
      { id: 1, 'owner.city': 'Chicago', city: 'Austin' },
      { id: 2, 'owner.city': 'Austin', city: 'Boston' },
      { id: 3, 'owner.city': 'Boston', city: 'Chicago' }
    ];
    for (const query of [
      'owner.city:Austin',
      'Owner.city:Austin',
      'owner.City:Austin'
    ]) {
      expect(filterInMemory(query, literalRows).map(row => row.id)).toEqual([
        2
      ]);
    }
  });
});
