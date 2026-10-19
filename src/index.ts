/**
 * QueryKit - A comprehensive query toolkit for TypeScript
 *
 * QueryKit simplifies how you build and execute data queries across different
 * environments with a unified, intuitive syntax for filtering, sorting, and
 * transforming data.
 */

// Core exports
import { QueryBuilder, IQueryBuilderOptions, QueryBuilderError } from './query';
import { QueryParser, IParserOptions } from './parser';
import { SqlTranslator } from './translators/sql';
import {
  DEFAULT_SECURITY_OPTIONS,
  EnforcedExclusions,
  ISecurityOptions,
  QuerySecurityError,
  QuerySecurityValidator
} from './security';
import {
  canonicalizeSecurityFields,
  respellTableQualifier,
  SchemaTables,
  selectedTableSchema
} from './security/schema-field-case';
import {
  aliasSecurityFields,
  applyEnforcedExclusions,
  canonicalFieldName
} from './security/validator';
import { IAdapter, IAdapterOptions, IQueryExecutionOptions } from './adapters';
import {
  IQueryContext,
  VirtualFieldsConfig,
  resolveVirtualFields
} from './virtual-fields';
import { assertNoVirtualSortField } from './virtual-fields/resolver';
import { QueryExpression } from './parser/types';

export {
  // Parser exports
  QueryParser,
  IParserOptions,

  // Query builder exports
  QueryBuilder,
  IQueryBuilderOptions,
  QueryBuilderError,

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
   * The schema to use for query validation. A query field and an `orderBy`
   * key are checked against the table the query selected, the one table
   * either adapter reads a field from, so a property of another table is
   * rejected before any adapter runs; a `table.` qualifier that differs
   * from the selected table only by ASCII case is read as that table. A
   * table the schema does not declare, or one that declares no property,
   * leaves the field checks to the adapter.
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
   * An `orderBy` key is folded under `caseInsensitiveFields` and renamed
   * through `fieldMappings` the way the parser treats a filter field. Under
   * `caseInsensitiveFields` a folded filter field or sort key is then
   * respelled as the one schema property differing only by ASCII case, as
   * are `allowedFields`, `denyFields` and the keys of `denyValues`; a name
   * that folds onto two properties is rejected with `QuerySecurityError`.
   * A `fieldMappings` alias and its target are one field for
   * `allowedFields`, `denyFields` and the keys of `denyValues`, and an
   * `enforceExcludedValues` key naming an alias is injected under its
   * target (see `aliasSecurityFields`).
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
  /**
   * Add a sort key. The first direction given for a key stays, as SQL keeps
   * the first of a repeated `ORDER BY` key, and a later key still breaks
   * ties. Before the adapter runs, the key is folded under
   * `caseInsensitiveFields`, renamed through `fieldMappings`, respelled as
   * the schema property it differs from only by ASCII case, and checked:
   * a virtual field is rejected with `QueryParseError`, and a key the schema
   * does not declare, that folds onto two properties, that `denyFields`
   * names or that a non-empty `allowedFields` omits is rejected with
   * `QuerySecurityError`, since ordering by a field would reveal its order.
   */
  orderBy(field: string, direction?: 'asc' | 'desc'): IQueryExecutor<TResult>;
  limit(count: number): IQueryExecutor<TResult>;
  offset(count: number): IQueryExecutor<TResult>;
}

/** What the kit needs to resolve a written field name before validation. */
interface IFieldResolution {
  /** The table the query selected. */
  table: string;
  /** The schema narrowed to that table. */
  schema: SchemaTables;
  parserOptions: IParserOptions;
}

/** A field name as the parser resolved it, with its literal marking. */
type FieldRespelling = (name: string, isLiteral: boolean) => string;

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
      `Invalid security option: queryTimeout must be an integer between 1 and ${MAX_QUERY_TIMEOUT_MS} milliseconds`
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
 * clamped to an immediate timeout, and `0` is a budget every query exceeds;
 * each would reject every query.
 *
 * @param value - Candidate timeout in milliseconds
 * @returns True for an integer from 1 to MAX_QUERY_TIMEOUT_MS inclusive
 */
function isTimeoutBudget(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
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
 * Run the adapter under the configured timeout. The timer is armed before
 * the adapter is invoked, so it bounds the asynchronous part of the call.
 * The synchronous part, during which no timer can fire, is measured when
 * the adapter returns and rejected on its own if it already used the whole
 * budget. Nothing after the adapter settles is charged to the query.
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
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(createTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    const pending = operation();
    if (performance.now() - startedAt >= timeoutMs) {
      // The timer expired while the adapter blocked the event loop, but
      // an already settled promise would still win the race below.
      pending.catch(() => undefined);
      throw createTimeoutError(timeoutMs);
    }
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the error `execute()` rejects with when the budget is exceeded.
 *
 * @param timeoutMs - The budget that was exceeded, in milliseconds
 * @returns The error `execute()` rejects with on a timeout
 */
function createTimeoutError(timeoutMs: number): QuerySecurityError {
  return new QuerySecurityError(`Query exceeded timeout of ${timeoutMs}ms`);
}

/**
 * Respell a field the parser resolved: a `table.` qualifier differing from
 * the selected table only by ASCII case becomes the table, and under
 * `caseInsensitiveFields` the folded name becomes the schema property it
 * differs from only by ASCII case, so the allowlist and both adapters see
 * one spelling.
 *
 * @throws {QuerySecurityError} When the name folds onto two properties
 */
function resolveQueryField(
  name: string,
  isLiteral: boolean,
  resolution: IFieldResolution
): string {
  const qualified = respellTableQualifier(name, resolution.table, isLiteral);
  if (!resolution.parserOptions.caseInsensitiveFields) {
    return qualified;
  }
  return canonicalFieldName(resolution.schema, qualified, isLiteral);
}

/**
 * Copy an expression with every comparison field respelled. An unchanged
 * node is returned as itself, a raw node is kept, and the literal marking
 * of a comparison is preserved.
 */
function respellFields(
  expression: QueryExpression,
  respell: FieldRespelling
): QueryExpression {
  if (expression.type === 'comparison') {
    const field = respell(expression.field, expression.isLiteral === true);
    return field === expression.field ? expression : { ...expression, field };
  }
  if (expression.type !== 'logical') {
    return expression;
  }
  const left = respellFields(expression.left, respell);
  const right = expression.right
    ? respellFields(expression.right, respell)
    : expression.right;
  if (left === expression.left && right === expression.right) {
    return expression;
  }
  return { ...expression, left, right };
}

/**
 * Resolve a sort key the way the parser resolves a filter field: fold it
 * under `caseInsensitiveFields`, rename it through an own `fieldMappings`
 * entry, then respell it as the schema property.
 *
 * @throws {QuerySecurityError} When the name folds onto two properties
 */
function resolveSortField(field: string, resolution: IFieldResolution): string {
  const { caseInsensitiveFields, fieldMappings } = resolution.parserOptions;
  const folded = caseInsensitiveFields ? field.toLowerCase() : field;
  const mapped =
    fieldMappings && Object.prototype.hasOwnProperty.call(fieldMappings, folded)
      ? fieldMappings[folded]
      : folded;
  return resolveQueryField(mapped, false, resolution);
}

/**
 * Resolve every `orderBy` key for the adapter. Two keys that resolve to one
 * name keep the direction of the first, as a repeated `ORDER BY` key does.
 */
function mapOrderFields(
  orderBy: Record<string, 'asc' | 'desc'>,
  resolution: IFieldResolution
): Record<string, 'asc' | 'desc'> {
  const mapped: Record<string, 'asc' | 'desc'> = {};
  for (const [field, direction] of Object.entries(orderBy)) {
    const resolved = resolveSortField(field, resolution);
    if (!Object.prototype.hasOwnProperty.call(mapped, resolved)) {
      mapped[resolved] = direction;
    }
  }
  return mapped;
}

/** The number of `NOT IN` comparisons `applyEnforcedExclusions` appends. */
function countInjectedExclusions(exclusions: EnforcedExclusions): number {
  return Object.values(exclusions).filter(values => values.length > 0).length;
}

/**
 * The allowlist the adapters receive: the kit's list widened by the field
 * of every injected exclusion, since the adapters check the query after
 * the exclusions are appended. An empty list stays empty, allowing every
 * field, and is not forwarded.
 */
function executionAllowedFields(
  security: Required<ISecurityOptions>
): string[] | undefined {
  if (security.allowedFields.length === 0) {
    return undefined;
  }
  const widened = [...security.allowedFields];
  for (const [field, values] of Object.entries(
    security.enforceExcludedValues
  )) {
    if (values.length > 0 && !widened.includes(field)) {
      widened.push(field);
    }
  }
  return widened;
}

/**
 * The security settings forwarded into `adapter.execute`: the resolved
 * caps, raised by one per injected exclusion so an exclusion never pushes a
 * query the kit accepted over a cap, and the widened allowlist. The kit's
 * own exclusions are already in the expression and are not forwarded.
 */
function executionSecurity(
  security: Required<ISecurityOptions>
): IQueryExecutionOptions {
  const injected = countInjectedExclusions(security.enforceExcludedValues);
  return {
    allowedFields: executionAllowedFields(security),
    maxValueLength: security.maxValueLength,
    maxQueryDepth: security.maxQueryDepth + injected,
    maxClauseCount: security.maxClauseCount + injected
  };
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
  const parserOptions = options.parserOptions ?? {};
  const foldsCase = parserOptions.caseInsensitiveFields === true;
  const schema = options.schema as unknown as SchemaTables;
  // The lists are resolved the way a field is: closed under the aliases
  // the parser maps, then respelled by the schema under the fold.
  const securityOptions = canonicalizeSecurityFields(
    aliasSecurityFields(
      resolveSecurityOptions(options.security),
      parserOptions.fieldMappings,
      foldsCase
    ),
    schema,
    foldsCase
  );
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
              // The first direction for a key stays, as SQL keeps the
              // first of a repeated ORDER BY key.
              if (!Object.prototype.hasOwnProperty.call(orderByState, field)) {
                orderByState = { ...orderByState, [field]: direction };
              }
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

              // Resolve the sort keys the way the parser resolves a filter
              // field, before any context or timer runs; a virtual field
              // keeps its own rejection. Every check reads the selected
              // table, the one table either adapter reads a field from.
              const resolution: IFieldResolution = {
                table,
                schema: selectedTableSchema(schema, table),
                parserOptions
              };
              assertNoVirtualSortField(
                Object.keys(orderByState).map(field =>
                  resolveSortField(field, resolution)
                ),
                options.virtualFields
              );
              const orderBy = mapOrderFields(orderByState, resolution);

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

              // Respell the fields as the schema declares them, then validate
              // the query and the sort keys against it and the field lists
              const respelledExpression = respellFields(
                resolvedExpression,
                (name, isLiteral) =>
                  resolveQueryField(name, isLiteral, resolution)
              );
              securityValidator.validate(
                respelledExpression,
                resolution.schema
              );
              const sortFields = Object.keys(orderBy);
              if (sortFields.length > 0) {
                securityValidator.validateSortFields(
                  sortFields,
                  resolution.schema
                );
              }

              // Apply enforced exclusions after validation (server-side RBAC enforcement)
              const finalExpression = applyEnforcedExclusions(
                respelledExpression,
                securityOptions.enforceExcludedValues
              );

              // Delegate to adapter with resource limits from security settings
              const effectiveLimit = resolveResultLimit(
                limitState,
                securityOptions
              );
              const results = await executeWithTimeout(
                () =>
                  options.adapter.execute(table, finalExpression, {
                    ...executionSecurity(securityOptions),
                    orderBy: sortFields.length > 0 ? orderBy : undefined,
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
