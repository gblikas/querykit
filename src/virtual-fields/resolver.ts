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

  // Unknown expression type, return as-is
  return expr;
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
  const virtualFieldDef = virtualFields[fieldName];

  // Not a virtual field, return as-is
  if (!virtualFieldDef) {
    return expr;
  }

  // Validate the value is a string (virtual fields require string values)
  if (typeof expr.value !== 'string') {
    const valueType = Array.isArray(expr.value)
      ? `array (${JSON.stringify(expr.value)})`
      : typeof expr.value === 'object'
        ? `object (${JSON.stringify(expr.value)})`
        : typeof expr.value;

    throw new QueryParseError(
      `Virtual field "${fieldName}" requires a string value, got ${valueType}`
    );
  }

  const value = expr.value;

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
  const input: IVirtualFieldInput & { value: string } = {
    field: fieldName,
    operator: expr.operator,
    value: value
  };

  // Create the helpers object with type-safe fields() helper
  const helpers: IResolverHelpers<TSchema, string> = {
    fields: <TValues extends string>(
      mapping: SchemaFieldMap<TValues, TSchema>
    ): SchemaFieldMap<TValues, TSchema> => {
      // Runtime: this is just an identity function
      // Compile-time: TypeScript validates the mapping
      return mapping;
    }
  };

  // Resolve the virtual field
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
