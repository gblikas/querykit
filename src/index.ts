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
  >
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
  TRows extends { [K in keyof TSchema & string]: unknown } = {
    [K in keyof TSchema & string]: unknown;
  }
>(options: IQueryKitOptions<TSchema>): QueryKit<TSchema, TRows> {
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
          // Parse and validate the query
          const expressionAst = parser.parse(queryString);
          securityValidator.validate(
            expressionAst,
            options.schema as unknown as Record<string, Record<string, unknown>>
          );

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
              // Delegate to adapter
              const results = await options.adapter.execute(
                table,
                expressionAst,
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
