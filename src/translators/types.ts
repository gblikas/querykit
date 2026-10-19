/**
 * QueryKit Translator Types
 *
 * These are the core interfaces for translators, which convert QueryKit's
 * internal AST representation into formats that specific data sources can understand.
 */

import { QueryExpression } from '../parser/types';
import { EnforcedExclusions } from '../security/types';

/**
 * The security settings a translator enforces on its own, before it builds
 * anything: the same checks `createQueryKit` runs through the validator, so
 * a translator or adapter used directly rejects what the kit rejects. Every
 * setting is optional; an omitted cap is the validator's default and an
 * omitted list or map allows every field and injects nothing.
 */
export interface ITranslationSecurity {
  /**
   * Fields a query may name. An omitted or empty list allows every field.
   * Rejected with `QuerySecurityError` (`Invalid query parameters`).
   */
  allowedFields?: readonly string[];

  /**
   * Longest string value, alone or as a membership member. Default 1000.
   * A membership list is also capped at 100 items regardless.
   */
  maxValueLength?: number;

  /**
   * Deepest nesting of logical nodes. Default 10.
   */
  maxQueryDepth?: number;

  /**
   * Most comparisons in one query. Default 50.
   */
  maxClauseCount?: number;

  /**
   * Values to exclude per field, appended as `AND field NOT IN (values)`
   * after the checks above. `createQueryKit` applies this itself and does
   * not pass it on, so an adapter does not append it twice.
   */
  enforceExcludedValues?: EnforcedExclusions;
}

/**
 * Options for configuring a translator
 */
export interface ITranslatorOptions extends ITranslationSecurity {
  /**
   * Whether to normalize field names (e.g., lowercase them)
   */
  normalizeFieldNames?: boolean;

  /**
   * Custom field mappings from QueryKit fields to target fields
   */
  fieldMappings?: Record<string, string>;
}

/**
 * Where a translation runs. An adapter passes the table an execution targets
 * so a bare field name can resolve against that table's columns, and the
 * security settings of that execution; a setting given here overrides the
 * same setting from the translator's constructor options.
 */
export interface ITranslationContext extends ITranslationSecurity {
  /**
   * Table the query selects from, as a key of the schema. A name that is
   * not a key resolves nothing, so bare fields are quoted as written.
   */
  tableName?: string;
}

/**
 * Interface for a query translator
 */
export interface ITranslator<T = unknown> {
  /**
   * Translate a QueryKit expression into the target format
   *
   * @param expression The QueryKit expression to translate
   * @param context Where the translation runs; omit for a standalone translation
   * @returns The translated query in the target format
   */
  translate(expression: QueryExpression, context?: ITranslationContext): T;

  /**
   * Check if an expression can be translated
   *
   * @param expression The expression to check
   * @param context Where the translation runs; omit for a standalone translation
   * @returns true if the expression can be translated, false otherwise
   */
  canTranslate(
    expression: QueryExpression,
    context?: ITranslationContext
  ): boolean;
}
