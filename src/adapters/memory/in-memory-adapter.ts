import { IAdapter } from '../types';
import { QueryExpression } from '../../parser/types';
import { InMemoryAdapterError } from './in-memory-adapter-error';
import { canMatchExpression, filterByExpression } from './match-expression';
import {
  IInMemoryAdapterOptions,
  IInMemoryQueryExecutionOptions
} from './types';

/**
 * Adapter that filters an already fetched array with the QueryKit AST.
 *
 * Pass the same expression the Drizzle adapter compiles. Virtual fields and
 * enforced exclusions are already folded into that expression. Sort, limit,
 * and offset run after filtering and do not score relevance. The adapter's
 * `fieldMappings` are applied to comparison and sort fields before any row
 * is read, with own-property lookups as in the Drizzle adapter.
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
   * Store the rows this adapter will filter.
   *
   * @param options Adapter options, including `records`
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
   * @param options Result window
   * @returns Matching rows
   * @throws {InMemoryAdapterError} When the adapter is not initialized, the table is missing, or the window is invalid
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
    this.assertWindow(options);
    const matched = filterByExpression(
      mapExpressionFields(expression, field => this.resolveFieldName(field)),
      records
    );
    return applyResultWindow(
      matched,
      this.mapWindowFields(options)
    ) as TResult[];
  }

  /**
   * Apply `fieldMappings` to one field name. Own-property lookup, so a name
   * such as `constructor` is not mapped through the object prototype.
   *
   * @param field Field name from the expression or the sort options
   * @returns The mapped name, or the field itself when it has no mapping
   */
  private resolveFieldName(field: string): string {
    if (Object.prototype.hasOwnProperty.call(this.fieldMappings, field)) {
      return this.fieldMappings[field] ?? field;
    }
    return field;
  }

  /**
   * Apply `fieldMappings` to the sort fields of a result window.
   *
   * @param options Result window as the caller passed it
   * @returns The window with mapped sort fields
   */
  private mapWindowFields(
    options?: IInMemoryQueryExecutionOptions
  ): IInMemoryQueryExecutionOptions | undefined {
    if (!options?.orderBy) {
      return options;
    }
    const orderBy: Record<string, 'asc' | 'desc'> = {};
    for (const [field, direction] of Object.entries(options.orderBy)) {
      orderBy[this.resolveFieldName(field)] = direction;
    }
    return { ...options, orderBy };
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
   * Reject limits, offsets, and sort directions that are not safe windows.
   *
   * @param options Result window
   * @throws {InMemoryAdapterError} When limit or offset is not a non-negative integer, or a sort direction is not asc or desc
   */
  private assertWindow(options?: IInMemoryQueryExecutionOptions): void {
    if (options?.orderBy) {
      for (const direction of Object.values(options.orderBy)) {
        normalizeDirection(direction);
      }
    }
    if (
      options?.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 0)
    ) {
      throw new InMemoryAdapterError('Limit must be a non-negative integer');
    }
    if (
      options?.offset !== undefined &&
      (!Number.isInteger(options.offset) || options.offset < 0)
    ) {
      throw new InMemoryAdapterError('Offset must be a non-negative integer');
    }
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
 * Return a copy of the expression with every comparison field renamed.
 *
 * @param expression Expression to rewrite
 * @param resolve Field name mapping
 * @returns The rewritten expression. Raw and malformed nodes are returned unchanged.
 */
function mapExpressionFields(
  expression: QueryExpression,
  resolve: (field: string) => string
): QueryExpression {
  if (!expression) {
    return expression;
  }
  if (expression.type === 'comparison') {
    return { ...expression, field: resolve(expression.field) };
  }
  if (expression.type !== 'logical') {
    return expression;
  }
  return {
    ...expression,
    left: mapExpressionFields(expression.left, resolve),
    ...(expression.right && {
      right: mapExpressionFields(expression.right, resolve)
    })
  };
}

/**
 * Sort and slice after the expression has chosen the matching rows.
 *
 * @param records Matching rows
 * @param options Field order, limit, and offset
 * @returns The requested window. Field order is not a relevance rank.
 */
function applyResultWindow<T extends object>(
  records: readonly T[],
  options?: IInMemoryQueryExecutionOptions
): T[] {
  const rows = [...records];
  const orderBy = options?.orderBy;
  if (orderBy && Object.keys(orderBy).length > 0) {
    const fields: Array<[string, 'asc' | 'desc']> = Object.entries(orderBy).map(
      ([field, direction]): [string, 'asc' | 'desc'] => [
        field,
        normalizeDirection(direction)
      ]
    );
    rows.sort((left, right) => compareRows(left, right, fields));
  }
  const offset = options?.offset ?? 0;
  if (options?.limit === undefined) {
    return rows.slice(offset);
  }
  return rows.slice(offset, offset + options.limit);
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
 * Compare two rows by the requested fields, in insertion order.
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
    const compared = compareFieldValues(
      readOwnValue(left, field),
      readOwnValue(right, field)
    );
    if (compared !== 0) {
      return direction === 'desc' ? -compared : compared;
    }
  }
  return 0;
}

/**
 * Compare two field values. Null and a missing field sort first, matching
 * SQLite. Numbers stay numeric. Everything else is text order.
 *
 * @param left Field value
 * @param right Field value
 * @returns Negative when left comes first
 */
function compareFieldValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing && rightMissing) {
    return 0;
  }
  if (leftMissing) {
    return -1;
  }
  if (rightMissing) {
    return 1;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) {
    return 0;
  }
  return leftText < rightText ? -1 : 1;
}

/**
 * Read a field without walking the row's prototype.
 *
 * @param record Row
 * @param field Field name
 * @returns The own value, or undefined when the row has no such key
 */
function readOwnValue(record: object, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return undefined;
  }
  return (record as Record<string, unknown>)[field];
}
