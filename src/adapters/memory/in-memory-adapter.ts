import { sqliteWindowCount } from '../../common/sqlite-window-count';
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
import { assertFieldInScope, ITableScope } from './table-scope';
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
 * sort fields with own-property lookups, as in the Drizzle adapter, and
 * each field is held to the selected table: a `table.column` must name it
 * and the name must be a key of its rows, as a Drizzle schema holds a
 * query to the table's properties. An empty table checks the own keys of a
 * schema given to the adapter or on the execution; with no schema it has
 * no keys to check. Sort, limit, and offset run after filtering, order
 * values the way SQLite orders a column, and do not score relevance.
 *
 * @example
 * const adapter = inMemoryAdapter({ records: { tasks } });
 * const kit = createQueryKit({ adapter, schema: { tasks } });
 * const preview = await kit.query('tasks').where('status:done').execute();
 */
export class InMemoryAdapter implements IAdapter<IInMemoryAdapterOptions> {
  private records: Record<string, readonly object[]> = {};
  private fieldMappings: Record<string, string> = {};
  private schema: Record<string, unknown> | undefined;
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
   * Store the rows this adapter will filter, the field mappings to apply,
   * and the schema an empty table checks. Mappings and the schema from an
   * earlier call are replaced, not merged.
   *
   * @param options Adapter options, including `records`, optional `fieldMappings`, and optional `schema`
   * @throws {InMemoryAdapterError} When `records` is missing
   */
  public initialize(options: IInMemoryAdapterOptions): void {
    if (!options.records) {
      throw new InMemoryAdapterError('Records are required');
    }
    this.records = options.records;
    this.fieldMappings = options.fieldMappings ?? {};
    this.schema = options.schema;
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
   * @throws {InMemoryAdapterError} When the adapter is not initialized, the table is missing, a field names another table or a property no row or empty-table schema has, or the window is invalid
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
    const tableScope: ITableScope = {
      tableName,
      records: this.records,
      columns: tableColumns(tableName, options?.schema, this.schema)
    };
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
 * Read the limit and offset the way SQLite does. A boolean is 1 or 0, as
 * SQLite reads `TRUE` and `FALSE`. A canonical digit string is that integer,
 * as SQLite reads `LIMIT '2'` and `OFFSET '0'`, and so is that integer with
 * surrounding ASCII space or a decimal whose fraction is only zeros. A
 * negative limit is no limit.
 * A negative offset beside a limit is zero; with no limit it is rejected, as
 * SQLite rejects a bare OFFSET. A non-integer fraction is rejected.
 *
 * @param options Result window as the caller passed it
 * @returns The rows to skip and, when bounded, the rows to keep
 * @throws {InMemoryAdapterError} When limit or offset is not an integer, or a negative offset has no limit
 */
function resolveWindow(
  options?: IInMemoryQueryExecutionOptions
): IResultWindow {
  const limit = sqliteWindowCount(options?.limit) as number | undefined;
  const offset = sqliteWindowCount(options?.offset) as number | undefined;
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
 * The selected table's schema for an empty-table field check. The schema on
 * this call wins when it declares the table; otherwise the schema stored on
 * the adapter is used. A table neither schema declares has no columns, so
 * an empty table accepts every name.
 *
 * @param tableName - Selected table
 * @param callSchema - Schema passed to this execution, if any
 * @param storedSchema - Schema stored by `initialize`, if any
 * @returns The table object, or undefined when no schema declares an object for it
 */
function tableColumns(
  tableName: string,
  callSchema: Record<string, unknown> | undefined,
  storedSchema: Record<string, unknown> | undefined
): object | undefined {
  const schema = schemaDeclaring(callSchema, tableName)
    ? callSchema
    : storedSchema;
  if (!schemaDeclaring(schema, tableName)) {
    return undefined;
  }
  const table = schema[tableName];
  return typeof table === 'object' && table !== null ? table : undefined;
}

/**
 * Whether a schema map has the selected table as its own key.
 *
 * @param schema - Tables keyed by name, if any
 * @param tableName - Selected table
 * @returns True when the map declares that table
 */
function schemaDeclaring(
  schema: Record<string, unknown> | undefined,
  tableName: string
): schema is Record<string, unknown> {
  return (
    schema !== undefined &&
    Object.prototype.hasOwnProperty.call(schema, tableName)
  );
}

/**
 * Map the sort fields and hold each to the selected table: its qualifier
 * must name the table and some row must have the key, or the empty table's
 * schema must, as the Drizzle adapter sorts only by a property of the
 * selected table. When two keys
 * map to the same name, the first keeps its direction and the second is
 * dropped, as a repeated `ORDER BY` key is a no-op in SQL.
 *
 * @param orderBy Sort fields as the caller passed them
 * @param fieldMappings Query field name to row key
 * @param tableScope The selected table and the records map
 * @returns Mapped field and direction pairs, in insertion order
 * @throws {InMemoryAdapterError} When a direction is not asc or desc, or a key names another table or a property no row or empty-table schema has
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
    assertFieldInScope(resolved, false, tableScope);
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
