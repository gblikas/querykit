/**
 * Drizzle ORM Adapter for QueryKit
 *
 * This adapter connects QueryKit to Drizzle ORM for database queries.
 */

import { DrizzleTranslator } from '../../translators/drizzle';
import {
  isQuotableFieldName,
  quoteFieldIdentifiers,
  readFieldIdentifiers
} from '../../translators/field-identifiers';
import { findOwnKeyIgnoringCase } from '../../translators/own-key-case';
import { enforceTranslationSecurity } from '../../translators/translation-security';
import { ITranslationSecurity } from '../../translators/types';
import { QuerySecurityError } from '../../security/validator';
import { IAdapter, IAdapterOptions, IQueryExecutionOptions } from '../types';
import { booleanWindowCount } from '../../common/boolean-window-count';
import { QueryExpression } from '../../parser/types';
import { SQL, SQLWrapper, asc, desc, sql } from 'drizzle-orm';
import { createQueryKit, QueryKit } from '../../query-kit';
import { IQueryContext } from '../../virtual-fields';
/**
 * Type for Drizzle ORM database instance
 */
export interface IDrizzleDatabase {
  select: () => { from: (table: unknown) => IDrizzleQueryBuilder };
}

/**
 * Type for Drizzle query builder
 */
export interface IDrizzleQueryBuilder {
  where: (condition: SQL) => IDrizzleQueryBuilder;
  orderBy: (...clauses: SQL[]) => IDrizzleQueryBuilder;
  limit: (limit: number | SQL) => IDrizzleQueryBuilder;
  offset: (offset: number) => IDrizzleQueryBuilder;
  // This is already a Promise due to Drizzle's thenable implementation
  [Symbol.toStringTag]: string;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
}

/**
 * Options specific to the Drizzle adapter
 */
export interface IDrizzleAdapterOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>
> extends IAdapterOptions {
  /**
   * The Drizzle ORM database instance
   */
  db: IDrizzleDatabase | unknown;

  /**
   * Schema information with Drizzle table definitions
   */
  schema: TSchema;

  /**
   * Whether to normalize field names (e.g., lowercase them)
   */
  normalizeFieldNames?: boolean;
}

/**
 * Options for Drizzle query execution
 */
export interface IDrizzleQueryExecutionOptions extends IQueryExecutionOptions {
  /**
   * Sort fields in the format: { field: 'asc' | 'desc' }
   */
  orderBy?: Record<string, 'asc' | 'desc'>;

  /**
   * Maximum number of records to return
   */
  limit?: number;

  /**
   * Number of records to skip
   */
  offset?: number;
}

/**
 * Error thrown when adapter operations fail. When the database or Drizzle
 * rejected the query, the error it threw is kept as `cause`.
 */
export class DrizzleAdapterError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DrizzleAdapterError';
    this.cause = cause;
  }
}

/**
 * The message of an error followed by the messages of its causes. Drizzle
 * reports a failed query as `Failed query: ...` with the database's own
 * error as the cause, so a user sees the database's words as well.
 */
function describeError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && messages.length < 4) {
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      current instanceof Error
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return messages.join(': ');
}

/**
 * Adapter for Drizzle ORM
 */
export class DrizzleAdapter<
  TSchema extends Record<string, unknown> = Record<string, unknown>
> implements IAdapter<IDrizzleAdapterOptions<TSchema>>
{
  private db!: unknown;
  private schema!: TSchema;
  private translator!: DrizzleTranslator;
  private fieldMappings: Record<string, string> = {};
  private normalizeFieldNames = false;
  private initialized: boolean = false;

  /**
   * Optionally initialize via constructor for convenience
   */
  constructor(options?: IDrizzleAdapterOptions<TSchema>) {
    if (options) {
      this.initialize(options);
    }
  }

  /**
   * Initialize the adapter with options
   */
  public initialize(options: IDrizzleAdapterOptions<TSchema>): void {
    if (!options.db) {
      throw new DrizzleAdapterError('Drizzle db instance is required');
    }

    if (!options.schema) {
      throw new DrizzleAdapterError('Schema definition is required');
    }

    this.db = options.db;
    this.schema = options.schema;
    this.fieldMappings = options.fieldMappings ?? {};
    this.normalizeFieldNames = options.normalizeFieldNames ?? false;
    this.translator = new DrizzleTranslator({
      normalizeFieldNames: options.normalizeFieldNames,
      fieldMappings: options.fieldMappings,
      schema: options.schema as unknown as Record<
        string,
        Record<string, unknown>
      >
    });

    this.initialized = true;
  }

  /**
   * Execute a QueryKit expression using Drizzle ORM.
   *
   * The shared security checks on the execution options (allowlist, value
   * length, depth and clause caps) run before `select().from`, so a rejected
   * query builds nothing and reads nothing; the enforced exclusions are
   * appended by the translator. A `QuerySecurityError` is thrown as is, not
   * wrapped as an adapter error. A boolean limit or offset is read as
   * SQLite reads `TRUE` and `FALSE` (`true` is 1, `false` is 0) before that
   * check. A non-finite limit or offset (`NaN`, `Infinity`, or `-Infinity`)
   * is rejected there too: Drizzle would otherwise omit a `NaN` or
   * `-Infinity` limit and return the matching rows.
   *
   * @throws {QuerySecurityError} When the query breaks a cap or names a field outside the allowlist
   * @throws {DrizzleAdapterError} When the table is unknown, the limit or offset is not finite, or the query cannot be built or run
   */
  public async execute<TResult = unknown>(
    tableName: string,
    expression: QueryExpression,
    options?: IDrizzleQueryExecutionOptions
  ): Promise<TResult[]> {
    this.ensureInitialized();

    const table = this.getTable(tableName);

    if (!table) {
      throw new DrizzleAdapterError(`Table ${tableName} not found in schema`);
    }

    const security = this.executionSecurity(options);
    enforceTranslationSecurity(expression, {
      ...security,
      enforceExcludedValues: undefined
    });
    const window = this.booleanWindow(options);
    this.rejectNonFiniteWindow(window);

    try {
      // Start with a base query
      let query = (this.db as IDrizzleDatabase).select().from(table);

      // Add where condition if expression is provided
      if (expression) {
        const condition = this.translator.translate(expression, {
          tableName,
          ...security
        });
        query = query.where(condition);
      }

      // Add ordering if specified
      if (options?.orderBy) {
        const orderClauses: SQL[] = [];
        for (const [field, direction] of Object.entries(options.orderBy)) {
          orderClauses.push(this.orderClause(tableName, field, direction));
        }
        if (orderClauses.length > 0) {
          query = query.orderBy(...orderClauses);
        }
      }

      const limit = this.limitClause(window);
      if (limit !== undefined) {
        query = query.limit(limit);
      }

      // Add offset if specified
      if (window?.offset !== undefined) {
        query = query.offset(window.offset);
      }

      // Execute the query
      const result = await query;
      return result as TResult[];
    } catch (error) {
      if (error instanceof QuerySecurityError) {
        throw error;
      }
      throw new DrizzleAdapterError(
        `Failed to execute query: ${describeError(error)}`,
        error
      );
    }
  }

  /**
   * Reject a non-finite limit or offset before Drizzle builds the statement.
   *
   * Drizzle omits a limit when `limit >= 0` is false and omits an offset
   * when the offset is falsy. `NaN` fails both checks, and `-Infinity`
   * fails the limit check, so the clause disappears and the matching rows
   * come back. A non-finite limit beside an offset would otherwise be
   * written as `LIMIT -1`. `Infinity` passes `>= 0` and is bound, which
   * SQLite then rejects; it is still not an integer. SQLite and the
   * in-memory adapter reject the whole window. A boolean is already 1 or 0
   * here; `booleanWindow` reads it before this check.
   *
   * @param options Result window as the caller passed it
   * @throws {DrizzleAdapterError} When the limit or the offset is NaN, Infinity, or -Infinity
   */
  private rejectNonFiniteWindow(options?: IDrizzleQueryExecutionOptions): void {
    const { limit, offset } = options ?? {};
    if (limit !== undefined && !Number.isFinite(limit)) {
      throw new DrizzleAdapterError('Limit must be an integer');
    }
    if (offset !== undefined && !Number.isFinite(offset)) {
      throw new DrizzleAdapterError('Offset must be an integer');
    }
  }

  /**
   * A copy of the execution options whose boolean limit and offset are 1 and
   * 0. The caller's object is left unchanged, so a later read of the options
   * still sees the boolean. `undefined` stays `undefined`.
   *
   * @param options Result window as the caller passed it
   * @returns The same window with `true` read as 1 and `false` read as 0
   */
  private booleanWindow(
    options?: IDrizzleQueryExecutionOptions
  ): IDrizzleQueryExecutionOptions | undefined {
    if (options === undefined) {
      return undefined;
    }
    return {
      ...options,
      limit: booleanWindowCount(options.limit) as number | undefined,
      offset: booleanWindowCount(options.offset) as number | undefined
    };
  }

  /**
   * The LIMIT of one execution. SQLite rejects an OFFSET with no LIMIT and
   * reads `LIMIT -1` as no limit, while Drizzle drops a negative number, so
   * an offset with no limit, or beside a negative limit, is written as the
   * raw `-1`; a negative limit with no offset is omitted. A non-negative
   * limit is passed as given. A NaN, Infinity, or -Infinity limit or offset
   * never reaches this method; `rejectNonFiniteWindow` rejects it first.
   */
  private limitClause(
    options?: IDrizzleQueryExecutionOptions
  ): number | SQL | undefined {
    const { limit, offset } = options ?? {};
    if (limit !== undefined && limit >= 0) {
      return limit;
    }
    const hasOffset =
      limit === undefined ? (offset ?? 0) > 0 : offset !== undefined;
    return hasOffset ? sql.raw('-1') : undefined;
  }

  /**
   * The security settings of one execution, read from its options.
   */
  private executionSecurity(
    options?: IDrizzleQueryExecutionOptions
  ): ITranslationSecurity {
    return {
      allowedFields: options?.allowedFields,
      maxValueLength: options?.maxValueLength,
      maxQueryDepth: options?.maxQueryDepth,
      maxClauseCount: options?.maxClauseCount,
      enforceExcludedValues: options?.enforceExcludedValues
    };
  }

  /**
   * Check if an expression can be executed by this adapter. The check has
   * no selected table, so it is stricter than `execute`: a bare field that
   * only resolves through a table's column keys reports false here.
   *
   * @param expression The QueryKit expression to check
   * @returns true if the expression can be translated without a table, false otherwise
   */
  public canExecute(expression: QueryExpression): boolean {
    try {
      this.ensureInitialized();
      return this.translator.canTranslate(expression);
    } catch {
      return false;
    }
  }

  /**
   * Get a table from the schema. Only own keys count: a runtime table name
   * such as `constructor` must not resolve an inherited Object property.
   */
  private getTable(tableName: string): unknown {
    if (!Object.prototype.hasOwnProperty.call(this.schema, tableName)) {
      return undefined;
    }
    return (this.schema as Record<string, unknown>)[tableName];
  }

  /**
   * Build one ORDER BY clause. The direction is accepted only as ASC or
   * DESC. A key that resolves to a column of the selected table sorts by
   * that column; a `table.column` naming another table is quoted as
   * written, since Drizzle's identifier escaping does not double quotes,
   * for the engine to reject as a table outside its FROM clause; any other
   * key the selected table lacks is rejected here, because with a schema
   * the query names the property and the column name `created_at` must not
   * be guessed as a raw identifier.
   *
   * @throws {DrizzleAdapterError} When the direction is not asc or desc,
   * the key cannot be quoted, or it names no property of the selected table
   */
  private orderClause(
    tableName: string,
    field: string,
    direction: string
  ): SQL {
    const sortDirection = this.sortDirection(direction);
    const resolvedField = this.resolveFieldName(field);
    const schemaField = this.getSchemaField(tableName, resolvedField);
    if (schemaField) {
      return sortDirection === 'ASC' ? asc(schemaField) : desc(schemaField);
    }
    const quotedField = this.quoteFieldName(resolvedField);
    this.assertNamesAnotherTable(tableName, resolvedField);
    return sql`${quotedField} ${sql.raw(sortDirection)}`;
  }

  /**
   * Allow the raw path only for a single `table.column` whose table part
   * does not resolve to the selected table.
   *
   * @throws {DrizzleAdapterError} `Field <field> does not name a property
   * of table <table>` for any other key the selected table lacks
   */
  private assertNamesAnotherTable(tableName: string, fieldName: string): void {
    const parts = readFieldIdentifiers(fieldName);
    if (
      parts.length === 2 &&
      findOwnKeyIgnoringCase(this.schema, parts[0] ?? '') !== tableName
    ) {
      return;
    }
    throw new DrizzleAdapterError(
      `Field ${fieldName} does not name a property of table ${tableName}`
    );
  }

  private resolveFieldName(fieldName: string): string {
    const normalizedField = this.normalizeFieldNames
      ? fieldName.toLowerCase()
      : fieldName;
    if (
      Object.prototype.hasOwnProperty.call(this.fieldMappings, normalizedField)
    ) {
      return this.fieldMappings[normalizedField];
    }
    return normalizedField;
  }

  /**
   * Accept only `asc` or `desc`, in any letter case. Anything else is a
   * caller error rather than a request for DESC.
   */
  private sortDirection(direction: unknown): 'ASC' | 'DESC' {
    const normalized =
      typeof direction === 'string' ? direction.toLowerCase() : '';
    if (normalized === 'asc') {
      return 'ASC';
    }
    if (normalized === 'desc') {
      return 'DESC';
    }
    throw new DrizzleAdapterError(
      `Invalid sort direction: ${String(direction)}`
    );
  }

  /**
   * Quote a sort field Drizzle will inline, the way the translator quotes a
   * filter field: exactly one dot is `table.column`, anything else is one
   * identifier, and an embedded quote is doubled. Rejects names that can
   * break out of the surrounding quotes.
   */
  private quoteFieldName(fieldName: string): SQL {
    if (!isQuotableFieldName(fieldName)) {
      throw new DrizzleAdapterError(`Invalid field name: ${fieldName}`);
    }
    return sql.raw(quoteFieldIdentifiers(fieldName));
  }

  /**
   * Resolve a sort field to a column of the selected table: the table's own
   * key, or the column part of a single `table.column` whose table part
   * resolves to the selected table. Each key resolves exactly or by the one
   * own key differing only by ASCII case, the rule SQLite applies to an
   * identifier, so `orderBy('CreatedAt')` and `orderBy('Items.createdAt')`
   * reach the renamed column through its property. Anything else resolves
   * nothing, and `orderClause` decides whether it is quoted or rejected.
   */
  private getSchemaField(
    tableName: string,
    fieldName: string
  ): SQLWrapper | null {
    const table = this.getTable(tableName) as
      | Record<string, SQLWrapper>
      | undefined;
    if (!table) {
      return null;
    }
    const ownKey = findOwnKeyIgnoringCase(table, fieldName);
    if (ownKey !== undefined) {
      return table[ownKey];
    }
    const parts = readFieldIdentifiers(fieldName);
    if (
      parts.length !== 2 ||
      findOwnKeyIgnoringCase(this.schema, parts[0] ?? '') !== tableName
    ) {
      return null;
    }
    const columnKey = findOwnKeyIgnoringCase(table, parts[1] ?? '');
    return columnKey === undefined ? null : table[columnKey];
  }

  /**
   * Ensure the adapter is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new DrizzleAdapterError('Adapter has not been initialized');
    }
  }
}

/**
 * Convenience factory to create a pre-initialized Drizzle adapter
 */
export function drizzleAdapter<TSchema extends Record<string, unknown>>(
  options: IDrizzleAdapterOptions<TSchema>
): DrizzleAdapter<TSchema> {
  return new DrizzleAdapter<TSchema>(options);
}

// Helper types and factory for zero-cast DX with Drizzle tables
export type RowTypeFromDrizzleTable<TTable> = TTable extends {
  $inferSelect: infer R;
}
  ? R
  : unknown;

export type RowMapFromDrizzleSchema<TSchema extends Record<string, unknown>> = {
  [K in keyof TSchema]: RowTypeFromDrizzleTable<TSchema[K]>;
};

export function createDrizzleQueryKit<
  TSchema extends Record<string, object>
>(args: {
  db: unknown;
  schema: TSchema;
  normalizeFieldNames?: boolean;
  fieldMappings?: Record<string, string>;
  security?: import('../../security').ISecurityOptions;
}): QueryKit<TSchema, RowMapFromDrizzleSchema<TSchema>> {
  const adapter = new DrizzleAdapter<TSchema>();
  adapter.initialize({
    db: args.db,
    schema: args.schema,
    normalizeFieldNames: args.normalizeFieldNames,
    fieldMappings: args.fieldMappings
  });

  type RowMap = RowMapFromDrizzleSchema<TSchema>;

  return createQueryKit<TSchema, IQueryContext, RowMap>({
    adapter,
    schema: args.schema as unknown as TSchema,
    security: args.security
  });
}
