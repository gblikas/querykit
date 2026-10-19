/**
 * JavaScript values classified the way SQLite stores them, so the in-memory
 * engine compares and sorts a row the way SQLite compares and orders a
 * column.
 *
 * A null, an undefined, a numeric NaN and an invalid Date are NULL (a bound
 * NaN is stored as NULL). A number, a bigint and a boolean (0 or 1) are one
 * numeric class and compare by value. A string and a Date (its ISO-8601
 * text, which is what the translators bind) are text and compare by Unicode
 * code point, SQLite's binary order. SQLite orders the classes NULL, then
 * numbers, then text; anything else (an object, an array, a symbol) sorts
 * after text by its string form and takes part in no comparison.
 *
 * A query value compared with a numeric row value takes that value's
 * affinity when it is a quoted numeral, as a typed column reads it on
 * PostgreSQL and SQLite: `count:"2"` is the number 2 against a number, a
 * bigint or a boolean, and stays the text `2` against a string or a Date.
 */

import { quotedDecimalValue } from '../../parser/stored-integer';

/**
 * A value as SQLite would store it.
 */
export type StoredValue =
  | { kind: 'null' }
  | { kind: 'numeric'; value: number | bigint }
  | { kind: 'text'; value: string }
  | { kind: 'other'; value: unknown };

/** Class order: NULL, then numbers, then text, then anything else. */
const CLASS_RANK: Record<StoredValue['kind'], number> = {
  null: 0,
  numeric: 1,
  text: 2,
  other: 3
};

/**
 * Classify a field or query value.
 *
 * @param value - A row field or a query value
 * @returns The value's storage class and the value SQLite would compare
 *
 * @example
 * ```typescript
 * storedValueOf(true); // { kind: 'numeric', value: 1 }
 * storedValueOf(NaN); // { kind: 'null' }
 * storedValueOf(new Date(0)); // { kind: 'text', value: '1970-01-01T00:00:00.000Z' }
 * ```
 */
export function storedValueOf(value: unknown): StoredValue {
  if (value === null || value === undefined) {
    return { kind: 'null' };
  }
  if (typeof value === 'number') {
    return Number.isNaN(value) ? { kind: 'null' } : { kind: 'numeric', value };
  }
  if (typeof value === 'bigint') {
    return { kind: 'numeric', value };
  }
  if (typeof value === 'boolean') {
    return { kind: 'numeric', value: value ? 1 : 0 };
  }
  if (typeof value === 'string') {
    return { kind: 'text', value };
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time)
      ? { kind: 'null' }
      : { kind: 'text', value: value.toISOString() };
  }
  return { kind: 'other', value };
}

/**
 * Classify a query value against the row value it is compared with. A
 * quoted numeral compared with a numeric row value (a number, a bigint or
 * a boolean stored as 0 or 1) is read as the number it spells, exactly
 * past 2^53, with the leading plus and surrounding whitespace both
 * databases skip, as a PostgreSQL `integer` column and a SQLite `INTEGER`
 * or `REAL` column read bound text; a quoted word, an exponent, a bare
 * number against a text value and every other pairing keep their own
 * class, so `"two"` still never equals a number and `2` never equals the
 * text `2`.
 *
 * @param field - The classified row value
 * @param value - The query value compared with it
 * @returns The query value's storage class against that row value
 *
 * @example
 * ```typescript
 * storedQueryValueOf({ kind: 'numeric', value: 2 }, '2'); // { kind: 'numeric', value: 2 }
 * storedQueryValueOf({ kind: 'numeric', value: 2 }, 'two'); // { kind: 'text', value: 'two' }
 * storedQueryValueOf({ kind: 'text', value: '2' }, 2); // { kind: 'numeric', value: 2 }
 * ```
 */
export function storedQueryValueOf(
  field: StoredValue,
  value: unknown
): StoredValue {
  if (field.kind !== 'numeric' || typeof value !== 'string') {
    return storedValueOf(value);
  }
  const numeral = quotedDecimalValue(value);
  if (numeral === null) {
    return storedValueOf(value);
  }
  return { kind: 'numeric', value: numeral };
}

/**
 * Whether a value is SQL NULL to this engine: null, undefined, NaN or an
 * invalid Date.
 *
 * @param value - A row field or a query value
 * @returns True when a comparison with the value is unknown
 */
export function isStoredNull(value: unknown): boolean {
  return storedValueOf(value).kind === 'null';
}

/**
 * The text SQLite's LIKE sees for a stored value: the string itself, a
 * Date's ISO-8601 text, or a finite number's or bigint's decimal digits.
 *
 * @param value - A row field
 * @returns The text to match, or undefined when the value has none (NULL, a
 * non-finite number, an object)
 */
export function likeTextOf(value: unknown): string | undefined {
  const stored = storedValueOf(value);
  if (stored.kind === 'text') {
    return stored.value;
  }
  if (stored.kind !== 'numeric') {
    return undefined;
  }
  if (typeof stored.value === 'number' && !Number.isFinite(stored.value)) {
    return undefined;
  }
  return stored.value.toString();
}

/**
 * Compare two classified values the way SQLite orders a column.
 *
 * @param left - A classified value
 * @param right - A classified value
 * @returns Negative when left orders first, positive when right does, 0 when
 * SQLite would consider them equal (two NULLs included)
 */
export function compareStored(left: StoredValue, right: StoredValue): number {
  if (left.kind !== right.kind) {
    return CLASS_RANK[left.kind] - CLASS_RANK[right.kind];
  }
  if (left.kind === 'numeric' && right.kind === 'numeric') {
    return compareNumeric(left.value, right.value);
  }
  if (left.kind === 'text' && right.kind === 'text') {
    return compareCodePoints(left.value, right.value);
  }
  if (left.kind === 'other' && right.kind === 'other') {
    return compareCodePoints(textOfOther(left.value), textOfOther(right.value));
  }
  return 0;
}

/**
 * Compare two raw values the way SQLite orders a column: NULL first, then
 * numbers by value, then text by code point.
 *
 * @param left - A row field
 * @param right - A row field
 * @returns Negative when left orders first, positive when right does, else 0
 *
 * @example
 * ```typescript
 * [10n, '3', 2, null, false].sort(compareStoredValues);
 * // [null, false, 2, 10n, '3']
 * ```
 */
export function compareStoredValues(left: unknown, right: unknown): number {
  return compareStored(storedValueOf(left), storedValueOf(right));
}

/**
 * Compare a number or bigint with a number or bigint by value. A bigint
 * against a fraction compares its whole part first and then the fraction,
 * so `10n < 10.5` and `10n > 9.5`; an infinity is beyond every bigint.
 *
 * @param left - A number or bigint
 * @param right - A number or bigint
 * @returns Negative, zero or positive
 */
export function compareNumeric(
  left: number | bigint,
  right: number | bigint
): number {
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return signOf(left, right);
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return signOf(left, right);
  }
  if (typeof left === 'bigint') {
    return compareBigintToNumber(left, right as number);
  }
  return -compareBigintToNumber(right as bigint, left);
}

/**
 * @param big - A bigint
 * @param num - A number that is not NaN
 * @returns Negative when the bigint is smaller, positive when larger, else 0
 */
function compareBigintToNumber(big: bigint, num: number): number {
  if (!Number.isFinite(num)) {
    return num > 0 ? -1 : 1;
  }
  const whole = Math.trunc(num);
  const wholeAsBigint = BigInt(whole);
  if (big !== wholeAsBigint) {
    return big < wholeAsBigint ? -1 : 1;
  }
  const fraction = num - whole;
  if (fraction === 0) {
    return 0;
  }
  return fraction > 0 ? -1 : 1;
}

/**
 * @param left - A value with `<` and `>`
 * @param right - A value of the same type
 * @returns -1, 0 or 1
 */
function signOf<T extends number | bigint>(left: T, right: T): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Compare two strings by Unicode code point, SQLite's binary order for
 * UTF-8 text. JavaScript's `<` compares UTF-16 code units, which puts a
 * supplementary character such as `😀` before `U+FFFF`.
 *
 * @param left - A string
 * @param right - A string
 * @returns Negative, zero or positive
 */
export function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference =
      (leftPoints[index]?.codePointAt(0) ?? 0) -
      (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

/**
 * The string form of a value outside SQLite's classes, used only to give
 * such values a stable order among themselves.
 *
 * @param value - An object, array, symbol or function
 * @returns Its string form, or an empty string when it has none
 */
function textOfOther(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}
