/**
 * The verdicts of `QueryParser.parse`, kept per text and length cap.
 *
 * A search box asks the parser about the same text more than once on a
 * keystroke: `parseWithContext` parses it, and `isInputComplete` asks
 * whether that parse accepted it, again on the next render and again when
 * a typist backspaces to it. The verdict is kept here so each later
 * question is a map lookup rather than a parse. Whether `parse` accepts a
 * text depends on the text and on `maxQueryLength` alone: the field
 * options rename fields after Liqe has read the text and reject nothing,
 * so every parser with the same cap gives the same verdict. Extend the key
 * when an option changes what `parse` accepts. This module is internal.
 */

/**
 * What one `QueryParser.parse` call gave for one text.
 */
export interface IParseVerdict {
  /**
   * The message of the `QueryParseError` or `QuerySecurityError` the parse
   * threw, or null when it returned an expression.
   */
  error: string | null;
}

/**
 * Verdicts kept at once; the map is cleared when full, as the scanner's
 * caches are, since a search box only asks about the texts it has shown.
 */
const PARSE_VERDICT_CACHE_LIMIT = 256;
const parseVerdicts = new Map<string, IParseVerdict>();

/**
 * The key one text has under one length cap.
 *
 * @param maxQueryLength The cap of the parser that gave the verdict
 * @param query The text
 * @returns The key
 */
export function parseVerdictKey(maxQueryLength: number, query: string): string {
  return `${maxQueryLength}\u0000${query}`;
}

/**
 * The verdict kept under `key`, if any.
 *
 * @param key A `parseVerdictKey`
 * @returns The verdict, or undefined when the text has not been parsed or
 * its verdict was cleared
 */
export function readParseVerdict(key: string): IParseVerdict | undefined {
  return parseVerdicts.get(key);
}

/**
 * Keep `verdict` under `key`, clearing every entry first when the map is
 * full.
 *
 * @param key A `parseVerdictKey`
 * @param verdict The outcome of the parse
 */
export function recordParseVerdict(key: string, verdict: IParseVerdict): void {
  if (parseVerdicts.size >= PARSE_VERDICT_CACHE_LIMIT) {
    parseVerdicts.clear();
  }
  parseVerdicts.set(key, verdict);
}
