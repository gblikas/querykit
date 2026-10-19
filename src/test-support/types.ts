/**
 * Types of the shared SQLite test harness.
 *
 * Test support only: this directory is excluded from the package build and
 * from coverage, like the test files themselves.
 */

import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  SQLiteColumn,
  SQLiteSyncDialect,
  SQLiteTable
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { IParserOptions, QueryExpression } from '../parser/types';

/** SQL text with its bound parameters, as the parameterized engines return it. */
export interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

/** A prepared better-sqlite3 statement, typed without `@types/better-sqlite3`. */
export interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
  run(...params: unknown[]): unknown;
}

/** An open better-sqlite3 database. */
export interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): ISqliteStatement;
  close(): void;
}

/**
 * A Drizzle SQLite table with an `id` column, as the parity tests declare
 * one; the index signature is what the Drizzle translator's schema expects.
 */
export type HarnessTable = SQLiteTable &
  Record<string, unknown> & { readonly id: SQLiteColumn };

/** A query as written, or an expression a test built by hand. */
export type QueryInput = string | QueryExpression;

/** A row the harness stores; `id` is what every engine returns. */
export interface IHarnessRow {
  id: number;
}

/** What `openSqliteHarness` needs: the table shape and its rows. */
export interface ISqliteHarnessOptions<TRow extends IHarnessRow> {
  /** The Drizzle table; its name is the SQLite table and the schema key. */
  table: HarnessTable;
  /**
   * SQL column declarations after `id INTEGER PRIMARY KEY`, keyed by the
   * column name, which is also the row property that fills it. An empty
   * string declares a column with no type affinity.
   */
  columns: Record<string, string>;
  /** The rows every engine reads; the in-memory engine reads them as they are. */
  rows: readonly TRow[];
  /** Options of the parser every engine starts from and of the in-memory filter. */
  parserOptions?: IParserOptions;
  /**
   * Maps a row property to the value SQLite stores. By default `true` and
   * `false` are stored as 1 and 0, which better-sqlite3 cannot bind.
   */
  storedValue?: (value: unknown, column: string, row: TRow) => unknown;
}

/** One query as each SQL engine compiled it. */
export interface ICompiledQuery {
  expression: QueryExpression;
  inlineSql: string;
  parameterized: IParameterizedSql;
  /** The Drizzle translator without a schema. */
  drizzle: IParameterizedSql;
  /** The Drizzle translator with the table in its schema. */
  schemaDrizzle: IParameterizedSql;
}

/** What the `expectSameIds` assertions return: the compiled forms and the agreed ids. */
export interface IEngineRun extends ICompiledQuery {
  /** The ids every engine returned: `expectedIds`, or the reference engine's. */
  ids: number[];
}

/** The ids the SQL engines returned for one query, in id order. */
export interface ISqlIdsByEngine {
  inline: number[];
  parameterized: number[];
  drizzle: number[];
  schemaDrizzle: number[];
  builder: number[];
}

/** The ids every engine returned for one query; memory ids are in row order. */
export interface IIdsByEngine extends ISqlIdsByEngine {
  memory: number[];
}

/**
 * One SQLite table shared by every engine of a parity test: inline SQL,
 * parameterized SQL, the Drizzle translator bare and with a schema, the
 * Drizzle query builder, and the in-memory filter over the same rows.
 */
export interface ISqliteHarness<TRow extends IHarnessRow> {
  readonly parser: QueryParser;
  readonly dialect: SQLiteSyncDialect;
  readonly database: ISqliteDatabase;
  readonly db: BetterSQLite3Database;
  readonly table: HarnessTable;
  readonly tableName: string;
  readonly rows: readonly TRow[];
  /** Parses the query, if given as text, and compiles it on each SQL engine without running it. */
  compile(query: QueryInput): ICompiledQuery;
  /** Ids of the table's rows the statement selects, in `orderBy` order. */
  idsOfSql(statement: IParameterizedSql, orderBy?: string): number[];
  /** The Drizzle translator's SQL for the expression, with or without a schema. */
  compileDrizzle(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): IParameterizedSql;
  /** Ids the Drizzle query builder returns for the expression, in id order. */
  idsOfBuilder(expression: QueryExpression): number[];
  /** Ids the in-memory filter returns for the query, in row order. */
  idsInMemory(query: QueryInput): number[];
  /** Runs the query on every engine and returns each engine's ids. */
  idsByEngine(query: QueryInput): IIdsByEngine;
  /** Runs the query on the SQL engines and returns each engine's ids. */
  sqlIdsByEngine(query: QueryInput): ISqlIdsByEngine;
  /**
   * Asserts that every engine returns `expectedIds`, or, when they are
   * omitted, the ids the in-memory filter returned. One failure shows the
   * ids of each engine, or the error an engine threw. Returns the compiled
   * forms and the agreed ids for further assertions.
   */
  expectSameIds(query: QueryInput, expectedIds?: number[]): IEngineRun;
  /** As `expectSameIds`, over the SQL engines only; inline SQL is the reference. */
  expectSameSqlIds(query: QueryInput, expectedIds?: number[]): IEngineRun;
}
