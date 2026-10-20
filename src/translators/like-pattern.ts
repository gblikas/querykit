import { nulSafeLikeText } from './nul-safe-like';
import { foldAsciiCase } from './own-key-case';

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

/**
 * One unit of a SQL LIKE pattern: `%`, `_`, or a literal character.
 */
type LikeToken =
  | { kind: 'any' }
  | { kind: 'one' }
  | { kind: 'char'; value: string };

/**
 * Split a SQL LIKE pattern into tokens. {@link LIKE_ESCAPE} makes the next
 * character literal, matching the `ESCAPE` clause the translators emit.
 *
 * @param sqlPattern SQL LIKE pattern
 * @returns Tokens in pattern order
 */
function tokenizeLikePattern(sqlPattern: string): LikeToken[] {
  const tokens: LikeToken[] = [];
  const chars = Array.from(sqlPattern);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? '';
    const next = chars[index + 1];
    if (char === LIKE_ESCAPE && next !== undefined) {
      tokens.push({ kind: 'char', value: next });
      index += 1;
      continue;
    }
    if (char === '%') {
      tokens.push({ kind: 'any' });
      continue;
    }
    if (char === '_') {
      tokens.push({ kind: 'one' });
      continue;
    }
    tokens.push({ kind: 'char', value: char });
  }
  return tokens;
}

/**
 * Match a whole value against a SQL LIKE pattern in O(pattern × value)
 * time. ASCII letters match in either case and every other character
 * exactly, which is SQLite's default LIKE (`open*` keeps `Open`; `ö` and
 * `Ö` stay distinct); an escaped letter folds the same way. The matcher
 * remembers the last `%` and resumes from it instead of backtracking
 * through every split, so a pattern such as `*a*a*a*ab` cannot stall the
 * event loop on a long value the way a compiled regular expression with
 * repeated `.*` groups does.
 *
 * The pattern is the SQL form from {@link toSqlLikePattern}, not the
 * QueryKit form: `%` is any sequence and `_` is one character. Each
 * U+0000 in the pattern and in the value is compared as U+0001, the
 * stand-in SQLite LIKE can read, so a null does not end either side.
 *
 * @param sqlPattern SQL LIKE pattern
 * @param value Field value
 * @returns True when the whole value matches
 *
 * @example
 * ```typescript
 * matchesLikePattern(toSqlLikePattern('hid*'), 'hidden'); // true
 * matchesLikePattern(toSqlLikePattern('HID*'), 'hidden'); // true
 * matchesLikePattern(toSqlLikePattern('other*'), 'hidden'); // false
 * ```
 */
export function matchesLikePattern(sqlPattern: string, value: string): boolean {
  const tokens = tokenizeLikePattern(
    foldAsciiCase(nulSafeLikeText(sqlPattern))
  );
  const chars = Array.from(foldAsciiCase(nulSafeLikeText(value)));
  let tokenIndex = 0;
  let charIndex = 0;
  let lastAnyToken = -1;
  let lastAnyChar = -1;
  while (charIndex < chars.length) {
    const token = tokens[tokenIndex];
    if (token?.kind === 'any') {
      lastAnyToken = tokenIndex;
      lastAnyChar = charIndex;
      tokenIndex += 1;
      continue;
    }
    if (
      token &&
      (token.kind === 'one' ||
        (token.kind === 'char' && token.value === chars[charIndex]))
    ) {
      tokenIndex += 1;
      charIndex += 1;
      continue;
    }
    if (lastAnyToken === -1) {
      return false;
    }
    lastAnyChar += 1;
    charIndex = lastAnyChar;
    tokenIndex = lastAnyToken + 1;
  }
  while (tokens[tokenIndex]?.kind === 'any') {
    tokenIndex += 1;
  }
  return tokenIndex === tokens.length;
}
