/**
 * Input Parser for QueryKit
 *
 * This module provides utilities for parsing partial/in-progress query input
 * from search bars, enabling features like:
 * - Key-value highlighting
 * - Autocomplete suggestions
 * - Real-time validation feedback
 */

import type { LiqeQuery } from 'liqe';
import {
  emitsGroup,
  hasQuotedTail,
  ILiteralAt,
  IQueryTextMap,
  isLiqeWhitespace,
  isRejectedBracketBody,
  mapQueryText,
  readComparisonOperator,
  readLiqe,
  readLiteralAt,
  readQuotedLiteralStarts,
  readRangeBounds,
  readRegexSpans,
  readUnquotedRewrite,
  someBracketExpression,
  splitListMembers,
  uppercaseBooleanOperators
} from './query-scanner';
import {
  hasUnreadRegexMember,
  IBracketRewrite,
  readPlaceholderStart,
  rewriteQueryForLiqe
} from './query-rewrite';
import {
  isPlainInteger,
  isUnstorableInteger,
  readNumeralToken,
  spellNumeralToken
} from './stored-integer';
import { exceedsMaxQueryLength, resolveMaxQueryLength } from './query-length';

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
 * Represents the context of where the cursor is within a query term
 */
export type CursorContext = 'key' | 'operator' | 'value' | 'empty' | 'between';

/**
 * Represents the parsed context of a single query term
 */
export interface IQueryInputTerm {
  /**
   * The field/key being typed (e.g., "status" in "status:done")
   * Will be null if only a bare value is being typed
   */
  key: string | null;

  /**
   * The operator being used (e.g., ":", ">", ">=", "<", "<=", "!=")
   * Will be null if no operator has been typed yet
   */
  operator: string | null;

  /**
   * The value being typed (e.g., "done" in "status:done")
   * Will be null if no value has been typed yet
   */
  value: string | null;

  /**
   * The start position of this term in the original input string
   */
  startPosition: number;

  /**
   * The end position of this term in the original input string
   */
  endPosition: number;

  /**
   * The original raw text of this term
   */
  raw: string;
}

/**
 * Represents the result of parsing query input
 */
export interface IQueryInputContext {
  /**
   * All terms found in the input
   */
  terms: IQueryInputTerm[];

  /**
   * The term where the cursor is currently positioned (if cursorPosition was provided)
   * Will be null if cursor is not within any term
   */
  activeTerm: IQueryInputTerm | null;

  /**
   * Where the cursor is within the active term
   */
  cursorContext: CursorContext;

  /**
   * The original input string
   */
  input: string;

  /**
   * The cursor position (if provided)
   */
  cursorPosition: number | null;

  /**
   * Logical operators found between terms (AND, OR, NOT)
   */
  logicalOperators: Array<{
    operator: string;
    position: number;
  }>;
}

/**
 * Options for parsing query input
 */
export interface IQueryInputParserOptions {
  /**
   * Whether to treat the input as case-insensitive for keys
   * @default false
   */
  caseInsensitiveKeys?: boolean;
}

/**
 * Regular expression patterns for parsing
 */
const PATTERNS = {
  // Matches an operator word (AND, OR, NOT) that the parser treats as one:
  // followed by the end of the text, whitespace or a parenthesis, so a word
  // glued to `.` or `:` stays inside a field name such as `not.priority`.
  LOGICAL_OPERATOR: /^(AND|OR|NOT)(?=$|[\s()])/i,

  // Matches comparison operators: :, :>, :>=, :<, :<=, :!=, :=
  COMPARISON_OPERATOR: /^(:>=|:<=|:!=|:>|:<|:=|:)/,

  // Matches a field name's characters, Liqe's `[\w$.]`. A hyphen never
  // names a field: in `last-updated:x` the parser reads a bare word and a
  // negated field, and the leading minus of `-status:open` is the negation.
  FIELD_NAME_PATTERN: /^[A-Za-z0-9_$.]+/,

  // Matches an unquoted value: it ends at ASCII whitespace or a parenthesis.
  // Liqe's whitespace is tab, line feed, vertical tab, form feed and space;
  // a Unicode space such as U+00A0 or U+2003 is a value character to it, so
  // the search box keeps it inside the value too.
  UNQUOTED_VALUE: /^[^\t\n\v\f\r ()]+/,

  // Matches whitespace
  WHITESPACE: /^\s+/,

  // Matches parentheses
  PAREN_OPEN: /^\(/,
  PAREN_CLOSE: /^\)/,

  // Matches negation prefix
  NEGATION: /^-/
};

/**
 * Read the string or regex literal that begins at `index` of the whole
 * query as the term's value. An unclosed quote or slash pattern runs to the
 * end of the text, so `name:"John Doe` is one term rather than `"John` and
 * `Doe`. The literal is read from the whole text, not from the rest of it,
 * because a regex spans what Liqe reads as one literal in the whole text.
 * The regex text is kept as a string and is not compiled or executed.
 */
function readTermLiteral(input: string, index: number): string | null {
  const literal = readLiteralAt(input, index);
  if (literal.kind === 'none') {
    return null;
  }
  return input.slice(index, literal.end);
}

/**
 * Parse the single term (key:value, key:>value, or just value) that begins
 * at `startPosition` of `input`
 */
function parseTerm(
  input: string,
  startPosition: number
): IQueryInputTerm | null {
  const text = input.substring(startPosition);
  if (text.length === 0) {
    return null;
  }

  let key: string | null = null;
  let operator: string | null = null;
  let value: string | null = null;
  let remaining = text;
  let currentPos = 0;

  // Handle negation prefix (e.g., -status:active)
  let hasNegation = false;
  const negationMatch = remaining.match(PATTERNS.NEGATION);
  if (negationMatch) {
    hasNegation = true;
    remaining = remaining.substring(1);
    currentPos += 1;
  }

  // Try to match a key (word before operator)
  const keyMatch = remaining.match(PATTERNS.FIELD_NAME_PATTERN);
  if (keyMatch) {
    const potentialKey = keyMatch[0];
    const afterKey = remaining.substring(potentialKey.length);

    // Check if followed by an operator
    const operatorMatch = afterKey.match(PATTERNS.COMPARISON_OPERATOR);
    if (operatorMatch) {
      // This is a key:value pattern
      key = (hasNegation ? '-' : '') + potentialKey;
      operator = operatorMatch[0];
      currentPos += potentialKey.length + operator.length;
      remaining = afterKey.substring(operator.length);

      // Try to match the value: a string or regex literal first, else an
      // unquoted value that runs to ASCII whitespace or a parenthesis.
      const literalValue = readTermLiteral(input, startPosition + currentPos);
      if (literalValue !== null) {
        value = literalValue;
        currentPos += literalValue.length;
      } else {
        const valueMatch = remaining.match(PATTERNS.UNQUOTED_VALUE);
        if (valueMatch) {
          value = valueMatch[0];
          currentPos += value.length;
        } else {
          // Operator present but no value yet
          value = null;
        }
      }
    } else {
      // No operator - this is a bare value (or incomplete key)
      // Treat the whole thing as a potential key that could become key:value
      // or as a bare value for full-text search
      key = null;
      operator = null;
      value = (hasNegation ? '-' : '') + potentialKey;
      currentPos += potentialKey.length;
    }
  } else {
    // A quoted string or a regex with no field is a bare value
    const literalValue = readTermLiteral(input, startPosition + currentPos);
    if (literalValue !== null) {
      key = null;
      operator = null;
      value = (hasNegation ? '-' : '') + literalValue;
      currentPos += literalValue.length;
    } else {
      // No recognizable token
      return null;
    }
  }

  return {
    key,
    operator,
    value,
    startPosition,
    endPosition: startPosition + currentPos,
    raw: text.substring(0, currentPos)
  };
}

/**
 * Tokenize the input string into terms and logical operators
 */
function tokenize(input: string): {
  terms: IQueryInputTerm[];
  logicalOperators: Array<{ operator: string; position: number }>;
} {
  const terms: IQueryInputTerm[] = [];
  const logicalOperators: Array<{ operator: string; position: number }> = [];

  let remaining = input;
  let position = 0;

  while (remaining.length > 0) {
    // Skip whitespace
    const wsMatch = remaining.match(PATTERNS.WHITESPACE);
    if (wsMatch) {
      position += wsMatch[0].length;
      remaining = remaining.substring(wsMatch[0].length);
      continue;
    }

    // Skip parentheses (they're structural, not terms)
    if (remaining.match(PATTERNS.PAREN_OPEN)) {
      position += 1;
      remaining = remaining.substring(1);
      continue;
    }
    if (remaining.match(PATTERNS.PAREN_CLOSE)) {
      position += 1;
      remaining = remaining.substring(1);
      continue;
    }

    // Check for logical operators where the parser reads one: bounded by
    // whitespace, a parenthesis or an end of the text on both sides, so the
    // `or` of `"sta tus":>=or` stays the value it is to the parser.
    const word = readLogicalOperator(input, position);
    if (word) {
      logicalOperators.push({ operator: word, position });
      position += word.length;
      remaining = remaining.substring(word.length);
      continue;
    }

    // Try to parse a term
    const term = parseTerm(input, position);
    if (term) {
      terms.push(term);
      position = term.endPosition;
      remaining = input.substring(position);
    } else {
      // Skip unknown character
      position += 1;
      remaining = remaining.substring(1);
    }
  }

  return { terms, logicalOperators };
}

/**
 * Determine the cursor context based on position within a term
 */
function determineCursorContext(
  term: IQueryInputTerm,
  cursorPosition: number
): CursorContext {
  const relativePos = cursorPosition - term.startPosition;

  if (term.key !== null && term.operator !== null) {
    // Key and operator are present
    const keyLength = term.key.length;
    const operatorLength = term.operator.length;
    const keyPlusOperatorLength = keyLength + operatorLength;

    if (relativePos < keyLength) {
      return 'key';
    } else if (relativePos < keyPlusOperatorLength) {
      return 'operator';
    } else {
      // Cursor is at or after the operator - this is the value position
      // Even if value is null (user hasn't typed anything yet),
      // they're positioned to type a value
      return 'value';
    }
  } else if (term.key !== null) {
    // Only key present (incomplete term)
    return 'key';
  } else if (term.value !== null) {
    // Only value present (bare value)
    return 'value';
  }

  return 'empty';
}

/**
 * Find the term that contains the cursor position
 */
function findActiveTermAndContext(
  terms: IQueryInputTerm[],
  cursorPosition: number | null,
  inputLength: number
): { activeTerm: IQueryInputTerm | null; cursorContext: CursorContext } {
  if (cursorPosition === null) {
    // If no cursor position provided, use the last term
    if (terms.length > 0) {
      const lastTerm = terms[terms.length - 1];
      return {
        activeTerm: lastTerm,
        cursorContext: determineCursorContext(lastTerm, lastTerm.endPosition)
      };
    }
    return { activeTerm: null, cursorContext: 'empty' };
  }

  // Find term containing cursor
  for (const term of terms) {
    if (
      cursorPosition >= term.startPosition &&
      cursorPosition <= term.endPosition
    ) {
      return {
        activeTerm: term,
        cursorContext: determineCursorContext(term, cursorPosition)
      };
    }
  }

  // Cursor is between terms or at the end
  if (cursorPosition >= inputLength && terms.length > 0) {
    // Cursor at the end - check if right after a term
    const lastTerm = terms[terms.length - 1];
    if (cursorPosition === lastTerm.endPosition) {
      return {
        activeTerm: lastTerm,
        cursorContext: determineCursorContext(lastTerm, cursorPosition)
      };
    }
  }

  return { activeTerm: null, cursorContext: 'between' };
}

/**
 * Parse query input to extract structured information about the current search state.
 *
 * This function is designed for real-time parsing of user input in a search bar,
 * allowing developers to:
 * - Highlight keys and values differently
 * - Provide autocomplete suggestions based on context
 * - Validate input as the user types
 *
 * @param input The current search input string
 * @param cursorPosition Optional cursor position to determine the active term
 * @param options Optional parsing options
 * @returns Structured information about the query input
 *
 * @example
 * ```typescript
 * // User is typing "status:d" (intending to type "status:done")
 * const result = parseQueryInput('status:d');
 * // result.terms[0] = { key: 'status', operator: ':', value: 'd', ... }
 * // result.activeTerm = { key: 'status', operator: ':', value: 'd', ... }
 * // result.cursorContext = 'value'
 *
 * // User is typing "priority:>2 status:"
 * const result = parseQueryInput('priority:>2 status:', 19);
 * // result.terms[0] = { key: 'priority', operator: ':>', value: '2', ... }
 * // result.terms[1] = { key: 'status', operator: ':', value: null, ... }
 * // result.activeTerm = result.terms[1] (cursor is at position 19)
 * // result.cursorContext = 'value' (waiting for value input)
 * ```
 */
export function parseQueryInput(
  input: string,
  cursorPosition?: number,
  options?: IQueryInputParserOptions
): IQueryInputContext {
  // Handle empty input
  if (!input || input.trim().length === 0) {
    return {
      terms: [],
      activeTerm: null,
      cursorContext: 'empty',
      input,
      cursorPosition: cursorPosition ?? null,
      logicalOperators: []
    };
  }

  // Tokenize the input
  const { terms, logicalOperators } = tokenize(input);

  // Apply case-insensitivity to keys if requested
  if (options?.caseInsensitiveKeys) {
    for (const term of terms) {
      if (term.key !== null) {
        term.key = term.key.toLowerCase();
      }
    }
  }

  // Find active term and cursor context
  const { activeTerm, cursorContext } = findActiveTermAndContext(
    terms,
    cursorPosition ?? null,
    input.length
  );

  return {
    terms,
    activeTerm,
    cursorContext,
    input,
    cursorPosition: cursorPosition ?? null,
    logicalOperators
  };
}

/**
 * Get the term at a specific cursor position.
 * Convenience function for quick lookups.
 *
 * @param input The query input string
 * @param cursorPosition The cursor position
 * @returns The term at the cursor position, or null if none
 */
export function getTermAtPosition(
  input: string,
  cursorPosition: number
): IQueryInputTerm | null {
  const result = parseQueryInput(input, cursorPosition);
  return result.activeTerm;
}

/**
 * Return the logical operator that ends `input`, ignoring trailing whitespace.
 *
 * The position is an index into `input.trimEnd()`. Characters inside quotes
 * and regex literals are not operators.
 *
 * @param input Query text, which may be incomplete
 * @returns The operator and its start index, or null when the text does not end with AND, OR, or NOT
 */
export function findTrailingLogicalOperator(
  input: string
): { operator: 'AND' | 'OR' | 'NOT'; position: number } | null {
  const trimmed = input.trimEnd();
  if (trimmed.length === 0) {
    return null;
  }
  const { logicalOperators } = tokenize(trimmed);
  const last = logicalOperators[logicalOperators.length - 1];
  if (!last) {
    return null;
  }
  const operator = last.operator;
  if (operator !== 'AND' && operator !== 'OR' && operator !== 'NOT') {
    return null;
  }
  if (last.position + operator.length !== trimmed.length) {
    return null;
  }
  return { operator, position: last.position };
}

/**
 * Check if the input appears to be a complete, valid query expression.
 * This is a lightweight check - it doesn't guarantee the query will parse
 * successfully, but it agrees with `QueryParser.parse`: it is never true
 * where the parser throws, and false where the parser accepts only on the
 * forms the completeness probe records, regex literals the same-length
 * stand-in below closes where the parser's Liqe does not.
 *
 * The input is read the way the parser reads it. The parser's own rewrite
 * of the text and Liqe's reading of the result decide first
 * (`hasRejectedLiqeReading`): the input is incomplete when the rewrite
 * rejects a numeral, when Liqe has no reading or two readings of the
 * rewritten text, when it reads a clause that names no field, or when its
 * one reading fails one of the three checks the parser makes after it.
 * That covers an unclosed quote or regex, unbalanced or glued parentheses,
 * a dangling, stacked or glued operator word, a bare word, a colon with no
 * field name, a stray or unreadable bracket, a value or list member Liqe
 * refuses, a tail glued to a literal or a bracket, and a regex Liqe reads
 * two ways. Then the forms the parser rejects only after Liqe has read
 * them, or never hands Liqe, are read from the text:
 * - an empty group, `()`, which Liqe reads as an empty expression;
 * - a comparison operator with no value after it (`status:`, `x:>`,
 *   `x:!=`, `(x:)`), which Liqe reads as a tag with an empty expression;
 * - an unquoted integer outside the signed 64-bit range, as the value
 *   after an operator or as a list member or range bound the bracket
 *   rewrite writes back as a number, which Liqe reads as a number and the
 *   parser then rejects;
 * - a quoted literal Liqe's string grammar refuses, a raw line feed or a
 *   backslash sequence outside Liqe's escapes, and a quoted membership
 *   member that is not one closed literal (`status:in["a"b"c"]`), which
 *   the parser's own membership decode refuses before Liqe runs.
 *
 * Quotes, regex literals, and parentheses inside those literals are not
 * syntax. A regex spans what Liqe reads as one literal in the rewritten
 * text, so `name:/foo/) AND status:/bar/` is complete and the ambiguous
 * `name:/foo/ AND status:/bar/` is not. `field:!=` is read as the parser
 * rewrites it, `NOT field:`, so an ordered operator after it belongs to
 * the operator: `count:!=>5` is complete.
 *
 * An input longer than `maxQueryLength` is incomplete before any of this
 * runs, as `QueryParser.parse` rejects it.
 *
 * @param input The query input string
 * @param options The length cap; the parser's default when omitted
 * @returns true if the input appears complete, false if it looks incomplete
 * @throws {RangeError} When `maxQueryLength` is neither a positive integer
 * nor `Infinity`
 */
export function isInputComplete(
  input: string,
  options: IInputCompletenessOptions = {}
): boolean {
  const maxQueryLength = resolveMaxQueryLength(options.maxQueryLength);
  if (!input || exceedsMaxQueryLength(input, maxQueryLength)) {
    return false;
  }
  if (input.trim().length === 0) {
    return false;
  }
  if (hasRejectedLiqeReading(input)) {
    return false;
  }
  const map = mapQueryText(input, readLiqeStandIn(input));
  return !COMPLETENESS_CHECKS.some(check => check(input, map));
}

/**
 * A text of the same length as `input` that Liqe reads the way it reads
 * the parser's rewritten query, as far as regex spans go: operator words
 * uppercased, each numeral the parser spells replaced by digits, each
 * bracket span the rewrite consumes replaced by a group or quoted
 * placeholder (its brackets by spaces when its member is written back as
 * typed), and `field:!=` read as the parser's `NOT field:` with any
 * ordered operator after it kept in place. Liqe cannot read the typed
 * `:!=`, `in[...]`, `[a, b]` or `1e5`, so without this the text map would
 * close every regex at its first slash where the parser's Liqe reads
 * `status:!=/a/b/` as one regex. The stand-in keeps the typed positions,
 * which the checks on the text need; what Liqe reads is decided on the
 * parser's rewritten text itself (`hasRejectedLiqeReading`).
 */
function readLiqeStandIn(input: string): string {
  const spelled = standInForNumerals(uppercaseBooleanOperators(input));
  return standInForInequalities(standInForBrackets(spelled), spelled);
}

function standInForNumerals(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const literal = readLiteralAt(text, index);
    if (literal.kind !== 'none') {
      result += text.slice(index, literal.end);
      index = literal.end;
      continue;
    }
    const token = readNumeralToken(text, index);
    if (token === null) {
      result += text[index] ?? '';
      index += 1;
      continue;
    }
    const isRespelled =
      isSpelledNumeral(token) && spellNumeralToken(token) !== token;
    result += isRespelled ? '1'.repeat(token.length) : token;
    index += token.length;
  }
  return result;
}

function standInForBrackets(text: string): string {
  const characters = text.split('');
  someBracketExpression(text, span => {
    if (span.kind === 'rejected' || isRejectedBracketBody(span)) {
      return false;
    }
    if (emitsGroup(span)) {
      // `(field:a OR field:b)` stands where the span stood, so a glued
      // `AND` after the closer is `)AND` to Liqe.
      characters.fill('x', span.start, span.end);
      characters[span.start] = '(';
      characters[span.start + 2] = ':';
      characters[span.end - 1] = ')';
      return false;
    }
    const colon = span.start + span.field.length;
    const operator = readComparisonOperator(text, colon) ?? ':';
    const start =
      span.kind === 'membership' ? colon + operator.length : span.bodyStart - 1;
    if (readUnquotedRewrite(span) !== null) {
      // The member reaches Liqe as typed; text glued to the closer is glued
      // to it (`x:[//]/` is `x:///`, `status:[a]AND` is `status:aAND`), so
      // the closer must not part them as whitespace would.
      const after = text[span.end];
      const isGlued =
        after !== undefined && !isLiqeWhitespace(after) && after !== ')';
      characters[start] = ' ';
      characters[span.end - 1] = isGlued ? 'x' : ' ';
      return false;
    }
    characters.fill('x', start, span.end);
    characters[start] = '"';
    characters[span.end - 1] = '"';
    return false;
  });
  return characters.join('');
}

/**
 * Replace each `field:!=` of `text` the way the parser reads it, finding
 * the fields and literals in `literalText`, the same-length text the
 * parser's inequality rewrite walks.
 */
function standInForInequalities(text: string, literalText: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const inequality = readInequalityAt(literalText, index);
    if (inequality && text.startsWith(':!=', inequality.colon)) {
      // `NOT field:value` stands in as ` -field:value`, a negated tag of
      // the same length, so a `NOT` or minus before it stacks and fails as
      // the parser's `NOT NOT` does, and the value stays the tag's own.
      const ordered = inequality.operator.slice(3);
      result += ` -${text.slice(index, inequality.colon)}:${ordered}`;
      index = inequality.colon + inequality.operator.length;
      continue;
    }
    const literal = readLiteralAt(literalText, index);
    result += text.slice(index, Math.max(literal.end, index + 1));
    index = Math.max(literal.end, index + 1);
  }
  return result;
}

/**
 * The `field:!=` the parser's inequality rewrite consumes at `index`: a
 * field no name character precedes, bare or closed quoted, and its colon
 * and operator.
 */
function readInequalityAt(
  text: string,
  index: number
): { colon: number; operator: string } | null {
  if (index > 0 && /[\w$.]/.test(text[index - 1] ?? '')) {
    return null;
  }
  const colon = readFieldEndAt(text, index);
  const operator = colon === null ? null : readComparisonOperator(text, colon);
  if (colon === null || operator === null || !operator.startsWith(':!=')) {
    return null;
  }
  return { colon, operator };
}

/**
 * The index just past the field written at `index`, a closed quoted string
 * or a bare name, or null when no field is written there.
 */
function readFieldEndAt(text: string, index: number): number | null {
  const literal = readLiteralAt(text, index);
  if (literal.kind === 'string') {
    return literal.closed ? literal.end : null;
  }
  const name = FIELD_NAME.exec(text.slice(index));
  return name ? index + name[0].length : null;
}

/**
 * One reason the search box reports input incomplete that Liqe's reading
 * of the rewritten text does not show: each mirrors a rejection
 * `QueryParser.parse` makes after Liqe has read the text, or before it
 * hands Liqe a membership member.
 */
type CompletenessCheck = (input: string, map: IQueryTextMap) => boolean;

const COMPLETENESS_CHECKS: CompletenessCheck[] = [
  hasEmptyGroup,
  hasValuelessOperator,
  hasUnstorableInteger,
  hasRejectedStringLiteral,
  hasRejectedMembershipLiteral
];

/**
 * Liqe's field name: `[$A-Z_a-z][\w$.]*`.
 */
const FIELD_NAME = /^[A-Za-z_$][\w$.]*/;

/**
 * The decimals Liqe reads and the spellings the parser turns into one:
 * `1`, `-1.5`, `+1`, `1.`, `.5`, `1e-7`, `1.e5`.
 */
const SPELLED_NUMERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * The decimal Liqe's grammar reads.
 */
const LIQE_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Whether `word` reaches Liqe as a decimal: it is a numeral spelling and
 * the parser's spelling of it is Liqe's decimal. An exponent past the
 * spelling limit (`1e401`) is left as written, and Liqe rejects it.
 */
function isSpelledNumeral(word: string): boolean {
  if (!SPELLED_NUMERAL.test(word)) {
    return false;
  }
  try {
    return LIQE_DECIMAL.test(spellNumeralToken(word));
  } catch {
    return false;
  }
}

/**
 * Escapes Liqe decodes after a backslash in either quote style; `\'` only in
 * single quotes, and `\u` with four hex digits in both.
 */
const SIMPLE_ESCAPES = '"/\\bfnrt';

/**
 * Read the operator word at `index` when the parser would treat it as one:
 * preceded by the start of the text, whitespace or a parenthesis, and
 * followed by the end of the text, whitespace or a parenthesis.
 */
function readLogicalOperator(
  input: string,
  index: number
): 'AND' | 'OR' | 'NOT' | null {
  const before = input[index - 1];
  if (
    before !== undefined &&
    !isLiqeWhitespace(before) &&
    !/[()]/.test(before)
  ) {
    return null;
  }
  const match = PATTERNS.LOGICAL_OPERATOR.exec(input.slice(index));
  if (!match) {
    return null;
  }
  return match[1].toUpperCase() as 'AND' | 'OR' | 'NOT';
}

/**
 * The parser's own reading of the text its rewrites hand Liqe, decided on
 * that text rather than on the same-length stand-in. The parser rejects
 * the query when the rewrite rejects a numeral before Liqe sees it (an
 * integer outside the signed 64-bit range, an exponent that underflows to
 * zero), when Liqe has no reading of the rewritten text (`status:"a"b`,
 * `x:1 AND`, `NOT NOT x:1`, `x:[]`) or two readings (`name:/foo/ AND
 * status:/bar/`, and two regex members whose group Liqe reads two ways,
 * `b:[,//,////]` is `(b:// OR b:////)`), when Liqe reads a literal with
 * no field as an implicit-field tag (`open`, `open done`, `"hello
 * world"`, `""`), and when Liqe's one reading fails one of the three
 * checks the parser makes after it: a regex literal must begin at each
 * regex list member written back as typed and end where a grouped member
 * ends (`hasUnreadRegexMember`), no quoted literal may begin at a quoted
 * member or bound copied as written that is not one closed literal
 * (`status:["a" OR status:"c"]` reaches Liqe as `status:"a" OR
 * status:"c"`), and a quoted literal must begin at each lifted membership
 * placeholder, so the clause can be put back. A regex Liqe reads from the
 * text before a member swallows it (`t:[//, a` LF `b] OR (d:/a/i)` is one
 * regex to the `i`; `(t:[//] u:[a` LF `b] v:in[a] OR d:/a/i)` swallows
 * the placeholder), which the stand-in, where such a member is a plain
 * string, cannot show. What the parser rejects after Liqe's reading is
 * converted, a tag with no value or an empty group, is left to the
 * positional checks. The verdict is kept per input string, since a search
 * box asks about the same text on every render and again when a typist
 * backspaces to it, and the rewrite and the Earley parse are the cost of
 * this check.
 */
function hasRejectedLiqeReading(input: string): boolean {
  const cached = liqeVerdicts.get(input);
  if (cached !== undefined) {
    return cached;
  }
  const verdict = readsRejectedLiqeReading(input);
  if (liqeVerdicts.size >= LIQE_VERDICT_CACHE_LIMIT) {
    liqeVerdicts.clear();
  }
  liqeVerdicts.set(input, verdict);
  return verdict;
}

const LIQE_VERDICT_CACHE_LIMIT = 256;
const liqeVerdicts = new Map<string, boolean>();

function readsRejectedLiqeReading(input: string): boolean {
  const rewrites: IBracketRewrite[] = [];
  let rewritten: string;
  try {
    rewritten = rewriteQueryForLiqe(input, rewrite => rewrites.push(rewrite));
  } catch {
    return true;
  }
  const reading = readLiqe(rewritten);
  if (reading.ast === null) {
    return true;
  }
  return (
    hasImplicitField(reading.ast) || hasUnreadRewrite(rewrites, reading.ast)
  );
}

/**
 * Whether Liqe's one reading of the rewritten text, `ast`, fails one of
 * the parser's checks after Liqe for one of the `rewrites`: it did not
 * read a regex literal at a regex list member, it read a quoted literal at
 * a copied quoted member or bound that is not one closed literal, or it
 * did not read a quoted literal at a membership placeholder.
 */
function hasUnreadRewrite(
  rewrites: IBracketRewrite[],
  ast: LiqeQuery
): boolean {
  if (rewrites.length === 0) {
    return false;
  }
  const literalStarts = readQuotedLiteralStarts(ast);
  const regexSpans = readRegexSpans(ast);
  return rewrites.some(
    rewrite =>
      hasUnreadRegexMember(rewrite.regexMembers, regexSpans) ||
      rewrite.quotedTails.some(tail => literalStarts.has(tail.start)) ||
      (rewrite.span.kind === 'membership' &&
        !literalStarts.has(readPlaceholderStart(rewrite)))
  );
}

function hasImplicitField(node: unknown): boolean {
  if (!node || typeof node !== 'object') {
    return false;
  }
  const token = node as {
    type?: string;
    field?: { type?: string };
    expression?: unknown;
    left?: unknown;
    right?: unknown;
    operand?: unknown;
  };
  if (token.type === 'Tag') {
    return token.field?.type === 'ImplicitField';
  }
  return [token.expression, token.left, token.right, token.operand].some(
    hasImplicitField
  );
}

/**
 * Whether the character at `index` is query syntax at bracket depth zero:
 * outside every literal and outside every bracket body, whose characters
 * are values the rewrite quotes or decodes.
 */
function isSyntaxAt(map: IQueryTextMap, index: number): boolean {
  return map.isCode[index] === true && map.depth[index] === 0;
}

/**
 * Liqe reads `()`, with nothing or only Liqe whitespace inside, as an
 * empty expression, which the parser rejects once Liqe has read it
 * (`()`, `( )`, `(())`, `status:a AND ()`).
 */
function hasEmptyGroup(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!isSyntaxAt(map, index) || input[index] !== '(') {
      continue;
    }
    let next = index + 1;
    while (isLiqeWhitespace(input[next])) {
      next += 1;
    }
    if (isSyntaxAt(map, next) && input[next] === ')') {
      return true;
    }
  }
  return false;
}

/**
 * A comparison operator must be followed by a value: the end of the text,
 * Liqe whitespace or a parenthesis after it leaves a tag with an empty
 * expression, which Liqe reads and the parser rejects (`status:`, `x:>`,
 * `"a b":`, `(x:)`). `field:!=` is the parser's `NOT field:`, so `x:!=`
 * is one too.
 */
function hasValuelessOperator(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (
      isSyntaxAt(map, index) &&
      input[index] === ':' &&
      isValuelessOperator(input, index)
    ) {
      return true;
    }
  }
  return false;
}

function isValuelessOperator(input: string, colonIndex: number): boolean {
  const operator = readComparisonOperator(input, colonIndex) ?? ':';
  const after = input[colonIndex + operator.length];
  return after === undefined || isLiqeWhitespace(after) || /[()]/.test(after);
}

/**
 * Liqe reads a run of digits as a number, and the parser then reads the
 * digits back from the text and rejects a plain integer outside the
 * signed 64-bit range: the unquoted value after an operator
 * (`count:9223372036854775809`), or a list member or range bound the
 * bracket rewrite writes back as a number (`count:[1 TO
 * 9223372036854775809]`). Membership members are read with `Number`, so a
 * wide integer inside `in[...]` is not rejected there.
 */
function hasUnstorableInteger(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!isSyntaxAt(map, index) || input[index] !== ':') {
      continue;
    }
    const word = readValueWordAfterOperator(input, map, index);
    if (word !== null && isUnstorableIntegerWord(word)) {
      return true;
    }
  }
  return someBracketExpression(
    input,
    span => {
      if (span.kind !== 'bracket') {
        return false;
      }
      const bounds = readRangeBounds(span);
      const written = bounds
        ? [bounds.min, bounds.max]
        : splitListMembers(span.body);
      return written.some(isUnstorableIntegerWord);
    },
    map.isCode
  );
}

function isUnstorableIntegerWord(word: string): boolean {
  return isPlainInteger(word) && isUnstorableInteger(word);
}

/**
 * The unquoted word after the comparison operator whose colon is at
 * `colonIndex`, up to Liqe whitespace, a parenthesis or the end of the text.
 * Null when no word follows, or when it begins a literal, a bracket, or a
 * membership list.
 */
function readValueWordAfterOperator(
  input: string,
  map: IQueryTextMap,
  colonIndex: number
): string | null {
  const operator = readComparisonOperator(input, colonIndex) ?? ':';
  const start = colonIndex + operator.length;
  if (
    !map.isCode[start] ||
    /^(?:[[{]|(?:not\s+in|in)\s*\[)/i.test(input.slice(start))
  ) {
    return null;
  }
  const word = readWordAt(input, map, start);
  return word.length === 0 ? null : word;
}

function readWordAt(input: string, map: IQueryTextMap, start: number): string {
  let end = start;
  while (end < input.length) {
    const char = input[end] ?? '';
    if (map.isCode[end] && (isLiqeWhitespace(char) || /[()]/.test(char))) {
      break;
    }
    end += 1;
  }
  return input.slice(start, end);
}

/**
 * A closed quoted literal Liqe's string grammar refuses: its characters
 * exclude a line feed, and a backslash must start one of Liqe's escapes
 * (`"a\q"` is not `aq`, `"\U0041"` is not `A`). The parser decodes a
 * quoted membership member with that grammar before Liqe runs
 * (`status:in["a\q"]`, `status:in["a` LF `b"]`), which is where this
 * decides; anywhere else the literal reaches Liqe, whose reading rejects
 * it as well.
 */
function hasRejectedStringLiteral(input: string, map: IQueryTextMap): boolean {
  return map.literals.some(
    literal =>
      literal.kind === 'string' &&
      literal.closed &&
      (input.slice(literal.start, literal.end).includes('\n') ||
        hasRejectedEscape(input, literal))
  );
}

/**
 * A quoted membership member that is not one closed literal
 * (`status:in["a"b"c"]`, `status:in["a" OR x:"c"]`, `status:in["a" "b"]`),
 * which the parser's membership decode refuses. Liqe never sees the
 * member, since the clause is lifted out as a placeholder; a bracket list
 * member or range bound copied as written reaches Liqe, where the reading
 * decides.
 */
function hasRejectedMembershipLiteral(
  input: string,
  map: IQueryTextMap
): boolean {
  return someBracketExpression(
    input,
    span =>
      span.kind === 'membership' &&
      splitListMembers(span.body).some(hasQuotedTail),
    map.isCode
  );
}

function hasRejectedEscape(input: string, literal: ILiteralAt): boolean {
  const quote = input[literal.start];
  let index = literal.start + 1;
  while (index < literal.end - 1) {
    if (input[index] !== '\\') {
      index += 1;
      continue;
    }
    const escaped = input[index + 1] ?? '';
    const isSimple = escaped !== '' && SIMPLE_ESCAPES.includes(escaped);
    if (isSimple || (escaped === "'" && quote === "'")) {
      index += 2;
    } else if (
      escaped === 'u' &&
      /^[0-9A-Fa-f]{4}/.test(input.slice(index + 2))
    ) {
      index += 6;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Extract just the key and value from a simple input.
 * Convenience function for the most common use case.
 *
 * @param input The query input string (e.g., "status:done")
 * @returns Object with key and value, or null if not a key:value pattern
 *
 * @example
 * ```typescript
 * extractKeyValue('status:done');
 * // { key: 'status', value: 'done' }
 *
 * extractKeyValue('status:');
 * // { key: 'status', value: null }
 *
 * extractKeyValue('hello');
 * // null (no key:value pattern)
 * ```
 */
export function extractKeyValue(
  input: string
): { key: string; value: string | null } | null {
  const result = parseQueryInput(input.trim());

  if (result.terms.length === 0) {
    return null;
  }

  const term = result.terms[0];

  if (term.key === null) {
    return null;
  }

  return {
    key: term.key,
    value: term.value
  };
}

// Import token types from types.ts (canonical location)
import type { IQueryToken } from './types';

/**
 * A token in the query sequence - either a term or a logical operator
 * This is an alias for IQueryToken from types.ts
 */
export type QueryToken = IQueryToken;

/**
 * Result of parsing query input into an interleaved token sequence
 */
export interface IQueryTokenSequence {
  /**
   * Ordered sequence of tokens (terms and operators interleaved)
   */
  tokens: QueryToken[];

  /**
   * The original input string
   */
  input: string;

  /**
   * The token where the cursor is currently positioned (if cursorPosition was provided)
   */
  activeToken: QueryToken | null;

  /**
   * Index of the active token in the tokens array (-1 if none)
   */
  activeTokenIndex: number;
}

/**
 * Parse query input into an interleaved sequence of terms and operators.
 *
 * This provides a flat, ordered representation ideal for:
 * - Rendering query tokens as UI chips/tags
 * - Building visual query builders
 * - Syntax highlighting with proper ordering
 *
 * @param input The query input string
 * @param cursorPosition Optional cursor position to identify active token
 * @returns Ordered sequence of term and operator tokens
 *
 * @example
 * ```typescript
 * const result = parseQueryTokens('status:done AND priority:high');
 * // result.tokens = [
 * //   { type: 'term', key: 'status', value: 'done', ... },
 * //   { type: 'operator', operator: 'AND', ... },
 * //   { type: 'term', key: 'priority', value: 'high', ... }
 * // ]
 *
 * // For incomplete input like 'status:d'
 * const result = parseQueryTokens('status:d');
 * // result.tokens = [
 * //   { type: 'term', key: 'status', value: 'd', ... }
 * // ]
 * ```
 */
export function parseQueryTokens(
  input: string,
  cursorPosition?: number
): IQueryTokenSequence {
  if (!input || input.trim().length === 0) {
    return {
      tokens: [],
      input,
      activeToken: null,
      activeTokenIndex: -1
    };
  }

  const context = parseQueryInput(input, cursorPosition);

  // Build a combined list of all tokens with their positions
  const allTokens: Array<{
    token: QueryToken;
    position: number;
  }> = [];

  // Add terms
  for (const term of context.terms) {
    allTokens.push({
      position: term.startPosition,
      token: {
        type: 'term',
        key: term.key,
        operator: term.operator,
        value: term.value,
        startPosition: term.startPosition,
        endPosition: term.endPosition,
        raw: term.raw
      }
    });
  }

  // Add operators
  for (const op of context.logicalOperators) {
    const opLength = op.operator.length;
    allTokens.push({
      position: op.position,
      token: {
        type: 'operator',
        operator: op.operator as 'AND' | 'OR' | 'NOT',
        startPosition: op.position,
        endPosition: op.position + opLength,
        raw: op.operator
      }
    });
  }

  // Sort by position to get the interleaved order
  allTokens.sort((a, b) => a.position - b.position);

  const tokens = allTokens.map(t => t.token);

  // Find active token based on cursor position
  let activeToken: QueryToken | null = null;
  let activeTokenIndex = -1;

  if (cursorPosition !== undefined) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (
        cursorPosition >= token.startPosition &&
        cursorPosition <= token.endPosition
      ) {
        activeToken = token;
        activeTokenIndex = i;
        break;
      }
    }

    // If cursor is at the end and right after the last token
    if (activeToken === null && tokens.length > 0) {
      const lastToken = tokens[tokens.length - 1];
      if (cursorPosition === lastToken.endPosition) {
        activeToken = lastToken;
        activeTokenIndex = tokens.length - 1;
      }
    }
  }

  return {
    tokens,
    input,
    activeToken,
    activeTokenIndex
  };
}
