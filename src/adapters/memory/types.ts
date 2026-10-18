import { IAdapterOptions, IQueryExecutionOptions } from '../types';
import { ITranslationSecurity } from '../../translators/types';
import { ITableScope } from './table-qualifier';

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
   * the security checks. The schema lists the names a query uses; the rows
   * use the keys. Own entries only: a name such as `constructor` is not
   * mapped through the object prototype.
   */
  fieldMappings?: Record<string, string>;
}

/**
 * Options of one in-memory filter, for `filterByExpression` and
 * `filterInMemory`. The security settings are the shared ones every
 * translator enforces, checked on the query as written before any row is
 * read; the mappings and the table scope are applied after them.
 */
export interface IInMemoryFilterOptions extends ITranslationSecurity {
  /**
   * Query field name to row key, applied after the security checks. Own
   * entries only. A mapped name loses the parser's literal marking, so
   * `"a.b"` mapped to `owner.city` reads column `city`.
   */
  fieldMappings?: Record<string, string>;

  /**
   * The selected table, when the rows belong to one. A single `table.column`
   * whose qualifier does not resolve to it is rejected before any row is
   * read, as SQLite rejects a table outside its FROM clause. Without a scope
   * the column of any single qualifier is read.
   */
  tableScope?: ITableScope;
}

/**
 * Execution options for an in-memory filter.
 */
export interface IInMemoryQueryExecutionOptions extends IQueryExecutionOptions {
  /**
   * Sort fields in insertion order. This is field order, not relevance.
   * The first direction for a key that repeats after mapping is kept.
   */
  orderBy?: Record<string, 'asc' | 'desc'>;

  /**
   * Maximum number of matching rows to return. A negative integer is no
   * limit, as SQLite reads `LIMIT -1`. A fraction is rejected.
   */
  limit?: number;

  /**
   * Number of matching rows to skip after sorting. A negative integer
   * beside a limit is zero, as SQLite reads a negative OFFSET; with no limit
   * it is rejected, as SQLite has no clause for it. A fraction is rejected.
   */
  offset?: number;
}
