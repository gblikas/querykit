/**
 * Input completeness for QueryKit
 *
 * `isInputComplete` tells a search bar whether the parser accepts the text
 * typed so far. The tokenizer that reads that text into terms and a cursor
 * context is `tokenizer.ts`; it stays out of this module because this
 * module imports the parser and the parser imports the tokenizer.
 */

import { QuerySecurityError } from '../security/validator';
import { QueryParseError, QueryParser } from './parser';
import {
  IParseVerdict,
  parseVerdictKey,
  readParseVerdict,
  recordParseVerdict
} from './parse-verdict';
import { resolveMaxQueryLength } from './query-length';

/**
 * Options for `isInputComplete`.
 */
export interface IInputCompletenessOptions {
  /**
   * Longest input, in characters, the check reads; a longer input is
   * incomplete before any rewrite or Liqe run. The same cap as
   * `IParserOptions.maxQueryLength`, with the same default.
   *
   * @default 10000
   */
  maxQueryLength?: number;
}

/**
 * Whether `QueryParser.parse` accepts `input`.
 *
 * The check is a parse: a `QueryParser` with the given `maxQueryLength`
 * parses the text, and the input is complete exactly when that returns an
 * expression. A `QueryParseError` or `QuerySecurityError` is the verdict
 * "incomplete", so an empty text, an unclosed quote or regex, a dangling
 * operator word, a bare word with no field, a stray bracket, an integer
 * outside the signed 64-bit range, a text longer than the cap and every
 * other form the parser rejects are incomplete because the parser rejects
 * them, not because this function recognizes them. Any other throw is a
 * defect and propagates. Nothing is executed: a regex literal stays its
 * source text in the expression.
 *
 * The verdict is kept per text and cap, and `parseWithContext` keeps the
 * verdict of its own parse in the same place, so a search box that calls
 * `parseWithContext` and then `isInputComplete` on each keystroke pays one
 * parse, not two, and a re-render or a backspace to an earlier text pays
 * none.
 *
 * @param input The query input string
 * @param options The length cap; the parser's default when omitted
 * @returns true when `parse` accepts the input, false when it throws
 * @throws {RangeError} When `maxQueryLength` is neither a positive integer
 * nor `Infinity`
 */
export function isInputComplete(
  input: string,
  options: IInputCompletenessOptions = {}
): boolean {
  const maxQueryLength = resolveMaxQueryLength(options.maxQueryLength);
  const key = parseVerdictKey(maxQueryLength, input);
  const kept = readParseVerdict(key);
  if (kept) {
    return kept.error === null;
  }
  const verdict = attemptParse(input, maxQueryLength);
  recordParseVerdict(key, verdict);
  return verdict.error === null;
}

/**
 * Parse `input` with a parser capped at `maxQueryLength` and report the
 * outcome as a verdict: a `QueryParseError` or `QuerySecurityError` is the
 * parser's rejection of the text; anything else is rethrown.
 */
function attemptParse(input: string, maxQueryLength: number): IParseVerdict {
  try {
    new QueryParser({ maxQueryLength }).parse(input);
    return { error: null };
  } catch (error) {
    if (
      error instanceof QueryParseError ||
      error instanceof QuerySecurityError
    ) {
      return { error: error.message };
    }
    throw error;
  }
}
