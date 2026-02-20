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
import { ISecurityOptions, QuerySecurityValidator } from './security';
import { IAdapter, IAdapterOptions } from './adapters';
import {
  IQueryContext,
  VirtualFieldsConfig,
  resolveVirtualFields
} from './virtual-fields';

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
 * Create a new QueryKit instance
 */
export function createQueryKit<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext = IQueryContext,
  TRows extends { [K in keyof TSchema & string]: unknown } = {
    [K in keyof TSchema & string]: unknown;
  }
>(options: IQueryKitOptions<TSchema, TContext>): QueryKit<TSchema, TRows> {
  const parser = new QueryParser();
  const securityValidator = new QuerySecurityValidator(options.security);

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
          // Parse the query
          const expressionAst = parser.parse(queryString);

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

              // Delegate to adapter
              const results = await options.adapter.execute(
                table,
                resolvedExpression,
                {
                  orderBy:
                    Object.keys(orderByState).length > 0
                      ? orderByState
                      : undefined,
                  limit: limitState,
                  offset: offsetState
                }
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
