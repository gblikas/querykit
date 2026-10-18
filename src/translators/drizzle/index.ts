/**
 * Drizzle ORM Translator for QueryKit
 *
 * This translator converts QueryKit AST expressions into Drizzle ORM
 * query conditions that can be used in Drizzle's SQL query builder.
 */

import { SQL, SQLWrapper, sql } from 'drizzle-orm';
import {
  IComparisonExpression,
  ILogicalExpression,
  QueryExpression
} from '../../parser/types';
import {
  isQuotableFieldName,
  quoteFieldIdentifiers,
  readFieldIdentifiers
} from '../field-identifiers';
import { likeEscapeClause, toSqlLikePattern } from '../like-pattern';
import { findOwnKeyIgnoringCase } from '../own-key-case';
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
 * The part of a Drizzle column that rewrites a query value for the driver,
 * such as the boolean-mode integer encoder that turns `true` into `1`.
 */
interface IDriverValueEncoder {
  mapToDriverValue: (value: unknown) => unknown;
}

/**
 * A field name after the translator's own normalization and mapping, with
 * the parser's literal flag when the mapping kept the name.
 */
interface IResolvedField {
  name: string;
  isLiteral: boolean;
}

/**
 * A schema table under the key it was declared with, whose own keys are
 * the properties a query may name.
 */
interface ISchemaTable {
  name: string;
  columns: Record<string, unknown>;
}

/**
 * The driver value a column's encoder produces for a boolean or a `Date`,
 * or the value itself when the column has no encoder or the encoder leaves
 * the value alone (or cannot take it, such as a timestamp encoder given a
 * boolean).
 */
function encodedDriverValue(
  column: SQLWrapper,
  value: boolean | Date
): unknown {
  const encoder = (column as Partial<IDriverValueEncoder>).mapToDriverValue;
  if (typeof encoder !== 'function') {
    return value;
  }
  try {
    return encoder.call(column, value);
  } catch {
    return value;
  }
}

/**
 * Whether a column's encoder rewrites the value, in which case the value is
 * bound through that encoder rather than inlined or written as text.
 */
function rewritesValue(
  column: SQLWrapper | null,
  value: boolean | Date
): boolean {
  return column !== null && encodedDriverValue(column, value) !== value;
}

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
  private options: Required<
    Omit<IDrizzleTranslatorOptions, keyof ITranslationSecurity>
  > &
    ITranslationSecurity;

  constructor(options: IDrizzleTranslatorOptions = {}) {
    this.options = {
      ...options,
      normalizeFieldNames: options.normalizeFieldNames ?? false,
      fieldMappings: options.fieldMappings ?? {},
      schema: options.schema ?? {}
    };
  }

  /**
   * Translate a QueryKit expression to a Drizzle ORM condition.
   *
   * The shared security checks run first, with the settings from the
   * constructor options overridden by any on the context, and the enforced
   * exclusions are appended before translation. A `QuerySecurityError` from
   * those checks is thrown as is, not wrapped as a translation error.
   *
   * @param expression The QueryKit expression to translate
   * @param context Table the query selects from, which bare fields resolve against, and the security settings of this translation
   * @returns The Drizzle condition
   * @throws {QuerySecurityError} When the query breaks a cap or names a field outside the allowlist
   * @throws {DrizzleTranslationError} When the expression, an operator, or a field name cannot be translated
   */
  public translate(
    expression: QueryExpression,
    context: ITranslationContext = {}
  ): SQL {
    const constrained = enforceTranslationSecurity(
      expression,
      resolveTranslationSecurity(this.options, context)
    );
    try {
      return this.translateExpression(constrained, context);
    } catch (error) {
      throw new DrizzleTranslationError(
        `Failed to translate expression: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an expression can be translated to Drizzle ORM
   *
   * @param expression The expression to check
   * @param context Table the query selects from; bare fields resolve against it
   * @returns true if the expression can be translated, false otherwise
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
    const { operator, value } = expression;
    const resolved = this.resolveField(expression);
    if (operator !== 'IN' && operator !== 'NOT IN') {
      this.assertFiniteValue(value);
    }
    const schemaField = this.getSchemaField(
      resolved.name,
      context.tableName,
      resolved.isLiteral
    );
    // A schema column is embedded as itself, so Drizzle prints the column's
    // own name; any other field is quoted as written.
    const column =
      schemaField ?? this.quoteSqlIdentifier(resolved.name, resolved.isLiteral);
    return this.buildSqlForOperator(column, schemaField, operator, value);
  }

  /**
   * Build the condition for one operator. Every value is bound as itself:
   * a string, a number and a bigint never pass through a column encoder, so
   * a boolean-mode column cannot turn `TRUE`, `yes` or `2` into `1`. A
   * boolean and a `Date` go through the encoder only when it rewrites them,
   * else a boolean is inlined and a `Date` is bound as ISO-8601 text.
   *
   * @param column - The column or quoted identifier to compare
   * @param encoder - The schema column whose encoder may apply, if any
   * @throws {DrizzleTranslationError} For an operator this translator lacks
   * or a value of the wrong shape
   */
  private buildSqlForOperator(
    column: SQLWrapper,
    encoder: SQLWrapper | null,
    operator: string,
    value: unknown
  ): SQL {
    switch (operator) {
      case '==':
        return value === null
          ? sql`${column} IS NULL`
          : sql`${column} = ${this.bindValue(value, encoder)}`;
      case '!=':
        return value === null
          ? sql`${column} IS NOT NULL`
          : sql`${column} ${sql.raw(encoder ? '<>' : '!=')} ${this.bindValue(value, encoder)}`;
      case '>':
        return sql`${column} > ${this.bindValue(value, encoder)}`;
      case '>=':
        return sql`${column} >= ${this.bindValue(value, encoder)}`;
      case '<':
        return sql`${column} < ${this.bindValue(value, encoder)}`;
      case '<=':
        return sql`${column} <= ${this.bindValue(value, encoder)}`;
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
        return this.translateMembership(column, encoder, value, false);
      }
      case 'NOT IN': {
        if (!Array.isArray(value)) {
          throw new DrizzleTranslationError(
            'NOT IN operator requires an array value'
          );
        }
        return this.translateMembership(column, encoder, value, true);
      }
      default:
        throw new DrizzleTranslationError(`Unsupported operator: ${operator}`);
    }
  }

  /**
   * The SQL chunk for one query value. A boolean is inlined as `TRUE` /
   * `FALSE`, which no SQLite driver could bind, unless the column encodes
   * it (a boolean-mode integer column binds 1 / 0). A `Date` is bound as
   * ISO-8601 text, the form SQLite stores, unless the column encoder
   * rewrites it (a timestamp column keeps its unix value). Anything else is
   * bound as itself.
   */
  private bindValue(value: unknown, encoder: SQLWrapper | null): SQL {
    if (typeof value === 'boolean') {
      return encoder && rewritesValue(encoder, value)
        ? sql`${sql.param(value, encoder as unknown as IDriverValueEncoder)}`
        : sql.raw(value ? 'TRUE' : 'FALSE');
    }
    if (value instanceof Date) {
      return encoder && rewritesValue(encoder, value)
        ? sql`${sql.param(value, encoder as unknown as IDriverValueEncoder)}`
        : sql`${value.toISOString()}`;
    }
    return sql`${value}`;
  }

  /**
   * Quote a field Drizzle inlines. Each identifier is written locally with
   * an embedded quote doubled, so the name may hold a space, a quote, or any
   * other character; `;` and a null byte are rejected, as is a reserved
   * `__` or a part longer than 64 characters.
   *
   * @throws {DrizzleTranslationError} `Invalid field name` for a name that
   * cannot be quoted
   */
  private quoteSqlIdentifier(fieldName: string, isLiteral: boolean): SQL {
    if (!isQuotableFieldName(fieldName, isLiteral)) {
      throw new DrizzleTranslationError(`Invalid field name: ${fieldName}`);
    }
    return sql.raw(quoteFieldIdentifiers(fieldName, isLiteral));
  }

  /**
   * Translate IN / NOT IN so NULL members agree with IS NULL / IS NOT NULL.
   * Empty IN is false and empty NOT IN is true; Drizzle's inArray has
   * treated an empty list differently across versions, so the list is
   * written here. Each non-null member is bound the way `==` binds it, so a
   * boolean member is inlined unless the column encodes it.
   *
   * @throws {DrizzleTranslationError} When a member is a non-finite number
   */
  private translateMembership(
    column: SQLWrapper,
    encoder: SQLWrapper | null,
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
    const members = sql.join(
      nonNullValues.map(value => this.bindValue(value, encoder)),
      sql`, `
    );
    if (isNegated) {
      if (!hasNull) {
        return sql`${column} not in (${members})`;
      }
      if (nonNullValues.length === 0) {
        return sql`${column} IS NOT NULL`;
      }
      return sql`(${column} IS NOT NULL AND ${column} not in (${members}))`;
    }
    if (!hasNull) {
      return sql`${column} in (${members})`;
    }
    if (nonNullValues.length === 0) {
      return sql`${column} IS NULL`;
    }
    return sql`(${column} IS NULL OR ${column} in (${members}))`;
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
   * Normalize and map a field name. The parser's literal flag survives
   * case folding but not a mapping that replaces the name, since the mapped
   * name was written by the caller, not quoted in the query.
   */
  private resolveField(expression: IComparisonExpression): IResolvedField {
    const normalizedField = this.options.normalizeFieldNames
      ? expression.field.toLowerCase()
      : expression.field;
    // Bracket access walks the prototype, so names such as `toString`
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

  /**
   * Resolve a field to a schema column. A single unmarked `table.column`
   * reads the full schema. Any other name, including a literal `"a.b"` and
   * a three-part `a.b.c`, is one column key read from the table the adapter
   * selected, or from the schema's only table when translating standalone;
   * with several tables and no selection a bare name is ambiguous and is
   * quoted instead. When the table is in the schema, the query names its
   * properties: a name that resolves to none of them is rejected rather
   * than quoted as a raw identifier, so the column name `status_col` does
   * not reach the engine in place of the property `status`. A table the
   * schema lacks, and every name of a translator without a schema, is
   * quoted as written for the engine to accept or reject.
   *
   * @throws {DrizzleTranslationError} When the table is in the schema and
   * the name could be an identifier but resolves to none of its properties
   */
  private getSchemaField(
    fieldName: string,
    tableName: string | undefined,
    isLiteral: boolean
  ): SQLWrapper | null {
    const parts = readFieldIdentifiers(fieldName, isLiteral);
    const scopeTable =
      parts.length === 2 ? parts[0] : (tableName ?? this.onlyTableName());
    if (scopeTable === undefined) {
      return null;
    }
    const table = this.tableOf(scopeTable);
    if (table === undefined) {
      return null;
    }
    const columnKey = findOwnKeyIgnoringCase(
      table.columns,
      parts[parts.length - 1] ?? ''
    );
    if (columnKey !== undefined) {
      return table.columns[columnKey] as SQLWrapper;
    }
    if (!isQuotableFieldName(fieldName, isLiteral)) {
      return null;
    }
    throw new DrizzleTranslationError(
      `Field ${fieldName} does not name a property of table ${table.name}`
    );
  }

  /**
   * The schema's only table name, when it has exactly one.
   */
  private onlyTableName(): string | undefined {
    const tableNames = Object.keys(this.options.schema);
    return tableNames.length === 1 ? tableNames[0] : undefined;
  }

  /**
   * Own-key lookup of a table. The key resolves exactly or by the one own
   * key differing only by ASCII case, the rule SQLite applies to an
   * identifier, so `Items.CreatedAt` reaches the table `items`; its column
   * key resolves the same way and reaches the renamed column `created_at`
   * through its property. Two keys that fold alike resolve nothing, and
   * `constructor.name` must not resolve the inherited Object constructor
   * as a table and its `name` as a column.
   */
  private tableOf(tableName: string): ISchemaTable | undefined {
    const tableKey = findOwnKeyIgnoringCase(this.options.schema, tableName);
    if (tableKey === undefined) {
      return undefined;
    }
    const columns = this.options.schema[tableKey] as
      | Record<string, unknown>
      | undefined;
    if (!columns) {
      return undefined;
    }
    return { name: tableKey, columns };
  }
}
