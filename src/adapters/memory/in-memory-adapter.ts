import { IAdapter } from '../types';
import { QueryExpression } from '../../parser/types';
import { InMemoryAdapterError } from './in-memory-adapter-error';
import {
  canMatchExpression,
  filterByExpression,
  readRowField,
  resolveMappedField
} from './match-expression';
import { compareStoredValues } from './stored-value';
import { assertQualifierInScope, ITableScope } from './table-qualifier';
import {
  IInMemoryAdapterOptions,
  IInMemoryQueryExecutionOptions
} from './types';

/**
 * Adapter that filters an already fetched array with the QueryKit AST.
 *
 * Pass the same expression the Drizzle adapter compiles. Virtual fields and
 * the kit's enforced exclusions are already folded into that expression;
 * the shared security settings on the execution options (allowlist, value
 * length, depth and clause caps, exclusions) are checked before any row is
 * read. The adapter's `fieldMappings` are then applied to comparison and
 * sort fields with own-property lookups, as in the Drizzle adapter, and a
 * `table.column` is held to the selected table. Sort, limit, and offset run
 * after filtering, order values the way SQLite orders a column, and do not
 * score relevance.
 *
 * @example
 * const adapter = inMemoryAdapter({ records: { tasks } });
 * const kit = createQueryKit({ adapter, schema: { tasks } });
 * const preview = await kit.query('tasks').where('status:done').execute();
 */
export class InMemoryAdapter implements IAdapter<IInMemoryAdapterOptions> {
  private records: Record<string, readonly object[]> = {};
  private fieldMappings: Record<string, string> = {};
  private initialized = false;

  /**
   * @param options Records to filter. Omit to call `initialize` later.
   */
  constructor(options?: IInMemoryAdapterOptions) {
    if (options) {
      this.initialize(options);
    }
  }

  /**
   * Store the rows this adapter will filter and the field mappings to apply.
   * Mappings from an earlier call are replaced, not merged.
   *
   * @param options Adapter options, including `records` and optional `fieldMappings`
   * @throws {InMemoryAdapterError} When `records` is missing
   */
  public initialize(options: IInMemoryAdapterOptions): void {
    if (!options.records) {
      throw new InMemoryAdapterError('Records are required');
    }
    this.records = options.records;
    this.fieldMappings = options.fieldMappings ?? {};
    this.initialized = true;
  }

  /**
   * Filter one table's rows and then apply order, limit, and offset.
   *
   * @param tableName Key in the records map
   * @param expression Resolved QueryKit expression
   * @param options Security settings and the result window
   * @returns Matching rows
   * @throws {QuerySecurityError} When the query breaks a cap or names a field outside `allowedFields`
   * @throws {InMemoryAdapterError} When the adapter is not initialized, the table is missing, a field names another table, or the window is invalid
   */
  public async execute<TResult = unknown>(
    tableName: string,
    expression: QueryExpression,
    options?: IInMemoryQueryExecutionOptions
  ): Promise<TResult[]> {
    this.ensureInitialized();
    const hasTable = Object.prototype.hasOwnProperty.call(
      this.records,
      tableName
    );
    const records = hasTable ? this.records[tableName] : undefined;
    if (!hasTable || !records) {
      throw new InMemoryAdapterError(`Table ${tableName} not found in records`);
    }
    const window = resolveWindow(options);
    const tableScope: ITableScope = { tableName, records: this.records };
    const sortFields = resolveSortFields(
      options?.orderBy,
      this.fieldMappings,
      tableScope
    );
    const matched = filterByExpression(expression, records, {
      allowedFields: options?.allowedFields,
      maxValueLength: options?.maxValueLength,
      maxQueryDepth: options?.maxQueryDepth,
      maxClauseCount: options?.maxClauseCount,
      enforceExcludedValues: options?.enforceExcludedValues,
      fieldMappings: this.fieldMappings,
      tableScope
    });
    return applyResultWindow(matched, sortFields, window) as TResult[];
  }

  /**
   * Report whether this expression can be applied to plain objects.
   * Raw SQL returns false. An uninitialized adapter returns false.
   *
   * @param expression Expression to check
   * @returns True when every node is a comparison or a complete boolean
   */
  public canExecute(expression: QueryExpression): boolean {
    if (!this.initialized) {
      return false;
    }
    return canMatchExpression(expression);
  }

  /**
   * @throws {InMemoryAdapterError} When `initialize` has not been called
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new InMemoryAdapterError('Adapter has not been initialized');
    }
  }
}

/**
 * Create an initialized in-memory adapter.
 *
 * @param options Records keyed by table name
 * @returns Adapter ready for `createQueryKit`
 *
 * @example
 * const adapter = inMemoryAdapter({ records: { tasks } });
 */
export function inMemoryAdapter(
  options: IInMemoryAdapterOptions
): InMemoryAdapter {
  return new InMemoryAdapter(options);
}

/**
 * A result window after SQLite's rules: rows to skip and rows to keep.
 */
interface IResultWindow {
  offset: number;
  limit?: number;
}

/**
 * Read the limit and offset the way SQLite does. A negative limit is no
 * limit. A negative offset beside a limit is zero; with no limit it is
 * rejected, as SQLite rejects a bare OFFSET. A fraction is rejected.
 *
 * @param options Result window as the caller passed it
 * @returns The rows to skip and, when bounded, the rows to keep
 * @throws {InMemoryAdapterError} When limit or offset is not an integer, or a negative offset has no limit
 */
function resolveWindow(
  options?: IInMemoryQueryExecutionOptions
): IResultWindow {
  const { limit, offset } = options ?? {};
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new InMemoryAdapterError('Limit must be an integer');
  }
  if (offset !== undefined && !Number.isInteger(offset)) {
    throw new InMemoryAdapterError('Offset must be an integer');
  }
  if (offset !== undefined && offset < 0 && limit === undefined) {
    throw new InMemoryAdapterError('Offset must be a non-negative integer');
  }
  return {
    offset: Math.max(offset ?? 0, 0),
    limit: limit === undefined || limit < 0 ? undefined : limit
  };
}

/**
 * Map the sort fields and hold each to the selected table. When two keys
 * map to the same name, the first keeps its direction and the second is
 * dropped, as a repeated `ORDER BY` key is a no-op in SQL.
 *
 * @param orderBy Sort fields as the caller passed them
 * @param fieldMappings Query field name to row key
 * @param tableScope The selected table and the records map
 * @returns Mapped field and direction pairs, in insertion order
 * @throws {InMemoryAdapterError} When a direction is not asc or desc, or a key names another table
 */
function resolveSortFields(
  orderBy: Record<string, 'asc' | 'desc'> | undefined,
  fieldMappings: Record<string, string>,
  tableScope: ITableScope
): Array<[string, 'asc' | 'desc']> {
  const fields: Array<[string, 'asc' | 'desc']> = [];
  const seen = new Set<string>();
  for (const [field, direction] of Object.entries(orderBy ?? {})) {
    const normalized = normalizeDirection(direction);
    const resolved = resolveMappedField(field, fieldMappings);
    assertQualifierInScope(resolved, false, tableScope);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      fields.push([resolved, normalized]);
    }
  }
  return fields;
}

/**
 * Sort and slice after the expression has chosen the matching rows.
 *
 * @param records Matching rows
 * @param fields Mapped sort fields in order
 * @param window Rows to skip and rows to keep
 * @returns The requested window. Field order is not a relevance rank.
 */
function applyResultWindow<T extends object>(
  records: readonly T[],
  fields: Array<[string, 'asc' | 'desc']>,
  window: IResultWindow
): T[] {
  const rows = [...records];
  if (fields.length > 0) {
    rows.sort((left, right) => compareRows(left, right, fields));
  }
  if (window.limit === undefined) {
    return rows.slice(window.offset);
  }
  return rows.slice(window.offset, window.offset + window.limit);
}

/**
 * Accept only `asc` or `desc`, in any letter case. Anything else is a
 * caller error rather than a request for ascending order.
 *
 * @param direction Requested sort direction
 * @returns The direction in lower case
 * @throws {InMemoryAdapterError} When the direction is not asc or desc
 */
function normalizeDirection(direction: unknown): 'asc' | 'desc' {
  const normalized =
    typeof direction === 'string' ? direction.toLowerCase() : '';
  if (normalized === 'asc' || normalized === 'desc') {
    return normalized;
  }
  throw new InMemoryAdapterError(
    `Invalid sort direction: ${String(direction)}`
  );
}

/**
 * Compare two rows by the requested fields, in insertion order. Each field
 * is read the way the filter reads it (an own key by ASCII case, else the
 * column of a single `table.column`) and orders the way SQLite orders a
 * column: null and a missing field (and a stored NaN) first, then numbers
 * with a boolean as 0 or 1 and a bigint by value, then text with a Date as
 * its ISO-8601 instant. DESC reverses the values and leaves the nulls last.
 *
 * @param left Row
 * @param right Row
 * @param fields Field and direction pairs
 * @returns Negative when left comes first
 */
function compareRows(
  left: object,
  right: object,
  fields: Array<[string, 'asc' | 'desc']>
): number {
  for (const [field, direction] of fields) {
    const compared = compareStoredValues(
      readRowField(left, field),
      readRowField(right, field)
    );
    if (compared !== 0) {
      return direction === 'desc' ? -compared : compared;
    }
  }
  return 0;
}
