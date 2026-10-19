import { QueryParser } from '../parser';
import { readLiteralAt } from '../parser/query-scanner';
import { QueryExpression } from '../parser/types';
import { QueryBuilderError } from './query-builder-error';
import {
  ComparisonOperator,
  IQueryBuilder,
  IQueryBuilderOptions,
  QueryField,
  QueryValue,
  SortDirection
} from './types';

/** A boolean operator word, read where a word starts and ended by a boundary. */
const BOOLEAN_OPERATOR_WORD = /^(AND|OR)(?=$|[\s()])/i;

/** Whether a boolean operator word may start at an index. */
function startsWord(clause: string, index: number): boolean {
  return index === 0 || /[\s()]/.test(clause[index - 1]);
}

/**
 * Whether a query string holds an AND or OR outside quotes, regex literals
 * and parentheses. A quoted `OR`, a regex `/a OR b/` and a dotted field
 * such as `or.group` are not operators.
 */
function hasTopLevelBooleanOperator(clause: string): boolean {
  let depth = 0;
  let index = 0;
  while (index < clause.length) {
    const literal = readLiteralAt(clause, index);
    if (literal.kind !== 'none') {
      index = Math.max(literal.end, index + 1);
      continue;
    }
    const char = clause[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(depth - 1, 0);
    } else if (
      depth === 0 &&
      startsWord(clause, index) &&
      BOOLEAN_OPERATOR_WORD.test(clause.slice(index))
    ) {
      return true;
    }
    index += 1;
  }
  return false;
}

/**
 * Parenthesize a query string that holds a top-level AND or OR, so it is
 * spliced into a larger expression as one operand: Liqe gives AND and OR
 * one precedence and associates left, so `(a) AND b OR c` would read as
 * `((a) AND b) OR c`. A simple comparison is returned as written.
 */
function groupClause(clause: string): string {
  return hasTopLevelBooleanOperator(clause) ? `(${clause})` : clause;
}

/**
 * Implementation of the type-safe query builder
 */
export class QueryBuilder<T> implements IQueryBuilder<T> {
  private parser: QueryParser;
  private expression: string = '';
  private orderByClause: string = '';
  private limitClause: string = '';
  private offsetClause: string = '';

  constructor(options: IQueryBuilderOptions<T> = {}) {
    this.parser = new QueryParser({
      caseInsensitiveFields: options.caseInsensitiveFields,
      fieldMappings: options.fieldMappings as Record<string, string>
    });
  }

  /**
   * Add a where clause to the query
   */
  public where(queryString: string): IQueryBuilder<T>;
  public where(
    field: QueryField<T>,
    operator: ComparisonOperator,
    value: QueryValue
  ): IQueryBuilder<T>;
  public where(
    fieldOrQueryString: QueryField<T> | string,
    operator?: ComparisonOperator,
    value?: QueryValue
  ): IQueryBuilder<T> {
    if (operator === undefined || value === undefined) {
      // Handle direct query string format
      this.expression = fieldOrQueryString as string;
    } else {
      // Handle field, operator, value format
      this.expression = this.buildComparison(
        fieldOrQueryString as QueryField<T>,
        operator,
        value
      );
    }
    return this;
  }

  /**
   * Add an AND where clause to the query
   */
  public andWhere(queryString: string): IQueryBuilder<T>;
  public andWhere(
    field: QueryField<T>,
    operator: ComparisonOperator,
    value: QueryValue
  ): IQueryBuilder<T>;
  public andWhere(
    fieldOrQueryString: QueryField<T> | string,
    operator?: ComparisonOperator,
    value?: QueryValue
  ): IQueryBuilder<T> {
    if (!this.expression) {
      if (
        typeof fieldOrQueryString === 'string' &&
        (operator === undefined || value === undefined)
      ) {
        // Handle direct query string
        return this.where(fieldOrQueryString);
      } else {
        // Handle field, operator, value format
        return this.where(
          fieldOrQueryString as QueryField<T>,
          operator as ComparisonOperator,
          value as QueryValue
        );
      }
    }

    if (operator === undefined || value === undefined) {
      // Handle direct query string format
      this.expression = `(${this.expression}) AND ${groupClause(
        fieldOrQueryString as string
      )}`;
    } else {
      // Handle field, operator, value format
      this.expression = `(${this.expression}) AND ${this.buildComparison(
        fieldOrQueryString as QueryField<T>,
        operator,
        value
      )}`;
    }
    return this;
  }

  /**
   * Add an OR where clause to the query
   */
  public orWhere(queryString: string): IQueryBuilder<T>;
  public orWhere(
    field: QueryField<T>,
    operator: ComparisonOperator,
    value: QueryValue
  ): IQueryBuilder<T>;
  public orWhere(
    fieldOrQueryString: QueryField<T> | string,
    operator?: ComparisonOperator,
    value?: QueryValue
  ): IQueryBuilder<T> {
    if (!this.expression) {
      if (
        typeof fieldOrQueryString === 'string' &&
        (operator === undefined || value === undefined)
      ) {
        // Handle direct query string
        return this.where(fieldOrQueryString);
      } else {
        // Handle field, operator, value format
        return this.where(
          fieldOrQueryString as QueryField<T>,
          operator as ComparisonOperator,
          value as QueryValue
        );
      }
    }

    if (operator === undefined || value === undefined) {
      // Handle direct query string format
      this.expression = `(${this.expression}) OR ${groupClause(
        fieldOrQueryString as string
      )}`;
    } else {
      // Handle field, operator, value format
      this.expression = `(${this.expression}) OR ${this.buildComparison(
        fieldOrQueryString as QueryField<T>,
        operator,
        value
      )}`;
    }
    return this;
  }

  /**
   * Add a NOT where clause to the query
   */
  public notWhere(queryString: string): IQueryBuilder<T>;
  public notWhere(
    field: QueryField<T>,
    operator: ComparisonOperator,
    value: QueryValue
  ): IQueryBuilder<T>;
  public notWhere(
    fieldOrQueryString: QueryField<T> | string,
    operator?: ComparisonOperator,
    value?: QueryValue
  ): IQueryBuilder<T> {
    if (!this.expression) {
      if (operator === undefined || value === undefined) {
        // Handle direct query string format
        this.expression = `NOT ${groupClause(fieldOrQueryString as string)}`;
      } else {
        // Handle field, operator, value format
        this.expression = `NOT ${this.buildComparison(
          fieldOrQueryString as QueryField<T>,
          operator,
          value
        )}`;
      }
    } else {
      if (operator === undefined || value === undefined) {
        // Handle direct query string format
        this.expression = `(${this.expression}) AND NOT ${groupClause(
          fieldOrQueryString as string
        )}`;
      } else {
        // Handle field, operator, value format
        this.expression = `(${this.expression}) AND NOT ${this.buildComparison(
          fieldOrQueryString as QueryField<T>,
          operator,
          value
        )}`;
      }
    }
    return this;
  }

  /**
   * Add an order by clause to the query
   */
  public orderBy(
    field: QueryField<T>,
    direction: SortDirection = 'asc'
  ): IQueryBuilder<T> {
    this.orderByClause = `ORDER BY ${field} ${direction.toUpperCase()}`;
    return this;
  }

  /**
   * Add a limit to the query
   */
  public limit(count: number): IQueryBuilder<T> {
    this.limitClause = `LIMIT ${count}`;
    return this;
  }

  /**
   * Add an offset to the query
   */
  public offset(count: number): IQueryBuilder<T> {
    this.offsetClause = `OFFSET ${count}`;
    return this;
  }

  /**
   * Get the current query expression
   */
  public getExpression(): QueryExpression {
    return this.parser.parse(this.expression);
  }

  /**
   * Get the current query as a string
   */
  public toString(): string {
    const clauses = [
      this.expression,
      this.orderByClause,
      this.limitClause,
      this.offsetClause
    ].filter(Boolean);

    return clauses.join(' ');
  }

  /**
   * Build a comparison expression
   */
  private buildComparison(
    field: QueryField<T>,
    operator: ComparisonOperator,
    value: QueryValue
  ): string {
    // Map QueryKit operators to Liqe operators
    const operatorMap: Record<ComparisonOperator, string> = {
      '==': ':',
      '!=': '!=',
      '>': '>',
      '>=': '>=',
      '<': '<',
      '<=': '<=',
      IN: 'in',
      'NOT IN': 'not in',
      LIKE: ':'
    };

    const liqeOperator = operatorMap[operator];
    const formattedValue = this.formatValue(value, operator);

    // For equality and LIKE operators, use field:value format (simple colon)
    if (operator === '==' || operator === 'LIKE') {
      return `${field}${liqeOperator}${formattedValue}`;
    }

    // Based on Liqe docs, comparison operators are prefixed with colon
    // e.g., 'height:>100', 'height:<100'
    if (
      operator === '>' ||
      operator === '>=' ||
      operator === '<' ||
      operator === '<=' ||
      operator === '!='
    ) {
      return `${field}:${liqeOperator}${formattedValue}`;
    }

    // For array operators (IN, NOT IN), use the format field:operator[values]
    if (operator === 'IN' || operator === 'NOT IN') {
      return `${field}:${liqeOperator}${formattedValue}`;
    }

    // For other operators, use field:operator value format
    return `${field}:${liqeOperator} ${formattedValue}`;
  }

  /**
   * Format a value for use in a query. A non-finite number has no Liqe
   * spelling, so it is rejected rather than written as a bare word the
   * parser would read back as a string, alone or as a list member.
   *
   * @throws {QueryBuilderError} For `NaN`, `Infinity` or `-Infinity`
   */
  private formatValue(
    value: QueryValue,
    operator?: ComparisonOperator
  ): string {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map(item => this.formatValue(item)).join(',')}]`;
    }
    if (typeof value === 'string') {
      if (this.isBareLikeToken(value, operator)) {
        return value;
      }
      return `"${this.escapeQuotedValue(value)}"`;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new QueryBuilderError(
        `Non-finite numbers are not supported. Got: ${String(value)}`
      );
    }
    return String(value);
  }

  /**
   * Keep a simple wildcard token unquoted.
   * Any other character is quoted so it cannot become another clause.
   */
  private isBareLikeToken(
    value: string,
    operator?: ComparisonOperator
  ): boolean {
    return (
      operator === 'LIKE' &&
      (value.includes('*') || value.includes('?')) &&
      /^[A-Za-z0-9*?]+$/.test(value)
    );
  }

  /**
   * Escape a string that will be wrapped in double quotes.
   */
  private escapeQuotedValue(value: string): string {
    return Array.from(value, (char: string): string =>
      this.escapeQuotedChar(char)
    ).join('');
  }

  /**
   * Escape one character for a double-quoted Liqe literal. Backslash and
   * quote take a backslash; a control character becomes `\uXXXX`, since Liqe
   * cannot carry a raw newline inside quotes but decodes the escape.
   */
  private escapeQuotedChar(char: string): string {
    if (char === '\\') {
      return '\\\\';
    }
    if (char === '"') {
      return '\\"';
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20) {
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
    return char;
  }
}
