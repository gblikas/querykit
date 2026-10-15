/**
 * QueryKit Translator Types
 *
 * These are the core interfaces for translators, which convert QueryKit's
 * internal AST representation into formats that specific data sources can understand.
 */

import { QueryExpression } from '../parser/types';

/**
 * Options for configuring a translator
 */
export interface ITranslatorOptions {
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
 * Interface for a query translator
 */
/**
 * Where a translation runs. An adapter passes the table an execution targets
 * so a bare field name can resolve against that table's columns.
 */
export interface ITranslationContext {
  /**
   * Table the query selects from, as a key of the schema
   */
  tableName?: string;
}

export interface ITranslator<T = unknown> {
  /**
   * Translate a QueryKit expression into the target format
   *
   * @param expression The QueryKit expression to translate
   * @returns The translated query in the target format
   */
  translate(expression: QueryExpression, context?: ITranslationContext): T;

  /**
   * Check if an expression can be translated
   *
   * @param expression The expression to check
   * @returns true if the expression can be translated, false otherwise
   */
  canTranslate(
    expression: QueryExpression,
    context?: ITranslationContext
  ): boolean;
}
