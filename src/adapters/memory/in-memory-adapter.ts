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
 * and offset run after filtering and do not score relevance.
 *
 * @example
 * const adapter = inMemoryAdapter({ records: { tasks } });
 * const kit = createQueryKit({ adapter, schema: { tasks } });
 * const preview = await kit.query('tasks').where('status:done').execute();
 */
export class InMemoryAdapter implements IAdapter<IInMemoryAdapterOptions> {
  private records: Record<string, readonly object[]> = {};
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
    const matched = filterByExpression(expression, records);
    return applyResultWindow(matched, options) as TResult[];
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
