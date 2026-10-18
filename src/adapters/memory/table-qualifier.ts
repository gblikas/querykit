/**
 * The table qualifier of an in-memory field, checked against the selected
 * table the way SQLite checks a `table.column` against its FROM clause.
 */

import { QueryExpression } from '../../parser/types';
import { readFieldIdentifiers } from '../../translators/field-identifiers';
import { findOwnKeyIgnoringCase } from '../../translators/own-key-case';
import { InMemoryAdapterError } from './in-memory-adapter-error';

/**
 * The table an in-memory execution selects, and the records map its name
 * is resolved against.
 */
export interface ITableScope {
  /** Key of the selected table in `records`. */
  tableName: string;
  /** Every table the adapter holds, keyed by name. */
  records: object;
}

/**
 * Reject a single `table.column` whose qualifier does not resolve to the
 * selected table. The qualifier resolves like a column key: exactly, or by
 * the one records key differing only by ASCII case, so `Items.status`
 * names `items` while `Other.status` and `owners.tier` (another table) do
 * not, as SQLite has no such column in its FROM clause. A literal name, a
 * name with no dot or more than one, and a name with an empty side are not
 * qualified and pass.
 *
 * @param field - The field name as the reader will see it, after any mapping
 * @param isLiteral - True when the parser marked the name one identifier
 * @param scope - The selected table and the records map
 * @throws {InMemoryAdapterError} `Field <field> does not name the selected table <table>`
 *
 * @example
 * ```typescript
 * assertQualifierInScope('Items.status', false, { tableName: 'items', records });
 * // passes
 * assertQualifierInScope('Other.status', false, { tableName: 'items', records });
 * // throws
 * ```
 */
export function assertQualifierInScope(
  field: string,
  isLiteral: boolean | undefined,
  scope: ITableScope
): void {
  const parts = readFieldIdentifiers(field, isLiteral);
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return;
  }
  if (
    findOwnKeyIgnoringCase(scope.records, parts[0] ?? '') === scope.tableName
  ) {
    return;
  }
  throw new InMemoryAdapterError(
    `Field ${field} does not name the selected table ${scope.tableName}`
  );
}

/**
 * Run {@link assertQualifierInScope} on every comparison of an expression,
 * before any row is read, so an empty table rejects what a populated one
 * rejects. Raw and malformed nodes are left to the shape check.
 *
 * @param expression - The expression as the reader will see it
 * @param scope - The selected table and the records map
 * @throws {InMemoryAdapterError} When a comparison names another table
 */
export function assertQualifiersInScope(
  expression: QueryExpression,
  scope: ITableScope
): void {
  if (!expression) {
    return;
  }
  if (expression.type === 'comparison') {
    assertQualifierInScope(expression.field, expression.isLiteral, scope);
    return;
  }
  if (expression.type !== 'logical') {
    return;
  }
  assertQualifiersInScope(expression.left, scope);
  if (expression.right) {
    assertQualifiersInScope(expression.right, scope);
  }
}
