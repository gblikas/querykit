/**
 * SQLite LIKE stops at the first U+0000. Equality still sees the bytes
 * after it, and a wildcard has to see them too. A value with no U+0000 is
 * compared as written. Each U+0000 is replaced with U+0001, one character
 * LIKE can read, and the bytes after it stay in the match. The pattern
 * uses that same stand-in, so a null written in the pattern does not end
 * the match before the rest of it. `?` still matches one character. A
 * stored U+0001 then compares as U+0000 under LIKE.
 */

import { SQL, SQLWrapper, sql } from 'drizzle-orm';

const NUL = '\u0000';
const NUL_STAND_IN = '\u0001';
const COLUMN = NUL;

/**
 * Text a SQLite LIKE comparison can read.
 *
 * LIKE stops at the first U+0000. The column operand replaces each one
 * with U+0001, and a pattern has to use that same stand-in or the
 * characters after a null in the pattern are never compared. Text with
 * no U+0000 is returned unchanged.
 *
 * @param text LIKE pattern or field text
 * @returns The text with each U+0000 replaced by U+0001
 * @example
 * nulSafeLikeText('a\u0000%') // "a\u0001%"
 */
export function nulSafeLikeText(text: string): string {
  return text.split(NUL).join(NUL_STAND_IN);
}

/**
 * Left-hand LIKE operand with a stand-in for the column expression.
 *
 * @returns SQL text containing {@link COLUMN} wherever the column goes
 */
function likeOperandTemplate(): string {
  const column = COLUMN;
  const blob = `cast(${column} AS BLOB)`;
  const rest = 'cast(rest AS BLOB)';
  const atNull = `instr(${rest}, x'00')`;
  const spliced = `unhex(hex(substr(${rest}, 1, ${atNull} - 1)) || '01' || hex(substr(${rest}, ${atNull} + 1)))`;
  return `CASE WHEN instr(${blob}, x'00') = 0 THEN ${column} ELSE (SELECT cast(rest AS TEXT) FROM (WITH RECURSIVE walk(rest) AS (SELECT ${blob} UNION ALL SELECT ${spliced} FROM walk WHERE ${atNull} > 0) SELECT rest FROM walk WHERE ${atNull} = 0 LIMIT 1)) END`;
}

/**
 * Column expression whose LIKE comparison sees the bytes after U+0000.
 *
 * The column SQL is quoted by the caller. SQLite reads a blob with
 * `substr` and `hex`, so a zero byte does not end the value, then `unhex`
 * puts the bytes back with U+0001 in place of each U+0000.
 *
 * @param columnSql Quoted column, or another SQL expression
 * @returns SQL expression for the left operand of LIKE
 * @example
 * nulSafeLikeOperand('"title"')
 */
export function nulSafeLikeOperand(columnSql: string): string {
  return likeOperandTemplate().split(COLUMN).join(columnSql);
}

/**
 * Rewrite a LIKE comparison so its column sees the bytes after U+0000.
 * A statement with no LIKE is returned unchanged.
 *
 * @param sqlText A comparison, as the translators used to emit it
 * @returns The statement with a NUL-safe LIKE operand
 * @example
 * withNulSafeLike(`"title" LIKE '%b' ESCAPE '!'`)
 */
export function withNulSafeLike(sqlText: string): string {
  const likeAt = sqlText.indexOf(' LIKE ');
  if (likeAt < 0) {
    return sqlText;
  }
  return `${nulSafeLikeOperand(sqlText.slice(0, likeAt))}${sqlText.slice(likeAt)}`;
}

/**
 * The same operand as {@link nulSafeLikeOperand}, for a Drizzle column.
 *
 * @param column Schema column or quoted identifier
 * @returns Drizzle SQL for the left operand of LIKE
 */
export function nulSafeLikeSql(column: SQLWrapper): SQL {
  const parts = likeOperandTemplate().split(COLUMN);
  let combined: SQL = sql.raw(parts[0] ?? '');
  for (let index = 1; index < parts.length; index += 1) {
    combined = sql`${combined}${column}${sql.raw(parts[index] ?? '')}`;
  }
  return combined;
}
