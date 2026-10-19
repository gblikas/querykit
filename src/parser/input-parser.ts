/**
 * Input Parser for QueryKit
 *
 * This module provides utilities for parsing partial/in-progress query input
 * from search bars, enabling features like:
 * - Key-value highlighting
 * - Autocomplete suggestions
 * - Real-time validation feedback
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
import { isLiqeWhitespace, readLiteralAt } from './query-scanner';

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
