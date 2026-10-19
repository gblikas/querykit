import { IAdapterOptions, IQueryExecutionOptions } from '../types';
import { ITranslationSecurity } from '../../translators/types';
import { ITableScope } from './table-scope';

/**
 * Options for the in-memory adapter.
 */
export interface IInMemoryAdapterOptions extends IAdapterOptions {
  /**
   * Fetched rows keyed by the table name passed to `query()`.
   */
  records: Record<string, readonly object[]>;

  /**
   * Tables keyed by name. An empty table checks a field against the own
   * keys of its table here, the way a Drizzle schema holds a query to the
   * table's properties. Without a schema an empty table has no keys to
   * check, so every name passes to read as null. A table that has a row is
   * still checked by its row keys. The schema on one execution wins when
   * it declares the selected table.
   */
  schema?: Record<string, unknown>;

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
   * read, as SQLite rejects a table outside its FROM clause, and so is a
   * name that no row of the table has, as the Drizzle adapter rejects a
   * name that is not a property of the selected table. An empty table with
   * `columns` rejects a name those columns lack; without columns every name
   * passes. Without a scope the column of any single qualifier is read and
   * a missing key reads as null.
   */
  tableScope?: ITableScope;
}

/**
 * Execution options for an in-memory filter.
 */
export interface IInMemoryQueryExecutionOptions extends IQueryExecutionOptions {
  /**
   * Tables keyed by name for this execution. When this schema declares the
   * selected table, an empty table checks that table's own keys; otherwise
   * the schema stored on the adapter is used. `createQueryKit` passes the
   * selected table here, so an adapter constructed with records only still
   * checks the kit's own keys. A table that has a row is still checked by
   * its row keys.
   */
  schema?: Record<string, unknown>;

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
