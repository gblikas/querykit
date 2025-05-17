/**
 * SQL Translator for QueryKit
 * 
 * This translator converts QueryKit AST expressions into generic SQL
 * WHERE clause conditions that can be used in any SQL query.
 */

import { IComparisonExpression, ILogicalExpression, QueryExpression } from '../../parser/types';
import { ITranslator, ITranslatorOptions } from '../types';

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
export class SqlTranslator implements ITranslator<ISqlTranslationResult | string> {
  private options: Required<ISqlTranslatorOptions>;
  private params: unknown[] = [];
  
  constructor(options: ISqlTranslatorOptions = {}) {
    this.options = {
      normalizeFieldNames: options.normalizeFieldNames ?? false,
      fieldMappings: options.fieldMappings ?? {},
      identifierQuote: options.identifierQuote ?? '"',
      stringLiteralQuote: options.stringLiteralQuote ?? "'",
      useParameters: options.useParameters ?? true
    };
  }

  /**
   * Translate a QueryKit expression to an SQL WHERE clause
   */
  public translate(expression: QueryExpression): ISqlTranslationResult | string {
    this.params = [];
    
    try {
      const sql = this.translateExpression(expression);
      
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
        throw new SqlTranslationError(`Unsupported expression type: ${(expression as { type: string }).type}`);
    }
  }

  /**
   * Translate a comparison expression to SQL
   */
  private translateComparisonExpression(expression: IComparisonExpression): string {
    const { field, operator, value } = expression;
    const fieldName = this.normalizeField(field);
    const quotedField = this.quoteIdentifier(fieldName);
    
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
          throw new SqlTranslationError('LIKE operator requires a string value');
        }
        // Convert wildcard syntax to SQL LIKE pattern
        const sqlPattern = this.wildcardToSqlPattern(value);
        return this.formatComparison(quotedField, 'LIKE', sqlPattern);
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
          throw new SqlTranslationError('NOT IN operator requires an array value');
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
    // Replace * with % and ? with _ for SQL LIKE syntax
    // Also escape any existing SQL LIKE special characters
    return pattern
      .replace(/%/g, '\\%')  // Escape existing %
      .replace(/_/g, '\\_')  // Escape existing _
      .replace(/\*/g, '%')   // * → %
      .replace(/\?/g, '_');  // ? → _
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
      throw new SqlTranslationError(`${operator} operator requires two operands`);
    }
    
    const rightSql = this.translateExpression(right);
    
    switch (operator) {
      case 'AND':
        return `(${leftSql}) AND (${rightSql})`;
      case 'OR':
        return `(${leftSql}) OR (${rightSql})`;
      default:
        throw new SqlTranslationError(`Unsupported logical operator: ${operator}`);
    }
  }

  /**
   * Format a comparison expression
   */
  private formatComparison(field: string, sqlOperator: string, value: unknown): string {
    if (value === null) {
      // Handle NULL comparisons
      return sqlOperator === '=' 
        ? `${field} IS NULL` 
        : `${field} IS NOT NULL`;
    }
    
    const formattedValue = this.formatValue(value);
    return `${field} ${sqlOperator} ${formattedValue}`;
  }

  /**
   * Format an IN clause
   */
  private formatInClause(field: string, values: unknown[], isNot: boolean): string {
    const operator = isNot ? 'NOT IN' : 'IN';
    
    if (this.options.useParameters) {
      const placeholders = values.map(() => `?`);
      this.params.push(...values);
      return `${field} ${operator} (${placeholders.join(', ')})`;
    } else {
      const formattedValues = values.map(v => this.formatValue(v, false));
      return `${field} ${operator} (${formattedValues.join(', ')})`;
    }
  }

  /**
   * Format a value for SQL
   */
  private formatValue(value: unknown, addToParams = true): string {
    if (this.options.useParameters && addToParams) {
      this.params.push(value);
      return '?';
    }
    
    if (value === null) {
      return 'NULL';
    }
    
    if (typeof value === 'string') {
      return `${this.options.stringLiteralQuote}${this.escapeString(value)}${this.options.stringLiteralQuote}`;
    }
    
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    
    if (value instanceof Date) {
      return `${this.options.stringLiteralQuote}${value.toISOString()}${this.options.stringLiteralQuote}`;
    }
    
    if (typeof value === 'object' && !Array.isArray(value)) {
      throw new SqlTranslationError(`Complex objects are not supported as values. Got: ${Object.prototype.toString.call(value)}`);
    }
    
    if (Array.isArray(value)) {
      const formattedValues = value.map(v => this.formatValue(v, false));
      return formattedValues.join(', ');
    }
    
    throw new SqlTranslationError(`Unsupported value type: ${typeof value}`);
  }

  /**
   * Escape a string literal for SQL
   */
  private escapeString(str: string): string {
    // Escape any quotes in the string by doubling them
    return str.replace(
      new RegExp(this.options.stringLiteralQuote, 'g'), 
      `${this.options.stringLiteralQuote}${this.options.stringLiteralQuote}`
    );
  }

  /**
   * Quote an identifier (field name) for SQL
   */
  private quoteIdentifier(identifier: string): string {
    // Handle table.column format
    if (identifier.includes('.')) {
      const parts = identifier.split('.');
      return parts.map(part => this.quoteIdentifier(part)).join('.');
    }
    
    const quote = this.options.identifierQuote;
    // Escape any quotes in the identifier by doubling them
    const escaped = identifier.replace(new RegExp(quote, 'g'), `${quote}${quote}`);
    return `${quote}${escaped}${quote}`;
  }

  /**
   * Normalize a field name based on translator options
   */
  private normalizeField(field: string): string {
    const normalizedField = this.options.normalizeFieldNames
      ? field.toLowerCase()
      : field;

    return this.options.fieldMappings[normalizedField] ?? normalizedField;
  }
} 