/**
 * Helper utilities for creating raw SQL expressions in virtual fields
 */

import { sql } from 'drizzle-orm';
import { IRawSqlExpression } from '../parser/types';

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
  return {
    type: 'raw',
    toSql: () =>
      sql`${sql.identifier(field)} >= NOW() - INTERVAL '${sql.raw(days.toString())} days'`
  };
}
