/**
 * An in-memory field checked against the selected table: its qualifier
 * must name that table, the way SQLite checks a `table.column` against its
 * FROM clause, and its name must read a key of the table's rows, the way a
 * Drizzle schema holds a query to the table's properties.
 */

import { QueryExpression } from '../../parser/types';
import { readFieldIdentifiers } from '../../translators/field-identifiers';
import { findOwnKeyIgnoringCase } from '../../translators/own-key-case';
import { InMemoryAdapterError } from './in-memory-adapter-error';
import { resolveRowKey } from './row-key';

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
 * Reject a field that names no property of the selected table. After the
 * qualifier check, the name must resolve to an own key of at least one of
 * the table's rows the way the reader resolves it: the whole name, or the
 * column of a single `table.column`, exactly or by ASCII case. The rows
 * Drizzle selects are keyed by property, so the column name `status_col`
 * for the property `status`, the quoted literal `"Items.status"` and the
 * sort key `created_at` are rejected here as the Drizzle adapter rejects
 * them, instead of reading no key on every row. A table with no rows has
 * no keys to check against, so every name passes to read as null.
 *
 * @param field - The field name as the reader will see it, after any mapping
 * @param isLiteral - True when the parser marked the name one identifier
 * @param scope - The selected table and the records map
 * @throws {InMemoryAdapterError} `Field <field> does not name the selected table <table>` for a foreign qualifier, `Field <field> does not name a property of table <table>` for a name no row has
 *
 * @example
 * ```typescript
 * const scope = { tableName: 'items', records: { items: [{ id: 1, status: 'open' }] } };
 * assertFieldInScope('STATUS', false, scope); // passes
 * assertFieldInScope('items.status', false, scope); // passes
 * assertFieldInScope('status_col', false, scope); // throws
 * ```
 */
export function assertFieldInScope(
  field: string,
  isLiteral: boolean | undefined,
  scope: ITableScope
): void {
  assertQualifierInScope(field, isLiteral, scope);
  const rows = selectedRows(scope);
  if (
    rows.length === 0 ||
    rows.some(row => resolveRowKey(row, field, isLiteral) !== undefined)
  ) {
    return;
  }
  throw new InMemoryAdapterError(
    `Field ${field} does not name a property of table ${scope.tableName}`
  );
}

/**
 * Run {@link assertFieldInScope} on every comparison of an expression,
 * before any row is read, so the whole expression is rejected rather than
 * the rows that reach the offending node. Raw and malformed nodes are left
 * to the shape check.
 *
 * @param expression - The expression as the reader will see it
 * @param scope - The selected table and the records map
 * @throws {InMemoryAdapterError} When a comparison names another table or a property no row has
 */
export function assertFieldsInScope(
  expression: QueryExpression,
  scope: ITableScope
): void {
  if (!expression) {
    return;
  }
  if (expression.type === 'comparison') {
    assertFieldInScope(expression.field, expression.isLiteral, scope);
    return;
  }
  if (expression.type !== 'logical') {
    return;
  }
  assertFieldsInScope(expression.left, scope);
  if (expression.right) {
    assertFieldsInScope(expression.right, scope);
  }
}

/**
 * The rows of the selected table, read as an own entry of the records map.
 *
 * @param scope - The selected table and the records map
 * @returns The table's rows, or none when the map has no such array
 */
function selectedRows(scope: ITableScope): readonly object[] {
  if (!Object.prototype.hasOwnProperty.call(scope.records, scope.tableName)) {
    return [];
  }
  const rows = (scope.records as Record<string, unknown>)[scope.tableName];
  return Array.isArray(rows) ? (rows as readonly object[]) : [];
}
