import { randomUUID } from 'crypto';
import { parse as liqeParse } from 'liqe';
import type {
  BooleanOperatorToken,
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
  IAutocompleteSuggestions,
  IComparisonExpression,
  IErrorRecovery,
  IFieldSchema,
  IFieldSuggestion,
  IFieldValidationDetail,
  IFieldValidationResult,
  ILogicalExpression,
  IOperatorSuggestion,
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
  IValueSuggestion,
  QueryExpression,
  QueryValue
} from './types';
import {
  findTrailingLogicalOperator,
  parseQueryTokens,
  isInputComplete,
  QueryToken
} from './input-parser';
import {
  measureQueryDelimiters,
  readLiteralAt,
  transformCodeSegments
} from './query-scanner';

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
interface IMembershipPlaceholder {
  operator: 'IN' | 'NOT IN';
  value: Array<string | number | boolean | null>;
}

export class QueryParser implements IQueryParser {
  private options: Required<IParserOptions>;
  private membershipPlaceholders: Map<string, IMembershipPlaceholder> | null =
    null;
  private placeholderNonce = '';

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
    const previousPlaceholders = this.membershipPlaceholders;
    const previousNonce = this.placeholderNonce;
    this.membershipPlaceholders = new Map();
    this.placeholderNonce = randomUUID();
    try {
      // Pre-process the query to handle IN operator syntax
      const preprocessedQuery = this.preprocessQuery(query);
      const liqeAst = liqeParse(preprocessedQuery);
      return this.restoreMembership(this.convertLiqeAst(liqeAst));
    } catch (error) {
      throw new QueryParseError(
        `Failed to parse query: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.membershipPlaceholders = previousPlaceholders;
      this.placeholderNonce = previousNonce;
    }
  }

  /**
   * Pre-process a query string to convert non-standard syntax to Liqe-compatible syntax.
   * Supports:
   * - `field:[val1, val2, val3]` → `(field:val1 OR field:val2 OR field:val3)`
   * - Lowercase boolean operators: `and` → `AND`, `or` → `OR`, `not` → `NOT`
   *
   * This keeps the syntax consistent with the `key:value` pattern used throughout QueryKit:
   * - `priority:>2` (comparison)
   * - `status:active` (equality)
   * - `status:[todo, doing, done]` (IN / multiple values)
   */
  private preprocessQuery(query: string): string {
    let result = query;
    // Normalize lowercase boolean operators to uppercase.
    // Liqe only recognizes uppercase AND, OR, NOT as boolean operators;
    // lowercase variants are treated as bare search terms causing crashes.
    result = this.normalizeBooleanOperators(result);
    // Liqe has no not-equals operator. The input parser and autocomplete
    // both advertise `:!=`, so rewrite it before parsing.
    result = this.rewriteInequalityOperators(result);
    // Bracket lists, date/string ranges, and dotted fields. Liqe ranges only
    // accept numbers, and a naive `field:[...]` replace corrupts dotted names
    // and quoted text.
    result = this.rewriteBracketExpressions(result);
    return result;
  }

  /**
   * Normalize lowercase boolean operators (and, or, not) to their uppercase
   * equivalents (AND, OR, NOT) while preserving content inside quoted strings.
   *
   * Liqe only recognizes uppercase boolean operators. Without normalization,
   * lowercase variants are parsed as bare search terms, which produces an
   * incompatible AST that crashes during conversion.
   */
  private normalizeBooleanOperators(query: string): string {
    return transformCodeSegments(query, code =>
      code.replace(
        /(?<![^\s()])\b(and|or|not)\b(?![^\s()])/gi,
        match => match.toUpperCase()
      )
    );
  }

  /**
   * Rewrite `field:!=value` to `NOT field:value` outside of literals.
   * Liqe's comparison operators do not include not-equals.
   */
  private rewriteInequalityOperators(query: string): string {
    return transformCodeSegments(query, code =>
      code.replace(/([A-Za-z_$][\w$.]*):!=/g, 'NOT $1:')
    );
  }

  /**
   * Rewrite `field:[...]` and `field:{...}` forms Liqe does not accept as-is:
   * IN lists (including dotted fields) and non-numeric or whitespace ranges.
   */
  private rewriteBracketExpressions(query: string): string {
    let result = '';
    let index = 0;
    while (index < query.length) {
      const rewritten = this.matchBracketExpression(query, index);
      if (rewritten) {
        result += rewritten.text;
        index = rewritten.end;
        continue;
      }
      const literal = readLiteralAt(query, index);
      if (literal.kind !== 'none') {
        result += query.slice(index, literal.end);
        index = literal.end;
        continue;
      }
      result += query[index] ?? '';
      index += 1;
    }
    return result;
  }

  private matchBracketExpression(
    query: string,
    index: number
  ): { text: string; end: number } | null {
    if (index > 0 && /[\w$.]/.test(query[index - 1] ?? '')) {
      return null;
    }
    const field = this.readFieldToken(query, index);
    if (!field) {
      return null;
    }
    if (query[field.end] !== ':') {
      return null;
    }
    const membership = this.matchMembershipOperator(query, field.end + 1);
    if (membership) {
      const closeIndex = this.readBracketEnd(query, membership.openIndex);
      if (closeIndex === null) {
        return null;
      }
      const body = query.slice(membership.openIndex + 1, closeIndex);
      return {
        text: this.rewriteMembership(field.text, membership.operatorText, body),
        end: closeIndex + 1
      };
    }
    const openerIndex = field.end + 1;
    const opener = query[openerIndex];
    if (opener !== '[' && opener !== '{') {
      return null;
    }
    const closeIndex = this.readBracketEnd(query, openerIndex);
    if (closeIndex === null) {
      return null;
    }
    const closer = query[closeIndex] ?? '';
    const body = query.slice(openerIndex + 1, closeIndex);
    const replacement = this.rewriteBracketBody(field.text, opener, closer, body);
    if (replacement === null) {
      return null;
    }
    return { text: replacement, end: closeIndex + 1 };
  }

  /**
   * Liqe has no membership operator. `field:in[...]` and `field:not in[...]`
   * are the strings the query builder emits, so recognize them before the
   * bracket-list rewrite and keep the values for the AST.
   */
  private matchMembershipOperator(
    query: string,
    index: number
  ): { openIndex: number; operatorText: string } | null {
    const match = /^(not\s+in|in)\s*\[/i.exec(query.slice(index));
    if (!match) {
      return null;
    }
    return {
      operatorText: match[1] ?? 'in',
      openIndex: index + match[0].length - 1
    };
  }

  private rewriteMembership(
    field: string,
    operatorText: string,
    body: string
  ): string {
    const operator = /^not/i.test(operatorText) ? 'NOT IN' : 'IN';
    const value = this.parseMembershipValues(body);
    const id = `\uE000qk${this.placeholderNonce}:${this.membershipPlaceholders?.size ?? 0}`;
    this.membershipPlaceholders?.set(id, { operator, value });
    return `${field}:"${id}"`;
  }

  private parseMembershipValues(
    body: string
  ): Array<string | number | boolean | null> {
    if (body.trim().length === 0) {
      return [];
    }
    return this.parseCommaSeparatedValues(body).map(token =>
      this.parseMembershipToken(token)
    );
  }

  private parseMembershipToken(
    token: string
  ): string | number | boolean | null {
    const quoted =
      (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
      (token.startsWith("'") && token.endsWith("'") && token.length >= 2);
    if (quoted) {
      return token.slice(1, -1).replace(/\\(.)/g, (_match, char: string) => char);
    }
    if (token === 'null') {
      return null;
    }
    if (token === 'true') {
      return true;
    }
    if (token === 'false') {
      return false;
    }
    if (/^-?(?:\d+)(?:\.\d+)?$/.test(token)) {
      return Number(token);
    }
    return token;
  }

  private restoreMembership(expression: QueryExpression): QueryExpression {
    if (expression.type === 'comparison') {
      const saved =
        typeof expression.value === 'string'
          ? this.membershipPlaceholders?.get(expression.value)
          : undefined;
      if (!saved) {
        return expression;
      }
      return {
        type: 'comparison',
        field: expression.field,
        operator: saved.operator,
        value: saved.value
      };
    }
    if (expression.type !== 'logical') {
      return expression;
    }
    return {
      type: 'logical',
      operator: expression.operator,
      left: this.restoreMembership(expression.left),
      ...(expression.right && {
        right: this.restoreMembership(expression.right)
      })
    };
  }

  private readFieldToken(
    query: string,
    index: number
  ): { text: string; end: number } | null {
    const literal = readLiteralAt(query, index);
    if (literal.kind === 'string' && literal.closed) {
      return { text: query.slice(index, literal.end), end: literal.end };
    }
    const match = /^[A-Za-z_$][\w$.]*/.exec(query.slice(index));
    if (!match) {
      return null;
    }
    return { text: match[0], end: index + match[0].length };
  }

  private readBracketEnd(query: string, openIndex: number): number | null {
    let depth = 1;
    let index = openIndex + 1;
    while (index < query.length) {
      const literal = readLiteralAt(query, index);
      if (literal.kind !== 'none') {
        index = literal.end;
        continue;
      }
      const char = query[index];
      if (char === '[' || char === '{') {
        depth += 1;
      } else if (char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
      index += 1;
    }
    return null;
  }

  private rewriteBracketBody(
    field: string,
    opener: string,
    closer: string,
    body: string
  ): string | null {
    if (body.trim().length === 0) {
      return null;
    }
    if (this.hasCodeComma(body)) {
      return this.convertToOrExpression(field, body);
    }
    const bounds = this.splitRangeBounds(body);
    if (bounds) {
      return this.formatRange(field, opener, closer, bounds.min, bounds.max);
    }
    if (opener === '[') {
      return this.convertToOrExpression(field, body);
    }
    return null;
  }

  private hasCodeComma(body: string): boolean {
    let index = 0;
    while (index < body.length) {
      const literal = readLiteralAt(body, index);
      if (literal.kind !== 'none') {
        index = literal.end;
        continue;
      }
      if (body[index] === ',') {
        return true;
      }
      index += 1;
    }
    return false;
  }

  private splitRangeBounds(
    body: string
  ): { min: string; max: string } | null {
    const matches: Array<{ start: number; end: number }> = [];
    let index = 0;
    while (index < body.length) {
      const literal = readLiteralAt(body, index);
      if (literal.kind !== 'none') {
        index = literal.end;
        continue;
      }
      const separator = /^\s+to\s+/i.exec(body.slice(index));
      if (separator) {
        matches.push({ start: index, end: index + separator[0].length });
        index += separator[0].length;
        continue;
      }
      index += 1;
    }
    if (matches.length !== 1) {
      return null;
    }
    const match = matches[0];
    if (!match) {
      return null;
    }
    return {
      min: body.slice(0, match.start).trim(),
      max: body.slice(match.end).trim()
    };
  }

  private formatRange(
    field: string,
    opener: string,
    closer: string,
    min: string,
    max: string
  ): string | null {
    if (min === '*' && max === '*') {
      return null;
    }
    if ((min !== '*' && min.length === 0) || (max !== '*' && max.length === 0)) {
      return null;
    }
    const minOperator = opener === '{' ? '>' : '>=';
    const maxOperator = closer === '}' ? '<' : '<=';
    const parts: string[] = [];
    if (min !== '*') {
      parts.push(this.formatComparison(field, minOperator, min));
    }
    if (max !== '*') {
      parts.push(this.formatComparison(field, maxOperator, max));
    }
    if (parts.length === 2) {
      return `(${parts[0]} AND ${parts[1]})`;
    }
    return parts[0] ?? null;
  }

  private formatComparison(
    field: string,
    operator: string,
    bound: string
  ): string {
    if (/^-?(?:\d+)(?:\.\d+)?$/.test(bound)) {
      return `${field}:${operator}${bound}`;
    }
    const isQuoted =
      (bound.startsWith('"') && bound.endsWith('"') && bound.length >= 2) ||
      (bound.startsWith("'") && bound.endsWith("'") && bound.length >= 2);
    if (isQuoted) {
      return `${field}:${operator}${bound}`;
    }
    const escaped = bound.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `${field}:${operator}"${escaped}"`;
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

    // If value contains spaces or special characters, quote it.
    // Escape backslashes first so a later quote escape is not doubled,
    // and so `\b` stays a backslash rather than a backspace.
    if (/\s|[():]/.test(value)) {
      const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
        const field = tagNode.field;
        const expression = tagNode.expression;
        if (!field || !expression) {
          throw new QueryParseError('Invalid field or expression in Tag node');
        }
        if (!('name' in field) || typeof field.name !== 'string') {
          throw new QueryParseError(
            'Implicit field search is not supported; queries must name a field'
          );
        }
        const fieldName = this.normalizeFieldName(field.name);
        if (expression.type === 'RangeExpression') {
          return this.convertRangeExpression(fieldName, expression);
        }
        if (expression.type === 'RegexExpression') {
          return this.createComparisonExpression(
            fieldName,
            'REGEX',
            expression.value
          );
        }
        if (!tagNode.operator || !('value' in expression)) {
          throw new QueryParseError('Invalid field or expression in Tag node');
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
    // Bracket access walks the prototype, so `toString` and `constructor`
    // would otherwise become functions instead of field names.
    if (
      Object.prototype.hasOwnProperty.call(
        this.options.fieldMappings,
        normalizedField
      )
    ) {
      return this.options.fieldMappings[normalizedField];
    }
    return normalizedField;
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
    if (ast) {
      structure.clauseCount = this.countComparisonClauses(ast);
      structure.referencedFields = this.collectComparisonFields(ast);
      structure.complexity = this.determineComplexity(
        structure.clauseCount,
        structure.operatorCount,
        structure.depth
      );
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

    // Generate autocomplete suggestions if cursor position provided
    if (options.cursorPosition !== undefined) {
      result.suggestions = this.generateAutocompleteSuggestions(
        query,
        options.cursorPosition,
        activeToken,
        options.schema
      );
    }

    // Generate error recovery suggestions if parsing failed
    if (!success) {
      result.recovery = this.generateErrorRecovery(query, structure);
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
    const delimiters = measureQueryDelimiters(query);
    const hasBalancedParentheses =
      delimiters.openParentheses === delimiters.closeParentheses;
    const hasBalancedQuotes = delimiters.unclosedQuote === null;
    const termTokens = tokens.filter(token => token.type === 'term');
    const operatorTokens = tokens.filter(token => token.type === 'operator');
    const clauseCount = termTokens.length;
    const operatorCount = operatorTokens.length;
    const referencedFields: string[] = [];
    for (const token of termTokens) {
      if (token.type !== 'term' || token.key === null) {
        continue;
      }
      const resolvedField = this.resolveReferencedField(token.key);
      if (
        resolvedField.length > 0 &&
        !referencedFields.includes(resolvedField)
      ) {
        referencedFields.push(resolvedField);
      }
    }
    const depth =
      query.trim().length > 0
        ? Math.max(1, delimiters.maxParenthesisDepth)
        : 0;
    const isComplete = isInputComplete(query);
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
   * Map a tokenizer field key onto the name the parser would execute.
   * A leading minus is the unary-not prefix, not part of the field.
   */
  private resolveReferencedField(key: string): string {
    const withoutNegation = key.startsWith('-') ? key.slice(1) : key;
    return this.normalizeFieldName(withoutNegation);
  }

  /**
   * Count comparison nodes in the AST that will actually be executed.
   */
  private countComparisonClauses(expression: QueryExpression): number {
    if (expression.type === 'comparison') {
      return 1;
    }
    if (expression.type !== 'logical') {
      return 0;
    }
    const rightCount = expression.right
      ? this.countComparisonClauses(expression.right)
      : 0;
    return this.countComparisonClauses(expression.left) + rightCount;
  }

  /**
   * Collect field names from comparison nodes, in execution order.
   */
  private collectComparisonFields(expression: QueryExpression): string[] {
    const fields: string[] = [];
    this.walkComparisonFields(expression, fields);
    return fields;
  }

  private walkComparisonFields(
    expression: QueryExpression,
    fields: string[]
  ): void {
    if (expression.type === 'comparison') {
      if (expression.field.length > 0 && !fields.includes(expression.field)) {
        fields.push(expression.field);
      }
      return;
    }
    if (expression.type !== 'logical') {
      return;
    }
    this.walkComparisonFields(expression.left, fields);
    if (expression.right) {
      this.walkComparisonFields(expression.right, fields);
    }
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
      // `in` walks the prototype, so `toString` looks like a schema field.
      if (Object.prototype.hasOwnProperty.call(schema, field)) {
        const fieldSchema = schema[field];
        fields.push({
          field,
          valid: true,
          expectedType: fieldSchema.type,
          allowedValues: fieldSchema.allowedValues
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

  /**
   * Generate autocomplete suggestions based on cursor position
   */
  private generateAutocompleteSuggestions(
    query: string,
    cursorPosition: number,
    activeToken: IQueryToken | undefined,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    // Determine context based on active token and position
    if (!activeToken) {
      // Cursor is not in a token - check if we're at the start or between tokens
      if (query.trim().length === 0 || cursorPosition === 0) {
        return this.suggestForEmptyContext(schema);
      }
      // Between tokens - suggest logical operators or new field
      return this.suggestBetweenTokens(schema);
    }

    if (activeToken.type === 'operator') {
      // Cursor is in a logical operator
      return {
        context: 'logical_operator',
        logicalOperators: ['AND', 'OR', 'NOT'],
        replaceText: activeToken.raw,
        replaceRange: {
          start: activeToken.startPosition,
          end: activeToken.endPosition
        }
      };
    }

    // Active token is a term
    const term = activeToken;
    const relativePos = cursorPosition - term.startPosition;

    // Determine if cursor is in key, operator, or value part
    if (term.key !== null && term.operator !== null) {
      const keyLength = term.key.length;
      const operatorLength = term.operator.length;

      if (relativePos < keyLength) {
        // Cursor is in the field name
        return this.suggestFields(term.key, schema);
      } else if (relativePos < keyLength + operatorLength) {
        // Cursor is in the operator
        return this.suggestOperators(term.key, schema);
      } else {
        // Cursor is in the value
        return this.suggestValues(term.key, term.value, schema);
      }
    } else if (term.key !== null) {
      // Only key present (incomplete)
      return this.suggestFields(term.key, schema);
    } else {
      // Bare value - could be a field name
      return this.suggestFields(term.value || '', schema);
    }
  }

  /**
   * Suggest for empty/start context
   */
  private suggestForEmptyContext(
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    return {
      context: 'empty',
      fields: this.getFieldSuggestions('', schema),
      logicalOperators: ['NOT']
    };
  }

  /**
   * Suggest between tokens (after a complete term)
   */
  private suggestBetweenTokens(
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    return {
      context: 'logical_operator',
      fields: this.getFieldSuggestions('', schema),
      logicalOperators: ['AND', 'OR', 'NOT']
    };
  }

  /**
   * Suggest field names
   */
  private suggestFields(
    partial: string,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    return {
      context: 'field',
      fields: this.getFieldSuggestions(partial, schema),
      replaceText: partial,
      replaceRange:
        partial.length > 0 ? { start: 0, end: partial.length } : undefined
    };
  }

  /**
   * Get field suggestions based on partial input
   */
  private getFieldSuggestions(
    partial: string,
    schema?: Record<string, IFieldSchema>
  ): IFieldSuggestion[] {
    if (!schema) {
      return [];
    }

    const partialLower = partial.toLowerCase();
    const suggestions: IFieldSuggestion[] = [];

    for (const [field, fieldSchema] of Object.entries(schema)) {
      const fieldLower = field.toLowerCase();
      let score = 0;

      if (partial.length === 0) {
        // No partial - suggest all fields with base score
        score = 50;
      } else if (fieldLower === partialLower) {
        // Exact match
        score = 100;
      } else if (fieldLower.startsWith(partialLower)) {
        // Prefix match
        score = 80 + (partial.length / field.length) * 20;
      } else if (fieldLower.includes(partialLower)) {
        // Contains match
        score = 60;
      } else {
        // Check Levenshtein distance for typos
        const distance = this.levenshteinDistance(partialLower, fieldLower);
        if (distance <= 2) {
          score = 40 - distance * 10;
        }
      }

      if (score > 0) {
        suggestions.push({
          field,
          type: fieldSchema.type,
          description: fieldSchema.description,
          score
        });
      }
    }

    // Sort by score descending
    return suggestions.sort((a, b) => b.score - a.score);
  }

  /**
   * Suggest operators
   */
  private suggestOperators(
    field: string,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    const fieldType = schema?.[field]?.type;
    const operators = this.getOperatorSuggestions(fieldType);

    return {
      context: 'operator',
      currentField: field,
      operators
    };
  }

  /**
   * Get operator suggestions based on field type
   */
  private getOperatorSuggestions(fieldType?: string): IOperatorSuggestion[] {
    const allOperators: IOperatorSuggestion[] = [
      { operator: ':', description: 'equals', applicable: true },
      { operator: ':!=', description: 'not equals', applicable: true },
      {
        operator: ':>',
        description: 'greater than',
        applicable: fieldType === 'number' || fieldType === 'date'
      },
      {
        operator: ':>=',
        description: 'greater than or equal',
        applicable: fieldType === 'number' || fieldType === 'date'
      },
      {
        operator: ':<',
        description: 'less than',
        applicable: fieldType === 'number' || fieldType === 'date'
      },
      {
        operator: ':<=',
        description: 'less than or equal',
        applicable: fieldType === 'number' || fieldType === 'date'
      }
    ];

    // Sort applicable operators first
    return allOperators.sort((a, b) => {
      if (a.applicable && !b.applicable) return -1;
      if (!a.applicable && b.applicable) return 1;
      return 0;
    });
  }

  /**
   * Suggest values
   */
  private suggestValues(
    field: string,
    partialValue: string | null,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    const fieldSchema = schema?.[field];
    const values = this.getValueSuggestions(partialValue || '', fieldSchema);

    return {
      context: 'value',
      currentField: field,
      values,
      replaceText: partialValue || undefined
    };
  }

  /**
   * Get value suggestions based on schema
   */
  private getValueSuggestions(
    partial: string,
    fieldSchema?: IFieldSchema
  ): IValueSuggestion[] {
    if (!fieldSchema?.allowedValues) {
      // Suggest based on type
      if (fieldSchema?.type === 'boolean') {
        return [
          { value: true, label: 'true', score: 100 },
          { value: false, label: 'false', score: 100 }
        ];
      }
      return [];
    }

    const partialLower = partial.toLowerCase();
    const suggestions: IValueSuggestion[] = [];

    for (const value of fieldSchema.allowedValues) {
      const valueStr = String(value).toLowerCase();
      let score = 0;

      if (partial.length === 0) {
        score = 50;
      } else if (valueStr === partialLower) {
        score = 100;
      } else if (valueStr.startsWith(partialLower)) {
        score = 80;
      } else if (valueStr.includes(partialLower)) {
        score = 60;
      }

      if (score > 0) {
        suggestions.push({
          value,
          label: String(value),
          score
        });
      }
    }

    return suggestions.sort((a, b) => b.score - a.score);
  }

  /**
   * Generate error recovery suggestions
   */
  private generateErrorRecovery(
    query: string,
    structure: IQueryStructure
  ): IErrorRecovery {
    const delimiters = measureQueryDelimiters(query);
    if (delimiters.unclosedQuote) {
      const quote = delimiters.unclosedQuote.quote;
      if (quote === "'") {
        return {
          issue: 'unclosed_quote',
          message: 'Unclosed single quote detected',
          suggestion: "Add a closing ' to complete the quoted value",
          autofix: query + "'",
          position: delimiters.unclosedQuote.position
        };
      }
      return {
        issue: 'unclosed_quote',
        message: 'Unclosed double quote detected',
        suggestion: 'Add a closing " to complete the quoted value',
        autofix: query + '"',
        position: delimiters.unclosedQuote.position
      };
    }
    if (!structure.hasBalancedParentheses) {
      const openCount = delimiters.openParentheses;
      const closeCount = delimiters.closeParentheses;
      if (openCount > closeCount) {
        return {
          issue: 'unclosed_parenthesis',
          message: `Missing ${openCount - closeCount} closing parenthesis`,
          suggestion: 'Add closing parenthesis to balance the expression',
          autofix: query + ')'.repeat(openCount - closeCount)
        };
      }
      return {
        issue: 'unclosed_parenthesis',
        message: `Extra ${closeCount - openCount} closing parenthesis`,
        suggestion: 'Remove extra closing parenthesis'
      };
    }
    const trailingOperator = findTrailingLogicalOperator(query);
    if (trailingOperator) {
      const trimmed = query.trimEnd();
      const written = trimmed.slice(
        trailingOperator.position,
        trailingOperator.position + trailingOperator.operator.length
      );
      return {
        issue: 'trailing_operator',
        message: `Query ends with incomplete "${written}" operator`,
        suggestion: 'Add a condition after the operator or remove it',
        autofix: trimmed.slice(0, trailingOperator.position).trim()
      };
    }
    const trimmed = query.trim();
    if (/:$/.test(trimmed) || /:\s*$/.test(trimmed)) {
      return {
        issue: 'missing_value',
        message: 'Field is missing a value',
        suggestion: 'Add a value after the colon'
      };
    }

    // Generic syntax error
    return {
      issue: 'syntax_error',
      message: 'Query contains a syntax error',
      suggestion: 'Check the query syntax and try again'
    };
  }
}
