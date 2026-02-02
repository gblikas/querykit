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
export type LogicalOperator = 'AND' | 'OR' | 'NOT';

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
export type QueryExpression = IComparisonExpression | ILogicalExpression;

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

  /**
   * Parse a query string with full context information
   * @param query The query string to parse
   * @param options Options for context parsing
   * @returns Rich parse result with tokens, AST, structure, and more
   */
  parseWithContext(
    query: string,
    options?: IParseWithContextOptions
  ): IQueryParseResult;
}

/**
 * Options for parseWithContext
 */
export interface IParseWithContextOptions {
  /**
   * Cursor position in the input (for cursor-aware features)
   */
  cursorPosition?: number;
}

/**
 * Structural analysis of a query
 */
export interface IQueryStructure {
  /**
   * Maximum nesting depth of the query
   * e.g., "a:1 AND (b:2 OR c:3)" has depth 2
   */
  depth: number;

  /**
   * Total number of comparison clauses
   * e.g., "a:1 AND b:2 OR c:3" has 3 clauses
   */
  clauseCount: number;

  /**
   * Number of logical operators (AND, OR, NOT)
   */
  operatorCount: number;

  /**
   * Whether parentheses are balanced
   */
  hasBalancedParentheses: boolean;

  /**
   * Whether all quotes are closed
   */
  hasBalancedQuotes: boolean;

  /**
   * Whether the query appears structurally complete
   * (no trailing operators, no unclosed constructs)
   */
  isComplete: boolean;

  /**
   * List of fields referenced in the query
   */
  referencedFields: string[];

  /**
   * Complexity classification
   */
  complexity: 'simple' | 'moderate' | 'complex';
}

/**
 * Error information when parsing fails
 */
export interface IQueryParseErrorInfo {
  /**
   * Error message
   */
  message: string;

  /**
   * Position in the input where the error occurred (if known)
   */
  position?: number;

  /**
   * The portion of input that caused the error (if identifiable)
   */
  problematicText?: string;
}

/**
 * Result of parseWithContext - provides rich context about the query
 */
export interface IQueryParseResult {
  /**
   * Whether parsing succeeded
   */
  success: boolean;

  /**
   * The original input string
   */
  input: string;

  /**
   * Parsed AST (only present if success is true)
   */
  ast?: QueryExpression;

  /**
   * Error information (only present if success is false)
   */
  error?: IQueryParseErrorInfo;

  /**
   * Tokenized representation of the input
   * Always present, even if parsing failed
   */
  tokens: IQueryToken[];

  /**
   * The token at the cursor position (if cursorPosition was provided)
   */
  activeToken?: IQueryToken;

  /**
   * Index of the active token (-1 if none)
   */
  activeTokenIndex: number;

  /**
   * Structural analysis of the query
   */
  structure: IQueryStructure;
}

/**
 * A token in the parsed query (term or operator)
 */
export type IQueryToken = IQueryTermToken | IQueryOperatorToken;

/**
 * A term token (field:value pair or bare value)
 */
export interface IQueryTermToken {
  type: 'term';
  key: string | null;
  operator: string | null;
  value: string | null;
  startPosition: number;
  endPosition: number;
  raw: string;
}

/**
 * A logical operator token (AND, OR, NOT)
 */
export interface IQueryOperatorToken {
  type: 'operator';
  operator: 'AND' | 'OR' | 'NOT';
  startPosition: number;
  endPosition: number;
  raw: string;
}
