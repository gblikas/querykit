import { parse as liqeParse } from 'liqe';
import type {
  BooleanOperatorToken,
  ExpressionToken,
  FieldToken,
  ImplicitBooleanOperatorToken,
  LiqeQuery,
  LogicalExpressionToken,
  ParenthesizedExpressionToken,
  RangeExpressionToken,
  TagToken,
  UnaryOperatorToken
} from 'liqe';
import {
  ComparisonOperator,
  IComparisonExpression,
  IFieldSchema,
  IFieldValidationDetail,
  IFieldValidationResult,
  ILogicalExpression,
  IParserOptions,
  IParseWithContextOptions,
  IQueryParser,
  IQueryParseResult,
  IQueryStructure,
  IQueryToken,
  ISecurityCheckResult,
  ISecurityOptionsForContext,
  ISecurityViolation,
  ISecurityWarning,
  QueryExpression,
  QueryValue
} from './types';
import { parseQueryTokens, isInputComplete, QueryToken } from './input-parser';

/**
 * Error thrown when query parsing fails
 */
export class QueryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryParseError';
  }
}

/**
 * Implementation of the QueryKit parser using Liqe
 */
export class QueryParser implements IQueryParser {
  private options: Required<IParserOptions>;

  constructor(options: IParserOptions = {}) {
    this.options = {
      caseInsensitiveFields: options.caseInsensitiveFields ?? false,
      fieldMappings: options.fieldMappings ?? {}
    };
  }

  /**
   * Parse a query string into a QueryKit AST
   */
  public parse(query: string): QueryExpression {
    try {
      // Pre-process the query to handle IN operator syntax
      const preprocessedQuery = this.preprocessQuery(query);
      const liqeAst = liqeParse(preprocessedQuery);
      return this.convertLiqeAst(liqeAst);
    } catch (error) {
      throw new QueryParseError(
        `Failed to parse query: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Pre-process a query string to convert non-standard syntax to Liqe-compatible syntax.
   * Supports:
   * - `field:[val1, val2, val3]` → `(field:val1 OR field:val2 OR field:val3)`
   *
   * This keeps the syntax consistent with the `key:value` pattern used throughout QueryKit:
   * - `priority:>2` (comparison)
   * - `status:active` (equality)
   * - `status:[todo, doing, done]` (IN / multiple values)
   */
  private preprocessQuery(query: string): string {
    let result = query;

    // Handle `field:[val1, val2, ...]` syntax (array-like, not range)
    // Pattern: fieldName:[value1, value2, ...]
    // We distinguish from range by checking for commas without "TO"
    const bracketArrayPattern = /(\w+):\[([^\]]+)\]/g;
    result = result.replace(bracketArrayPattern, (fullMatch, field, values) => {
      // Check if this looks like a range expression (contains " TO ")
      if (/\s+TO\s+/i.test(values)) {
        // This is a range expression, keep as-is
        return fullMatch;
      }
      // This is an array-like expression, convert to OR
      return this.convertToOrExpression(field, values);
    });

    return result;
  }

  /**
   * Convert a field and comma-separated values to an OR expression string
   */
  private convertToOrExpression(field: string, valuesStr: string): string {
    // Parse values respecting quoted strings (commas inside quotes are preserved)
    const values = this.parseCommaSeparatedValues(valuesStr);

    if (values.length === 0) {
      return `${field}:""`;
    }

    if (values.length === 1) {
      return this.formatFieldValue(field, values[0]);
    }

    // Build OR expression: (field:val1 OR field:val2 OR ...)
    const orClauses = values.map((v: string) =>
      this.formatFieldValue(field, v)
    );
    return `(${orClauses.join(' OR ')})`;
  }

  /**
   * Parse a comma-separated string into values, respecting quoted strings.
   * Commas inside quoted strings are preserved as part of the value.
   *
   * Examples:
   * - `a, b, c` → ['a', 'b', 'c']
   * - `"John, Jr.", Jane` → ['"John, Jr."', 'Jane']
   * - `'hello, world', test` → ["'hello, world'", 'test']
   */
  private parseCommaSeparatedValues(input: string): string[] {
    const values: string[] = [];
    let current = '';
    let inDoubleQuotes = false;
    let inSingleQuotes = false;
    let i = 0;

    while (i < input.length) {
      const char = input[i];
      const nextChar = input[i + 1];

      // Handle escape sequences inside quotes
      if ((inDoubleQuotes || inSingleQuotes) && char === '\\' && nextChar) {
        // Include both the backslash and the escaped character
        current += char + nextChar;
        i += 2;
        continue;
      }

      // Toggle double quote state
      if (char === '"' && !inSingleQuotes) {
        inDoubleQuotes = !inDoubleQuotes;
        current += char;
        i++;
        continue;
      }

      // Toggle single quote state
      if (char === "'" && !inDoubleQuotes) {
        inSingleQuotes = !inSingleQuotes;
        current += char;
        i++;
        continue;
      }

      // Handle comma as separator (only when not inside quotes)
      if (char === ',' && !inDoubleQuotes && !inSingleQuotes) {
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          values.push(trimmed);
        }
        current = '';
        i++;
        continue;
      }

      // Regular character
      current += char;
      i++;
    }

    // Don't forget the last value
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      values.push(trimmed);
    }

    return values;
  }

  /**
   * Format a field:value pair, quoting the value if necessary
   */
  private formatFieldValue(field: string, value: string): string {
    // If the value is already quoted, use it as-is
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return `${field}:${value}`;
    }

    // If value contains spaces or special characters, quote it
    if (/\s|[():]/.test(value)) {
      // Escape quotes within the value
      const escapedValue = value.replace(/"/g, '\\"');
      return `${field}:"${escapedValue}"`;
    }
    return `${field}:${value}`;
  }

  /**
   * Validate a query string
   */
  public validate(query: string): boolean {
    try {
      const preprocessedQuery = this.preprocessQuery(query);
      const ast = liqeParse(preprocessedQuery);
      this.convertLiqeAst(ast);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert a Liqe AST node to a QueryKit expression
   */
  private convertLiqeAst(node: LiqeQuery): QueryExpression {
    if (!node || typeof node !== 'object') {
      throw new QueryParseError('Invalid AST node');
    }

    switch (node.type) {
      case 'LogicalExpression': {
        const logicalNode = node as LogicalExpressionToken;
        const operator = (
          logicalNode.operator as
            | BooleanOperatorToken
            | ImplicitBooleanOperatorToken
        ).operator;
        return this.createLogicalExpression(
          this.convertLogicalOperator(operator),
          logicalNode.left,
          logicalNode.right
        );
      }

      case 'UnaryOperator': {
        const unaryNode = node as UnaryOperatorToken;
        return this.createLogicalExpression('NOT', unaryNode.operand);
      }

      case 'Tag': {
        const tagNode = node as TagToken;
        const field = tagNode.field as FieldToken;
        const expression = tagNode.expression as ExpressionToken & {
          value: QueryValue;
        };

        if (!field || !expression) {
          throw new QueryParseError('Invalid field or expression in Tag node');
        }

        const fieldName = this.normalizeFieldName(field.name);

        // Handle RangeExpression (e.g., field:[min TO max])
        if (expression.type === 'RangeExpression') {
          return this.convertRangeExpression(
            fieldName,
            expression as unknown as RangeExpressionToken
          );
        }

        const operator = this.convertLiqeOperator(tagNode.operator.operator);
        const value = this.convertLiqeValue(expression.value);

        // Check for wildcard patterns in string values
        if (
          operator === '==' &&
          typeof value === 'string' &&
          (value.includes('*') || value.includes('?'))
        ) {
          return this.createComparisonExpression(fieldName, 'LIKE', value);
        }

        return this.createComparisonExpression(fieldName, operator, value);
      }

      case 'EmptyExpression':
        if ('left' in node && node.left) {
          return this.convertLiqeAst(node.left);
        }
        throw new QueryParseError('Invalid empty expression');

      case 'ParenthesizedExpression': {
        const parenNode = node as ParenthesizedExpressionToken;
        if (parenNode.expression) {
          return this.convertLiqeAst(parenNode.expression);
        }
        throw new QueryParseError('Invalid parenthesized expression');
      }

      default:
        throw new QueryParseError(
          `Unsupported node type: ${(node as { type: string }).type}`
        );
    }
  }

  /**
   * Convert a Liqe logical operator to a QueryKit operator
   */
  private convertLogicalOperator(operator: string): 'AND' | 'OR' | 'NOT' {
    switch (operator.toLowerCase()) {
      case 'and':
        return 'AND';
      case 'or':
        return 'OR';
      case 'not':
        return 'NOT';
      default:
        throw new QueryParseError(`Unsupported logical operator: ${operator}`);
    }
  }

  /**
   * Create a logical expression from Liqe nodes
   */
  private createLogicalExpression(
    operator: 'AND' | 'OR' | 'NOT',
    left: LiqeQuery,
    right?: LiqeQuery
  ): ILogicalExpression {
    return {
      type: 'logical',
      operator,
      left: this.convertLiqeAst(left),
      ...(right && { right: this.convertLiqeAst(right) })
    };
  }

  /**
   * Create a comparison expression
   */
  private createComparisonExpression(
    field: string,
    operator: ComparisonOperator,
    value: QueryValue
  ): IComparisonExpression {
    return {
      type: 'comparison',
      field,
      operator,
      value
    };
  }

  /**
   * Convert a Liqe RangeExpression to a QueryKit logical AND expression
   * E.g., `field:[2 TO 5]` becomes `(field >= 2 AND field <= 5)`
   */
  private convertRangeExpression(
    fieldName: string,
    expression: RangeExpressionToken
  ): QueryExpression {
    const range = expression.range;

    // Handle null/undefined range values
    if (range === null || range === undefined) {
      throw new QueryParseError('Invalid range expression: missing range data');
    }

    const { min, max, minInclusive, maxInclusive } = range;

    // Determine the operators based on inclusivity
    const minOperator: ComparisonOperator = minInclusive ? '>=' : '>';
    const maxOperator: ComparisonOperator = maxInclusive ? '<=' : '<';

    // Create comparison expressions for min and max
    const minComparison = this.createComparisonExpression(
      fieldName,
      minOperator,
      min
    );
    const maxComparison = this.createComparisonExpression(
      fieldName,
      maxOperator,
      max
    );

    // Combine with AND
    return {
      type: 'logical',
      operator: 'AND',
      left: minComparison,
      right: maxComparison
    };
  }

  /**
   * Convert a Liqe operator to a QueryKit operator
   */
  private convertLiqeOperator(operator: string): ComparisonOperator {
    // Handle the case where operator is part of the value for comparison operators
    if (operator === ':') {
      return '==';
    }

    // Check if the operator is prefixed with a colon
    const actualOperator = operator.startsWith(':')
      ? operator.substring(1)
      : operator;

    // Map Liqe operators to QueryKit operators
    const operatorMap: Record<string, ComparisonOperator> = {
      '=': '==',
      '!=': '!=',
      '>': '>',
      '>=': '>=',
      '<': '<',
      '<=': '<=',
      in: 'IN',
      'not in': 'NOT IN'
    };

    const queryKitOperator = operatorMap[actualOperator.toLowerCase()];
    if (!queryKitOperator) {
      throw new QueryParseError(`Unsupported operator: ${operator}`);
    }

    return queryKitOperator;
  }

  /**
   * Convert a Liqe value to a QueryKit value
   * Security: Strict type checking to prevent NoSQL injection via objects
   */
  private convertLiqeValue(value: unknown): QueryValue {
    // Security fix: Strict type checking to prevent object injection
    if (value === null) {
      return null;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value as QueryValue;
    }

    if (Array.isArray(value)) {
      // Security fix: Recursively validate array elements
      const validatedArray = value.map(item => {
        if (typeof item === 'object' && item !== null) {
          throw new QueryParseError('Object values are not allowed in arrays');
        }
        return this.convertLiqeValue(item);
      });
      return validatedArray as QueryValue;
    }

    // Security fix: Reject all object types to prevent NoSQL injection
    if (typeof value === 'object') {
      throw new QueryParseError(
        'Object values are not supported for security reasons'
      );
    }

    throw new QueryParseError(`Unsupported value type: ${typeof value}`);
  }

  /**
   * Normalize a field name based on parser options
   */
  private normalizeFieldName(field: string): string {
    const normalizedField = this.options.caseInsensitiveFields
      ? field.toLowerCase()
      : field;

    return this.options.fieldMappings[normalizedField] ?? normalizedField;
  }

  /**
   * Parse a query string with full context information.
   *
   * Unlike `parse()`, this method never throws. Instead, it returns a result object
   * that indicates success or failure along with rich contextual information useful
   * for building search UIs.
   *
   * @param query The query string to parse
   * @param options Optional configuration (cursor position, etc.)
   * @returns Rich parse result with tokens, AST/error, and structural analysis
   *
   * @example
   * ```typescript
   * const result = parser.parseWithContext('status:done AND priority:high');
   *
   * if (result.success) {
   *   // Use result.ast for query execution
   *   console.log('Valid query:', result.ast);
   * } else {
   *   // Show error to user
   *   console.log('Error:', result.error?.message);
   * }
   *
   * // Always available for UI rendering
   * console.log('Tokens:', result.tokens);
   * console.log('Structure:', result.structure);
   * ```
   */
  public parseWithContext(
    query: string,
    options: IParseWithContextOptions = {}
  ): IQueryParseResult {
    // Get tokens from input parser (always works, even for invalid input)
    const tokenResult = parseQueryTokens(query, options.cursorPosition);
    const tokens = this.convertTokens(tokenResult.tokens);

    // Analyze structure
    const structure = this.analyzeStructure(query, tokens);

    // Attempt full parse
    let ast: QueryExpression | undefined;
    let error:
      | { message: string; position?: number; problematicText?: string }
      | undefined;
    let success = false;

    try {
      ast = this.parse(query);
      success = true;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      error = {
        message: errorMessage,
        // Try to extract position from error message if available
        position: this.extractErrorPosition(errorMessage),
        problematicText: this.extractProblematicText(query, errorMessage)
      };
    }

    // Determine active token
    const activeToken = tokenResult.activeToken
      ? this.convertSingleToken(tokenResult.activeToken)
      : undefined;

    // Build base result
    const result: IQueryParseResult = {
      success,
      input: query,
      ast,
      error,
      tokens,
      activeToken,
      activeTokenIndex: tokenResult.activeTokenIndex,
      structure
    };

    // Perform field validation if schema provided
    if (options.schema) {
      result.fieldValidation = this.validateFields(
        structure.referencedFields,
        options.schema
      );
    }

    // Perform security pre-check if security options provided
    if (options.securityOptions) {
      result.security = this.performSecurityCheck(
        structure,
        options.securityOptions
      );
    }

    return result;
  }

  /**
   * Convert tokens from input parser format to IQueryToken format
   */
  private convertTokens(tokens: QueryToken[]): IQueryToken[] {
    return tokens.map(token => this.convertSingleToken(token));
  }

  /**
   * Convert a single token from input parser format
   */
  private convertSingleToken(token: QueryToken): IQueryToken {
    if (token.type === 'term') {
      return {
        type: 'term',
        key: token.key,
        operator: token.operator,
        value: token.value,
        startPosition: token.startPosition,
        endPosition: token.endPosition,
        raw: token.raw
      };
    } else {
      return {
        type: 'operator',
        operator: token.operator,
        startPosition: token.startPosition,
        endPosition: token.endPosition,
        raw: token.raw
      };
    }
  }

  /**
   * Analyze the structure of a query
   */
  private analyzeStructure(
    query: string,
    tokens: IQueryToken[]
  ): IQueryStructure {
    // Count parentheses
    const openParens = (query.match(/\(/g) || []).length;
    const closeParens = (query.match(/\)/g) || []).length;
    const hasBalancedParentheses = openParens === closeParens;

    // Count quotes
    const singleQuotes = (query.match(/'/g) || []).length;
    const doubleQuotes = (query.match(/"/g) || []).length;
    const hasBalancedQuotes = singleQuotes % 2 === 0 && doubleQuotes % 2 === 0;

    // Count terms and operators
    const termTokens = tokens.filter(t => t.type === 'term');
    const operatorTokens = tokens.filter(t => t.type === 'operator');

    const clauseCount = termTokens.length;
    const operatorCount = operatorTokens.length;

    // Extract referenced fields
    const referencedFields: string[] = [];
    for (const token of termTokens) {
      if (token.type === 'term' && token.key !== null) {
        if (!referencedFields.includes(token.key)) {
          referencedFields.push(token.key);
        }
      }
    }

    // Calculate depth (by counting max nesting in parentheses)
    const depth = this.calculateDepth(query);

    // Check if complete
    const isComplete = isInputComplete(query);

    // Determine complexity
    const complexity = this.determineComplexity(
      clauseCount,
      operatorCount,
      depth
    );

    return {
      depth,
      clauseCount,
      operatorCount,
      hasBalancedParentheses,
      hasBalancedQuotes,
      isComplete,
      referencedFields,
      complexity
    };
  }

  /**
   * Calculate the maximum nesting depth of parentheses
   */
  private calculateDepth(query: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of query) {
      if (char === '(') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === ')') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    // Base depth is 1 if there's any content
    return query.trim().length > 0 ? Math.max(1, maxDepth) : 0;
  }

  /**
   * Determine query complexity classification
   */
  private determineComplexity(
    clauseCount: number,
    operatorCount: number,
    depth: number
  ): 'simple' | 'moderate' | 'complex' {
    // Simple: 1-2 clauses, no nesting
    if (clauseCount <= 2 && depth <= 1) {
      return 'simple';
    }

    // Complex: many clauses, deep nesting, or many operators
    if (clauseCount > 5 || depth > 3 || operatorCount > 4) {
      return 'complex';
    }

    return 'moderate';
  }

  /**
   * Try to extract error position from error message
   */
  private extractErrorPosition(errorMessage: string): number | undefined {
    // Try to find position indicators in error messages
    // e.g., "at position 15" or "column 15"
    const posMatch = errorMessage.match(/(?:position|column|offset)\s*(\d+)/i);
    if (posMatch) {
      return parseInt(posMatch[1], 10);
    }
    return undefined;
  }

  /**
   * Try to extract the problematic text from the query based on error
   */
  private extractProblematicText(
    query: string,
    errorMessage: string
  ): string | undefined {
    // If we found a position, extract surrounding text
    const position = this.extractErrorPosition(errorMessage);
    if (position !== undefined && position < query.length) {
      const start = Math.max(0, position - 10);
      const end = Math.min(query.length, position + 10);
      return query.substring(start, end);
    }

    // Try to find quoted text in error message
    const quotedMatch = errorMessage.match(/"([^"]+)"/);
    if (quotedMatch) {
      return quotedMatch[1];
    }

    return undefined;
  }

  /**
   * Validate fields against the provided schema
   */
  private validateFields(
    referencedFields: string[],
    schema: Record<string, IFieldSchema>
  ): IFieldValidationResult {
    const schemaFields = Object.keys(schema);
    const fields: IFieldValidationDetail[] = [];
    const unknownFields: string[] = [];
    let allValid = true;

    for (const field of referencedFields) {
      if (field in schema) {
        // Field exists in schema
        fields.push({
          field,
          valid: true,
          expectedType: schema[field].type,
          allowedValues: schema[field].allowedValues
        });
      } else {
        // Field not in schema - try to find a suggestion
        const suggestion = this.findSimilarField(field, schemaFields);
        fields.push({
          field,
          valid: false,
          reason: 'unknown_field',
          suggestion
        });
        unknownFields.push(field);
        allValid = false;
      }
    }

    return {
      valid: allValid,
      fields,
      unknownFields
    };
  }

  /**
   * Find a similar field name (for typo suggestions)
   */
  private findSimilarField(
    field: string,
    schemaFields: string[]
  ): string | undefined {
    const fieldLower = field.toLowerCase();

    // First, try exact case-insensitive match
    for (const schemaField of schemaFields) {
      if (schemaField.toLowerCase() === fieldLower) {
        return schemaField;
      }
    }

    // Then, try to find fields that start with the same prefix
    const prefix = fieldLower.substring(0, Math.min(3, fieldLower.length));
    for (const schemaField of schemaFields) {
      if (schemaField.toLowerCase().startsWith(prefix)) {
        return schemaField;
      }
    }

    // Try Levenshtein distance for short fields
    if (field.length <= 10) {
      let bestMatch: string | undefined;
      let bestDistance = Infinity;

      for (const schemaField of schemaFields) {
        const distance = this.levenshteinDistance(
          fieldLower,
          schemaField.toLowerCase()
        );
        if (distance <= 2 && distance < bestDistance) {
          bestDistance = distance;
          bestMatch = schemaField;
        }
      }

      if (bestMatch) {
        return bestMatch;
      }
    }

    return undefined;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Perform security pre-check against the provided options
   */
  private performSecurityCheck(
    structure: IQueryStructure,
    options: ISecurityOptionsForContext
  ): ISecurityCheckResult {
    const violations: ISecurityViolation[] = [];
    const warnings: ISecurityWarning[] = [];

    // Check denied fields
    if (options.denyFields && options.denyFields.length > 0) {
      for (const field of structure.referencedFields) {
        if (options.denyFields.includes(field)) {
          violations.push({
            type: 'denied_field',
            message: `Field "${field}" is not allowed in queries`,
            field
          });
        }
      }
    }

    // Check allowed fields (if specified, only these fields are allowed)
    if (options.allowedFields && options.allowedFields.length > 0) {
      for (const field of structure.referencedFields) {
        if (!options.allowedFields.includes(field)) {
          violations.push({
            type: 'field_not_allowed',
            message: `Field "${field}" is not in the list of allowed fields`,
            field
          });
        }
      }
    }

    // Check dot notation
    if (options.allowDotNotation === false) {
      for (const field of structure.referencedFields) {
        if (field.includes('.')) {
          violations.push({
            type: 'dot_notation',
            message: `Dot notation is not allowed in field names: "${field}"`,
            field
          });
        }
      }
    }

    // Check query depth
    if (options.maxQueryDepth !== undefined) {
      if (structure.depth > options.maxQueryDepth) {
        violations.push({
          type: 'depth_exceeded',
          message: `Query depth (${structure.depth}) exceeds maximum allowed (${options.maxQueryDepth})`
        });
      } else if (structure.depth >= options.maxQueryDepth * 0.8) {
        warnings.push({
          type: 'approaching_depth_limit',
          message: `Query depth (${structure.depth}) is approaching the limit (${options.maxQueryDepth})`,
          current: structure.depth,
          limit: options.maxQueryDepth
        });
      }
    }

    // Check clause count
    if (options.maxClauseCount !== undefined) {
      if (structure.clauseCount > options.maxClauseCount) {
        violations.push({
          type: 'clause_limit',
          message: `Clause count (${structure.clauseCount}) exceeds maximum allowed (${options.maxClauseCount})`
        });
      } else if (structure.clauseCount >= options.maxClauseCount * 0.8) {
        warnings.push({
          type: 'approaching_clause_limit',
          message: `Clause count (${structure.clauseCount}) is approaching the limit (${options.maxClauseCount})`,
          current: structure.clauseCount,
          limit: options.maxClauseCount
        });
      }
    }

    // Add complexity warning
    if (structure.complexity === 'complex') {
      warnings.push({
        type: 'complex_query',
        message: 'This query is complex and may impact performance'
      });
    }

    return {
      passed: violations.length === 0,
      violations,
      warnings
    };
  }
}
