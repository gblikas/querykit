import { booleanWindowCount } from './boolean-window-count';

/**
 * A canonical integer, that integer with surrounding ASCII space, or a
 * decimal whose fraction is only zeros. `"2"`, `"0"`, `" 2"`, `"2 "`, and
 * `"2.0"` match. `"02"`, `"+2"`, and `"2.5"` do not: SQLite accepts some of
 * those spellings too, and they stay unchanged here. A non-breaking space
 * is not ASCII space, and SQLite rejects it.
 */
const SQLITE_INTEGER_TEXT =
  /^[ \t\n\v\f\r]*((?:0|[1-9][0-9]*)(?:\.0+)?)[ \t\n\v\f\r]*$/;

/**
 * Read a limit or offset the way SQLite reads `TRUE`, `FALSE`, and a digit
 * string such as `LIMIT '2'`, `LIMIT ' 2'`, `LIMIT '2 '`, or `LIMIT '2.0'`.
 *
 * `true` is 1 and `false` is 0. A canonical digit string is that integer
 * when it is a safe integer, so `"2"` is 2 and `"0"` is 0. The same integer
 * with surrounding ASCII space is that integer, and a decimal whose fraction
 * is only zeros is that integer, so `" 2"`, `"2 "`, and `"2.0"` are 2. Any
 * other value, including a number, is returned unchanged.
 * `Number.isInteger` and `Number.isFinite` both reject a string, and the
 * kit's limit check requires a number, so a string window would otherwise
 * throw while `LIMIT '2'` returns rows.
 *
 * @param value - Limit or offset as the caller passed it
 * @returns `1` or `0` for a boolean, the integer for a digit, padded, or decimal integer string, otherwise the same value
 * @example
 * sqliteWindowCount('2'); // 2
 * sqliteWindowCount(' 2'); // 2
 * sqliteWindowCount('2 '); // 2
 * sqliteWindowCount('2.0'); // 2
 */
export function sqliteWindowCount(value: unknown): unknown {
  const counted = booleanWindowCount(value);
  if (typeof counted !== 'string') {
    return counted;
  }
  return integerFromWindowText(counted) ?? counted;
}

/**
 * The safe integer a SQLite limit or offset text spells.
 *
 * The text is a canonical integer, that integer with surrounding ASCII
 * space, or a decimal whose fraction is only zeros. A value `Number` would
 * round is left unread.
 *
 * @param text - Limit or offset text
 * @returns The integer, or `undefined` when the text is another spelling
 */
function integerFromWindowText(text: string): number | undefined {
  const matched = SQLITE_INTEGER_TEXT.exec(text);
  if (matched === null) {
    return undefined;
  }
  const numeral = matched[1];
  if (numeral === undefined) {
    return undefined;
  }
  const dot = numeral.indexOf('.');
  const digits = dot === -1 ? numeral : numeral.slice(0, dot);
  const count = Number(numeral);
  if (!Number.isSafeInteger(count) || String(count) !== digits) {
    return undefined;
  }
  return count;
}
