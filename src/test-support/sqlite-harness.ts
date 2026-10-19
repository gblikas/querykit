/**
 * Shared SQLite harness for the engine parity tests.
 *
 * Opens an in-memory better-sqlite3 database with one table, stores the
 * given rows, and runs a query on every engine QueryKit compiles to:
 * inline SQL, parameterized SQL, the Drizzle translator bare and with the
 * table in its schema, the Drizzle query builder, and the in-memory filter
 * over the same rows. Each engine returns ids so a test can compare them.
 *
 * Test support only: excluded from the package build and from coverage.
 *
 * @example
 * const items = sqliteTable('items', { id: integer('id'), status: text('status') });
 * const harness = openSqliteHarness({
 *   table: items,
 *   columns: { status: 'TEXT' },
 *   rows: [{ id: 1, status: 'open' }, { id: 2, status: 'closed' }]
 * });
 * const run = harness.expectSameIds('status:open', [1]);
 * expect(run.inlineSql).toBe(`"status" = 'open'`);
 *
 * Side effect: registers an `afterAll` hook in the enclosing `describe`
 * (or the file) that closes the database.
 */

import { createRequire } from 'module';
import { getTableName } from 'drizzle-orm';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { IParserOptions, QueryExpression } from '../parser/types';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import {
  HarnessTable,
  ICompiledQuery,
  IHarnessRow,
  IIdsByEngine,
  IParameterizedSql,
  ISqlIdsByEngine,
  ISqliteDatabase,
  ISqliteHarness,
  ISqliteHarnessOptions
} from './types';

const nodeRequire = createRequire(__filename);

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

/** Quotes a SQLite identifier, writing an inner quote twice. */
function quoteIdentifier(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

/** better-sqlite3 cannot bind a boolean; SQLite stores one as 1 or 0. */
function storeBooleanAsInteger(value: unknown): unknown {
  return typeof value === 'boolean' ? Number(value) : value;
}

/** An engine's ids, or the error it threw, in the per-engine report. */
type EngineReport = number[] | string;

/** How each SQL engine turns a compiled query into ids. */
type SqlEngineTable = Record<
  keyof ISqlIdsByEngine,
  (harness: SqliteHarness<IHarnessRow>, compiled: ICompiledQuery) => number[]
>;

const SQL_ENGINES: SqlEngineTable = {
  inline: (harness, compiled) =>
    harness.idsOfSql({ sql: compiled.inlineSql, params: [] }),
  parameterized: (harness, compiled) =>
    harness.idsOfSql(compiled.parameterized),
  drizzle: (harness, compiled) => harness.idsOfSql(compiled.drizzle),
  schemaDrizzle: (harness, compiled) =>
    harness.idsOfSql(compiled.schemaDrizzle),
  builder: (harness, compiled) => harness.idsOfBuilder(compiled.expression)
};

/** The engine's ids, or the error it threw as `Name: message`. */
function attempt(run: () => number[]): EngineReport {
  try {
    return run();
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

/** `expectedIds` under every key of `actual`, for one diff per engine. */
function sameIdsAs<T extends object>(actual: T, expectedIds: number[]): T {
  return Object.fromEntries(
    Object.keys(actual).map(engine => [engine, expectedIds])
  ) as T;
}

class SqliteHarness<TRow extends IHarnessRow> implements ISqliteHarness<TRow> {
  public readonly parser: QueryParser;
  public readonly dialect = new SQLiteSyncDialect();
  public readonly database: ISqliteDatabase;
  public readonly db: BetterSQLite3Database;
  public readonly table: HarnessTable;
  public readonly tableName: string;
  public readonly rows: readonly TRow[];
  private readonly parserOptions: IParserOptions | undefined;
  private readonly schema: Record<string, Record<string, unknown>>;

  constructor(options: ISqliteHarnessOptions<TRow>) {
    this.table = options.table;
    this.tableName = getTableName(options.table);
    this.rows = options.rows;
    this.parserOptions = options.parserOptions;
    this.parser = new QueryParser(options.parserOptions);
    this.schema = { [this.tableName]: options.table };
    this.database = openDatabase(this.tableName, options);
    this.db = drizzle(this.database as never);
  }

  public compile(query: string): ICompiledQuery {
    const expression = this.parser.parse(query);
    const inlineSql = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    return {
      expression,
      inlineSql,
      parameterized,
      drizzle: this.compileDrizzle(expression),
      schemaDrizzle: this.compileDrizzle(expression, this.schema)
    };
  }

  public idsOfSql(statement: IParameterizedSql, orderBy = 'id'): number[] {
    return this.database
      .prepare(
        `SELECT id FROM ${quoteIdentifier(this.tableName)} WHERE ${statement.sql} ORDER BY ${orderBy}`
      )
      .all(...statement.params)
      .map(row => row.id);
  }

  public compileDrizzle(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): IParameterizedSql {
    const translator = new DrizzleTranslator(schema ? { schema } : {});
    const compiled = this.dialect.sqlToQuery(translator.translate(expression));
    return { sql: compiled.sql, params: compiled.params };
  }

  public idsOfBuilder(expression: QueryExpression): number[] {
    const condition = new DrizzleTranslator({ schema: this.schema }).translate(
      expression,
      { tableName: this.tableName }
    );
    return this.db
      .select({ id: this.table.id })
      .from(this.table)
      .where(condition)
      .orderBy(this.table.id)
      .all()
      .map(row => row.id as number);
  }

  public idsInMemory(query: string): number[] {
    return filterInMemory(query, this.rows, this.parserOptions).map(
      row => row.id
    );
  }

  public idsByEngine(query: string): IIdsByEngine {
    return { ...this.sqlIdsByEngine(query), memory: this.idsInMemory(query) };
  }

  public sqlIdsByEngine(query: string): ISqlIdsByEngine {
    return this.sqlIdsOf(this.compile(query));
  }

  public expectSameIds(query: string, expectedIds: number[]): ICompiledQuery {
    const compiled = this.compile(query);
    const actual = {
      ...this.sqlReportOf(compiled),
      memory: attempt(() => this.idsInMemory(query))
    };
    expect(actual).toEqual(sameIdsAs(actual, expectedIds));
    return compiled;
  }

  public expectSameSqlIds(
    query: string,
    expectedIds: number[]
  ): ICompiledQuery {
    const compiled = this.compile(query);
    const actual = this.sqlReportOf(compiled);
    expect(actual).toEqual(sameIdsAs(actual, expectedIds));
    return compiled;
  }

  /** Every SQL engine's ids; an engine that throws ends the run. */
  private sqlIdsOf(compiled: ICompiledQuery): ISqlIdsByEngine {
    return this.mapSqlEngines(compiled, run => run());
  }

  /** Every SQL engine's ids, or the error it threw, for one diff. */
  private sqlReportOf(
    compiled: ICompiledQuery
  ): Record<keyof ISqlIdsByEngine, EngineReport> {
    return this.mapSqlEngines(compiled, attempt);
  }

  private mapSqlEngines<T>(
    compiled: ICompiledQuery,
    evaluate: (run: () => number[]) => T
  ): Record<keyof ISqlIdsByEngine, T> {
    const entries = Object.entries(SQL_ENGINES).map(([engine, run]) => [
      engine,
      evaluate(() => run(this, compiled))
    ]);
    return Object.fromEntries(entries) as Record<keyof ISqlIdsByEngine, T>;
  }
}

/** Opens `:memory:`, creates the table and stores every row. */
function openDatabase<TRow extends IHarnessRow>(
  tableName: string,
  options: ISqliteHarnessOptions<TRow>
): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  const storedValue = options.storedValue ?? storeBooleanAsInteger;
  const columns = Object.keys(options.columns);
  const declarations = columns.map(column =>
    [quoteIdentifier(column), options.columns[column]].join(' ').trimEnd()
  );
  database.exec(
    `CREATE TABLE ${quoteIdentifier(tableName)} (${['id INTEGER PRIMARY KEY', ...declarations].join(', ')})`
  );
  const insert = database.prepare(
    `INSERT INTO ${quoteIdentifier(tableName)} (${['id', ...columns].map(quoteIdentifier).join(', ')}) VALUES (${['id', ...columns].map(() => '?').join(', ')})`
  );
  for (const row of options.rows) {
    const values = columns.map(column =>
      storedValue((row as Record<string, unknown>)[column], column, row)
    );
    insert.run(row.id, ...values);
  }
  return database;
}

/**
 * Opens one SQLite table for every engine of a parity test.
 *
 * @typeParam TRow The row shape; `id` is what the engines return.
 * @param options The Drizzle table, its SQL column declarations and rows.
 * @returns The engine runners and the `expectSameIds` assertions.
 * @throws {Error} When better-sqlite3 rejects a declaration or a row value.
 */
export function openSqliteHarness<TRow extends IHarnessRow>(
  options: ISqliteHarnessOptions<TRow>
): ISqliteHarness<TRow> {
  const harness = new SqliteHarness(options);
  afterAll((): void => {
    harness.database.close();
  });
  return harness;
}
