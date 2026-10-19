/**
 * The security checks every translator runs before it builds anything.
 *
 * `createQueryKit` runs these through `QuerySecurityValidator`; a translator
 * or adapter used on its own runs the same shared checks with the same
 * wording, so a query the kit rejects is rejected everywhere, before any
 * SQL is built or any row is read.
 */

import { QueryExpression } from '../parser/types';
import {
  applyEnforcedExclusions,
  assertAllowedFields,
  assertMaxValueLength,
  assertQueryComplexity,
  resolveMaxClauseCount,
  resolveMaxQueryDepth
} from '../security/validator';
import { ITranslationSecurity } from './types';

/**
 * Merge the settings of one translation: a setting on the context wins over
 * the same setting from the translator's constructor options.
 *
 * @param options - Settings the translator was constructed with
 * @param context - Settings of this translation
 * @returns The settings to enforce
 */
export function resolveTranslationSecurity(
  options: ITranslationSecurity,
  context: ITranslationSecurity
): ITranslationSecurity {
  return {
    allowedFields: context.allowedFields ?? options.allowedFields,
    maxValueLength: context.maxValueLength ?? options.maxValueLength,
    maxQueryDepth: context.maxQueryDepth ?? options.maxQueryDepth,
    maxClauseCount: context.maxClauseCount ?? options.maxClauseCount,
    enforceExcludedValues:
      context.enforceExcludedValues ?? options.enforceExcludedValues
  };
}

/**
 * Reject a query that breaks a cap or names a field outside the allowlist,
 * then append the enforced exclusions. The checks see the query as written,
 * so an exclusion never pushes a query at a cap over it. A missing node is
 * left to the translator's own error.
 *
 * @param expression - The parsed query
 * @param security - The settings to enforce
 * @returns The query with any exclusions AND-ed in
 * @throws {QuerySecurityError} With the validator's wording
 *
 * @example
 * ```typescript
 * const constrained = enforceTranslationSecurity(parser.parse('status:open'), {
 *   allowedFields: ['status'],
 *   enforceExcludedValues: { secret: [1] }
 * });
 * // status == "open" AND secret NOT IN [1]
 * ```
 */
export function enforceTranslationSecurity(
  expression: QueryExpression,
  security: ITranslationSecurity
): QueryExpression {
  if (!expression) {
    return expression;
  }
  assertMaxValueLength(expression, security.maxValueLength);
  assertQueryComplexity(
    expression,
    resolveMaxQueryDepth(security.maxQueryDepth),
    resolveMaxClauseCount(security.maxClauseCount)
  );
  assertAllowedFields(expression, security.allowedFields);
  return applyEnforcedExclusions(expression, security.enforceExcludedValues);
}
