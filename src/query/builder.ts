import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import {
  ComparisonOperator,
  IQueryBuilder,
  IQueryBuilderOptions,
  QueryField,
  QueryValue,
  SortDirection
} from './types';

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
  public where(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
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
  public andWhere(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
  public andWhere(
    fieldOrQueryString: QueryField<T> | string,
    operator?: ComparisonOperator,
    value?: QueryValue
  ): IQueryBuilder<T> {
    if (!this.expression) {
      if (typeof fieldOrQueryString === 'string' && (operator === undefined || value === undefined)) {
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
      this.expression = `(${this.expression}) AND ${fieldOrQueryString}`;
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
  public orWhere(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
  public orWhere(
    fieldOrQueryString: QueryField<T> | string,
    operator?: ComparisonOperator,
    value?: QueryValue
  ): IQueryBuilder<T> {
    if (!this.expression) {
      if (typeof fieldOrQueryString === 'string' && (operator === undefined || value === undefined)) {
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
      this.expression = `(${this.expression}) OR ${fieldOrQueryString}`;
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
  public notWhere(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): IQueryBuilder<T>;
  public notWhere(
    fieldOrQueryString: QueryField<T> | string,
    operator?: ComparisonOperator,
    value?: QueryValue
  ): IQueryBuilder<T> {
    if (!this.expression) {
      if (operator === undefined || value === undefined) {
        // Handle direct query string format
        this.expression = `NOT ${fieldOrQueryString}`;
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
        this.expression = `(${this.expression}) AND NOT ${fieldOrQueryString}`;
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
  public orderBy(field: QueryField<T>, direction: SortDirection = 'asc'): IQueryBuilder<T> {
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
  private buildComparison(field: QueryField<T>, operator: ComparisonOperator, value: QueryValue): string {
    // Map QueryKit operators to Liqe operators
    const operatorMap: Record<ComparisonOperator, string> = {
      '==': ':',
      '!=': '!=',
      '>': '>',
      '>=': '>=',
      '<': '<',
      '<=': '<=',
      'IN': 'in',
      'NOT IN': 'not in',
      'LIKE': ':'
    };

    const liqeOperator = operatorMap[operator];
    const formattedValue = this.formatValue(value, operator);

    // For equality and LIKE operators, use field:value format (simple colon)
    if (operator === '==' || operator === 'LIKE') {
      return `${field}${liqeOperator}${formattedValue}`;
    }

    // Based on Liqe docs, comparison operators are prefixed with colon
    // e.g., 'height:>100', 'height:<100'
    if (operator === '>' || operator === '>=' || operator === '<' || operator === '<=' || operator === '!=') {
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
   * Format a value for use in a query
   */
  private formatValue(value: QueryValue, operator?: ComparisonOperator): string {
    if (value === null) {
      return 'null';
    }

    if (Array.isArray(value)) {
      return `[${value.map(v => this.formatValue(v)).join(',')}]`;
    }

    if (typeof value === 'string') {
      // For LIKE operator with wildcard patterns, don't add quotes to allow pattern matching
      if (operator === 'LIKE' && (value.includes('*') || value.includes('?'))) {
        return value;
      }
      return `"${value}"`;
    }

    return String(value);
  }
} 