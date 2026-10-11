/**
 * Converts a QueryKit wildcard pattern into a SQL LIKE pattern.
 *
 * `*` matches any sequence and `?` matches one character. `%`, `_`, and `\`
 * already in the pattern are escaped so they match literally. Callers must
 * append `ESCAPE '\'`; without that clause the backslashes are ordinary
 * characters on engines that follow the SQL standard.
 *
 * @param pattern QueryKit wildcard pattern
 * @returns SQL LIKE pattern that uses `\` as the escape character
 * @example
 * toSqlLikePattern('100%') // "100\\%"
 * toSqlLikePattern('foo*') // "foo%"
 * toSqlLikePattern('foo\\*') // "foo\\\\%"
 */
export function toSqlLikePattern(pattern: string): string {
  return pattern
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
}
