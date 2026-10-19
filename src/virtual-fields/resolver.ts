/**
 * Virtual field resolution logic
 */

import {
  QueryExpression,
  IComparisonExpression,
  ILogicalExpression
} from '../parser/types';
import { QueryParseError } from '../parser/parser';
import {
  IQueryContext,
  IVirtualFieldInput,
  VirtualFieldsConfig,
  IResolverHelpers,
  SchemaFieldMap
} from './types';

/**
 * Resolve virtual fields in a query expression.
 * Recursively walks the AST and replaces virtual field references with
 * their resolved expressions based on the provided context.
 *
 * @param expr - The query expression to resolve
 * @param virtualFields - Virtual field configuration
 * @param context - Runtime context for resolution
 * @returns The resolved query expression
 * @throws {QueryParseError} If a virtual field value is invalid or operator is not allowed
 */
export function resolveVirtualFields<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext
>(
  expr: QueryExpression,
  virtualFields: VirtualFieldsConfig<TSchema, TContext>,
  context: TContext
): QueryExpression {
  // Base case: comparison expression
  if (expr.type === 'comparison') {
    return resolveComparisonExpression(expr, virtualFields, context);
  }

  // Recursive case: logical expression
  if (expr.type === 'logical') {
    return resolveLogicalExpression(expr, virtualFields, context);
  }

  // Pass through raw expressions
  if (expr.type === 'raw') {
    return expr;
  }

  // Unknown expression type, return as-is
  return expr;
}

/**
 * Reject a sort key that names a virtual field. A virtual field resolves to
 * a predicate, not a column, so no engine can order by it: SQLite would
 * reject the unknown column while an in-memory sort would tie every row.
 * `createQueryKit` calls this with the sort keys folded and mapped the way
 * the parser treats a filter field, before `createContext` or an adapter
 * runs.
 *
 * @param fields - The sort keys as the parser would resolve them
 * @param virtualFields - Virtual field configuration, if any
 * @throws {QueryParseError} When a key is an own key of `virtualFields`
 *
 * @example
 * ```typescript
 * assertNoVirtualSortField(['my'], virtualFields);
 * // QueryParseError: Virtual field "my" cannot be used in orderBy. It resolves to a filter, not a column.
 * ```
 */
export function assertNoVirtualSortField<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext
>(
  fields: readonly string[],
  virtualFields: VirtualFieldsConfig<TSchema, TContext> | undefined
): void {
  if (!virtualFields) {
    return;
  }
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(virtualFields, field)) {
      throw new QueryParseError(
        `Virtual field "${field}" cannot be used in orderBy. It resolves to a filter, not a column.`
      );
    }
  }
}

/**
 * Resolve a comparison expression.
 * If the field is a virtual field, resolve it using the configuration.
 * Otherwise, return the expression unchanged.
 */
function resolveComparisonExpression<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext
>(
  expr: IComparisonExpression,
  virtualFields: VirtualFieldsConfig<TSchema, TContext>,
  context: TContext
): QueryExpression {
  const fieldName = expr.field;
  // Bracket access walks the prototype, so `toString` is a function and
  // crashes when a real virtual field is configured beside it.
  if (!Object.prototype.hasOwnProperty.call(virtualFields, fieldName)) {
    return expr;
  }
  const virtualFieldDef = virtualFields[fieldName];

  // Validate the value type (virtual fields accept string, number, or boolean values)
  const valueType = typeof expr.value;
  if (
    valueType !== 'string' &&
    valueType !== 'number' &&
    valueType !== 'boolean'
  ) {
    const typeDescription = Array.isArray(expr.value)
      ? `array (${JSON.stringify(expr.value)})`
      : valueType === 'object'
        ? `object (${JSON.stringify(expr.value)})`
        : valueType;

    throw new QueryParseError(
      `Virtual field "${fieldName}" requires a string, number, or boolean value, got ${typeDescription}`
    );
  }

  const value = expr.value as string | number | boolean;

  // Validate the value is in allowedValues
  if (!virtualFieldDef.allowedValues.includes(value)) {
    const allowedValuesStr = virtualFieldDef.allowedValues
      .map(v => `"${v}"`)
      .join(', ');
    throw new QueryParseError(
      `Invalid value "${value}" for virtual field "${fieldName}". Allowed values: ${allowedValuesStr}`
    );
  }

  // Validate operator usage
  const allowOperators = virtualFieldDef.allowOperators ?? false;
  if (!allowOperators && expr.operator !== '==') {
    throw new QueryParseError(
      `Virtual field "${fieldName}" does not allow comparison operators. Only equality (":") is permitted.`
    );
  }

  // Create the input for the resolver
  const input: IVirtualFieldInput & { value: string | number | boolean } = {
    field: fieldName,
    operator: expr.operator,
    value: value
  };

  // Create the helpers object with type-safe fields() helper
  // The fields() method is generic at the method level, allowing TypeScript to
  // infer TValues from the mapping object at call-time without needing type assertions
  const helpers: IResolverHelpers<TSchema> = {
    fields: <TValues extends string>(
      mapping: SchemaFieldMap<TValues, TSchema>
    ): SchemaFieldMap<TValues, TSchema> => {
      // Validate that all keys in the mapping are in the virtual field's allowed values
      const mappingKeys = Object.keys(mapping);
      const allowedValues = virtualFieldDef.allowedValues as readonly (
        | string
        | number
        | boolean
      )[];

      for (const key of mappingKeys) {
        // Convert string key to appropriate type for comparison
        // Numbers: "1" -> 1, Booleans: "true" -> true, Strings: remain as-is
        let keyToCheck: string | number | boolean = key;

        // Try to parse as number - but only if that specific number exists in allowedValues
        const asNumber = Number(key);
        if (!isNaN(asNumber) && allowedValues.includes(asNumber)) {
          keyToCheck = asNumber;
        }
        // Try to parse as boolean
        else if (key === 'true' || key === 'false') {
          keyToCheck = key === 'true';
        }

        if (!allowedValues.includes(keyToCheck)) {
          throw new QueryParseError(
            `Invalid key "${key}" in field mapping for virtual field "${fieldName}". ` +
              `Allowed keys are: ${allowedValues.map(v => `"${v}"`).join(', ')}`
          );
        }
      }

      // Runtime: this is just an identity function
      // Compile-time: TypeScript validates the mapping structure
      return mapping;
    }
  };

  // Resolve the virtual field - no type assertions needed!
  const resolved = virtualFieldDef.resolve(input, context, helpers);

  return resolved as QueryExpression;
}

/**
 * Resolve a logical expression.
 * Recursively resolve both left and right sides.
 */
function resolveLogicalExpression<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext
>(
  expr: ILogicalExpression,
  virtualFields: VirtualFieldsConfig<TSchema, TContext>,
  context: TContext
): ILogicalExpression {
  return {
    type: 'logical',
    operator: expr.operator,
    left: resolveVirtualFields(expr.left, virtualFields, context),
    right: expr.right
      ? resolveVirtualFields(expr.right, virtualFields, context)
      : undefined
  };
}
