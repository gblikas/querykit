/**
 * QueryKit Adapter Types
 * 
 * These are the core interfaces for adapters, which connect QueryKit to 
 * external systems or libraries like Drizzle ORM.
 */

import { QueryExpression } from '../parser/types';

/**
 * Options for configuring an adapter
 */
export interface IAdapterOptions {
  /**
   * Schema information for type safety and validation
   */
  schema?: Record<string, unknown>;
  
  /**
   * Field mappings from QueryKit fields to target database fields
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