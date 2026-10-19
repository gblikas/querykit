/**
 * Security module exports.
 *
 * Only the names listed here reach the root barrel. The validator's
 * helpers (`assertAllowedFields`, `isDeniedName`, `aliasSecurityFields`
 * and the rest) are internal and are imported from `./validator` by the
 * parser, the translators and the kit.
 */

export { DEFAULT_SECURITY_OPTIONS } from './types';
export type {
  DeniedValue,
  EnforcedExclusions,
  ISecurityOptions
} from './types';
export { QuerySecurityError, QuerySecurityValidator } from './validator';
