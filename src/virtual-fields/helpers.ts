/**
 * Helper utilities for creating raw SQL expressions in virtual fields
 */

import { sql } from 'drizzle-orm';
import { IRawSqlExpression } from '../parser/types';

/**
 * Validates field name to prevent SQL injection.
 * Only allows alphanumeric characters, dots, and underscores.
 * @private
 */
function validateFieldName(field: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9._]*$/.test(field)) {
    throw new Error(`Invalid field name: ${field}`);
  }
  if (field.length > 64) {
    throw new Error(`Field name too long: ${field}`);
  }
}

/**
 * Create a JSONB array contains expression (PostgreSQL).
 * Checks if the JSONB array field contains the given value.
 *
 * @param field - The JSONB field name (e.g., 'assigned_to')
 * @param value - The value to check for in the array
 * @returns A raw SQL expression for JSONB contains check
 *
 * @example
 * // Check if assignedTo contains the current user ID
 * jsonbContains('assigned_to', ctx.currentUserId)
 * // Generates: assigned_to @> '["user123"]'::jsonb
 */
export function jsonbContains(
  field: string,
  value: unknown
): IRawSqlExpression {
  validateFieldName(field);
  return {
    type: 'raw',
    toSql: () =>
      sql`${sql.identifier(field)} @> ${JSON.stringify(Array.isArray(value) ? value : [value])}::jsonb`
  };
}

/**
 * Create a date range expression.
 * Checks if a timestamp field is within the specified number of days from now.
 *
 * @param field - The timestamp field name (e.g., 'created_at')
 * @param days - Number of days from now
 * @returns A raw SQL expression for date range check
 *
 * @example
 * // Check if created within last day
 * dateWithinDays('created_at', 1)
 * // Generates: created_at >= NOW() - INTERVAL '1 days'
 */
export function dateWithinDays(field: string, days: number): IRawSqlExpression {
  validateFieldName(field);
  return {
    type: 'raw',
    toSql: () =>
      sql`${sql.identifier(field)} >= NOW() - INTERVAL '${sql.raw(days.toString())} days'`
  };
}
