/**
 * Security configuration types for QueryKit
 *
 * This module defines the security configuration interface and default values
 * used throughout QueryKit to enforce security boundaries and prevent abuse.
 */

/**
 * A value a query may not reference, or a value a row may not carry.
 */
export type DeniedValue = string | number | boolean | null;

/**
 * Map of field name to the values excluded from every result for that field.
 * `createQueryKit`, both translators, and both adapters append
 * `AND field NOT IN (values)` for each entry with at least one value; an
 * omitted or empty map, or an empty value list, injects nothing.
 */
export type EnforcedExclusions = Record<string, DeniedValue[]>;

/**
 * @interface ISecurityOptions
 * @description Comprehensive security configuration options for QueryKit
 *
 * These options help protect your application from potential security issues,
 * resource exhaustion, and performance problems when exposing QueryKit to users.
 *
 * @example
 * ```typescript
 * import { createQueryKit, type ISecurityOptions } from '@gblikas/querykit';
 *
 * // Configure security options
 * const securityOptions: ISecurityOptions = {
 *   allowedFields: ['id', 'name', 'createdAt'],
 *   denyFields: ['password', 'secretKey'],
 *   maxQueryDepth: 5,
 *   maxClauseCount: 20
 * };
 *
 * // Create QueryKit instance with security options
 * const queryKit = createQueryKit({
 *   // ...other options
 *   security: securityOptions
 * });
 * ```
 */
export interface ISecurityOptions {
  /**
   * List of fields that are allowed to be queried.
   * If empty, all fields in the schema are allowed by default.
   *
   * An entry is matched as written: it ignores neither ASCII case nor a
   * `table.` qualifier. A `fieldMappings` alias and its target are one field,
   * so an entry in either spelling permits both (see `aliasSecurityFields`).
   *
   * @example
   * ```typescript
   * // Only allow specific fields to be queried
   * allowedFields: ['id', 'name', 'email', 'createdAt']
   * ```
   */
  allowedFields?: string[];

  /**
   * List of fields that are explicitly denied from being queried.
   * These fields will be blocked even if they appear in allowedFields.
   * Use this to protect sensitive data fields.
   *
   * An entry matches a field regardless of ASCII case and of a single
   * `table.` qualifier on either side, so `secret` denies `SECRET`,
   * `items.secret` and `Items.secret`, and `items.secret` denies `secret`.
   * A `fieldMappings` alias and its target are one field, so an entry in
   * either spelling denies both.
   *
   * @example
   * ```typescript
   * // Prevent querying of sensitive fields
   * denyFields: ['password', 'secretToken', 'ssn']
   * ```
   */
  denyFields?: string[];

  /**
   * Map of field names to arrays of values that are denied for that field.
   * This provides granular control over what values can be used in queries.
   * Use this to protect against queries targeting specific sensitive values.
   *
   * The keys are field names (can include table prefixes like "user.role")
   * and the values are arrays of denied values for that field. A key is
   * matched the way a `denyFields` entry is, regardless of ASCII case and of
   * a single `table.` qualifier on either side, and a `fieldMappings` alias
   * and its target are one key, so a value listed under any spelling, alias
   * or alias target of a field is denied for every spelling of that field.
   *
   * Any query that references a denied value in any form is rejected, including
   * negated forms (`NOT status:"deleted"`, `status != "deleted"`, `status NOT IN
   * ["deleted"]`). This follows an explicit allow-listing approach: if you don't
   * want users to reference a sensitive value at all, `denyValues` blocks it
   * completely, regardless of how it's used.
   *
   * To guarantee denied records are never returned from any query — including
   * queries that don't reference the denied value at all (e.g. `NOT status:
   * "published"` implicitly includes archived/deleted) — use
   * `enforceExcludedValues` to inject server-side `NOT IN` filters.
   *
   * @example
   * ```typescript
   * denyValues: {
   *   'status': ['deleted', 'banned'],
   *   'role': ['superadmin', 'system']
   * }
   *
   * // Blocked queries (denied value is mentioned in any form):
   * // status == "deleted"
   * // NOT status == "deleted"
   * // status != "deleted"
   * // status IN ["deleted", "active"]
   * // status NOT IN ["deleted", "banned"]
   * // role == "superadmin"
   *
   * // Allowed queries (no denied value is referenced):
   * // status == "active"
   * // role == "admin"
   * ```
   */
  denyValues?: Record<string, DeniedValue[]>;

  /**
   * Values that are automatically excluded from ALL query results.
   * Unlike `denyValues` (which validates user input), this option
   * injects `AND field NOT IN (values)` into every query at the adapter layer.
   *
   * Use this for RBAC enforcement where certain records must never be returned
   * regardless of how users phrase their queries.
   *
   * A key that names a `fieldMappings` alias is injected under the alias's
   * target, so both adapters drop the same rows (see `aliasSecurityFields`).
   *
   * @example
   * ```typescript
   * enforceExcludedValues: {
   *   status: ['archived', 'deleted'],
   *   visibility: ['internal']
   * }
   * // Every query will have appended:
   * // AND status NOT IN ('archived', 'deleted')
   * // AND visibility NOT IN ('internal')
   * ```
   */
  enforceExcludedValues?: EnforcedExclusions;

  /**
   * Whether to allow dot notation in field names (e.g., "user.name", "metadata.tags").
   * When disabled, queries with dots in field names will be rejected.
   *
   * Use cases for DISABLING dot notation:
   * - Public-facing search APIs where users should only query flat, top-level fields
   * - Preventing access to table-qualified columns in SQL joins (e.g., "users.password")
   * - Simpler security model when your schema doesn't have nested/JSON data
   * - Preventing users from probing internal table structures
   *
   * @default true
   *
   * @example
   * ```typescript
   * // Disable dot notation for a public search API
   * allowDotNotation: false
   *
   * // This would block queries like:
   * // user.email == "test@example.com"  // Rejected
   * // metadata.tags == "sale"           // Rejected
   * // email == "test@example.com"       // Allowed
   * ```
   */
  allowDotNotation?: boolean;

  /**
   * Maximum nesting depth of query expressions.
   * Prevents deeply nested queries that could impact performance.
   *
   * @default 10
   *
   * @example
   * ```typescript
   * // Allow only simple queries with limited nesting
   * maxQueryDepth: 3
   *
   * // This would allow queries like:
   * // title:"Meeting notes" && (priority > 2 || completed == true)
   * // But would reject more deeply nested expressions
   * ```
   */
  maxQueryDepth?: number;

  /**
   * Maximum number of clauses (AND/OR operations) in a query.
   * Prevents overly complex queries that could impact performance.
   *
   * @default 50
   *
   * @example
   * ```typescript
   * // Limit query complexity
   * maxClauseCount: 20
   *
   * // This would allow queries with up to 20 conditions joined by AND/OR
   * ```
   */
  maxClauseCount?: number;

  /**
   * Default limit for query results if none is specified by the client.
   * Prevents unintentionally large result sets.
   *
   * @default 100
   *
   * @example
   * ```typescript
   * // Set conservative default limit
   * defaultLimit: 50
   * ```
   */
  defaultLimit?: number;

  /**
   * Maximum allowed limit for pagination.
   * Prevents clients from requesting excessively large result sets.
   *
   * @default 1000
   *
   * @example
   * ```typescript
   * // Restrict maximum page size
   * maxLimit: 500
   *
   * // Even if a client requests limit=10000, it will be capped at 500
   * ```
   */
  maxLimit?: number;

  /**
   * Maximum string length for query values.
   * Prevents memory exhaustion from extremely large string values.
   *
   * @default 1000
   *
   * @example
   * ```typescript
   * // Limit string length in query values
   * maxValueLength: 500
   *
   * // Prevents attacks using extremely long strings in filters
   * ```
   */
  maxValueLength?: number;

  /**
   * Whether to sanitize wildcard patterns in LIKE queries to prevent regex DoS.
   * When enabled, excessive wildcard patterns are sanitized or rejected.
   *
   * @default true
   *
   * @example
   * ```typescript
   * // Enable wildcard sanitization
   * sanitizeWildcards: true
   *
   * // Prevents regex DoS attacks like: name LIKE "%a%a%a%a%a%a%a%a%..."
   * ```
   */
  sanitizeWildcards?: boolean;

  /**
   * Timeout in milliseconds for the adapter call. The budget starts when the
   * adapter is invoked, after parsing, virtual-field resolution, and
   * validation. A timer bounds the asynchronous part of the call, and the
   * synchronous part, during which no timer can fire, is measured when the
   * adapter returns and rejected on its own when it used the whole budget.
   * Work other code does on the event loop after the adapter settles is not
   * counted. When execution exceeds this limit, the call rejects. The
   * underlying statement is not cancelled. Must be an integer from 1 to
   * 2147483647, the largest delay `setTimeout` honours; `createQueryKit`
   * rejects anything else, including `0`, which no query could satisfy.
   *
   * @default 30000 (30 seconds)
   *
   * @example
   * ```typescript
   * // Set shorter timeout for API endpoints
   * queryTimeout: 5000 // 5 seconds
   *
   * // The call rejects after 5 seconds. The underlying statement is not cancelled.
   * ```
   */
  queryTimeout?: number;
}

/**
 * Default security configuration values
 *
 * These defaults provide a reasonable balance between functionality and security.
 * It's recommended to review and adjust these settings based on your specific use case.
 *
 * @example
 * ```typescript
 * import { DEFAULT_SECURITY_OPTIONS } from '@gblikas/querykit';
 *
 * // Use defaults but override specific options
 * const securityOptions = {
 *   ...DEFAULT_SECURITY_OPTIONS,
 *   maxLimit: 500,
 *   queryTimeout: 10000
 * };
 * ```
 */
export const DEFAULT_SECURITY_OPTIONS: Required<ISecurityOptions> = {
  // Field restrictions - by default, all schema fields are allowed
  allowedFields: [], // Empty means "use schema fields"
  denyFields: [], // Empty means no denied fields
  denyValues: {}, // Empty means no denied values for any field
  enforceExcludedValues: {}, // Empty means no enforced exclusions
  allowDotNotation: true, // Allow dot notation by default for backward compatibility

  // Query complexity limits
  maxQueryDepth: 10, // Maximum nesting level of expressions
  maxClauseCount: 50, // Maximum number of clauses (AND/OR operations)

  // Resource protection
  defaultLimit: 100, // Default result limit if none specified
  maxLimit: 1000, // Maximum allowed limit for pagination

  // Value sanitization
  maxValueLength: 1000, // Maximum string length for query values
  sanitizeWildcards: true, // Prevent regex DoS with wildcards in LIKE queries

  // Performance safeguards
  queryTimeout: 30000 // 30 second timeout by default
};
