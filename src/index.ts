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
export interface IQueryKitOptions {
  /**
   * The adapter to use for database connections
   */
  adapter: IAdapter;

  /**
   * The schema to use for query validation
   */
  schema: Record<string, Record<string, unknown>>;

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
interface IQueryExecutor {
  execute(): Promise<unknown[]>;
  orderBy(field: string, direction?: 'asc' | 'desc'): IQueryExecutor;
  limit(count: number): IQueryExecutor;
  offset(count: number): IQueryExecutor;
}

interface IWhereClause {
  where(queryString: string): IQueryExecutor;
}

/**
 * Create a new QueryKit instance
 */
export function createQueryKit(options: IQueryKitOptions): {
  query(table: string): IWhereClause;
} {
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
    query: (table: string): IWhereClause => {
      return {
        where: (queryString: string): IQueryExecutor => {
          // Parse and validate the query
          const expressionAst = parser.parse(queryString);
          securityValidator.validate(expressionAst, options.schema);

          // Execution state accumulated via fluent calls
          let orderByState: Record<string, 'asc' | 'desc'> = {};
          let limitState: number | undefined;
          let offsetState: number | undefined;

          const executor: IQueryExecutor = {
            orderBy: (
              field: string,
              direction: 'asc' | 'desc' = 'asc'
            ): IQueryExecutor => {
              orderByState = { ...orderByState, [field]: direction };
              return executor;
            },
            limit: (count: number): IQueryExecutor => {
              limitState = count;
              return executor;
            },
            offset: (count: number): IQueryExecutor => {
              offsetState = count;
              return executor;
            },
            execute: async (): Promise<unknown[]> => {
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
              return results as unknown[];
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
