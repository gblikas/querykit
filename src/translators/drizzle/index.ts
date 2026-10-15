/**
 * Drizzle ORM Translator for QueryKit
 *
 * This translator converts QueryKit AST expressions into Drizzle ORM
 * query conditions that can be used in Drizzle's SQL query builder.
 */

import {
  SQL,
  SQLWrapper,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  notInArray,
  sql
} from 'drizzle-orm';
import {
  IComparisonExpression,
  ILogicalExpression,
  QueryExpression
} from '../../parser/types';
import { likeEscapeClause, toSqlLikePattern } from '../like-pattern';
import { ITranslationContext, ITranslator, ITranslatorOptions } from '../types';

/**
 * Options specific to the Drizzle translator
 */
export interface IDrizzleTranslatorOptions extends ITranslatorOptions {
  /**
   * Schema information for type safety
   */
  schema?: Record<string, Record<string, unknown>>;
}

/**
 * Error thrown when translation fails
 */
export class DrizzleTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrizzleTranslationError';
  }
}

/**
 * Translates QueryKit AST expressions to Drizzle ORM conditions
 */
export class DrizzleTranslator implements ITranslator<SQL> {
  private options: Required<IDrizzleTranslatorOptions>;

  constructor(options: IDrizzleTranslatorOptions = {}) {
    this.options = {
      normalizeFieldNames: options.normalizeFieldNames ?? false,
      fieldMappings: options.fieldMappings ?? {},
      schema: options.schema ?? {}
    };
  }

  /**
   * Translate a QueryKit expression to a Drizzle ORM condition
   */
  public translate(
    expression: QueryExpression,
    context: ITranslationContext = {}
  ): SQL {
    try {
      return this.translateExpression(expression, context);
    } catch (error) {
      throw new DrizzleTranslationError(
        `Failed to translate expression: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an expression can be translated to Drizzle ORM
   */
  public canTranslate(
    expression: QueryExpression,
    context: ITranslationContext = {}
  ): boolean {
    try {
      this.translateExpression(expression, context);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Translate any QueryKit expression to a Drizzle ORM condition
   */
  private translateExpression(
    expression: QueryExpression,
    context: ITranslationContext
  ): SQL {
    if (!expression) {
      throw new DrizzleTranslationError('Empty expression');
    }

    switch (expression.type) {
      case 'comparison':
        return this.translateComparisonExpression(expression, context);
      case 'logical':
        return this.translateLogicalExpression(expression, context);
      case 'raw': {
        const rawExpr = expression as {
          type: 'raw';
          toSql: (context: {
            adapter: string;
            tableName: string;
            schema: Record<string, unknown>;
          }) => unknown;
        };
        return rawExpr.toSql({
          adapter: 'drizzle',
          // The selected table is known only when an adapter supplies it;
          // raw SQL in virtual fields is resolved before translation.
          tableName: context.tableName ?? '',
          schema: this.options.schema
        }) as SQL;
      }
      default:
        throw new DrizzleTranslationError(
          `Unsupported expression type: ${(expression as { type: string }).type}`
        );
    }
  }

  /**
   * Translate a comparison expression to a Drizzle ORM condition
   */
  private translateComparisonExpression(
    expression: IComparisonExpression,
    context: ITranslationContext
  ): SQL {
    const { field, operator, value } = expression;
    const fieldName = this.normalizeField(field);
    if (operator !== 'IN' && operator !== 'NOT IN') {
      this.assertFiniteValue(value);
    }
    const schemaField = this.getSchemaField(fieldName, context.tableName);

    // If we have a schema field, use it directly with Drizzle operators
    if (schemaField) {
      switch (operator) {
        case '==':
          return value === null
            ? sql`${schemaField} IS NULL`
            : eq(schemaField, value);
        case '!=':
          return value === null
            ? sql`${schemaField} IS NOT NULL`
            : ne(schemaField, value);
        case '>':
          return gt(schemaField, value);
        case '>=':
          return gte(schemaField, value);
        case '<':
          return lt(schemaField, value);
        case '<=':
          return lte(schemaField, value);
        case 'LIKE': {
          if (typeof value !== 'string') {
            throw new DrizzleTranslationError(
              'LIKE operator requires a string value'
            );
          }
          const sqlPattern = this.wildcardToSqlPattern(value);
          return sql`${schemaField} LIKE ${sqlPattern} ${sql.raw(likeEscapeClause())}`;
        }
        case 'IN':
          if (!Array.isArray(value)) {
            throw new DrizzleTranslationError(
              'IN operator requires an array value'
            );
          }
          return this.translateMembership(schemaField, value, false);
        case 'NOT IN':
          if (!Array.isArray(value)) {
            throw new DrizzleTranslationError(
              'NOT IN operator requires an array value'
            );
          }
          return this.translateMembership(schemaField, value, true);
        default:
          throw new DrizzleTranslationError(
            `Unsupported operator: ${operator}`
          );
      }
    }

    // If we don't have a schema field, we need to build the SQL manually
    // Handle each operator type
    return this.buildSqlForOperator(fieldName, operator, value);
  }

  /**
   * Build SQL for a specific operator with raw field name
   * Security: Validates field names to prevent SQL injection
   */
  private buildSqlForOperator(
    fieldName: string,
    operator: string,
    value: unknown
  ): SQL {
    // Security fix: Validate field name format before using it (prevents SQL injection)
    if (!this.isValidFieldName(fieldName)) {
      throw new DrizzleTranslationError(`Invalid field name: ${fieldName}`);
    }

    const column = this.quotedField(fieldName);
    switch (operator) {
      case '==':
        return value === null
          ? sql`${column} IS NULL`
          : sql`${column} = ${value}`;
      case '!=':
        return value === null
          ? sql`${column} IS NOT NULL`
          : sql`${column} != ${value}`;
      case '>':
        return sql`${column} > ${value}`;
      case '>=':
        return sql`${column} >= ${value}`;
      case '<':
        return sql`${column} < ${value}`;
      case '<=':
        return sql`${column} <= ${value}`;
      case 'LIKE': {
        if (typeof value !== 'string') {
          throw new DrizzleTranslationError(
            'LIKE operator requires a string value'
          );
        }
        const sqlPattern = this.wildcardToSqlPattern(value);
        return sql`${column} LIKE ${sqlPattern} ${sql.raw(likeEscapeClause())}`;
      }
      case 'IN': {
        if (!Array.isArray(value)) {
          throw new DrizzleTranslationError(
            'IN operator requires an array value'
          );
        }
        return this.translateMembership(column, value, false);
      }
      case 'NOT IN': {
        if (!Array.isArray(value)) {
          throw new DrizzleTranslationError(
            'NOT IN operator requires an array value'
          );
        }
        return this.translateMembership(column, value, true);
      }
      default:
        throw new DrizzleTranslationError(`Unsupported operator: ${operator}`);
    }
  }

  /**
   * Quote a validated field, splitting table.column into separate identifiers.
   */
  private quotedField(fieldName: string): SQL {
    const parts = fieldName.split('.');
    if (parts.length === 1) {
      return sql`${sql.identifier(parts[0])}`;
    }
    return sql`${sql.identifier(parts[0])}.${sql.identifier(parts[1])}`;
  }

  /**
   * Translate IN / NOT IN so NULL members agree with IS NULL / IS NOT NULL.
   * Empty IN is false and empty NOT IN is true; Drizzle's inArray has
   * treated an empty list differently across versions, so the rewrite
   * handles it here. The non-null members go through inArray / notInArray
   * so the column's encoder applies, as it does for `==`: a boolean-mode
   * integer column binds `true` as 1 rather than as a boolean SQLite cannot
   * bind.
   *
   * @throws {DrizzleTranslationError} When a member is a non-finite number
   */
  private translateMembership(
    column: SQLWrapper,
    values: unknown[],
    isNegated: boolean
  ): SQL {
    for (const value of values) {
      this.assertFiniteValue(value);
    }
    if (values.length === 0) {
      return isNegated ? sql`TRUE` : sql`FALSE`;
    }
    const nonNullValues = values.filter(
      (value: unknown): boolean => value !== null
    );
    const hasNull = nonNullValues.length !== values.length;
    if (isNegated) {
      if (!hasNull) {
        return notInArray(column, nonNullValues);
      }
      if (nonNullValues.length === 0) {
        return sql`${column} IS NOT NULL`;
      }
      return sql`(${column} IS NOT NULL AND ${notInArray(column, nonNullValues)})`;
    }
    if (!hasNull) {
      return inArray(column, nonNullValues);
    }
    if (nonNullValues.length === 0) {
      return sql`${column} IS NULL`;
    }
    return sql`(${column} IS NULL OR ${inArray(column, nonNullValues)})`;
  }

  private assertFiniteValue(value: unknown): void {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new DrizzleTranslationError(
        `Non-finite numbers are not supported. Got: ${String(value)}`
      );
    }
  }

  /**
   * Convert wildcard pattern to SQL LIKE pattern
   */
  private wildcardToSqlPattern(pattern: string): string {
    return toSqlLikePattern(pattern);
  }

  /**
   * Translate a logical expression to a Drizzle ORM condition
   */
  private translateLogicalExpression(
    expression: ILogicalExpression,
    context: ITranslationContext
  ): SQL {
    const { operator, left, right } = expression;

    const leftSql = this.translateExpression(left, context);

    if (operator === 'NOT') {
      return sql`NOT (${leftSql})`;
    }

    if (!right) {
      throw new DrizzleTranslationError(
        `${operator} operator requires two operands`
      );
    }

    const rightSql = this.translateExpression(right, context);

    switch (operator) {
      case 'AND':
        return sql`(${leftSql}) AND (${rightSql})`;
      case 'OR':
        return sql`(${leftSql}) OR (${rightSql})`;
      default:
        throw new DrizzleTranslationError(
          `Unsupported logical operator: ${operator}`
        );
    }
  }

  /**
   * Normalize a field name based on translator options
   */
  private normalizeField(field: string): string {
    const normalizedField = this.options.normalizeFieldNames
      ? field.toLowerCase()
      : field;
    // Bracket access walks the prototype, so names such as `toString`
    // would otherwise resolve to functions instead of column names.
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
   * Resolve a field to a schema column. A qualified `table.column` reads the
   * full schema. A bare name reads the table the adapter selected, or the
   * schema's only table when translating standalone; with several tables and
   * no selection a bare name is ambiguous and is quoted instead.
   */
  private getSchemaField(
    fieldName: string,
    tableName?: string
  ): SQLWrapper | null {
    const parts = fieldName.split('.');
    if (parts.length === 2) {
      return this.columnOf(parts[0] ?? '', parts[1] ?? '');
    }
    if (parts.length !== 1) {
      return null;
    }
    const scopeTable = tableName ?? this.onlyTableName();
    if (scopeTable === undefined) {
      return null;
    }
    return this.columnOf(scopeTable, parts[0] ?? '');
  }

  /**
   * The schema's only table name, when it has exactly one.
   */
  private onlyTableName(): string | undefined {
    const tableNames = Object.keys(this.options.schema);
    return tableNames.length === 1 ? tableNames[0] : undefined;
  }

  /**
   * Own-property lookup of a column: `constructor.name` must not resolve the
   * inherited Object constructor as a table and its `name` as a column.
   */
  private columnOf(tableName: string, columnName: string): SQLWrapper | null {
    if (!Object.prototype.hasOwnProperty.call(this.options.schema, tableName)) {
      return null;
    }
    const table = this.options.schema[tableName] as
      | Record<string, unknown>
      | undefined;
    if (!table || !Object.prototype.hasOwnProperty.call(table, columnName)) {
      return null;
    }
    return table[columnName] as SQLWrapper;
  }

  /**
   * Security: Validates field names to prevent SQL injection
   * Only allows alphanumeric chars, dots, underscores. Max 64 chars per part.
   */
  private isValidFieldName(fieldName: string): boolean {
    const validFieldPattern = /^[a-zA-Z][a-zA-Z0-9._]*$/;
    const parts = fieldName.split('.');

    // Only allow table.column format (max 2 parts)
    if (parts.length > 2) return false;

    return parts.every(
      part =>
        validFieldPattern.test(part) &&
        part.length <= 64 &&
        !part.includes('__') // Prevent reserved patterns
    );
  }
}
