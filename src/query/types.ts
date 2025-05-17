import { QueryExpression } from '../parser/types';

/**
 * Represents a field in a query
 */
export type QueryField<T> = keyof T & string;

/**
 * Represents a value that can be used in a query
 */
export type QueryValue = string | number | boolean | null | Array<string | number | boolean | null>;

/**
 * Represents a comparison operator in a query
 */
export type ComparisonOperator = 
  | '==' 
  | '!=' 
  | '>' 
  | '>=' 
  | '<' 
  | '<=' 
  | 'IN' 
  | 'NOT IN'
  | 'LIKE';

/**
 * Represents a logical operator in a query
 */
export type LogicalOperator = 
  | 'AND' 
  | 'OR' 
  | 'NOT';

/**
 * Represents a sort direction
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Configuration options for the query builder
 */
export interface IQueryBuilderOptions<T> {
  /**
   * Whether to allow case-insensitive field names
   */
  caseInsensitiveFields?: boolean;
  
  /**
   * Custom field name mappings
   */
  fieldMappings?: Partial<Record<QueryField<T>, string>>;
}

/**
 * Interface for a query builder
 */
export interface IQueryBuilder<T> {
  /**
   * Add a where clause to the query
   */
  where(queryString: string): IQueryBuilder<T>;
  where(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
  
  /**
   * Add an AND where clause to the query
   */
  andWhere(queryString: string): IQueryBuilder<T>;
  andWhere(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
  
  /**
   * Add an OR where clause to the query
   */
  orWhere(queryString: string): IQueryBuilder<T>;
  orWhere(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
  
  /**
   * Add a NOT where clause to the query
   */
  notWhere(queryString: string): IQueryBuilder<T>;
  notWhere(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
  
  /**
   * Add an order by clause to the query
   */
  orderBy(field: QueryField<T>, direction?: SortDirection): IQueryBuilder<T>;
  
  /**
   * Add a limit to the query
   */
  limit(count: number): IQueryBuilder<T>;
  
  /**
   * Add an offset to the query
   */
  offset(count: number): IQueryBuilder<T>;
  
  /**
   * Get the current query expression
   */
  getExpression(): QueryExpression;
  
  /**
   * Get the current query as a string
   */
  toString(): string;
} 