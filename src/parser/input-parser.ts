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
  emitsGroup,
  hasBooleanRangeEndpoint,
  hasGluedRangeTail,
  hasNullRangeEndpoint,
  hasRejectedBracketExpression,
  hasStrayBracket,
  IBracketExpressionSpan,
  ILiteralAt,
  IQueryTextMap,
  isCopiedBracketMember,
  isLiqeWhitespace,
  isListBody,
  isRejectedBracketBody,
  mapQueryText,
  readComparisonOperator,
  readGroupEnds,
  readLiqe,
  readLiteralAt,
  readRangeBounds,
  readUnquotedRewrite,
  someBracketExpression,
  splitListMembers,
  uppercaseBooleanOperators,
  writesBackUnquoted
} from './query-scanner';
import { rewriteQueryForLiqe } from './query-rewrite';
import {
  isPlainInteger,
  isUnstorableInteger,
  readNumeralToken,
  spellNumeralToken,
  spellNumerals
} from './stored-integer';

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
 * successfully, but it agrees with `QueryParser.parse` on the shapes below:
 * it is never true where the parser throws for one of them, and never false
 * where the parser accepts.
 *
 * Quotes, regex literals, and parentheses inside those literals are not
 * syntax. A regex spans what Liqe reads as one literal, so
 * `name:/foo/) AND status:/bar/` is complete and the ambiguous
 * `name:/foo/ AND status:/bar/` is not. Whether Liqe reads the text two
 * ways, or reads a clause that names no field, is decided on the text the
 * parser's rewrites hand Liqe, so a list of two regex members whose
 * rewrite Liqe reads two ways (`b:[,//,////]` is `(b:// OR b:////)`,
 * `status:[/a/, /b/, x]`) is incomplete.
 *
 * Incomplete input:
 * - a field with an operator and no value, an unclosed quote or regex, or
 *   unbalanced parentheses, including a close before its open (a
 *   parenthesis inside a bracket body is a value the rewrite quotes);
 * - a trailing `AND`, `OR` or `NOT`; an `AND` or `OR` with no clause on one
 *   side or with another operator word beside it; a `NOT` with nothing to
 *   negate, or stacked on another `NOT`; an empty parenthesis group;
 * - a clause that names no field, whether a bare word, a quoted phrase, a
 *   numeral or a regex, wherever it stands (there is no full-text field);
 * - a colon with no field name, with whitespace before it, after a name that
 *   starts with `.` or a digit, or after a name glued to the text before it
 *   (`status :a`, `:a`, `.column:open`, `status:open\u2003AND\u2003x:1`);
 * - a Unicode space (U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
 *   U+205F, U+3000, U+FEFF) outside quotes and outside every term; inside
 *   an unquoted value it is a value character, as it is to Liqe;
 * - a `[min TO max]` range whose unquoted bound is `null`, `true` or
 *   `false`, which the parser leaves to Liqe to reject;
 * - a character Liqe never accepts outside a literal: `&`, `|`, `;`, `^`,
 *   `~`, a `!` that is not the one in `:!=`, or a `?` outside every value
 *   (`status:open?` is a wildcard; `?status:open` is not);
 * - a `--` or `-` stacked on another negation, a `NOT` followed by `NOT`, a
 *   minus or a `:!=` clause, which reaches Liqe as `NOT NOT`;
 * - an unquoted value that starts like a number but is not one Liqe reads
 *   or the parser spells (`0x10`, `1_0`, `1e`, `1.2.3`, `--1`, `+`, `.`,
 *   `1e401`), or a numeral the parser rejects (an integer outside the
 *   signed 64-bit range, an exponent that underflows to zero);
 * - a closed quote followed by the same quote (`"a""b"`), or a quoted
 *   backslash sequence Liqe does not accept (`"a\q"`, `"\U0041"`), or a raw
 *   line feed inside quotes, or two backslashes in a row inside a regex
 *   Liqe reads (`l:/\\/`, `status:[/\\/]`), whose body takes any character
 *   but a backslash or a backslash and one such character;
 * - a parenthesis glued to a clause, to `NOT`, to a minus or to another
 *   group (`AND` and `OR` may touch a group, but not the `NOT (` a
 *   `field:!=[a, b]` list becomes), a clause-leading minus with no tag
 *   glued to it, and a clause-leading minus before a list or two-sided
 *   range, which the rewrite turns into `-(`;
 * - a carriage return or any other ASCII control character that is not
 *   Liqe whitespace, outside quotes, regex and bracket lists;
 * - a bracket body the parser leaves to Liqe (`[]`, `{abc}`, `[a TO ]`,
 *   `[* TO *]`, an unclosed opener, `in[a}`), a stray bracket, a list
 *   member written back unquoted that Liqe refuses (`[AND]`, `[1x]`,
 *   `["a"b]`, `[[a]]`), a quoted bound or membership member with a tail,
 *   or a membership list or regex member swallowed by a regex Liqe reads
 *   from the text before it (`f:[//]x:in[]/`, `x://T:[//]`);
 * - a tail glued to a closed quote or regex (`status:"a"b`, `status:/a/ib`)
 *   or to a bracket closer, unless Liqe reads the rewrite's one unquoted
 *   member or numeric bound joined to it (`status:[a]b` is `status:ab`,
 *   `status:[1]x` is not a value, `status:[a, b]x` glues a `)`), a quote or
 *   regex glued to the text before it (`NOT"a"`, `status:[a]/b/`), a field
 *   name that starts with a digit, and an unquoted value that is not
 *   Liqe's value or number (`a%b`, `-x`, `a=b`, `1x`, `a"b"`) or is exactly
 *   `AND`, `OR` or `NOT`.
 *
 * `field:!=` is read as the parser rewrites it, `NOT field:`, so an ordered
 * operator after it belongs to the operator: `count:!=>5` is complete.
 *
 * @param input The query input string
 * @returns true if the input appears complete, false if it looks incomplete
 */
export function isInputComplete(input: string): boolean {
  if (!input || input.trim().length === 0) {
    return false;
  }
  if (findTrailingLogicalOperator(input)) {
    return false;
  }
  const standIn = readLiqeStandIn(input);
  const map = mapQueryText(input, standIn.liqeText, standIn.rewriteText);
  if (map.literals.some(literal => !literal.closed)) {
    return false;
  }
  return !COMPLETENESS_CHECKS.some(check => check(input, map));
}

/**
 * Texts of the same length as `input` that Liqe reads the way it reads
 * the parser's rewritten query, as far as regex spans and ambiguity go.
 * `liqeText` stands for the text Liqe finally parses: operator words
 * uppercased, each numeral the parser spells replaced by digits, each
 * bracket span the rewrite consumes replaced by a group or quoted
 * placeholder (its brackets by spaces when its member is written back as
 * typed), and `field:!=` read as the parser's `NOT field:` with any ordered
 * operator after it kept in place. `rewriteText` stops before the brackets,
 * which is the text the parser's bracket rewrite reads its literals from.
 * Liqe cannot read the typed `:!=`, `in[...]`, `[a, b]` or `1e5`, so
 * without this the search box would close every regex at its first slash
 * where the parser's Liqe reads `status:!=/a/b/` as one regex. The
 * stand-in keeps the typed positions; what it hides, the regex members of
 * a group, is decided on the parser's rewritten text itself
 * (`readParserText`).
 */
function readLiqeStandIn(input: string): {
  liqeText: string;
  rewriteText: string;
} {
  const spelled = standInForNumerals(uppercaseBooleanOperators(input));
  return {
    liqeText: standInForInequalities(standInForBrackets(spelled), spelled),
    rewriteText: standInForInequalities(spelled, spelled)
  };
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
 * One reason the search box reports input incomplete. Each check mirrors a
 * rejection of `QueryParser.parse`.
 */
type CompletenessCheck = (input: string, map: IQueryTextMap) => boolean;

const COMPLETENESS_CHECKS: CompletenessCheck[] = [
  hasDanglingSyntax,
  hasFieldlessClause,
  hasInvalidFieldColon,
  hasImplicitFieldTerm,
  hasUncoveredUnicodeSpace,
  (input, map): boolean => hasNullRangeEndpoint(input, map.isCode),
  (input, map): boolean => hasBooleanRangeEndpoint(input, map.isCode),
  hasBareSymbol,
  hasStackedNegation,
  hasBrokenNumeral,
  hasRejectedQuote,
  hasRejectedRegexEscape,
  hasQuotedLineFeed,
  hasGluedParenthesis,
  hasLoneMinus,
  hasControlCharacter,
  (input, map): boolean => hasRejectedBracketExpression(input, map.isCode),
  (input, map): boolean => hasStrayBracket(input, map.isCode),
  hasSwallowedMembership,
  hasSwallowedRegexMember,
  hasCopiedMember,
  hasRejectedListWord,
  hasGluedLiteralTail,
  hasGluedLiteralStart,
  hasRejectedValueWord
];

/**
 * Liqe's unquoted value, as its grammar writes it.
 */
const LIQE_UNQUOTED_VALUE =
  /^[#$*?@A-Za-z_\u0080-\uffff][\w#$*.?@\u0080-\uffff-]*$/;

/**
 * The operator words, which Liqe never reads as a value.
 */
const LIQE_KEYWORD_VALUE = /^(?:AND|OR|NOT)$/;

/**
 * Whether `char` is an ASCII control character Liqe accepts nowhere outside
 * a literal: a code below U+0020 that is not tab, line feed, vertical tab
 * or form feed, or U+007F.
 */
function isRejectedControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  if (Number.isNaN(code)) {
    return false;
  }
  return code === 0x7f || (code < 0x20 && !isLiqeWhitespace(char));
}

/**
 * The parser's membership opener after a field's comparison operator.
 */
const MEMBERSHIP_LIST_OPEN = /^(?:not\s+in|in)\s*\[/i;

/**
 * The index just past the `[` of a membership list whose operator's colon
 * is at `colonIndex`, or null when no membership list opens there. The
 * whitespace the parser accepts between `in` and `[` lies inside it.
 */
function readMembershipOpenEnd(
  input: string,
  colonIndex: number
): number | null {
  const operator = readComparisonOperator(input, colonIndex);
  if (operator !== ':' && operator !== ':!=') {
    return null;
  }
  const start = colonIndex + operator.length;
  const opener = MEMBERSHIP_LIST_OPEN.exec(input.slice(start));
  return opener ? start + opener[0].length : null;
}

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
const FIELD_NAME = /^[A-Za-z_$][\w$.]*/;

/**
 * Characters Liqe accepts nowhere outside a literal.
 */
const REJECTED_SYNTAX_CHARACTER = /[&|;^~]/;

/**
 * A word that begins like a number: an optional sign or dot before a digit,
 * or nothing but signs and dots.
 */
const NUMERAL_LIKE_WORD = /^(?:[+-.]*\d|[+-.]+$)/;

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
 * followed by the end of the text, whitespace or a parenthesis. Where the
 * bracket rewrite closes a group (`groupEnds`), the text before the word is
 * a `)` to Liqe, so an `AND` or `OR` stands there too; it is not uppercased
 * after a bracket, so only the uppercase words count.
 */
function readLogicalOperator(
  input: string,
  index: number,
  groupEnds: number[] = []
): 'AND' | 'OR' | 'NOT' | null {
  const before = input[index - 1];
  if (
    before !== undefined &&
    !isLiqeWhitespace(before) &&
    !/[()]/.test(before)
  ) {
    if (!groupEnds.includes(index)) {
      return null;
    }
    const glued = /^(AND|OR)(?=$|[\s()])/.exec(input.slice(index));
    return glued ? (glued[1] as 'AND' | 'OR') : null;
  }
  const match = PATTERNS.LOGICAL_OPERATOR.exec(input.slice(index));
  if (!match) {
    return null;
  }
  return match[1].toUpperCase() as 'AND' | 'OR' | 'NOT';
}

/**
 * The syntax tokens of the text at bracket depth zero. A clause runs to
 * Liqe's whitespace or a parenthesis; a Unicode space is a value character
 * and stays inside it, as does the whitespace between `in` and `[`.
 */
function readSyntaxTokens(input: string, map: IQueryTextMap): ISyntaxToken[] {
  const tokens: ISyntaxToken[] = [];
  const groupEnds = readGroupEnds(input, map.isCode);
  let index = 0;
  while (index < input.length) {
    const char = input[index] ?? '';
    if (map.isCode[index] && map.depth[index] === 0) {
      if (isLiqeWhitespace(char)) {
        index += 1;
        continue;
      }
      if (char === '(' || char === ')') {
        const kind = char === '(' ? 'open' : 'close';
        tokens.push({ kind, start: index, end: index + 1 });
        index += 1;
        continue;
      }
      const word = readLogicalOperator(input, index, groupEnds);
      if (word) {
        tokens.push({ kind: word, start: index, end: index + word.length });
        index += word.length;
        continue;
      }
    }
    const end = readClauseEnd(input, map, index, groupEnds);
    tokens.push({ kind: 'clause', start: index, end });
    index = end;
  }
  return tokens;
}

/**
 * The end of the clause that begins at `start`: the next whitespace or
 * parenthesis at bracket depth zero, or the closer of a bracket span the
 * rewrite turns into a group, which is a `)` to Liqe.
 */
function readClauseEnd(
  input: string,
  map: IQueryTextMap,
  start: number,
  groupEnds: number[]
): number {
  let index = start;
  while (index < input.length) {
    if (index > start && groupEnds.includes(index)) {
      break;
    }
    const char = input[index] ?? '';
    const isSyntax = map.isCode[index] && map.depth[index] === 0;
    if (isSyntax && (isLiqeWhitespace(char) || char === '(' || char === ')')) {
      break;
    }
    const membershipEnd = isSyntax ? readMembershipOpenEnd(input, index) : null;
    index = membershipEnd ?? index + 1;
  }
  return Math.max(index, start + 1);
}

/**
 * An `AND` or `OR` needs a clause or group on each side (`NOT` may stand on
 * the right), a `NOT` needs a clause or group after it and cannot stack on
 * another `NOT`, a group cannot be empty, a `)` cannot come before its `(`,
 * and every `(` needs its `)`. Liqe rejects each of these. Parentheses
 * inside a bracket body are values the rewrite quotes, not groups.
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
  return depth !== 0;
}

/**
 * Every clause must name a field: Liqe reads a clause with no colon outside
 * its literals as an implicit-field expression, which the parser rejects,
 * or not at all. This reads positions, so a bare word, quoted phrase,
 * numeral or regex beside a clause Liqe cannot read before the parser's
 * rewrites (`open status:in[a]`, `x status:!=a`) is found as well.
 */
function hasFieldlessClause(input: string, map: IQueryTextMap): boolean {
  return readSyntaxTokens(input, map).some(
    token =>
      token.kind === 'clause' &&
      !hasSyntaxColon(input, map, token.start, token.end)
  );
}

function hasSyntaxColon(
  input: string,
  map: IQueryTextMap,
  start: number,
  end: number
): boolean {
  for (let index = start; index < end; index += 1) {
    if (map.isCode[index] && map.depth[index] === 0 && input[index] === ':') {
      return true;
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
 * The operator must be followed by a value: the end of the text, Liqe
 * whitespace or a parenthesis after it leaves a tag with no expression,
 * which the parser rejects for a quoted name as it does for a bare one.
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
    if (isValuelessOperator(input, index)) {
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
 * parser rejects: `open`, `open done`, `"hello world"` and `""`. A text
 * Liqe reads two ways (`name:/foo/ AND status:/bar/`) is rejected by the
 * parser as well. Both are read from the text the parser's rewrites hand
 * Liqe, not from the same-length stand-in: the stand-in replaces a bracket
 * group by opaque text, so two regex members whose group Liqe reads two
 * ways (`b:[,//,////]` is `(b:// OR b:////)`) can only be decided by the
 * rewrite itself, as can a lowercase `and` the typed text keeps inside an
 * unclosed regex while the rewritten text closes it earlier
 * (`r:!=///// and $:b`). A Liqe syntax error decides nothing here; the
 * other checks cover those shapes. A numeral the parser rejects before
 * Liqe is left to the numeral check.
 */
function hasImplicitFieldTerm(input: string): boolean {
  const rewritten = readParserText(input);
  if (rewritten === null) {
    return false;
  }
  const reading = readLiqe(rewritten);
  if (reading.isAmbiguous) {
    return true;
  }
  return reading.ast !== null && hasImplicitField(reading.ast);
}

/**
 * The text the parser hands Liqe for `input`, or null when the parser
 * rejects a numeral before Liqe sees it.
 */
function readParserText(input: string): string | null {
  try {
    return rewriteQueryForLiqe(input);
  } catch {
    return null;
  }
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
 * A Unicode space outside quotes and outside every value is a value
 * character to Liqe and never a separator: `\u00a0status:open` and
 * `status:open AND\u2003label:x` are syntax errors. Inside a value, after
 * a field's operator, it is part of the value; the whitespace the parser
 * accepts between `in` and `[` is skipped.
 */
function hasUncoveredUnicodeSpace(input: string, map: IQueryTextMap): boolean {
  let index = 0;
  while (index < input.length) {
    if (!map.isCode[index] || map.depth[index] !== 0) {
      index += 1;
      continue;
    }
    const membershipEnd = readMembershipOpenEnd(input, index);
    if (membershipEnd !== null) {
      index = membershipEnd;
      continue;
    }
    if (
      UNICODE_SPACE.test(input[index] ?? '') &&
      !isInsideValue(input, map, index)
    ) {
      return true;
    }
    index += 1;
  }
  return false;
}

/**
 * `&`, `|`, `;`, `^` and `~` are neither operators nor value characters to
 * Liqe, so one outside a literal is a syntax error wherever it stands. A
 * `!` is only accepted as the one in `:!=`, which the parser rewrites. A `?`
 * is a wildcard inside a value and a syntax error anywhere else.
 */
function hasBareSymbol(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!map.isCode[index] || map.depth[index] !== 0) {
      continue;
    }
    const char = input[index] ?? '';
    if (REJECTED_SYNTAX_CHARACTER.test(char)) {
      return true;
    }
    if (char === '!' && !isNotEqualsBang(input, index)) {
      return true;
    }
    if (char === '?' && !isInsideValue(input, map, index)) {
      return true;
    }
  }
  return false;
}

function isNotEqualsBang(input: string, index: number): boolean {
  return input[index - 1] === ':' && input[index + 1] === '=';
}

/**
 * Whether the character at `index` stands inside a value: a field's colon
 * comes before it in the same word, the run of characters back to the
 * start of the text, Liqe whitespace, a parenthesis or a literal.
 */
function isInsideValue(
  input: string,
  map: IQueryTextMap,
  index: number
): boolean {
  let start = index;
  while (start > 0 && isWordCharacterAt(input, map, start - 1)) {
    start -= 1;
  }
  return hasSyntaxColon(input, map, start, index);
}

function isWordCharacterAt(
  input: string,
  map: IQueryTextMap,
  index: number
): boolean {
  const char = input[index] ?? '';
  if (map.isCode[index] !== true) {
    return false;
  }
  if (map.depth[index] > 0) {
    return true;
  }
  return !isLiqeWhitespace(char) && !/[()]/.test(char);
}

/**
 * Liqe's `NOT` and minus each take one tag or, for `NOT`, one group. After
 * a `NOT` operator and Liqe whitespace, or directly after a clause-leading
 * minus, another `NOT`, a minus, or a field followed by `:!=` (which the
 * parser rewrites to `NOT field:`) stacks two negations, which Liqe
 * rejects. A parenthesis is not skipped, so `NOT (NOT a:1)` is complete.
 */
function hasStackedNegation(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!map.isCode[index] || map.depth[index] !== 0) {
      continue;
    }
    if (readLogicalOperator(input, index) === 'NOT') {
      let next = index + 3;
      while (isLiqeWhitespace(input[next])) {
        next += 1;
      }
      if (next > index + 3 && startsNegation(input, map, next)) {
        return true;
      }
    } else if (
      input[index] === '-' &&
      startsMinusNegation(input, map, index) &&
      startsNegation(input, map, index + 1)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a negation begins at `index`: a `NOT` word, a minus, or a field
 * (bare or closed quoted) followed by `:!=`.
 */
function startsNegation(
  input: string,
  map: IQueryTextMap,
  index: number
): boolean {
  if (input[index] === '-' || /^NOT(?=$|[\s()])/i.test(input.slice(index))) {
    return true;
  }
  const quoted = map.literals.find(
    literal =>
      literal.start === index && literal.kind === 'string' && literal.closed
  );
  if (quoted) {
    return input.startsWith(':!=', quoted.end);
  }
  const name = FIELD_NAME.exec(input.slice(index));
  return name !== null && input.startsWith(':!=', index + name[0].length);
}

/**
 * The parser spells `+1`, `1.`, `.5` and exponents into Liqe's decimal and
 * rejects an integer outside the signed 64-bit range or an exponent that
 * underflows to zero; any other word that starts like a number is a Liqe
 * syntax error. Membership members are read with `Number`, so a wide
 * integer inside `in[...]` is not rejected there.
 */
function hasBrokenNumeral(input: string, map: IQueryTextMap): boolean {
  try {
    spellNumerals(input);
  } catch {
    return true;
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!map.isCode[index] || map.depth[index] !== 0 || input[index] !== ':') {
      continue;
    }
    const word = readValueWordAfterOperator(input, map, index);
    if (word !== null && isBrokenNumeralWord(word)) {
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
      return written.some(
        token => isPlainInteger(token) && isUnstorableInteger(token)
      );
    },
    map.isCode
  );
}

function isBrokenNumeralWord(word: string): boolean {
  if (NUMERAL_LIKE_WORD.test(word) && !isSpelledNumeral(word)) {
    return true;
  }
  return isPlainInteger(word) && isUnstorableInteger(word);
}

/**
 * The unquoted word after the comparison operator whose colon is at
 * `colonIndex`, up to Liqe whitespace, a parenthesis or the end of the text.
 * Null when no word follows, or when it begins a literal, a bracket, or a
 * membership list, which other checks read.
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

/**
 * A closed quote directly followed by the same quote leaves a stray quote
 * Liqe rejects (`"a""b"` is not `a"b`), and a quoted backslash sequence
 * outside Liqe's escapes is a syntax error (`"a\q"` is not `aq`).
 */
function hasRejectedQuote(input: string, map: IQueryTextMap): boolean {
  return map.literals.some(
    literal =>
      literal.kind === 'string' &&
      literal.closed &&
      (input[literal.end] === input[literal.start] ||
        hasRejectedEscape(input, literal))
  );
}

/**
 * Liqe's regex body is any character but a backslash, or a backslash and
 * one such character, so two backslashes in a row never stand inside a
 * regex Liqe reads: `l:/\\/` is a syntax error while `l:/\//` and `l:"\\"`
 * parse. The scan that closes a regex where Liqe cannot read the text
 * pairs `\\` as an escape, so a regex that reaches Liqe as one, at bracket
 * depth zero or as a list member written back as typed, is read here. A
 * quoted bound, a membership member and a member the rewrite quotes reach
 * Liqe as strings, whose escapes the quote check reads.
 */
function hasRejectedRegexEscape(input: string, map: IQueryTextMap): boolean {
  const hasRegexLiteral = map.literals.some(
    literal =>
      literal.kind === 'regex' &&
      map.depth[literal.start] === 0 &&
      input.slice(literal.start, literal.end).includes('\\\\')
  );
  return (
    hasRegexLiteral ||
    someBracketExpression(
      input,
      span =>
        isListBody(span) &&
        splitListMembers(span.body).some(
          member =>
            writesBackUnquoted(member) &&
            member.startsWith('/') &&
            member.includes('\\\\')
        ),
      map.isCode
    )
  );
}

/**
 * Liqe's string characters exclude a line feed, so a quoted value, member,
 * bound or field name holding one is a syntax error. A regex body keeps it.
 */
function hasQuotedLineFeed(input: string, map: IQueryTextMap): boolean {
  return map.literals.some(
    literal =>
      literal.kind === 'string' &&
      input.slice(literal.start, literal.end).includes('\n')
  );
}

/**
 * Liqe's implicit operator needs whitespace between two clauses or groups,
 * `NOT` needs whitespace before its operand, and a minus takes a tag, never
 * a group. `AND` and `OR` may touch a group: on their right always, on
 * their left only when that group is the whole left operand, so
 * `(a:1)AND(b:2)` parses while `(a:1)AND(b:2)AND(c:3)` and `x:1 (a:1)AND
 * (b:2)` do not. A `(` must therefore follow the start, Liqe whitespace,
 * `(` or an `AND`/`OR`, and a `)` must be followed by the end, Liqe
 * whitespace, `)`, or an `AND`/`OR` when its `(` begins the operand. The
 * group the bracket rewrite emits for a list or a two-sided range is one
 * such group, so a clause-leading minus before `status:[a, b]` reaches
 * Liqe as `-(`, which it rejects, while `NOT status:[a, b]` is `NOT (`;
 * `status:!=[a, b]` reaches Liqe as `NOT (status:a OR status:b)`, so its
 * group never begins its operand and `status:!=[a, b]AND(x:1)` is glued.
 */
function hasGluedParenthesis(input: string, map: IQueryTextMap): boolean {
  const groupEnds = readGroupEnds(input, map.isCode);
  const tokens = readSyntaxTokens(input, map);
  const openers: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'open') {
      if (!separatesBeforeGroup(input, map, token.start, groupEnds)) {
        return true;
      }
      openers.push(index);
    } else if (token.kind === 'close') {
      const opener = openers.pop();
      const openStart = opener === undefined ? 0 : tokens[opener].start;
      const beginsOperand = beginsOperandAt(input, map, openStart);
      if (!separatesAfterGroup(input, token.end, groupEnds, beginsOperand)) {
        return true;
      }
      if (
        opener !== undefined &&
        followsGluedOperator(input, openStart, groupEnds) &&
        !holdsOneOperand(tokens.slice(opener + 1, index))
      ) {
        return true;
      }
    }
  }
  return someBracketExpression(
    input,
    span => {
      if (!emitsGroup(span)) {
        return false;
      }
      const isAfterMinus =
        input[span.start - 1] === '-' &&
        startsMinusNegation(input, map, span.start - 1);
      const beginsOperand =
        span.operator !== ':!=' && beginsOperandAt(input, map, span.start);
      return (
        isAfterMinus ||
        !separatesAfterGroup(input, span.end, groupEnds, beginsOperand)
      );
    },
    map.isCode
  );
}

function separatesBeforeGroup(
  input: string,
  map: IQueryTextMap,
  index: number,
  groupEnds: number[]
): boolean {
  if (index === 0) {
    return true;
  }
  const before = input[index - 1] ?? '';
  if (map.isCode[index - 1] && (isLiqeWhitespace(before) || before === '(')) {
    return true;
  }
  return followsGluedOperator(input, index, groupEnds);
}

/**
 * Whether an `AND` or `OR` the parser reads as an operator ends exactly at
 * `index`, glued to what follows.
 */
function followsGluedOperator(
  input: string,
  index: number,
  groupEnds: number[]
): boolean {
  return [3, 2].some(length => {
    if (index < length) {
      return false;
    }
    const word = readLogicalOperator(input, index - length, groupEnds);
    return word !== null && word !== 'NOT' && word.length === length;
  });
}

/**
 * Whether the tokens inside a group are one operand to Liqe: one clause, or
 * one nested group, either after a `NOT`. A group glued to the `AND` or
 * `OR` before it may hold nothing else (`s:a AND(y:D)` parses, `s:a
 * AND(y:D l:a)` does not); with whitespace before it, any group may follow.
 */
function holdsOneOperand(content: ISyntaxToken[]): boolean {
  const operand = content[0]?.kind === 'NOT' ? content.slice(1) : content;
  const first = operand[0];
  if (first === undefined) {
    return false;
  }
  if (operand.length === 1) {
    return first.kind === 'clause';
  }
  let depth = 0;
  for (let index = 0; index < operand.length; index += 1) {
    const kind = operand[index].kind;
    depth += kind === 'open' ? 1 : kind === 'close' ? -1 : 0;
    if (depth === 0) {
      return first.kind === 'open' && index === operand.length - 1;
    }
  }
  return false;
}

/**
 * Whether a group that ends just before `end` may be followed by what
 * stands at `end`: the end of the text, Liqe whitespace, `)`, or an
 * `AND`/`OR` glued to it when the group begins its operand.
 */
function separatesAfterGroup(
  input: string,
  end: number,
  groupEnds: number[],
  beginsOperand: boolean
): boolean {
  const after = input[end];
  if (after === undefined || isLiqeWhitespace(after) || after === ')') {
    return true;
  }
  const word = readLogicalOperator(input, end, groupEnds);
  return (word === 'AND' || word === 'OR') && beginsOperand;
}

/**
 * Whether the group whose `(` stands at `openIndex` begins its operand: the
 * start of the text or an enclosing `(` and whitespace precede it.
 */
function beginsOperandAt(
  input: string,
  map: IQueryTextMap,
  openIndex: number
): boolean {
  let before = openIndex - 1;
  while (before >= 0 && map.isCode[before] && isLiqeWhitespace(input[before])) {
    before -= 1;
  }
  return before < 0 || (map.isCode[before] === true && input[before] === '(');
}

/**
 * A clause-leading minus must touch a tag; one followed by whitespace, the
 * end of the text or a parenthesis negates nothing and Liqe rejects it. A
 * minus after `:`, `>`, `[` or `,` is part of a value.
 */
function hasLoneMinus(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (
      map.isCode[index] &&
      map.depth[index] === 0 &&
      input[index] === '-' &&
      startsMinusNegation(input, map, index)
    ) {
      const after = input[index + 1];
      if (
        after === undefined ||
        isLiqeWhitespace(after) ||
        /[()]/.test(after)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A carriage return, or any other ASCII control character that is not Liqe
 * whitespace, parses nowhere outside a literal or a bracket body. The
 * whitespace the parser accepts between `in` and `[` is skipped.
 */
function hasControlCharacter(input: string, map: IQueryTextMap): boolean {
  let index = 0;
  while (index < input.length) {
    if (!map.isCode[index] || map.depth[index] !== 0) {
      index += 1;
      continue;
    }
    const membershipEnd = readMembershipOpenEnd(input, index);
    if (membershipEnd !== null) {
      index = membershipEnd;
      continue;
    }
    if (isRejectedControlCharacter(input[index] ?? '')) {
      return true;
    }
    index += 1;
  }
  return false;
}

/**
 * A list member the rewrite writes back unquoted reaches Liqe as typed, so
 * `[AND]`, `[1x]` and `[a"b"]` are syntax errors. Operator words are
 * uppercased first, as the parser does, so `[ and ]` is `AND` while
 * `[and]` stays the value `and`. The one member of a list with text glued
 * to its closer reaches Liqe joined to that text, which the glued-tail
 * check reads (`[AND]x` is `ANDx`).
 */
function hasRejectedListWord(input: string, map: IQueryTextMap): boolean {
  const uppercased = uppercaseBooleanOperators(input);
  return someBracketExpression(
    uppercased,
    span =>
      isListBody(span) &&
      !isJoinedToTail(uppercased, map, span) &&
      splitListMembers(span.body).some(
        member => writesBackUnquoted(member) && isRejectedValueWord(member)
      ),
    map.isCode
  );
}

/**
 * Whether the rewrite writes the span's one member or bound back unquoted
 * with text glued to the closer, so Liqe reads them as one word, which the
 * glued-tail check judges.
 */
function isJoinedToTail(
  input: string,
  map: IQueryTextMap,
  span: IBracketExpressionSpan
): boolean {
  return (
    readUnquotedRewrite(span) !== null &&
    readWordAt(input, map, span.end).length > 0
  );
}

/**
 * The parser lifts a membership list out as a quoted placeholder and puts
 * the clause back where Liqe reads that placeholder; when a regex Liqe
 * reads swallows the placeholder (`f:[//]x:in[]/` is one regex to Liqe),
 * the clause has nowhere to go and the parser throws.
 */
function hasSwallowedMembership(input: string, map: IQueryTextMap): boolean {
  // Only a list the bracket rewrite reached, outside the literals of the
  // text it walked, was lifted; one inside a regex there stays as typed.
  const rewriteMap = mapQueryText(input, map.rewriteText, map.rewriteText);
  return someBracketExpression(
    input,
    span =>
      span.kind === 'membership' && map.isCode[span.bodyStart - 1] === false,
    rewriteMap.isCode
  );
}

/**
 * The parser writes a regex list member back as typed and requires Liqe to
 * read a regex literal beginning there; when a regex Liqe reads from the
 * text before the list swallows the member (`x://T:[//]` is `x://T://`,
 * one regex to Liqe), the parser throws. The stray-bracket check reports
 * the closer when that regex ends before it; this reports the list when
 * the regex runs on past it (`x:[//]T:[//]/`).
 */
function hasSwallowedRegexMember(input: string, map: IQueryTextMap): boolean {
  const rewriteMap = mapQueryText(input, map.rewriteText, map.rewriteText);
  return someBracketExpression(
    input,
    span => holdsRegexMember(span) && map.isCode[span.bodyStart - 1] === false,
    rewriteMap.isCode
  );
}

/**
 * Whether a list has a member the rewrite writes back unquoted that begins
 * with a slash, which Liqe must then read as a regex literal.
 */
function holdsRegexMember(span: IBracketExpressionSpan): boolean {
  return (
    isListBody(span) &&
    splitListMembers(span.body).some(
      member => writesBackUnquoted(member) && member.startsWith('/')
    )
  );
}

/**
 * A bracket member or bound copied as written with a tail glued to its
 * literal is a syntax error (`status:["a"b]`, `status:[/a/b]`), unless it
 * is the one regex member of a list with text glued to the closer, which
 * Liqe reads joined to that text (`status:[//2]/` is `status://2/`).
 */
function hasCopiedMember(input: string, map: IQueryTextMap): boolean {
  return someBracketExpression(
    input,
    span =>
      isCopiedBracketMember(span) &&
      !(
        isJoinedToTail(input, map, span) &&
        (readUnquotedRewrite(span)?.startsWith('/') ?? false)
      ),
    map.isCode
  );
}

/**
 * Whether an unquoted word Liqe reads as a value is one it refuses: exactly
 * an operator word, or neither its unquoted value nor a numeral the parser
 * spells. A word that begins a literal or a bracket is left to its own
 * check.
 */
function isRejectedValueWord(word: string): boolean {
  if (/^["'/[{]/.test(word)) {
    return false;
  }
  if (LIQE_KEYWORD_VALUE.test(word)) {
    return true;
  }
  return !LIQE_UNQUOTED_VALUE.test(word) && !isSpelledNumeral(word);
}

/**
 * A closed quote or regex must be followed by the end of the text, Liqe
 * whitespace or `)`; a quoted string may also be a field name, so `:` is
 * accepted after it. Anything else glued to the literal (`status:"a"b`,
 * `status:/a/ib`) is a syntax error. A literal inside a bracket body stays
 * on the parser's rewrite, but text glued to the bracket's closer reaches
 * Liqe glued to what the rewrite wrote: a quoted placeholder or value
 * (`status:in[a]b`, `status:["a"]b`, `status:[a TO *]b`), which is a
 * syntax error, or one unquoted member or numeric bound, which Liqe reads
 * joined to the tail (`status:[a]b` is `status:ab`, `status:[1]x` is
 * `status:1x`). A group's closer is read as a `)` by the syntax tokens.
 */
function hasGluedLiteralTail(input: string, map: IQueryTextMap): boolean {
  const hasQuoteTail = map.literals.some(literal => {
    if (!literal.closed || map.depth[literal.start] !== 0) {
      return false;
    }
    const after = input[literal.end];
    if (after === undefined || isLiqeWhitespace(after) || after === ')') {
      return false;
    }
    return !(literal.kind === 'string' && after === ':');
  });
  return (
    hasQuoteTail ||
    hasGluedRangeTail(input, map.isCode) ||
    someBracketExpression(
      input,
      span => {
        const after = input[span.end];
        if (after === undefined || isLiqeWhitespace(after) || after === ')') {
          return false;
        }
        if (span.kind === 'membership') {
          return true;
        }
        if (span.kind === 'rejected' || emitsGroup(span)) {
          return false;
        }
        const written = readUnquotedRewrite(span);
        if (written === null) {
          return true;
        }
        const tail = readWordAt(input, map, span.end);
        return isRejectedJoinedValue(spellWrittenValue(written), tail);
      },
      map.isCode
    )
  );
}

/**
 * The spelling the parser hands Liqe for a bracket member it writes back
 * unquoted: a numeral is spelled first, so `[.5]` is `0.5`.
 */
function spellWrittenValue(written: string): string {
  if (!SPELLED_NUMERAL.test(written)) {
    return written;
  }
  try {
    return spellNumeralToken(written);
  } catch {
    return written;
  }
}

/**
 * Whether Liqe rejects the value it reads when `tail` is glued to the
 * unquoted `written` text: a regex must still be one closed literal with
 * only flags after it, and any other word must be Liqe's value or decimal.
 */
function isRejectedJoinedValue(written: string, tail: string): boolean {
  const joined = written + tail;
  if (joined.startsWith('/')) {
    const literal = readLiteralAt(joined, 0);
    return !(literal.closed && literal.end === joined.length);
  }
  return /^["']/.test(joined) || isRejectedValueWord(joined);
}

/**
 * A quote or regex must begin where Liqe lets a field or value begin: the
 * start of the text, Liqe whitespace, `(`, a clause-leading minus, or the
 * end of a comparison operator. One glued to the text before it
 * (`status:a"b"`, `NOT"a"`, `status:[a]/b/`, `ab"c"`) is a syntax error.
 * A slash glued to the closer of a list whose one member is a regex
 * written back as typed continues that regex (`x:[//]/` is `x:///`), which
 * the glued-tail check reads joined.
 */
function hasGluedLiteralStart(input: string, map: IQueryTextMap): boolean {
  return map.literals.some(
    literal =>
      map.depth[literal.start] === 0 &&
      !separatesBeforeField(input, map, literal.start) &&
      !endsComparisonOperator(input, map, literal.start) &&
      !continuesRegexMember(input, map, literal.start)
  );
}

function continuesRegexMember(
  input: string,
  map: IQueryTextMap,
  index: number
): boolean {
  return someBracketExpression(
    input,
    span =>
      span.end === index &&
      (readUnquotedRewrite(span)?.startsWith('/') ?? false),
    map.isCode
  );
}

/**
 * Whether a comparison operator ends at `index`: a colon at bracket depth
 * zero stands at most five characters before it, and the operator the
 * parser reads there reaches `index`.
 */
function endsComparisonOperator(
  input: string,
  map: IQueryTextMap,
  index: number
): boolean {
  for (let colon = index - 1; colon >= 0 && colon >= index - 5; colon -= 1) {
    if (!map.isCode[colon] || map.depth[colon] !== 0) {
      continue;
    }
    const operator = readComparisonOperator(input, colon);
    if (operator !== null && colon + operator.length === index) {
      return true;
    }
  }
  return false;
}

/**
 * The unquoted word after a comparison operator must be Liqe's value or a
 * numeral the parser spells, and not an operator word; a bare token that
 * starts like a number must be a numeral. `a%b`, `-x`, `a=b`, `1x`, `2nd`,
 * `a"b"` and `status:AND` are syntax errors.
 */
function hasRejectedValueWord(input: string, map: IQueryTextMap): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!map.isCode[index] || map.depth[index] !== 0) {
      continue;
    }
    if (input[index] === ':') {
      const word = readValueWordAfterOperator(input, map, index);
      if (word !== null && isRejectedValueWord(word)) {
        return true;
      }
    } else if (
      separatesBeforeField(input, map, index) &&
      NUMERAL_LIKE_WORD.test(input.slice(index))
    ) {
      const word = readWordAt(input, map, index);
      if (!isSpelledNumeral(word)) {
        return true;
      }
    }
  }
  return false;
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
