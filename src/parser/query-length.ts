/**
 * The query length cap.
 *
 * Liqe's cost grows superlinearly with the length of a bare word (about
 * 2 s of synchronous CPU for 10,000 characters), and the caps a
 * `QuerySecurityValidator` applies measure the parsed AST, so nothing
 * before the parser would otherwise bound the text a request hands it.
 * `QueryParser.parse`, `QueryParser.parseWithContext` and `isInputComplete`
 * check the length against `maxQueryLength` at their entry, before any
 * rewrite or Liqe run. This module is internal; the option is
 * `IParserOptions.maxQueryLength`.
 */

/** Longest query text, in characters, the parser reads by default. */
export const DEFAULT_MAX_QUERY_LENGTH = 10000;

/**
 * Resolve the `maxQueryLength` option.
 *
 * @param maxQueryLength - The option as given, if any
 * @returns The cap: a positive integer, or `Infinity` for no cap
 * @throws {RangeError} When the option is neither a positive integer nor
 * `Infinity`
 */
export function resolveMaxQueryLength(maxQueryLength?: number): number {
  if (maxQueryLength === undefined) {
    return DEFAULT_MAX_QUERY_LENGTH;
  }
  const isPositiveInteger =
    Number.isSafeInteger(maxQueryLength) && maxQueryLength > 0;
  if (!isPositiveInteger && maxQueryLength !== Infinity) {
    throw new RangeError(
      'Invalid parser option: maxQueryLength must be a positive integer or Infinity'
    );
  }
  return maxQueryLength;
}

/**
 * Whether a query text is longer than the cap, counted in UTF-16 code
 * units as `String.length` counts them.
 */
export function exceedsMaxQueryLength(
  query: string,
  maxQueryLength: number
): boolean {
  return query.length > maxQueryLength;
}

/**
 * The message a rejected query carries.
 *
 * @param length - The length of the rejected text
 * @param maxQueryLength - The cap it exceeded
 */
export function queryLengthMessage(
  length: number,
  maxQueryLength: number
): string {
  return `Query exceeds the maximum length of ${maxQueryLength} characters (${length})`;
}
