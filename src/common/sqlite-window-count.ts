import { booleanWindowCount } from './boolean-window-count';

/**
 * A digit string with no sign, fraction, or exponent. `"2"` and `"0"` match.
 * `"2.0"`, `"02"`, and `"+2"` do not: SQLite accepts those spellings too,
 * and they stay unchanged here.
 */
const CANONICAL_INTEGER_STRING = /^(?:0|[1-9][0-9]*)$/;

/**
 * Read a limit or offset the way SQLite reads `TRUE`, `FALSE`, and a digit
 * string such as `LIMIT '2'` or `OFFSET '0'`.
 *
 * `true` is 1 and `false` is 0. A canonical digit string is that integer
 * when it is a safe integer, so `"2"` is 2 and `"0"` is 0. Any other value,
 * including a number, is returned unchanged. `Number.isInteger` and
 * `Number.isFinite` both reject a string, and the kit's limit check requires
 * a number, so a string window would otherwise throw while `LIMIT '2'`
 * returns rows.
 *
 * @param value - Limit or offset as the caller passed it
 * @returns `1` or `0` for a boolean, the integer for a canonical digit string, otherwise the same value
 * @example
 * sqliteWindowCount('2'); // 2
 * sqliteWindowCount('0'); // 0
 * sqliteWindowCount(true); // 1
 */
export function sqliteWindowCount(value: unknown): unknown {
  const counted = booleanWindowCount(value);
  if (typeof counted !== 'string' || !CANONICAL_INTEGER_STRING.test(counted)) {
    return counted;
  }
  const count = Number(counted);
  if (!Number.isSafeInteger(count)) {
    return counted;
  }
  return count;
}
