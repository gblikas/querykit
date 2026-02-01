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
  ILogicalExpression,
  IParserOptions,
  IQueryParser,
  QueryExpression,
  QueryValue
} from './types';

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
}
