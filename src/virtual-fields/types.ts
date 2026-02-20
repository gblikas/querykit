/**
 * Type definitions for Virtual Fields support
 */

import {
  QueryExpression,
  IComparisonExpression,
  ComparisonOperator
} from '../parser/types';

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
  value: string;
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
 */
export interface IResolverHelpers<
  TSchema extends Record<string, object>,
  TValues extends string = string
> {
  /**
   * Type-safe field mapping helper.
   * Ensures all allowedValues are mapped to valid schema fields.
   *
   * @example
   * const fieldMap = fields({
   *   assigned: 'assignee_id',
   *   created: 'creator_id'
   * });
   */
  fields: (
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
 * Can be a comparison or logical expression with typed fields.
 */
export type ITypedQueryExpression<TFields extends string = string> =
  | ITypedComparisonExpression<TFields>
  | QueryExpression;

/**
 * Definition for a virtual field.
 * Configures how a virtual field should be resolved at query execution time.
 */
export interface IVirtualFieldDefinition<
  TSchema extends Record<string, object>,
  TContext extends IQueryContext = IQueryContext,
  TValues extends string = string
> {
  /**
   * Allowed values for this virtual field.
   * Use `as const` for type inference.
   *
   * @example
   * allowedValues: ['assigned', 'created', 'watching'] as const
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
    helpers: IResolverHelpers<TSchema, TValues>
  ) => ITypedQueryExpression<AllSchemaFields<TSchema>>;

  /**
   * Human-readable description (for autocomplete UI).
   * Optional metadata for documentation and tooling.
   */
  description?: string;

  /**
   * Descriptions for each allowed value (for autocomplete UI).
   * Optional metadata for documentation and tooling.
   */
  valueDescriptions?: Partial<Record<TValues, string>>;
}

/**
 * Configuration for all virtual fields in a QueryKit instance.
 */
export type VirtualFieldsConfig<
  TSchema extends Record<string, object> = Record<string, object>,
  TContext extends IQueryContext = IQueryContext
> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [fieldName: string]: IVirtualFieldDefinition<TSchema, TContext, any>;
};
