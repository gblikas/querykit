/**
 * In-memory adapter.
 *
 * Filters plain objects by evaluating the QueryKit AST with the same
 * operators the Drizzle translator emits.
 */

export { InMemoryAdapterError } from './in-memory-adapter-error';
export { filterInMemory } from './filter-in-memory';
export { InMemoryAdapter, inMemoryAdapter } from './in-memory-adapter';
export type { ITableScope } from './table-qualifier';
export type {
  IInMemoryAdapterOptions,
  IInMemoryFilterOptions,
  IInMemoryQueryExecutionOptions
} from './types';
