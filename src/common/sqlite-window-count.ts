import { booleanWindowCount } from './boolean-window-count';

/**
 * A canonical integer, that integer with surrounding ASCII space, a decimal
 * whose fraction is only zeros, the same forms with a leading plus or minus,
 * leading zeros, or an exponent whose value is an integer. `"2"`, `"0"`,
 * `" 2"`, `"2 "`, `"2.0"`, `"02"`, `"+2"`, `"-2"`, and `"2e1"` match.
 * `"2.5"` and `"+ 2"` do not: SQLite rejects both with `datatype mismatch`.
 * A non-breaking space is not ASCII space, and SQLite rejects it.
 */
const SQLITE_INTEGER_TEXT =
  /^[ \t\n\v\f\r]*([+-])?(\d+(?:\.0+)?)(?:[eE]([+-]?\d+))?[ \t\n\v\f\r]*$/;

/** Digit length of the largest safe integer, plus one is never safe. */
const SAFE_INTEGER_DIGITS = 16;

/**
 * Read a limit or offset the way SQLite reads `TRUE`, `FALSE`, and a digit
 * string such as `LIMIT '2'`, `LIMIT '-2'`, or `LIMIT '2e1'`.
 *
 * `true` is 1 and `false` is 0. A canonical digit string is that integer
 * when it is a safe integer, so `"2"` is 2 and `"0"` is 0. The same integer
 * with surrounding ASCII space is that integer, a decimal whose fraction is
 * only zeros is that integer, and so are a leading plus, a leading minus,
 * leading zeros, and an exponent, so `" 2"`, `"2 "`, `"2.0"`, `"02"`,
 * `"+2"`, `"-2"`, and `"2e1"` are 2, 2, 2, 2, 2, -2, and 20. A fraction that
 * is not all zeros, such as `"2.5"`, and a sign that is not against the
 * digits, such as `"+ 2"`, are returned unchanged. Any other value,
 * including a number, is returned unchanged. `Number.isInteger` and
 * `Number.isFinite` both reject a string, and the kit's limit check requires
 * a number, so a string window would otherwise throw while `LIMIT '-2'`
 * returns rows.
 *
 * @param value - Limit or offset as the caller passed it
 * @returns `1` or `0` for a boolean, the integer for a digit, padded, signed, decimal, or exponent string, otherwise the same value
 * @example
 * sqliteWindowCount('2'); // 2
 * sqliteWindowCount('-2'); // -2
 * sqliteWindowCount('2e1'); // 20
 * sqliteWindowCount('+ 2'); // '+ 2'
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
 * space, a decimal whose fraction is only zeros, a leading plus or minus,
 * leading zeros, or an exponent whose value is an integer. A value `Number`
 * would round is left unread. A fraction that is not all zeros, and a sign
 * with a space before the digits, are left unread.
 *
 * @param text - Limit or offset text
 * @returns The integer, or `undefined` when the text is another spelling
 */
function integerFromWindowText(text: string): number | undefined {
  const matched = SQLITE_INTEGER_TEXT.exec(text);
  if (matched === null) {
    return undefined;
  }
  const numeral = matched[2];
  if (numeral === undefined) {
    return undefined;
  }
  const count = integerFromParts(numeral, matched[3]);
  if (count === undefined) {
    return undefined;
  }
  return applySign(matched[1], count);
}

/**
 * The unsigned integer spelled by the digits and the optional exponent.
 *
 * @param numeral - Digits, or digits with a fraction of only zeros
 * @param exponentText - Exponent text, when the spelling has one
 * @returns The integer, or `undefined` when it is not a safe integer
 */
function integerFromParts(
  numeral: string,
  exponentText: string | undefined
): number | undefined {
  const dot = numeral.indexOf('.');
  const digits = dot === -1 ? numeral : numeral.slice(0, dot);
  const canonical = digits.replace(/^0+(?=\d)/, '');
  if (exponentText === undefined) {
    return plainInteger(numeral, canonical);
  }
  return scaledInteger(canonical, Number(exponentText));
}

/**
 * A safe integer whose canonical digits are `canonical`.
 *
 * @param numeral - The matched digits, including a fraction of only zeros
 * @param canonical - Those digits without a fraction and without leading zeros
 * @returns The integer, or `undefined` when `Number` would round it
 */
function plainInteger(numeral: string, canonical: string): number | undefined {
  const count = Number(numeral);
  if (!Number.isSafeInteger(count) || String(count) !== canonical) {
    return undefined;
  }
  return count;
}

/**
 * Move the decimal point by `exponent` places.
 *
 * A negative exponent is left unread: `LIMIT '2e-1'` is not an integer.
 * An expansion past the safe-integer digit length is left unread.
 *
 * @param digits - Canonical digits of the mantissa
 * @param exponent - Power of ten
 * @returns The integer, or `undefined` when the value is not a safe integer
 */
function scaledInteger(digits: string, exponent: number): number | undefined {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    return undefined;
  }
  if (/^0+$/.test(digits)) {
    return 0;
  }
  if (digits.length + exponent > SAFE_INTEGER_DIGITS) {
    return undefined;
  }
  const expanded = `${digits}${'0'.repeat(exponent)}`;
  const count = Number(expanded);
  const canonical = expanded.replace(/^0+(?=\d)/, '');
  if (!Number.isSafeInteger(count) || String(count) !== canonical) {
    return undefined;
  }
  return count;
}

/**
 * Apply a leading minus. Minus zero is zero: SQLite reads `LIMIT '-0'` as
 * no rows, not as no upper bound.
 *
 * @param sign - The leading `+` or `-`, when present
 * @param count - The unsigned integer
 * @returns The signed integer
 */
function applySign(sign: string | undefined, count: number): number {
  if (sign !== '-' || count === 0) {
    return count;
  }
  return -count;
}
