/**
 * QueryKit Adapter Types
 *
 * These are the core interfaces for adapters, which connect QueryKit to
 * external systems or libraries like Drizzle ORM.
 */

import { QueryExpression } from '../parser/types';
import { EnforcedExclusions } from '../security/types';

/**
 * Options for configuring an adapter
 */
export interface IAdapterOptions {
  /**
   * Schema information for type safety and validation
   */
  schema?: Record<string, unknown>;

  /**
   * Field mappings from QueryKit fields to the names the adapter reads: a
   * Drizzle schema property or an in-memory row key, not a database column
   * name, which neither adapter resolves
   */
  fieldMappings?: Record<string, string>;
}

/**
 * Options for a query execution
 */
export interface IQueryExecutionOptions {
  /**
   * Optional transaction object
   */
  transaction?: unknown;

  /**
   * Fields the query may name. An omitted or empty list allows every field.
   * The adapter rejects any other field with `QuerySecurityError` before it
   * builds a query or reads a row.
   */
  allowedFields?: readonly string[];

  /**
   * Longest string value, alone or as a membership member. Default 1000.
   */
  maxValueLength?: number;

  /**
   * Deepest nesting of logical nodes. Default 10.
   */
  maxQueryDepth?: number;

  /**
   * Most comparisons in one query. Default 50.
   */
  maxClauseCount?: number;

  /**
   * Values to exclude per field, appended as `AND field NOT IN (values)`
   * after the checks above. `createQueryKit` applies its own map before it
   * calls the adapter and does not pass it here.
   */
  enforceExcludedValues?: EnforcedExclusions;

  /**
   * Additional parameters specific to the adapter
   */
  [key: string]: unknown;
}

/**
 * Interface for a query adapter
 */
export interface IAdapter<TOptions extends IAdapterOptions = IAdapterOptions> {
  /**
   * Initialize the adapter with options
   *
   * @param options Adapter-specific options
   */
  initialize(options: TOptions): void;

  /**
   * Execute a QueryKit expression and return results
   *
   * @param tableName The table/collection name to query
   * @param expression The QueryKit expression to execute
   * @param options Optional execution options
   * @returns The query results
   */
  execute<T = unknown>(
    tableName: string,
    expression: QueryExpression,
    options?: IQueryExecutionOptions
  ): Promise<T[]>;

  /**
   * Check if an expression can be executed by this adapter
   *
   * @param expression The QueryKit expression to check
   * @returns true if the expression can be executed, false otherwise
   */
  canExecute(expression: QueryExpression): boolean;
}
