/**
 * Numerals a query may write for a value SQLite stores exactly.
 *
 * Liqe reads a decimal with `Number`, so an integer past 2^53 is rounded
 * before the AST exists, and its grammar has no exponent, no leading plus,
 * no leading dot and no trailing dot. This module spells the numerals Liqe
 * cannot read as the plain decimals it can, rejects the ones no engine can
 * compare exactly, and recovers an exact integer from the digits a literal
 * was written with.
 */

import { readLiteralAt } from './query-scanner';

/** Smallest value a SQLite INTEGER column stores. */
const SIGNED_INT64_MIN = -(2n ** 63n);

/** Largest value a SQLite INTEGER column stores. */
const SIGNED_INT64_MAX = 2n ** 63n - 1n;

/**
 * The one integer past the signed range a query may still write: `Number`
 * holds 2^63 exactly, and a stored maximum compares below it on every
 * engine, so it stays the number it already was.
 */
const TWO_TO_63 = 2n ** 63n;

/**
 * Largest exponent magnitude the spelling expands. A wider exponent is left
 * as written for Liqe, which rejects it, rather than spelled as a numeral of
 * hundreds of digits.
 */
const MAX_SPELLED_EXPONENT = 400;

/** A sign and digits, with nothing else. */
const PLAIN_INTEGER = /^[+-]?\d+$/;

/** A plain integer written with a trailing dot, which Liqe rejects. */
const INTEGER_WITH_TRAILING_DOT = /^[+-]?\d+\.$/;

/**
 * An unquoted numeral where it may stand in query text: an optional sign, a
 * mantissa that is digits with an optional fraction or a bare fraction, and
 * an optional exponent.
 */
const NUMERAL_AT_START = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/** The parts of an exponent numeral. */
const EXPONENT_NUMERAL = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/;

/**
 * A spelling Liqe reads as a plain decimal: a leading plus, a leading dot
 * or a trailing dot is none of these.
 */
const LIQE_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Characters that may precede a numeral token: the start of the text,
 * whitespace, an opening bracket, a comma, or the end of a comparison
 * operator. A letter, digit, dot, dollar or sign before the token makes it
 * part of another word (`batch1e2`, `a.5`, `++1`).
 */
const BEFORE_NUMERAL = /[\s([{,:=<>]/;

/**
 * Characters that may follow a numeral token: the end of the text,
 * whitespace, a closing bracket or a comma. Anything else glues the token
 * to a wildcard, a letter or another numeral (`1.*`, `1e2y`, `1.2.3`).
 */
const AFTER_NUMERAL = /[\s)\]},]/;

/**
 * Error a numeral spelling raises. `QueryParser.parse` wraps it as a
 * `QueryParseError` with the same message.
 */
class NumeralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumeralError';
  }
}

/**
 * Whether a bigint fits a SQLite INTEGER column.
 *
 * @param value - The integer
 * @returns True between -2^63 and 2^63 - 1 inclusive
 */
export function isWithinSignedInt64(value: bigint): boolean {
  return value >= SIGNED_INT64_MIN && value <= SIGNED_INT64_MAX;
}

/**
 * The exact integer a plain integer literal names, when a JavaScript number
 * would misspell it. Inside the signed 64-bit range, the digits are kept as
 * a bigint when `Number` rounds them, or when `String` of that number is
 * not the written integer, which is how `-9223372036854775808` and `2^60`
 * would otherwise reach inline SQL as `-9223372036854776000` and
 * `1152921504606847000`. An integer `Number` holds and prints exactly, such
 * as `1`, `007` or `2^53`, stays a number, as does any integer outside the
 * range.
 *
 * @param digits - A plain integer literal, optionally signed
 * @returns The bigint to use as the value, or null to keep Liqe's number
 *
 * @example
 * ```typescript
 * exactSqliteInteger('9007199254740993'); // 9007199254740993n
 * exactSqliteInteger('9007199254740992'); // null
 * ```
 */
export function exactSqliteInteger(digits: string): bigint | null {
  const exact = BigInt(digits);
  if (!isWithinSignedInt64(exact)) {
    return null;
  }
  const approximate = Number(digits);
  if (BigInt(approximate) !== exact) {
    return exact;
  }
  if (BigInt(String(approximate)) !== exact) {
    return exact;
  }
  return null;
}

/**
 * Whether a plain integer literal names an integer no engine can store or
 * compare exactly: one outside the signed 64-bit range that `Number` still
 * holds as a finite integer, rounded onto another integer or kept. The exact
 * 2^63 is excepted. A digit string too long for a finite number is not
 * rejected here; the engines refuse the non-finite value themselves.
 *
 * @param digits - A plain integer literal, optionally signed
 * @returns True when the parser rejects the literal
 *
 * @example
 * ```typescript
 * isUnstorableInteger('9223372036854775809'); // true
 * isUnstorableInteger('9223372036854775808'); // false, 2^63
 * ```
 */
export function isUnstorableInteger(digits: string): boolean {
  const exact = BigInt(digits);
  if (isWithinSignedInt64(exact) || exact === TWO_TO_63) {
    return false;
  }
  return Number.isFinite(Number(digits));
}

/**
 * The message the parser raises for an integer `isUnstorableInteger` rejects.
 *
 * @param written - The literal as written
 * @returns The error message
 */
export function outsideSignedRangeMessage(written: string): string {
  return `Integer is outside the signed 64-bit range: ${written}`;
}

/**
 * Spell one unquoted numeral token as the plain decimal Liqe reads. An
 * exponent numeral is expanded exactly, with bigint arithmetic, so `1e-7`
 * is `0.0000001`, `2E3` is `2000` and `-1.5e+2` is `-150`; one whose
 * magnitude exceeds 400 is left as written. A leading plus, a leading dot
 * or a trailing dot is respelled through `Number`, so `+1` is `1`, `.5` is
 * `0.5` and `1.` is `1`; a plain integer with one of those marks keeps its
 * digits exactly. Any other token is returned unchanged.
 *
 * @param token - An unquoted token
 * @returns The spelling to hand Liqe
 * @throws {Error} `Integer is outside the signed 64-bit range: <token>` when
 * the exponent spells an integer outside the signed 64-bit range
 * @throws {Error} `Exponent underflows to zero: <token>` when the exponent's
 * decimal is not zero but `Number` reads it as zero
 *
 * @example
 * ```typescript
 * spellNumeralToken('1e-7'); // '0.0000001'
 * spellNumeralToken('+1'); // '1'
 * spellNumeralToken('1e21'); // throws
 * ```
 */
export function spellNumeralToken(token: string): string {
  const exponent = EXPONENT_NUMERAL.exec(token);
  if (exponent) {
    return spellExponentNumeral(token, exponent);
  }
  return spellRejectedNumeral(token);
}

/**
 * Spell every unquoted numeral in a query as the plain decimal Liqe reads,
 * leaving quoted strings and regex literals untouched. A token glued to a
 * letter, a dot, a sign or a wildcard is part of another word and is left
 * as written.
 *
 * @param query - Query text before Liqe sees it
 * @returns The text with numerals respelled
 * @throws {Error} When a numeral is one `spellNumeralToken` rejects
 *
 * @example
 * ```typescript
 * spellNumerals('priority:1e-7 AND name:"1e-7"');
 * // 'priority:0.0000001 AND name:"1e-7"'
 * ```
 */
export function spellNumerals(query: string): string {
  let result = '';
  let index = 0;
  while (index < query.length) {
    const literal = readLiteralAt(query, index);
    if (literal.kind !== 'none') {
      result += query.slice(index, literal.end);
      index = literal.end;
      continue;
    }
    const token = readNumeralToken(query, index);
    if (token !== null) {
      result += spellNumeralToken(token);
      index += token.length;
      continue;
    }
    result += query[index] ?? '';
    index += 1;
  }
  return result;
}

/**
 * The numeral written at `start`, as far as it runs. Liqe reports a numeric
 * literal's end from the stringified number, which is five characters for
 * `1000000000000000000000`, so a caller that needs the written digits reads
 * them from the literal's start with this function.
 *
 * @param text - Query text
 * @param start - Index where a numeric literal begins
 * @returns The numeral spelling at that index, or null when none starts there
 *
 * @example
 * ```typescript
 * numeralAt('count:007 AND x:1', 6); // '007'
 * ```
 */
export function numeralAt(text: string, start: number): string | null {
  const match = NUMERAL_AT_START.exec(text.slice(start));
  return match ? match[0] : null;
}

/**
 * The numeral token that starts at `index`, when one stands on its own
 * there, which is where `spellNumerals` respells it; null otherwise.
 *
 * @param query - Query text
 * @param index - Index where the token would begin
 * @returns The token, or null when none stands alone there
 *
 * @example
 * ```typescript
 * readNumeralToken('count:1e5', 6); // '1e5'
 * readNumeralToken('batch1e2', 5); // null
 * ```
 */
export function readNumeralToken(query: string, index: number): string | null {
  const before = index === 0 ? '' : (query[index - 1] ?? '');
  if (before !== '' && !BEFORE_NUMERAL.test(before)) {
    return null;
  }
  const token = numeralAt(query, index);
  if (token === null) {
    return null;
  }
  const after = query[index + token.length] ?? '';
  if (after !== '' && !AFTER_NUMERAL.test(after)) {
    return null;
  }
  return token;
}

/**
 * Expand an exponent numeral to its exact decimal.
 */
function spellExponentNumeral(token: string, parts: RegExpExecArray): string {
  const sign = parts[1] === '-' ? '-' : '';
  const integerDigits = parts[2] ?? '';
  const fractionDigits = parts[3] ?? '';
  const exponent = Number(parts[4]);
  if (integerDigits === '' && fractionDigits === '') {
    return token;
  }
  if (Math.abs(exponent) > MAX_SPELLED_EXPONENT) {
    return token;
  }
  const mantissa = (integerDigits + fractionDigits).replace(/^0+(?=\d)/, '');
  const spelled = shiftDecimalPoint(mantissa, exponent - fractionDigits.length);
  if (!spelled.includes('.')) {
    if (!isWithinSignedInt64(BigInt(sign + spelled))) {
      throw new NumeralError(outsideSignedRangeMessage(token));
    }
    return sign + spelled;
  }
  if (Number(spelled) === 0) {
    throw new NumeralError(`Exponent underflows to zero: ${token}`);
  }
  return sign + spelled;
}

/**
 * Move the decimal point of an unsigned digit string `scale` places to the
 * right, padding with zeros, and drop the trailing zeros of any fraction.
 */
function shiftDecimalPoint(digits: string, scale: number): string {
  if (scale >= 0) {
    return (BigInt(digits) * 10n ** BigInt(scale)).toString();
  }
  const shift = -scale;
  const padded = digits.padStart(shift + 1, '0');
  const integerPart = padded.slice(0, padded.length - shift);
  const fractionPart = padded.slice(padded.length - shift).replace(/0+$/, '');
  return fractionPart === '' ? integerPart : `${integerPart}.${fractionPart}`;
}

/**
 * Respell a leading plus, a leading dot or a trailing dot. A plain integer
 * only loses the mark, so its digits stay exact; any other spelling goes
 * through `Number` and is kept when that prints a plain decimal.
 */
function spellRejectedNumeral(token: string): string {
  if (LIQE_DECIMAL.test(token)) {
    return token;
  }
  if (PLAIN_INTEGER.test(token) || INTEGER_WITH_TRAILING_DOT.test(token)) {
    return token.replace(/^\+/, '').replace(/\.$/, '');
  }
  const value = Number(token);
  if (!Number.isFinite(value)) {
    return token;
  }
  const spelled = String(value);
  return /[eE]/.test(spelled) ? token : spelled;
}

/**
 * Whether a token is a plain integer literal, optionally signed.
 *
 * @param token - An unquoted token
 * @returns True for a sign and digits only
 */
export function isPlainInteger(token: string): boolean {
  return PLAIN_INTEGER.test(token);
}
