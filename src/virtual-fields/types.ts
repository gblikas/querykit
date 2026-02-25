/**
 * Type definitions for Virtual Fields support
 */

import {
  QueryExpression,
  IComparisonExpression,
  ComparisonOperator,
  IRawSqlExpression
} from '../parser/types';

/**
 * Context provided to raw SQL generators for adapter-specific SQL generation.
 */
export interface IRawSqlContext {
  /**
   * The database adapter identifier (e.g., 'drizzle')
   */
  adapter: string;
  /**
   * The table name being queried
   */
  tableName: string;
  /**
   * Access to the schema for field references
   */
  schema: Record<string, unknown>;
}

/**
 * Base interface for query context.
 * Users can extend this interface with their own context properties.
 */
export interface IQueryContext {
  [key: string]: unknown;
}

/**
 * Input provided to a virtual field resolver.
 * Contains the parsed field, operator, and value from the query.
 */
export interface IVirtualFieldInput {
  /**
   * The virtual field name (e.g., "my")
   */
  field: string;

  /**
   * The comparison operator used (e.g., ":", ">", "<", etc.)
   * Maps to ComparisonOperator type
   */
  operator: string;

  /**
   * The value provided in the query
   */
  value: string | number | boolean;
}

/**
 * Helper type to filter out index signatures from a type
 */
type KnownKeys<T> = {
  [K in keyof T]: string extends K ? never : number extends K ? never : K;
} extends { [_ in keyof T]: infer U }
  ? U
  : never;

/**
 * Utility type to extract all field names from a schema.
 * Recursively extracts field names from nested tables, excluding index signatures.
 */
export type AllSchemaFields<TSchema extends Record<string, object>> = {
  [K in KnownKeys<TSchema>]: TSchema[K] extends { [key: string]: unknown }
    ? keyof TSchema[K] & string
    : never;
}[KnownKeys<TSchema>];

/**
 * Type-safe mapping from allowed values to schema fields.
 * Ensures all keys in TKeys map to valid fields in the schema.
 */
export type SchemaFieldMap<
  TKeys extends string,
  TSchema extends Record<string, object>
> = Record<TKeys, AllSchemaFields<TSchema>>;

/**
 * Helper functions provided to virtual field resolvers.
 *
 * Note: The fields() method is generic at the method level, not the interface level.
 * This allows TypeScript to infer TValues from the mapping object passed at call-time,
 * eliminating the need for type assertions while maintaining full type safety.
 */
export interface IResolverHelpers<TSchema extends Record<string, object>> {
  /**
   * Type-safe field mapping helper.
   * Ensures all allowedValues are mapped to valid schema fields.
   *
   * The generic TValues parameter is inferred from the keys in the mapping object,
   * providing full type safety without requiring explicit type annotations.
   *
   * @example
   * const fieldMap = fields({
   *   assigned: 'assignee_id',
   *   created: 'creator_id'
   * });
   * // TypeScript infers TValues as 'assigned' | 'created'
   */
  fields: <TValues extends string>(
    mapping: SchemaFieldMap<TValues, TSchema>
  ) => SchemaFieldMap<TValues, TSchema>;
}

/**
 * Schema-constrained comparison expression.
 * Ensures field names are valid schema fields.
 */
export interface ITypedComparisonExpression<
  TFields extends string = string
> extends Omit<IComparisonExpression, 'field'> {
  type: 'comparison';
  field: TFields;
  operator: ComparisonOperator;
  value:
    | string
    | number
    | boolean
    | null
    | Array<string | number | boolean | null>;
}

/**
 * Schema-constrained query expression.
 * Can be a comparison, logical expression with typed fields, or a raw SQL expression.
 */
export type ITypedQueryExpression<TFields extends string = string> =
  | ITypedComparisonExpression<TFields>
  | IRawSqlExpression
  | QueryExpression;

/**
 * Definition for a virtual field.
 * Configures how a virtual field should be resolved at query execution time.
 */
export interface IVirtualFieldDefinition<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext = IQueryContext,
  TValues extends string | number | boolean = string | number | boolean
> {
  /**
   * Allowed values for this virtual field.
   * Use `as const` for type inference.
   *
   * @example
   * allowedValues: ['assigned', 'created', 'watching'] as const
   * allowedValues: [1, 2, 3] as const
   * allowedValues: [true, false] as const
   * allowedValues: ['today', 7, true] as const
   */
  allowedValues: readonly TValues[];

  /**
   * Whether to allow comparison operators beyond `:` (equality).
   * If false, only `:` is allowed. If true, `:>`, `:<`, etc. are permitted.
   *
   * @default false
   */
  allowOperators?: boolean;

  /**
   * Resolve the virtual field to a real query expression.
   * The `fields` helper ensures type-safe field references.
   *
   * @param input - The parsed virtual field input (field, operator, value)
   * @param context - Runtime context provided by createContext()
   * @param helpers - Helper functions including type-safe fields() helper
   * @returns A query expression that replaces the virtual field
   *
   * @example
   * resolve: (input, ctx, { fields }) => {
   *   const fieldMap = fields({
   *     assigned: 'assignee_id',
   *     created: 'creator_id'
   *   });
   *   return {
   *     type: 'comparison',
   *     field: fieldMap[input.value],
   *     operator: '==',
   *     value: ctx.currentUserId
   *   };
   * }
   */
  resolve: (
    input: IVirtualFieldInput & { value: TValues },
    context: TContext,
    helpers: IResolverHelpers<TSchema>
  ) => ITypedQueryExpression<AllSchemaFields<TSchema>>;

  /**
   * Human-readable description (for autocomplete UI).
   * Optional metadata for documentation and tooling.
   */
  description?: string;

  /**
   * Descriptions for each allowed value (for autocomplete UI).
   * Optional metadata for documentation and tooling.
   * For boolean values, use "true" or "false" as keys.
   */
  valueDescriptions?: Partial<
    Record<TValues extends string | number ? TValues : string, string>
  >;
}

/**
 * Configuration for all virtual fields in a QueryKit instance.
 *
 * Note: Uses a flexible type for the values to allow each virtual field definition
 * to have its own specific TValues type (e.g., 'assigned' | 'created' for one field,
 * 'high' | 'low' for another). The IResolverHelpers.fields() method infers these
 * types at call-time, maintaining type safety without needing explicit annotations.
 */
export type VirtualFieldsConfig<
  TSchema extends Record<string, object> = Record<string, object>,
  TContext extends IQueryContext = IQueryContext
> = {
  [fieldName: string]: IVirtualFieldDefinition<
    TSchema,
    TContext,
    string | number | boolean
  >;
};
