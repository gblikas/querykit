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
  adapter: unknown; // Replace with actual adapter interface

  /**
   * The schema to use for query validation
   */
  schema: Record<string, Record<string, unknown>>;

  /**
   * Security options for query validation
   */
  security?: ISecurityOptions;
}

// Define interfaces for return types
interface IQueryExecutor {
  execute(): Promise<unknown[]>;
  orderBy(field: string, direction?: 'asc' | 'desc'): IQueryExecutor;
  limit(count: number): IQueryExecutor;
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

  // This function would be expanded to include all QueryKit functionality
  return {
    query: (table: string): IWhereClause => {
      // This would be expanded to include query building functionality
      return {
        where: (queryString: string): IQueryExecutor => {
          // Parse the query
          const ast = parser.parse(queryString);

          // Validate against security constraints
          securityValidator.validate(ast, options.schema);

          // Return a query builder with the validated AST
          const executor: IQueryExecutor = {
            // Additional query methods would be added here
            orderBy: (
              /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
              _field: string,
              /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
              _direction?: 'asc' | 'desc'
            ): IQueryExecutor => {
              return executor;
            },
            /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
            limit: (_count: number): IQueryExecutor => {
              return executor;
            },
            execute: async (): Promise<unknown[]> => {
              // Actual query execution would happen here using the 'table' parameter
              console.log(`Query executed on table: ${table}`);
              return [];
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
