import { IAdapterOptions, IQueryExecutionOptions } from '../types';

/**
 * Options for the in-memory adapter.
 */
export interface IInMemoryAdapterOptions extends IAdapterOptions {
  /**
   * Fetched rows keyed by the table name passed to `query()`.
   */
  records: Record<string, readonly object[]>;

  /**
   * Query field name to row key, applied to comparison and sort fields after
   * validation. The schema lists the names a query uses; the rows use the keys.
   */
  fieldMappings?: Record<string, string>;
}

/**
 * Execution options for an in-memory filter.
 */
export interface IInMemoryQueryExecutionOptions extends IQueryExecutionOptions {
  /**
   * Sort fields in insertion order. This is field order, not relevance.
   */
  orderBy?: Record<string, 'asc' | 'desc'>;

  /**
   * Maximum number of matching rows to return.
   */
  limit?: number;

  /**
   * Number of matching rows to skip after sorting.
   */
  offset?: number;
}
