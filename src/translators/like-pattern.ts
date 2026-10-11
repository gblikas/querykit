/**
 * Character used in `ESCAPE` for SQL LIKE patterns from {@link toSqlLikePattern}.
 *
 * Exactly one character, and one that no supported dialect treats specially
 * inside a string literal. A backslash is a syntax error on MySQL and MariaDB
 * because those engines escape string literals with `\`.
 */
export const LIKE_ESCAPE = '!';

/**
 * Converts a QueryKit wildcard pattern into a SQL LIKE pattern.
 *
 * `*` matches any sequence and `?` matches one character. The escape
 * character, `%`, and `_` already in the pattern are escaped so they match
 * literally. Callers must append {@link likeEscapeClause}.
 *
 * @param pattern QueryKit wildcard pattern
 * @returns SQL LIKE pattern that uses {@link LIKE_ESCAPE}
 * @example
 * toSqlLikePattern('100%') // "100!%"
 * toSqlLikePattern('foo*') // "foo%"
 * toSqlLikePattern('foo\\*') // "foo\\%"
 * toSqlLikePattern('a!b%c_d*e?') // "a!!b!%c!_d%e_"
 */
export function toSqlLikePattern(pattern: string): string {
  return pattern
    .split(LIKE_ESCAPE)
    .join(LIKE_ESCAPE + LIKE_ESCAPE)
    .split('%')
    .join(`${LIKE_ESCAPE}%`)
    .split('_')
    .join(`${LIKE_ESCAPE}_`)
    .split('*')
    .join('%')
    .split('?')
    .join('_');
}

/**
 * `ESCAPE` clause paired with {@link toSqlLikePattern}.
 *
 * @param quote String-literal quote used by the dialect
 * @returns Clause such as `ESCAPE '!'`
 * @throws {Error} When {@link LIKE_ESCAPE} is not exactly one character
 * @example
 * likeEscapeClause() // "ESCAPE '!'"
 */
export function likeEscapeClause(quote = "'"): string {
  const escape: string = LIKE_ESCAPE;
  if (escape.length !== 1) {
    throw new Error('LIKE ESCAPE must be exactly one character');
  }
  return `ESCAPE ${quote}${escape}${quote}`;
}
