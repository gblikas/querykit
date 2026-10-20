import { booleanWindowCount } from './boolean-window-count';

/**
 * A canonical integer, that integer with surrounding ASCII space, a decimal
 * whose fraction is only zeros, the same forms with a leading plus, or
 * leading zeros. `"2"`, `"0"`, `" 2"`, `"2 "`, `"2.0"`, `"02"`, and `"+2"`
 * match. `"2.5"` does not: SQLite rejects it with `datatype mismatch`. A
 * non-breaking space is not ASCII space, and SQLite rejects it.
 */
const SQLITE_INTEGER_TEXT = /^[ \t\n\v\f\r]*\+?(\d+(?:\.0+)?)[ \t\n\v\f\r]*$/;

/**
 * Read a limit or offset the way SQLite reads `TRUE`, `FALSE`, and a digit
 * string such as `LIMIT '2'`, `LIMIT ' 2'`, `LIMIT '02'`, or `LIMIT '+2'`.
 *
 * `true` is 1 and `false` is 0. A canonical digit string is that integer
 * when it is a safe integer, so `"2"` is 2 and `"0"` is 0. The same integer
 * with surrounding ASCII space is that integer, a decimal whose fraction is
 * only zeros is that integer, and so are a leading plus and leading zeros,
 * so `" 2"`, `"2 "`, `"2.0"`, `"02"`, and `"+2"` are 2. A fraction that is
 * not all zeros, such as `"2.5"`, is returned unchanged. Any other value,
 * including a number, is returned unchanged. `Number.isInteger` and
 * `Number.isFinite` both reject a string, and the kit's limit check requires
 * a number, so a string window would otherwise throw while `LIMIT '02'`
 * returns rows.
 *
 * @param value - Limit or offset as the caller passed it
 * @returns `1` or `0` for a boolean, the integer for a digit, padded, signed, or decimal integer string, otherwise the same value
 * @example
 * sqliteWindowCount('2'); // 2
 * sqliteWindowCount(' 2'); // 2
 * sqliteWindowCount('2 '); // 2
 * sqliteWindowCount('2.0'); // 2
 * sqliteWindowCount('02'); // 2
 * sqliteWindowCount('+2'); // 2
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
 * space, a decimal whose fraction is only zeros, a leading plus, or leading
 * zeros. A value `Number` would round is left unread. A fraction that is
 * not all zeros is left unread.
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
  const canonical = digits.replace(/^0+(?=\d)/, '');
  if (!Number.isSafeInteger(count) || String(count) !== canonical) {
    return undefined;
  }
  return count;
}
