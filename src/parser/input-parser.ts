/**
 * Input Parser for QueryKit
 *
 * This module provides utilities for parsing partial/in-progress query input
 * from search bars, enabling features like:
 * - Key-value highlighting
 * - Autocomplete suggestions
 * - Real-time validation feedback
 */

import {
  hasBooleanRangeEndpoint,
  hasNullRangeEndpoint,
  IQueryTextMap,
  isLiqeWhitespace,
  mapQueryText,
  measureQueryDelimiters,
  readLiqe,
  readLiteralAt,
  uppercaseBooleanOperators
} from './query-scanner';

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

  // Matches word characters and some special chars (for keys/values)
  WORD_CHARS: /^[a-zA-Z0-9_.-]+/,

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
 * Read the string or regex literal at the start of `text` as the term's
 * value. An unclosed quote or slash pattern runs to the end of the text,
 * so `name:"John Doe` is one term rather than `"John` and `Doe`. The regex
 * text is kept as a string and is not compiled or executed.
 */
function readTermLiteral(text: string): string | null {
  const literal = readLiteralAt(text, 0);
  if (literal.kind === 'none') {
    return null;
  }
  return text.slice(0, literal.end);
}

/**
 * Parse a single term (key:value, key:>value, or just value)
 */
function parseTerm(
  input: string,
  startPosition: number
): IQueryInputTerm | null {
  if (!input || input.length === 0) {
    return null;
  }

  let key: string | null = null;
  let operator: string | null = null;
  let value: string | null = null;
  let remaining = input;
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
  const keyMatch = remaining.match(PATTERNS.WORD_CHARS);
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
      const literalValue = readTermLiteral(remaining);
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
    const literalValue = readTermLiteral(remaining);
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
    raw: input.substring(0, currentPos)
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

    // Check for logical operators
    const logicalMatch = remaining.match(PATTERNS.LOGICAL_OPERATOR);
    if (logicalMatch) {
      logicalOperators.push({
        operator: logicalMatch[0].toUpperCase(),
        position
      });
      position += logicalMatch[0].length;
      remaining = remaining.substring(logicalMatch[0].length);
      continue;
    }

    // Try to parse a term
    const term = parseTerm(remaining, position);
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
 * successfully, but it agrees with `QueryParser.parse` on the shapes below:
 * it is never true where the parser throws for one of them, and never false
 * where the parser accepts.
 *
 * Quotes, regex literals, and parentheses inside those literals are not
 * syntax. A regex spans what Liqe reads as one literal, so
 * `name:/foo/) AND status:/bar/` is complete and the ambiguous
 * `name:/foo/ AND status:/bar/` is not.
 *
 * Incomplete input:
 * - a field with an operator and no value, an unclosed quote or regex, or
 *   unbalanced parentheses, including a close before its open;
 * - a trailing `AND`, `OR` or `NOT`; an `AND` or `OR` with no clause on one
 *   side or with another operator word beside it; a `NOT` with nothing to
 *   negate, or stacked on another `NOT`; an empty parenthesis group;
 * - a literal with no field, whether a bare word or a quoted phrase (there
 *   is no full-text field);
 * - a colon with no field name, with whitespace before it, after a name that
 *   starts with `.` or a digit, or after a name glued to the text before it
 *   (`status :a`, `:a`, `.column:open`, `status:open\u2003AND\u2003x:1`);
 * - a Unicode space (U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
 *   U+205F, U+3000, U+FEFF) outside quotes and outside every term; inside
 *   an unquoted value it is a value character, as it is to Liqe;
 * - a `[min TO max]` range whose unquoted bound is `null`, `true` or
 *   `false`, which the parser leaves to Liqe to reject.
 *
 * @param input The query input string
 * @returns true if the input appears complete, false if it looks incomplete
 */
export function isInputComplete(input: string): boolean {
  if (!input || input.trim().length === 0) {
    return false;
  }
  const result = parseQueryInput(input);
  if (result.terms.some(isValuelessTerm)) {
    return false;
  }
  if (findTrailingLogicalOperator(input)) {
    return false;
  }
  const delimiters = measureQueryDelimiters(input);
  if (delimiters.unclosedQuote !== null || delimiters.hasUnclosedRegex) {
    return false;
  }
  if (delimiters.openParentheses !== delimiters.closeParentheses) {
    return false;
  }
  const map = mapQueryText(input);
  return !COMPLETENESS_CHECKS.some(check => check(input, map, result.terms));
}

/**
 * One reason the search box reports input incomplete. Each check mirrors a
 * rejection of `QueryParser.parse`.
 */
type CompletenessCheck = (
  input: string,
  map: IQueryTextMap,
  terms: IQueryInputTerm[]
) => boolean;

const COMPLETENESS_CHECKS: CompletenessCheck[] = [
  hasDanglingSyntax,
  hasInvalidFieldColon,
  hasImplicitFieldTerm,
  hasUncoveredUnicodeSpace,
  (input): boolean => hasNullRangeEndpoint(input),
  (input): boolean => hasBooleanRangeEndpoint(input)
];

/**
 * Every Unicode space JavaScript's `\s` matches that Liqe does not treat as
 * whitespace. Inside an unquoted value each is a value character.
 */
const UNICODE_SPACE =
  /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/**
 * Liqe's field name: `[$A-Z_a-z][\w$.]*`.
 */
const FIELD_NAME_START = /^[A-Za-z_$]/;
const FIELD_NAME_CHARACTER = /[\w$.]/;

function isValuelessTerm(term: IQueryInputTerm): boolean {
  return term.key !== null && term.operator !== null && term.value === null;
}

/**
 * A piece of query syntax at bracket depth zero: a parenthesis, an operator
 * word, or a clause (everything else up to whitespace or a parenthesis,
 * literals and bracket bodies included).
 */
interface ISyntaxToken {
  kind: 'open' | 'close' | 'AND' | 'OR' | 'NOT' | 'clause';
  start: number;
  end: number;
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
  if (before !== undefined && !/[\s()]/.test(before)) {
    return null;
  }
  const match = PATTERNS.LOGICAL_OPERATOR.exec(input.slice(index));
  if (!match) {
    return null;
  }
  return match[1].toUpperCase() as 'AND' | 'OR' | 'NOT';
}

function readSyntaxTokens(input: string, map: IQueryTextMap): ISyntaxToken[] {
  const tokens: ISyntaxToken[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] ?? '';
    if (map.isCode[index] && map.depth[index] === 0) {
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (char === '(' || char === ')') {
        const kind = char === '(' ? 'open' : 'close';
        tokens.push({ kind, start: index, end: index + 1 });
        index += 1;
        continue;
      }
      const word = readLogicalOperator(input, index);
      if (word) {
        tokens.push({ kind: word, start: index, end: index + word.length });
        index += word.length;
        continue;
      }
    }
    const end = readClauseEnd(input, map, index);
    tokens.push({ kind: 'clause', start: index, end });
    index = end;
  }
  return tokens;
}

function readClauseEnd(
  input: string,
  map: IQueryTextMap,
  start: number
): number {
  let index = start;
  while (index < input.length) {
    const char = input[index] ?? '';
    const isSyntax = map.isCode[index] && map.depth[index] === 0;
    if (isSyntax && (/\s/.test(char) || char === '(' || char === ')')) {
      break;
    }
    index += 1;
  }
  return Math.max(index, start + 1);
}

/**
 * An `AND` or `OR` needs a clause or group on each side (`NOT` may stand on
 * the right), a `NOT` needs a clause or group after it and cannot stack on
 * another `NOT`, a group cannot be empty, and a `)` cannot come before its
 * `(`. Liqe rejects each of these.
 */
function hasDanglingSyntax(input: string, map: IQueryTextMap): boolean {
  const tokens = readSyntaxTokens(input, map);
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (token.kind === 'open') {
      depth += 1;
      if (next?.kind === 'close') {
        return true;
      }
    } else if (token.kind === 'close') {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    } else if (token.kind === 'AND' || token.kind === 'OR') {
      if (!previous || !['clause', 'close'].includes(previous.kind)) {
        return true;
      }
      if (!next || !['clause', 'open', 'NOT'].includes(next.kind)) {
        return true;
      }
    } else if (token.kind === 'NOT') {
      if (!next || !['clause', 'open'].includes(next.kind)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Every colon at bracket depth zero must end a field name: a closed quoted
 * string, or a bare name of Liqe's field characters that starts with a
 * letter, `_` or `$`. The name must begin a clause: the start of the text,
 * Liqe whitespace, `(` or a clause-leading minus precedes it. Whitespace
 * before the colon, a missing name, `.column`, and a name glued to the text
 * before it (`openlabel:x`, a value holding a Unicode space) are rejected.
 */
function hasInvalidFieldColon(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!map.isCode[index] || map.depth[index] !== 0 || input[index] !== ':') {
      continue;
    }
    const name = readFieldNameBefore(input, map, index);
    if (name === null) {
      return true;
    }
    if (!name.quoted && !FIELD_NAME_START.test(input.slice(name.start))) {
      return true;
    }
    if (!separatesBeforeField(input, map, name.start)) {
      return true;
    }
  }
  return false;
}

function readFieldNameBefore(
  input: string,
  map: IQueryTextMap,
  colonIndex: number
): { start: number; quoted: boolean } | null {
  const quoted = map.literals.find(
    literal =>
      literal.end === colonIndex && literal.kind === 'string' && literal.closed
  );
  if (quoted) {
    return { start: quoted.start, quoted: true };
  }
  let start = colonIndex;
  while (
    start > 0 &&
    map.isCode[start - 1] &&
    FIELD_NAME_CHARACTER.test(input[start - 1] ?? '')
  ) {
    start -= 1;
  }
  return start === colonIndex ? null : { start, quoted: false };
}

/**
 * Whether a field or value may begin at `start`: the start of the text,
 * Liqe whitespace, `(` or a clause-leading minus comes before it.
 */
function separatesBeforeField(
  input: string,
  map: IQueryTextMap,
  start: number
): boolean {
  if (start === 0) {
    return true;
  }
  const before = input[start - 1] ?? '';
  if (!map.isCode[start - 1]) {
    return false;
  }
  if (isLiqeWhitespace(before) || before === '(') {
    return true;
  }
  return before === '-' && startsMinusNegation(input, map, start - 1);
}

/**
 * Whether the minus at `minusIndex` begins a clause: the start of the text,
 * Liqe whitespace or `(` precedes it. A minus after `:`, `>`, `[` or `,` is
 * part of a value.
 */
function startsMinusNegation(
  input: string,
  map: IQueryTextMap,
  minusIndex: number
): boolean {
  if (minusIndex === 0) {
    return true;
  }
  const before = input[minusIndex - 1] ?? '';
  return (
    map.isCode[minusIndex - 1] === true &&
    (isLiqeWhitespace(before) || before === '(')
  );
}

/**
 * Liqe reads a literal with no field as an implicit-field tag, which the
 * parser rejects: `open`, `open done`, `"hello world"` and `""`. The text is
 * uppercased the way the parser does before Liqe sees it, so a lowercase
 * `and` between clauses stays an operator. A text Liqe reads two ways
 * (`name:/foo/ AND status:/bar/`) is rejected by the parser as well. A Liqe
 * syntax error decides nothing here; the other checks cover those shapes.
 */
function hasImplicitFieldTerm(input: string): boolean {
  const reading = readLiqe(uppercaseBooleanOperators(input));
  if (reading.isAmbiguous) {
    return true;
  }
  return reading.ast !== null && hasImplicitField(reading.ast);
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
 * A Unicode space the tokenizer skipped as whitespace, outside quotes and
 * outside every term, is a value character to Liqe and never a separator:
 * `\u00a0status:open` and `status:open AND\u2003label:x` are syntax errors.
 */
function hasUncoveredUnicodeSpace(
  input: string,
  map: IQueryTextMap,
  terms: IQueryInputTerm[]
): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (
      map.isCode[index] &&
      map.depth[index] === 0 &&
      UNICODE_SPACE.test(input[index] ?? '') &&
      !terms.some(
        term => term.startPosition <= index && index < term.endPosition
      )
    ) {
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
