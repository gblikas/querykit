/**
 * Core AST types for QueryKit's parser
 */

/**
 * Represents a comparison operator in a query expression
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
 * Represents a logical operator in a query expression
 */
export type LogicalOperator = 
  | 'AND' 
  | 'OR' 
  | 'NOT';

/**
 * Represents a value that can be used in a query expression
 */
export type QueryValue = 
  | string 
  | number 
  | boolean 
  | null 
  | Array<string | number | boolean | null>;

/**
 * Represents a comparison expression node in the AST
 */
export interface IComparisonExpression {
  type: 'comparison';
  field: string;
  operator: ComparisonOperator;
  value: QueryValue;
}

/**
 * Represents a logical expression node in the AST
 */
export interface ILogicalExpression {
  type: 'logical';
  operator: LogicalOperator;
  left: QueryExpression;
  right?: QueryExpression;
}

/**
 * Represents any valid query expression node
 */
export type QueryExpression = 
  | IComparisonExpression 
  | ILogicalExpression;

/**
 * Configuration options for the parser
 */
export interface IParserOptions {
  /**
   * Whether to allow case-insensitive field names
   */
  caseInsensitiveFields?: boolean;
  
  /**
   * Custom field name mappings
   */
  fieldMappings?: Record<string, string>;
}

/**
 * Interface for the query parser
 */
export interface IQueryParser {
  /**
   * Parse a query string into an AST
   * @param query The query string to parse
   * @returns The parsed AST
   * @throws {QueryParseError} If the query is invalid
   */
  parse(query: string): QueryExpression;
  
  /**
   * Validate a query string without fully parsing it
   * @param query The query string to validate
   * @returns true if the query is valid, false otherwise
   */
  validate(query: string): boolean;
} 