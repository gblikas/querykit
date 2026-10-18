/**
 * The own key of a row that a field name reads, resolved the way SQLite
 * resolves the identifiers the translators write for the name.
 */

import { readFieldIdentifiers } from '../../translators/field-identifiers';
import { findOwnKeyIgnoringCase } from '../../translators/own-key-case';

/**
 * Resolve a field name to the own key of one row. The whole name is read
 * as an own key, exactly or by the one own key differing only by ASCII
 * case (`Status` reads `status`). Failing that, a single unmarked
 * `table.column` reads the own key `column` by the same rule, since SQL
 * addresses column `city` for `owner.city`; the qualifier itself is not
 * read here but checked by the table scope. A name the parser marked
 * literal (`"a.b"`, `column.`) is one identifier and does not fall
 * through. A nested object is not walked and a prototype property is
 * never a key.
 *
 * @param record - Row
 * @param field - Field name as the AST or the sort options store it
 * @param isLiteral - True when the parser marked the name one identifier
 * @returns The own key the name resolves to, or undefined when the row has none
 *
 * @example
 * ```typescript
 * resolveRowKey({ status: 'open' }, 'STATUS'); // 'status'
 * resolveRowKey({ city: 'Austin' }, 'owner.City'); // 'city'
 * resolveRowKey({ city: 'Austin' }, 'owner.city', true); // undefined
 * ```
 */
export function resolveRowKey(
  record: object,
  field: string,
  isLiteral?: boolean
): string | undefined {
  const ownKey = findOwnKeyIgnoringCase(record, field);
  if (ownKey !== undefined) {
    return ownKey;
  }
  const parts = readFieldIdentifiers(field, isLiteral);
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return undefined;
  }
  return findOwnKeyIgnoringCase(record, parts[1] ?? '');
}
