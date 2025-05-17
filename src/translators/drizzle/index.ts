/**
 * Drizzle ORM Translator for QueryKit
 * 
 * This translator converts QueryKit AST expressions into Drizzle ORM
 * query conditions that can be used in Drizzle's SQL query builder.
 */

import { SQL, SQLWrapper, eq, gt, gte, inArray, lt, lte, ne, notInArray, sql } from 'drizzle-orm';
import { IComparisonExpression, ILogicalExpression, QueryExpression } from '../../parser/types';
import { ITranslator, ITranslatorOptions } from '../types';

/**
 * Options specific to the Drizzle translator
 */
export interface IDrizzleTranslatorOptions extends ITranslatorOptions {
  /**
   * Schema information for type safety
   */
  schema?: Record<string, Record<string, SQLWrapper>>;
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
  public translate(expression: QueryExpression): SQL {
    try {
      return this.translateExpression(expression);
    } catch (error) {
      throw new DrizzleTranslationError(
        `Failed to translate expression: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an expression can be translated to Drizzle ORM
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
   * Translate any QueryKit expression to a Drizzle ORM condition
   */
  private translateExpression(expression: QueryExpression): SQL {
    if (!expression) {
      throw new DrizzleTranslationError('Empty expression');
    }

    switch (expression.type) {
      case 'comparison':
        return this.translateComparisonExpression(expression);
      case 'logical':
        return this.translateLogicalExpression(expression);
      default:
        throw new DrizzleTranslationError(`Unsupported expression type: ${(expression as { type: string }).type}`);
    }
  }

  /**
   * Translate a comparison expression to a Drizzle ORM condition
   */
  private translateComparisonExpression(expression: IComparisonExpression): SQL {
    const { field, operator, value } = expression;
    const fieldName = this.normalizeField(field);
    
    // Get the field from the schema if available
    const schemaField = this.getSchemaField(fieldName);
    
    // If we have a schema field, use it directly with Drizzle operators
    if (schemaField) {
      switch (operator) {
        case '==':
          return eq(schemaField, value);
        case '!=':
          return ne(schemaField, value);
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
            throw new DrizzleTranslationError('LIKE operator requires a string value');
          }
          // Convert wildcard to SQL pattern and use the like function
          const sqlPattern = this.wildcardToSqlPattern(value);
          return sql`${schemaField} LIKE ${sqlPattern}`;
        }
        case 'IN':
          if (!Array.isArray(value)) {
            throw new DrizzleTranslationError('IN operator requires an array value');
          }
          return inArray(schemaField, value);
        case 'NOT IN':
          if (!Array.isArray(value)) {
            throw new DrizzleTranslationError('NOT IN operator requires an array value');
          }
          return notInArray(schemaField, value);
        default:
          throw new DrizzleTranslationError(`Unsupported operator: ${operator}`);
      }
    }
    
    // If we don't have a schema field, we need to build the SQL manually
    // Handle each operator type
    return this.buildSqlForOperator(fieldName, operator, value);
  }

  /**
   * Build SQL for a specific operator with raw field name
   */
  private buildSqlForOperator(fieldName: string, operator: string, value: unknown): SQL {
    switch (operator) {
      case '==':
        return sql`${sql.identifier(fieldName)} = ${value}`;
      case '!=':
        return sql`${sql.identifier(fieldName)} != ${value}`;
      case '>':
        return sql`${sql.identifier(fieldName)} > ${value}`;
      case '>=':
        return sql`${sql.identifier(fieldName)} >= ${value}`;
      case '<':
        return sql`${sql.identifier(fieldName)} < ${value}`;
      case '<=':
        return sql`${sql.identifier(fieldName)} <= ${value}`;
      case 'LIKE': {
        if (typeof value !== 'string') {
          throw new DrizzleTranslationError('LIKE operator requires a string value');
        }
        // Convert wildcard to SQL pattern
        const sqlPattern = this.wildcardToSqlPattern(value);
        return sql`${sql.identifier(fieldName)} LIKE ${sqlPattern}`;
      }
      case 'IN': {
        if (!Array.isArray(value)) {
          throw new DrizzleTranslationError('IN operator requires an array value');
        }
        if (value.length === 0) {
          // Empty IN clause should always be false
          return sql`FALSE`;
        }
        return sql`${sql.identifier(fieldName)} IN (${value})`;
      }
      case 'NOT IN': {
        if (!Array.isArray(value)) {
          throw new DrizzleTranslationError('NOT IN operator requires an array value');
        }
        if (value.length === 0) {
          // Empty NOT IN clause should always be true
          return sql`TRUE`;
        }
        return sql`${sql.identifier(fieldName)} NOT IN (${value})`;
      }
      default:
        throw new DrizzleTranslationError(`Unsupported operator: ${operator}`);
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
   * Translate a logical expression to a Drizzle ORM condition
   */
  private translateLogicalExpression(expression: ILogicalExpression): SQL {
    const { operator, left, right } = expression;
    
    const leftSql = this.translateExpression(left);
    
    if (operator === 'NOT') {
      return sql`NOT (${leftSql})`;
    }
    
    if (!right) {
      throw new DrizzleTranslationError(`${operator} operator requires two operands`);
    }
    
    const rightSql = this.translateExpression(right);
    
    switch (operator) {
      case 'AND':
        return sql`(${leftSql}) AND (${rightSql})`;
      case 'OR':
        return sql`(${leftSql}) OR (${rightSql})`;
      default:
        throw new DrizzleTranslationError(`Unsupported logical operator: ${operator}`);
    }
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

  /**
   * Get a field from the schema if it exists
   */
  private getSchemaField(fieldName: string): SQLWrapper | null {
    // Extract table and column names from fieldName (e.g., 'users.id' -> { table: 'users', column: 'id' })
    const parts = fieldName.split('.');
    
    if (parts.length === 2) {
      const [tableName, columnName] = parts;
      const table = this.options.schema[tableName];
      
      if (table && columnName in table) {
        return table[columnName];
      }
    }
    
    // If the field is not found in the schema or not in the format 'table.column'
    return null;
  }
} 