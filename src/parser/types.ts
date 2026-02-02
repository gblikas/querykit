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

  /**
   * Schema to validate fields against.
   * Keys are field names, values describe the field type.
   * When provided, enables field validation in the result.
   */
  schema?: Record<string, IFieldSchema>;

  /**
   * Security options for pre-validation.
   * When provided, enables security pre-check in the result.
   */
  securityOptions?: ISecurityOptionsForContext;
}

/**
 * Field schema definition for validation
 */
export interface IFieldSchema {
  /**
   * The type of the field
   */
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'unknown';

  /**
   * Whether the field is required (for documentation purposes)
   */
  required?: boolean;

  /**
   * Allowed values for the field (for enums)
   */
  allowedValues?: Array<string | number | boolean>;

  /**
   * Human-readable description of the field
   */
  description?: string;
}

/**
 * Security options for parseWithContext (subset of full security options)
 */
export interface ISecurityOptionsForContext {
  /**
   * List of fields that are allowed to be queried
   */
  allowedFields?: string[];

  /**
   * List of fields that are denied from being queried
   */
  denyFields?: string[];

  /**
   * Maximum query depth allowed
   */
  maxQueryDepth?: number;

  /**
   * Maximum number of clauses allowed
   */
  maxClauseCount?: number;

  /**
   * Whether to allow dot notation in field names
   */
  allowDotNotation?: boolean;
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

  /**
   * Field validation results (only present if schema was provided in options)
   */
  fieldValidation?: IFieldValidationResult;

  /**
   * Security pre-check results (only present if securityOptions was provided)
   */
  security?: ISecurityCheckResult;

  /**
   * Autocomplete suggestions based on cursor position
   * Only present if cursorPosition was provided in options
   */
  suggestions?: IAutocompleteSuggestions;

  /**
   * Error recovery hints (only present if parsing failed)
   */
  recovery?: IErrorRecovery;
}

/**
 * Autocomplete suggestions based on cursor context
 */
export interface IAutocompleteSuggestions {
  /**
   * The context where the cursor is positioned
   */
  context: 'field' | 'operator' | 'value' | 'logical_operator' | 'empty';

  /**
   * The current field being edited (if in value context)
   */
  currentField?: string;

  /**
   * Suggested field names (when in field context)
   */
  fields?: IFieldSuggestion[];

  /**
   * Suggested values (when in value context and schema has allowedValues)
   */
  values?: IValueSuggestion[];

  /**
   * Suggested operators (when in operator context)
   */
  operators?: IOperatorSuggestion[];

  /**
   * Suggested logical operators (AND, OR, NOT)
   */
  logicalOperators?: string[];

  /**
   * The text that would be replaced by the suggestion
   */
  replaceText?: string;

  /**
   * Position range that would be replaced
   */
  replaceRange?: { start: number; end: number };
}

/**
 * A field suggestion for autocomplete
 */
export interface IFieldSuggestion {
  /**
   * The field name
   */
  field: string;

  /**
   * The field type (from schema)
   */
  type?: string;

  /**
   * Description of the field (from schema)
   */
  description?: string;

  /**
   * Match score (higher is better match)
   */
  score: number;
}

/**
 * A value suggestion for autocomplete
 */
export interface IValueSuggestion {
  /**
   * The suggested value
   */
  value: string | number | boolean;

  /**
   * Display label (may differ from value)
   */
  label?: string;

  /**
   * Match score (higher is better match)
   */
  score: number;
}

/**
 * An operator suggestion for autocomplete
 */
export interface IOperatorSuggestion {
  /**
   * The operator symbol
   */
  operator: string;

  /**
   * Human-readable description
   */
  description: string;

  /**
   * Whether this operator is applicable to the current field type
   */
  applicable: boolean;
}

/**
 * Error recovery suggestions
 */
export interface IErrorRecovery {
  /**
   * The type of issue detected
   */
  issue:
    | 'unclosed_quote'
    | 'unclosed_parenthesis'
    | 'trailing_operator'
    | 'missing_value'
    | 'missing_operator'
    | 'syntax_error';

  /**
   * Human-readable description of the issue
   */
  message: string;

  /**
   * Suggested fix description
   */
  suggestion: string;

  /**
   * The corrected query (if auto-fix is possible)
   */
  autofix?: string;

  /**
   * Position where the issue was detected
   */
  position?: number;
}

/**
 * Result of field validation against schema
 */
export interface IFieldValidationResult {
  /**
   * Whether all fields passed validation
   */
  valid: boolean;

  /**
   * Validation details for each field
   */
  fields: IFieldValidationDetail[];

  /**
   * Fields that were referenced but not found in schema
   */
  unknownFields: string[];
}

/**
 * Validation detail for a single field
 */
export interface IFieldValidationDetail {
  /**
   * The field name
   */
  field: string;

  /**
   * Whether this field is valid
   */
  valid: boolean;

  /**
   * The expected type from schema (if known)
   */
  expectedType?: string;

  /**
   * Reason for validation failure (if invalid)
   */
  reason?: 'unknown_field' | 'type_mismatch' | 'invalid_value' | 'denied';

  /**
   * Suggested correction (for typos)
   */
  suggestion?: string;

  /**
   * Allowed values (if field has enum constraint)
   */
  allowedValues?: Array<string | number | boolean>;
}

/**
 * Result of security pre-check
 */
export interface ISecurityCheckResult {
  /**
   * Whether the query passes all security checks
   */
  passed: boolean;

  /**
   * List of security violations found
   */
  violations: ISecurityViolation[];

  /**
   * Warnings that don't block execution but should be noted
   */
  warnings: ISecurityWarning[];
}

/**
 * A security violation that blocks query execution
 */
export interface ISecurityViolation {
  /**
   * Type of violation
   */
  type:
    | 'denied_field'
    | 'depth_exceeded'
    | 'clause_limit'
    | 'dot_notation'
    | 'field_not_allowed';

  /**
   * Human-readable message
   */
  message: string;

  /**
   * The field that caused the violation (if applicable)
   */
  field?: string;
}

/**
 * A security warning (doesn't block execution)
 */
export interface ISecurityWarning {
  /**
   * Type of warning
   */
  type:
    | 'approaching_depth_limit'
    | 'approaching_clause_limit'
    | 'complex_query';

  /**
   * Human-readable message
   */
  message: string;

  /**
   * Current value
   */
  current?: number;

  /**
   * Limit value
   */
  limit?: number;
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
