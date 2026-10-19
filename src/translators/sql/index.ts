/**
 * SQL Translator for QueryKit
 *
 * This translator converts QueryKit AST expressions into generic SQL
 * WHERE clause conditions that can be used in any SQL query.
 */

import { quotedDecimalValue } from '../../parser/stored-integer';
import {
  IComparisonExpression,
  ILogicalExpression,
  QueryExpression
} from '../../parser/types';
import { quoteFieldIdentifiers } from '../field-identifiers';
import { likeEscapeClause, toSqlLikePattern } from '../like-pattern';
import {
  enforceTranslationSecurity,
  resolveTranslationSecurity
} from '../translation-security';
import {
  ITranslationContext,
  ITranslationSecurity,
  ITranslator,
  ITranslatorOptions
} from '../types';

/**
 * A field name after the translator's own normalization and mapping, with
 * the parser's literal flag when the mapping kept the name.
 */
interface IResolvedField {
  name: string;
  isLiteral: boolean;
}

/**
 * Options specific to the SQL translator
 */
export interface ISqlTranslatorOptions extends ITranslatorOptions {
  /**
   * Quote character for identifiers (field names)
   * Default is double quotes (ANSI SQL standard)
   */
  identifierQuote?: string;

  /**
   * Quote character for string literals
   * Default is single quotes (ANSI SQL standard)
   */
  stringLiteralQuote?: string;

  /**
   * Whether to use parameters instead of inline values
   * If true, translate() will return an object with sql and params
   * Default is true for security reasons (protection against SQL injection)
   *
   * @warning Setting this to false may expose your application to SQL injection attacks.
   * Only disable this if you have a very specific reason and you're handling the security
   * implications yourself.
   */
  useParameters?: boolean;
}

/**
 * The result of SQL translation
 */
export interface ISqlTranslationResult {
  /**
   * The SQL query string with placeholders for parameters
   */
  sql: string;

  /**
   * The parameters to be used with the query
   */
  params: unknown[];
}

/**
 * Error thrown when translation fails
 */
export class SqlTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlTranslationError';
  }
}

/**
 * Translates QueryKit AST expressions to SQL WHERE clauses
 */
export class SqlTranslator
  implements ITranslator<ISqlTranslationResult | string>
{
  private options: Required<
    Omit<ISqlTranslatorOptions, keyof ITranslationSecurity>
  > &
    ITranslationSecurity;
  private params: unknown[] = [];

  constructor(options: ISqlTranslatorOptions = {}) {
    this.options = {
      ...options,
      normalizeFieldNames: options.normalizeFieldNames ?? false,
      fieldMappings: options.fieldMappings ?? {},
      identifierQuote: options.identifierQuote ?? '"',
      stringLiteralQuote: options.stringLiteralQuote ?? "'",
      useParameters: options.useParameters ?? true
    };
  }

  /**
   * Translate a QueryKit expression to an SQL WHERE clause.
   *
   * The shared security checks run first, with the settings from the
   * constructor options overridden by any on the context, and the enforced
   * exclusions are appended before translation. A `QuerySecurityError` from
   * those checks is thrown as is, not wrapped as a translation error.
   *
   * @param expression The QueryKit expression to translate
   * @param context Security settings of this translation; omit to use the options
   * @returns The SQL text, or the text with its parameters when `useParameters` is set
   * @throws {QuerySecurityError} When the query breaks a cap or names a field outside the allowlist
   * @throws {SqlTranslationError} When the expression cannot be translated
   */
  public translate(
    expression: QueryExpression,
    context: ITranslationContext = {}
  ): ISqlTranslationResult | string {
    this.params = [];
    const constrained = enforceTranslationSecurity(
      expression,
      resolveTranslationSecurity(this.options, context)
    );

    try {
      const sql = this.translateExpression(constrained);

      return this.options.useParameters
        ? { sql, params: [...this.params] }
        : sql;
    } catch (error) {
      throw new SqlTranslationError(
        `Failed to translate expression: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an expression can be translated to SQL
   */
  public canTranslate(expression: QueryExpression): boolean {
    try {
      this.translateExpression(expression);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Translate any QueryKit expression to SQL
   */
  private translateExpression(expression: QueryExpression): string {
    if (!expression) {
      throw new SqlTranslationError('Empty expression');
    }

    switch (expression.type) {
      case 'comparison':
        return this.translateComparisonExpression(expression);
      case 'logical':
        return this.translateLogicalExpression(expression);
      default:
        throw new SqlTranslationError(
          `Unsupported expression type: ${(expression as { type: string }).type}`
        );
    }
  }

  /**
   * Translate a comparison expression to SQL
   */
  private translateComparisonExpression(
    expression: IComparisonExpression
  ): string {
    const { operator, value } = expression;
    const resolved = this.resolveField(expression);
    const quotedField = quoteFieldIdentifiers(
      resolved.name,
      resolved.isLiteral,
      this.options.identifierQuote
    );

    // Handle each operator type
    switch (operator) {
      case '==':
        return this.formatComparison(quotedField, '=', value);
      case '!=':
        return this.formatComparison(quotedField, '<>', value);
      case '>':
        return this.formatComparison(quotedField, '>', value);
      case '>=':
        return this.formatComparison(quotedField, '>=', value);
      case '<':
        return this.formatComparison(quotedField, '<', value);
      case '<=':
        return this.formatComparison(quotedField, '<=', value);
      case 'LIKE': {
        if (typeof value !== 'string') {
          throw new SqlTranslationError(
            'LIKE operator requires a string value'
          );
        }
        const sqlPattern = this.wildcardToSqlPattern(value);
        const escapeClause = likeEscapeClause(this.options.stringLiteralQuote);
        return `${quotedField} LIKE ${this.formatValue(sqlPattern)} ${escapeClause}`;
      }
      case 'IN': {
        if (!Array.isArray(value)) {
          throw new SqlTranslationError('IN operator requires an array value');
        }
        if (value.length === 0) {
          // Empty IN clause should always be false
          return 'FALSE';
        }
        return this.formatInClause(quotedField, value, false);
      }
      case 'NOT IN': {
        if (!Array.isArray(value)) {
          throw new SqlTranslationError(
            'NOT IN operator requires an array value'
          );
        }
        if (value.length === 0) {
          // Empty NOT IN clause should always be true
          return 'TRUE';
        }
        return this.formatInClause(quotedField, value, true);
      }
      default:
        throw new SqlTranslationError(`Unsupported operator: ${operator}`);
    }
  }

  /**
   * Convert wildcard pattern to SQL LIKE pattern
   */
  private wildcardToSqlPattern(pattern: string): string {
    return toSqlLikePattern(pattern);
  }

  /**
   * Translate a logical expression to SQL
   */
  private translateLogicalExpression(expression: ILogicalExpression): string {
    const { operator, left, right } = expression;

    const leftSql = this.translateExpression(left);

    if (operator === 'NOT') {
      return `NOT (${leftSql})`;
    }

    if (!right) {
      throw new SqlTranslationError(
        `${operator} operator requires two operands`
      );
    }

    const rightSql = this.translateExpression(right);

    switch (operator) {
      case 'AND':
        return `(${leftSql}) AND (${rightSql})`;
      case 'OR':
        return `(${leftSql}) OR (${rightSql})`;
      default:
        throw new SqlTranslationError(
          `Unsupported logical operator: ${operator}`
        );
    }
  }

  /**
   * Format a comparison expression
   */
  private formatComparison(
    field: string,
    sqlOperator: string,
    value: unknown
  ): string {
    // Only equality is two-valued for NULL. Ordered comparisons stay unknown,
    // so `>` NULL and `NOT (> NULL)` both match nothing in a WHERE clause.
    if (value === null && (sqlOperator === '=' || sqlOperator === '<>')) {
      return sqlOperator === '=' ? `${field} IS NULL` : `${field} IS NOT NULL`;
    }
    const affinity = this.formatNumericAffinity(field, sqlOperator, value);
    if (affinity !== null) {
      return affinity;
    }
    const formattedValue = this.formatValue(value);
    return `${field} ${sqlOperator} ${formattedValue}`;
  }

  /**
   * A quoted decimal compared by SQLite storage class, the rule the
   * in-memory adapter uses. A number or real uses the number the text
   * spells, so `count > "2"` keeps a stored 10. Text stays text, so the
   * string `2.0` is still greater than `2`. A NULL stays unknown, because
   * the leading `IS NULL AND NULL` term is NULL and `NOT` of that is NULL.
   * A column with no affinity then agrees with a typed numeric column and
   * with memory.
   *
   * @param field - Quoted identifier
   * @param sqlOperator - SQL comparison operator
   * @param value - Query value
   * @returns The comparison, or null when the value is not a quoted decimal
   */
  private formatNumericAffinity(
    field: string,
    sqlOperator: string,
    value: unknown
  ): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const numeral = quotedDecimalValue(value);
    if (numeral === null) {
      return null;
    }
    const numericSql = this.formatValue(numeral);
    const textSql = this.formatValue(value);
    return `(${field} IS NULL AND NULL) OR (typeof(${field}) IN ('integer', 'real') AND ${field} ${sqlOperator} ${numericSql}) OR (typeof(${field}) = 'text' AND ${field} ${sqlOperator} ${textSql})`;
  }

  /**
   * Format an IN clause
   */
  private formatInClause(
    field: string,
    values: unknown[],
    isNot: boolean
  ): string {
    const nonNullValues = values.filter(
      (value: unknown): boolean => value !== null
    );
    const hasNull = nonNullValues.length !== values.length;
    if (isNot) {
      return this.formatExcludedSet(field, nonNullValues, hasNull);
    }
    return this.formatIncludedSet(field, nonNullValues, hasNull);
  }

  /**
   * Membership that agrees with `=`, including NULL.
   */
  private formatIncludedSet(
    field: string,
    nonNullValues: unknown[],
    hasNull: boolean
  ): string {
    if (!hasNull) {
      return `${field} IN (${this.formatValueList(nonNullValues)})`;
    }
    if (nonNullValues.length === 0) {
      return `${field} IS NULL`;
    }
    const list = this.formatValueList(nonNullValues);
    return `(${field} IS NULL) OR (${field} IN (${list}))`;
  }

  /**
   * Exclusion that agrees with `<>`, including NULL.
   * A NULL member must not poison the rest of the list.
   */
  private formatExcludedSet(
    field: string,
    nonNullValues: unknown[],
    hasNull: boolean
  ): string {
    if (!hasNull) {
      return `${field} NOT IN (${this.formatValueList(nonNullValues)})`;
    }
    if (nonNullValues.length === 0) {
      return `${field} IS NOT NULL`;
    }
    const list = this.formatValueList(nonNullValues);
    return `(${field} IS NOT NULL) AND (${field} NOT IN (${list}))`;
  }

  private formatValueList(values: unknown[]): string {
    if (this.options.useParameters) {
      return values
        .map((value: unknown): string => this.formatValue(value))
        .join(', ');
    }
    return values
      .map((value: unknown): string => this.formatValue(value, false))
      .join(', ');
  }

  /**
   * Format a value for SQL.
   *
   * A boolean is never bound: SQLite drivers cannot bind a JavaScript
   * boolean, so parameterized SQL writes `TRUE` / `FALSE` while inline SQL
   * keeps its lowercase `true` / `false`. A `Date` binds as ISO-8601 text,
   * the form SQLite stores. A bigint binds as itself; inline, only an
   * integer `Number` would round is written as digits, so a hand-built safe
   * bigint is still rejected.
   *
   * @throws {SqlTranslationError} For a non-finite number, a safe bigint
   * inline, an object, or an unsupported type
   */
  private formatValue(value: unknown, addToParams = true): string {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new SqlTranslationError(
        `Non-finite numbers are not supported. Got: ${String(value)}`
      );
    }
    if (typeof value === 'boolean') {
      if (this.options.useParameters) {
        return value ? 'TRUE' : 'FALSE';
      }
      return String(value);
    }
    if (this.options.useParameters && addToParams) {
      this.params.push(value instanceof Date ? value.toISOString() : value);
      return '?';
    }

    if (value === null) {
      return 'NULL';
    }

    if (typeof value === 'string') {
      return this.quoteString(value);
    }

    if (typeof value === 'number') {
      return String(value);
    }

    if (typeof value === 'bigint') {
      if (Number.isSafeInteger(Number(value))) {
        throw new SqlTranslationError('Unsupported value type: bigint');
      }
      return value.toString();
    }

    if (value instanceof Date) {
      return this.quoteString(value.toISOString());
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      throw new SqlTranslationError(
        `Complex objects are not supported as values. Got: ${Object.prototype.toString.call(value)}`
      );
    }

    if (Array.isArray(value)) {
      const formattedValues = value.map(v => this.formatValue(v, false));
      return formattedValues.join(', ');
    }

    throw new SqlTranslationError(`Unsupported value type: ${typeof value}`);
  }

  /**
   * Write a string literal. A quote inside the string is doubled. A string
   * that holds U+0000 cannot be written into statement text, since SQLite
   * stops reading at the zero byte, so it is split there and the quoted
   * pieces are joined with `CHAR(0)`.
   */
  private quoteString(value: string): string {
    const quote = this.options.stringLiteralQuote;
    const pieces = value
      .split('\u0000')
      .map(piece => `${quote}${this.escapeString(piece)}${quote}`);
    if (pieces.length === 1) {
      return pieces[0];
    }
    return `(${pieces.join(' || CHAR(0) || ')})`;
  }

  /**
   * Escape a string literal for SQL
   */
  private escapeString(str: string): string {
    // Escape any quotes in the string by doubling them
    const quote = this.options.stringLiteralQuote;
    return str.split(quote).join(`${quote}${quote}`);
  }

  /**
   * Normalize and map a field name. The parser's literal flag survives
   * case folding but not a mapping that replaces the name, since the mapped
   * name was written by the caller, not quoted in the query.
   */
  private resolveField(expression: IComparisonExpression): IResolvedField {
    const normalizedField = this.options.normalizeFieldNames
      ? expression.field.toLowerCase()
      : expression.field;
    // Bracket access walks the prototype, so `toString` and `constructor`
    // would otherwise resolve to functions instead of column names.
    if (
      Object.prototype.hasOwnProperty.call(
        this.options.fieldMappings,
        normalizedField
      )
    ) {
      return {
        name: this.options.fieldMappings[normalizedField],
        isLiteral: false
      };
    }
    return { name: normalizedField, isLiteral: expression.isLiteral === true };
  }
}
