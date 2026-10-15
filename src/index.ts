/**
 * QueryKit - A comprehensive query toolkit for TypeScript
 *
 * QueryKit simplifies how you build and execute data queries across different
 * environments with a unified, intuitive syntax for filtering, sorting, and
 * transforming data.
 */

// Core exports
import { QueryBuilder, IQueryBuilderOptions } from './query';
import { QueryParser, IParserOptions } from './parser';
import { SqlTranslator } from './translators/sql';
import {
  DEFAULT_SECURITY_OPTIONS,
  ISecurityOptions,
  QuerySecurityError,
  QuerySecurityValidator
} from './security';
import { IAdapter, IAdapterOptions } from './adapters';
import {
  IQueryContext,
  VirtualFieldsConfig,
  resolveVirtualFields
} from './virtual-fields';
import { QueryExpression } from './parser/types';

export {
  // Parser exports
  QueryParser,
  IParserOptions,

  // Query builder exports
  QueryBuilder,
  IQueryBuilderOptions,

  // Translator exports
  SqlTranslator
};

// Re-export from modules
export * from './translators';
export * from './adapters';
export * from './virtual-fields';

/**
 * Create a new QueryBuilder instance
 */
export function createQueryBuilder<T>(
  options?: IQueryBuilderOptions<T>
): QueryBuilder<T> {
  return new QueryBuilder<T>(options);
}

/**
 * Create a new QueryParser instance
 */
export function createQueryParser(options?: IParserOptions): QueryParser {
  return new QueryParser(options);
}

/**
 * Options for creating a new QueryKit instance
 */
export interface IQueryKitOptions<
  TSchema extends Record<string, object> = Record<
    string,
    Record<string, unknown>
  >,
  TContext extends IQueryContext = IQueryContext
> {
  /**
   * The adapter to use for database connections
   */
  adapter: IAdapter;

  /**
   * The schema to use for query validation
   */
  schema: TSchema;

  /**
   * Security options for query validation
   */
  security?: ISecurityOptions;

  /**
   * Options to initialize the provided adapter
   */
  adapterOptions?: IAdapterOptions & { [key: string]: unknown };

  /**
   * Parser configuration options passed through to the QueryParser.
   * Allows configuring field name mappings, case sensitivity, and other
   * parser-level settings at the QueryKit instance level.
   *
   * @example
   * parserOptions: {
   *   caseInsensitiveFields: true,
   *   fieldMappings: {
   *     author: 'author_name',
   *     name: 'title',
   *   }
   * }
   */
  parserOptions?: IParserOptions;

  /**
   * When true, the execution pipeline uses `parseWithContext` with autofix
   * instead of `parse`, recovering gracefully from incomplete or malformed
   * queries (trailing operators, unclosed quotes, etc.) instead of throwing.
   *
   * Useful for search UIs where queries may be in a transiently incomplete
   * state when submitted.
   *
   * @default false
   */
  tolerant?: boolean;

  /**
   * Virtual field definitions for context-aware query expansion.
   * Virtual fields allow shortcuts like `my:assigned` that expand to
   * real schema fields at query execution time.
   *
   * @example
   * virtualFields: {
   *   my: {
   *     allowedValues: ['assigned', 'created'] as const,
   *     resolve: (input, ctx, { fields }) => ({
   *       type: 'comparison',
   *       field: fields({ assigned: 'assignee_id', created: 'creator_id' })[input.value],
   *       operator: '==',
   *       value: ctx.currentUserId
   *     })
   *   }
   * }
   */
  virtualFields?: VirtualFieldsConfig<TSchema, TContext>;

  /**
   * Factory function to create query execution context.
   * Called once per query execution to provide runtime values
   * for virtual field resolution.
   *
   * @example
   * createContext: async () => ({
   *   currentUserId: await getCurrentUserId(),
   *   currentUserTeamIds: await getUserTeamIds()
   * })
   */
  createContext?: () => TContext | Promise<TContext>;
}

// Define interfaces for return types
export interface IQueryExecutor<TResult> {
  execute(): Promise<TResult[]>;
  orderBy(field: string, direction?: 'asc' | 'desc'): IQueryExecutor<TResult>;
  limit(count: number): IQueryExecutor<TResult>;
  offset(count: number): IQueryExecutor<TResult>;
}

export interface IWhereClause<TResult> {
  where(queryString: string): IQueryExecutor<TResult>;
}

/**
 * Public QueryKit type
 */
export type QueryKit<
  TSchema extends Record<string, object>,
  TRows extends { [K in keyof TSchema & string]: unknown } = {
    [K in keyof TSchema & string]: unknown;
  }
> = {
  query<K extends keyof TSchema & string>(table: K): IWhereClause<TRows[K]>;
};

/**
 * Inject enforced exclusion filters into a query expression.
 *
 * For each field in `enforceExcludedValues`, appends
 * `AND field NOT IN (values)` to the expression, ensuring those records
 * are never returned regardless of what the user queried.
 *
 * This is an internal helper used by `createQueryKit`. It is applied after
 * security validation, so the exclusions are invisible to the validator.
 *
 * @param expression - The original query expression
 * @param enforceExcludedValues - Map of field → denied values to inject
 * @returns A new expression with the exclusion filters AND-ed in
 */
function applyEnforcedExclusions(
  expression: QueryExpression,
  enforceExcludedValues: Record<string, Array<string | number | boolean | null>>
): QueryExpression {
  const entries = Object.entries(enforceExcludedValues).filter(
    ([, values]) => values.length > 0
  );

  if (entries.length === 0) {
    return expression;
  }

  // Build NOT IN exclusion expressions for each field
  const exclusions: QueryExpression[] = entries.map(([field, values]) => ({
    type: 'comparison' as const,
    field,
    operator: 'NOT IN' as const,
    value: values
  }));

  // AND all exclusions together with the original expression
  return exclusions.reduce<QueryExpression>(
    (acc, exclusion) => ({
      type: 'logical' as const,
      operator: 'AND' as const,
      left: acc,
      right: exclusion
    }),
    expression
  );
}

/**
 * Largest delay `setTimeout` honours. Node and browsers keep the delay in a
 * signed 32-bit integer and run anything above it immediately.
 */
const MAX_QUERY_TIMEOUT_MS = 2147483647;

/**
 * Merge caller security options with QueryKit defaults.
 *
 * @param security - Caller security options, if any
 * @returns Fully populated security settings
 * @throws {QuerySecurityError} When a limit or the timeout is out of range
 */
function resolveSecurityOptions(
  security: ISecurityOptions | undefined
): Required<ISecurityOptions> {
  const resolved: Required<ISecurityOptions> = {
    ...DEFAULT_SECURITY_OPTIONS,
    ...definedSecurityOptions(security)
  };
  if (!isResultLimit(resolved.defaultLimit)) {
    throw new QuerySecurityError(
      'Invalid security option: defaultLimit must be a non-negative integer'
    );
  }
  if (!isResultLimit(resolved.maxLimit)) {
    throw new QuerySecurityError(
      'Invalid security option: maxLimit must be a non-negative integer'
    );
  }
  if (!isTimeoutBudget(resolved.queryTimeout)) {
    throw new QuerySecurityError(
      `Invalid security option: queryTimeout must be an integer between 0 and ${MAX_QUERY_TIMEOUT_MS} milliseconds`
    );
  }
  return resolved;
}

/**
 * Whether a value can be forwarded as a row limit. SQL `LIMIT` and the
 * in-memory window both need a non-negative integer, and `NaN` or a negative
 * `maxLimit` would otherwise switch the cap off or forward a bad value.
 *
 * @param value - Candidate limit
 * @returns True for a non-negative safe integer
 */
function isResultLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether a value can be forwarded to `setTimeout` as the query budget.
 * `NaN`, `Infinity`, a negative, or a delay above the timer range would be
 * clamped to an immediate timeout and reject every query.
 *
 * @param value - Candidate timeout in milliseconds
 * @returns True for an integer from 0 to MAX_QUERY_TIMEOUT_MS inclusive
 */
function isTimeoutBudget(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_QUERY_TIMEOUT_MS
  );
}

/**
 * Drop undefined security options so the QueryKit defaults stay in place.
 *
 * @param security - Caller security options, if any
 * @returns Provided options with undefined values removed
 */
function definedSecurityOptions(
  security: ISecurityOptions | undefined
): Partial<ISecurityOptions> {
  const provided: Partial<ISecurityOptions> = {};
  if (security === undefined) {
    return provided;
  }
  (Object.keys(security) as Array<keyof ISecurityOptions>).forEach(
    (key: keyof ISecurityOptions): void => {
      if (security[key] !== undefined) {
        Object.assign(provided, { [key]: security[key] });
      }
    }
  );
  return provided;
}

/**
 * Choose the limit forwarded to the adapter.
 *
 * An omitted limit uses `defaultLimit`. A limit above `maxLimit` is capped.
 * The chosen limit is always less than or equal to `maxLimit`.
 *
 * @param requestedLimit - Limit supplied by the caller, if any
 * @param security - Resolved security settings
 * @returns The limit to send to the adapter
 * @throws {QuerySecurityError} When the limit is not a non-negative integer
 */
function resolveResultLimit(
  requestedLimit: number | undefined,
  security: Required<ISecurityOptions>
): number {
  const chosenLimit =
    requestedLimit === undefined ? security.defaultLimit : requestedLimit;
  if (!isResultLimit(chosenLimit)) {
    throw new QuerySecurityError('Invalid query limit');
  }
  if (chosenLimit > security.maxLimit) {
    return security.maxLimit;
  }
  return chosenLimit;
}

/**
 * Run the adapter under the configured timeout. The budget starts before
 * the adapter is invoked and is checked again when its result arrives, so
 * synchronous work inside the adapter, during which no timer can fire, is
 * counted as well.
 *
 * @param operation - Starts the adapter execution
 * @param timeoutMs - Maximum time to wait, in milliseconds
 * @returns The adapter result
 * @throws {QuerySecurityError} When the operation exceeds timeoutMs
 */
async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(createTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    const result = await Promise.race([operation(), timeout]);
    if (Date.now() - startedAt > timeoutMs) {
      throw createTimeoutError(timeoutMs);
    }
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * @param timeoutMs - The budget that was exceeded, in milliseconds
 * @returns The error `execute()` rejects with on a timeout
 */
function createTimeoutError(timeoutMs: number): QuerySecurityError {
  return new QuerySecurityError(`Query exceeded timeout of ${timeoutMs}ms`);
}

/**
 * Create a new QueryKit instance
 */
export function createQueryKit<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext = IQueryContext,
  TRows extends { [K in keyof TSchema & string]: unknown } = {
    [K in keyof TSchema & string]: unknown;
  }
>(options: IQueryKitOptions<TSchema, TContext>): QueryKit<TSchema, TRows> {
  const parser = new QueryParser(options.parserOptions);
  const securityOptions = resolveSecurityOptions(options.security);
  const securityValidator = new QuerySecurityValidator(securityOptions);
  const isTolerant = options.tolerant ?? false;

  // Initialize adapter if options provided. If adapter is already initialized,
  // calling initialize again with the same options should be a no-op for most adapters.
  if (options.adapterOptions) {
    const mergedAdapterOptions: IAdapterOptions & { [key: string]: unknown } = {
      // Ensure adapter receives schema information if not already provided
      schema: options.adapterOptions.schema ?? options.schema,
      ...options.adapterOptions
    } as IAdapterOptions & { [key: string]: unknown };

    try {
      options.adapter.initialize(mergedAdapterOptions);
    } catch {
      // If initialization fails here, the adapter might already be initialized
      // or require a different init path; we'll let execute-time errors surface.
    }
  }

  // This function would be expanded to include all QueryKit functionality
  return {
    query: <K extends keyof TSchema & string>(
      table: K
    ): IWhereClause<TRows[K]> => {
      return {
        where: (queryString: string): IQueryExecutor<TRows[K]> => {
          // Parse the query, optionally using tolerant mode with autofix
          let expressionAst: QueryExpression;
          if (isTolerant) {
            const contextResult = parser.parseWithContext(queryString);
            if (contextResult.success && contextResult.ast) {
              expressionAst = contextResult.ast;
            } else if (contextResult.recovery?.autofix) {
              const retryResult = parser.parseWithContext(
                contextResult.recovery.autofix
              );
              if (retryResult.success && retryResult.ast) {
                expressionAst = retryResult.ast;
              } else {
                throw new Error(
                  `Failed to parse query even after autofix: ${contextResult.error?.message ?? 'Unknown error'}`
                );
              }
            } else {
              throw new Error(
                `Failed to parse query: ${contextResult.error?.message ?? 'Unknown error'}`
              );
            }
          } else {
            expressionAst = parser.parse(queryString);
          }

          // Execution state accumulated via fluent calls
          let orderByState: Record<string, 'asc' | 'desc'> = {};
          let limitState: number | undefined;
          let offsetState: number | undefined;

          const executor: IQueryExecutor<TRows[K]> = {
            orderBy: (
              field: string,
              direction: 'asc' | 'desc' = 'asc'
            ): IQueryExecutor<TRows[K]> => {
              orderByState = { ...orderByState, [field]: direction };
              return executor;
            },
            limit: (count: number): IQueryExecutor<TRows[K]> => {
              limitState = count;
              return executor;
            },
            offset: (count: number): IQueryExecutor<TRows[K]> => {
              offsetState = count;
              return executor;
            },
            execute: async (): Promise<TRows[K][]> => {
              // Validate that if virtual fields are configured, createContext must also be provided
              if (options.virtualFields && !options.createContext) {
                throw new Error(
                  'createContext must be provided when virtualFields is configured'
                );
              }

              // Get context if virtual fields are configured
              let context: TContext | undefined;
              if (options.virtualFields && options.createContext) {
                context = await options.createContext();
              }

              // Resolve virtual fields if configured and context is available
              let resolvedExpression = expressionAst;
              if (options.virtualFields && context) {
                resolvedExpression = resolveVirtualFields(
                  expressionAst,
                  options.virtualFields,
                  context
                );
              }

              // Validate the resolved query
              securityValidator.validate(
                resolvedExpression,
                options.schema as unknown as Record<
                  string,
                  Record<string, unknown>
                >
              );

              // Apply enforced exclusions after validation (server-side RBAC enforcement)
              const enforceExcludedValues =
                options.security?.enforceExcludedValues;
              const finalExpression =
                enforceExcludedValues &&
                Object.keys(enforceExcludedValues).length > 0
                  ? applyEnforcedExclusions(
                      resolvedExpression,
                      enforceExcludedValues
                    )
                  : resolvedExpression;

              // Delegate to adapter with resource limits from security settings
              const effectiveLimit = resolveResultLimit(
                limitState,
                securityOptions
              );
              const results = await executeWithTimeout(
                () =>
                  options.adapter.execute(table, finalExpression, {
                    orderBy:
                      Object.keys(orderByState).length > 0
                        ? orderByState
                        : undefined,
                    limit: effectiveLimit,
                    offset: offsetState
                  }),
                securityOptions.queryTimeout
              );
              return results as TRows[K][];
            }
          };

          return executor;
        }
      };
    }
  };
}

// Export all public APIs
export * from './parser';
export * from './security';
