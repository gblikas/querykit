/**
 * Security configuration types for QueryKit
 *
 * This module defines the security configuration interface and default values
 * used throughout QueryKit to enforce security boundaries and prevent abuse.
 */

/**
 * @interface ISecurityOptions
 * @description Comprehensive security configuration options for QueryKit
 *
 * These options help protect your application from potential security issues,
 * resource exhaustion, and performance problems when exposing QueryKit to users.
 *
 * @example
 * ```typescript
 * import { createQueryKit, type ISecurityOptions } from 'querykit';
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
   * and the values are arrays of denied values for that field.
   *
   * @example
   * ```typescript
   * // Prevent certain values from being queried
   * denyValues: {
   *   'status': ['deleted', 'banned'],
   *   'role': ['superadmin', 'system'],
   *   'user.type': ['internal', 'bot']
   * }
   *
   * // This would block queries like:
   * // status == "deleted"
   * // role IN ["superadmin", "admin"]
   * // user.type == "internal"
   * ```
   */
  denyValues?: Record<string, Array<string | number | boolean | null>>;

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
   * Timeout in milliseconds for query execution.
   * Prevents long-running queries from consuming excessive resources.
   *
   * @default 30000 (30 seconds)
   *
   * @example
   * ```typescript
   * // Set shorter timeout for API endpoints
   * queryTimeout: 5000 // 5 seconds
   *
   * // Queries taking longer than 5 seconds will be terminated
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
 * import { DEFAULT_SECURITY_OPTIONS } from 'querykit';
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
