/**
 * Quote- and regex-aware scanning for query text.
 *
 * Structural checks (parentheses, boolean words, brackets) must ignore
 * characters that live inside string or regex literals. Liqe treats `/.../`
 * as a regex value and quotes as literals; counting those characters as
 * syntax changes the meaning of a query the parser has already accepted.
 *
 * Liqe's regex body may itself contain `/`, so the span of a regex is
 * whatever makes the whole text parse. When Liqe reads the text one way,
 * its `RegexExpression` spans are the literals; `name:/foo/) AND
 * status:/bar/` is one regex. When Liqe rejects the text, or reads it two
 * ways, the local scan closes a regex at the first slash outside a
 * character class such as `[/]`. The pattern is only ever read as text and
 * is never compiled or executed here.
 */

import { parse as liqeParse } from 'liqe';
import type { LiqeQuery } from 'liqe';

/**
 * A span of query text that is either raw syntax or one literal.
 */
export interface ILiteralSpan {
  /**
   * `none` when `start` is not the beginning of a literal.
   */
  kind: 'string' | 'regex' | 'none';
  /**
   * Index just past the literal, or `start` when `kind` is `none`.
   */
  end: number;
  /**
   * Whether a string or regex literal found its closing delimiter.
   */
  closed: boolean;
}

/**
 * Parentheses and quotes that belong to the query syntax, not to literals.
 */
export interface IQueryDelimiterMeasure {
  openParentheses: number;
  closeParentheses: number;
  maxParenthesisDepth: number;
  unclosedQuote: { quote: '"' | "'"; position: number } | null;
  hasUnclosedRegex: boolean;
}

interface IQueryTextSegment {
  kind: 'code' | 'string' | 'regex';
  text: string;
  start: number;
  closed: boolean;
}

/**
 * One literal found while mapping query text.
 */
export interface ILiteralAt {
  start: number;
  end: number;
  kind: 'string' | 'regex';
  closed: boolean;
}

/**
 * Which characters of a query are syntax, how deeply each sits inside
 * `[`/`{` brackets, and where its literals are. Completeness checks walk
 * this map instead of re-reading literals.
 */
export interface IQueryTextMap {
  /**
   * True at an index that is syntax rather than part of a literal.
   */
  isCode: boolean[];
  /**
   * Number of `[` or `{` still open before the character at each index, so
   * an opener itself sits at the depth outside it.
   */
  depth: number[];
  /**
   * Every literal, in order.
   */
  literals: ILiteralAt[];
}

/**
 * How Liqe reads a text: its AST when the text has exactly one parse,
 * whether the failure was `Ambiguous results.`, and the regex spans of the
 * unique parse, filled in on first use.
 */
export interface ILiqeReading {
  ast: LiqeQuery | null;
  isAmbiguous: boolean;
  regexSpans: Map<number, number> | null;
}

const LIQE_READING_CACHE_LIMIT = 32;
const liqeReadings = new Map<string, ILiqeReading>();

/**
 * Parse `input` with Liqe, remembering the outcome. The parser's own
 * preprocessing and the completeness checks read the same few texts many
 * times, once per index, so the cache keeps the Earley parse to one run per
 * text. Nothing in the result is executed; a regex stays its source text.
 *
 * @param input Text as Liqe would receive it
 * @returns The unique AST, or null with `isAmbiguous` set when Liqe found two parses
 */
export function readLiqe(input: string): ILiqeReading {
  const cached = liqeReadings.get(input);
  if (cached) {
    return cached;
  }
  let reading: ILiqeReading;
  try {
    reading = { ast: liqeParse(input), isAmbiguous: false, regexSpans: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reading = {
      ast: null,
      isAmbiguous: message === 'Ambiguous results.',
      regexSpans: null
    };
  }
  if (liqeReadings.size >= LIQE_READING_CACHE_LIMIT) {
    liqeReadings.clear();
  }
  liqeReadings.set(input, reading);
  return reading;
}

/**
 * Whether `char` is whitespace to Liqe: tab, line feed, vertical tab, form
 * feed or a space. A carriage return and every Unicode space are not.
 *
 * @param char One character, or undefined past the end of the text
 * @returns True for Liqe's five whitespace characters
 */
export function isLiqeWhitespace(char: string | undefined): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\v' ||
    char === '\f'
  );
}

/**
 * Uppercase `and`, `or` and `not` where they stand as operator words:
 * bounded by the start or end of the text, whitespace or a parenthesis, and
 * outside every literal. Liqe only recognizes the uppercase words. This is
 * the parser's normalization, shared so the search box reads the text the
 * parser hands to Liqe.
 *
 * @param input Query text
 * @returns The text with operator words uppercased
 *
 * @example
 * ```typescript
 * uppercaseBooleanOperators('a:1 and not.b:2'); // 'a:1 AND not.b:2'
 * ```
 */
export function uppercaseBooleanOperators(input: string): string {
  return transformCodeSegments(input, code =>
    code.replace(/(?<![^\s()])\b(and|or|not)\b(?![^\s()])/gi, match =>
      match.toUpperCase()
    )
  );
}

/**
 * Read a string or regex literal that begins at `start`.
 *
 * @param input Query text
 * @param start Index to inspect
 * @returns The literal span, or `{ kind: 'none', end: start }` when `start` is syntax
 */
export function readLiteralAt(input: string, start: number): ILiteralSpan {
  const quote = input[start];
  if (quote === '"' || quote === "'") {
    return readStringLiteral(input, start, quote);
  }
  if (quote === '/') {
    return readRegexLiteral(input, start);
  }
  return { kind: 'none', end: start, closed: true };
}

let lastMappedText: string | null = null;
let lastTextMap: IQueryTextMap | null = null;

/**
 * Map which characters of `input` are syntax, their bracket depth, and the
 * literals. The last map is kept, since every completeness check walks the
 * same text.
 *
 * @param input Query text
 * @returns The map
 */
export function mapQueryText(input: string): IQueryTextMap {
  if (lastTextMap && lastMappedText === input) {
    return lastTextMap;
  }
  const isCode: boolean[] = new Array<boolean>(input.length).fill(true);
  const depth: number[] = new Array<number>(input.length).fill(0);
  const literals: ILiteralAt[] = [];
  let index = 0;
  let open = 0;
  while (index < input.length) {
    const literal = readLiteralAt(input, index);
    if (literal.kind !== 'none') {
      literals.push({
        start: index,
        end: literal.end,
        kind: literal.kind,
        closed: literal.closed
      });
      for (let inside = index; inside < literal.end; inside += 1) {
        isCode[inside] = false;
        depth[inside] = open;
      }
      index = literal.end;
      continue;
    }
    depth[index] = open;
    open = nextBracketDepth(open, input[index] ?? '');
    index += 1;
  }
  lastMappedText = input;
  lastTextMap = { isCode, depth, literals };
  return lastTextMap;
}

/**
 * The bracket depth after reading `char` at `depth`. Only `[` and `{` open
 * and `]` and `}` close; a stray closer never goes below zero.
 *
 * @param depth Depth before the character
 * @param char The character
 * @returns Depth after it
 */
export function nextBracketDepth(depth: number, char: string): number {
  if (char === '[' || char === '{') {
    return depth + 1;
  }
  if (char === ']' || char === '}') {
    return Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * Measure parentheses and unclosed literals, ignoring text inside literals.
 *
 * @param input Query text
 * @returns Counts a security check can compare to the parsed AST
 */
export function measureQueryDelimiters(input: string): IQueryDelimiterMeasure {
  const segments = segmentQueryText(input);
  let openParentheses = 0;
  let closeParentheses = 0;
  let depth = 0;
  let maxParenthesisDepth = 0;
  let unclosedQuote: { quote: '"' | "'"; position: number } | null = null;
  let hasUnclosedRegex = false;
  for (const segment of segments) {
    if (segment.kind === 'string' && !segment.closed && !unclosedQuote) {
      const quote = segment.text[0];
      if (quote === '"' || quote === "'") {
        unclosedQuote = { quote, position: segment.start };
      }
    }
    if (segment.kind === 'regex' && !segment.closed) {
      hasUnclosedRegex = true;
    }
    if (segment.kind !== 'code') {
      continue;
    }
    for (const char of segment.text) {
      if (char === '(') {
        openParentheses += 1;
        depth += 1;
        if (depth > maxParenthesisDepth) {
          maxParenthesisDepth = depth;
        }
      } else if (char === ')') {
        closeParentheses += 1;
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return {
    openParentheses,
    closeParentheses,
    maxParenthesisDepth,
    unclosedQuote,
    hasUnclosedRegex
  };
}

/**
 * Apply `transform` only to syntax characters, leaving literals unchanged.
 *
 * @param input Query text
 * @param transform Function invoked with each raw syntax slice
 * @returns The query with syntax slices replaced and literals copied through
 */
export function transformCodeSegments(
  input: string,
  transform: (code: string) => string
): string {
  return segmentQueryText(input)
    .map(segment =>
      segment.kind === 'code' ? transform(segment.text) : segment.text
    )
    .join('');
}

/**
 * Split a bracket-list body into its members at the commas that are not
 * inside a string or regex literal. A quote runs to its match, with a
 * backslash escaping the next character; an unclosed quote or regex runs to
 * the end of the body. Members are trimmed and empty members dropped. The
 * parser's bracket and membership rewrites split with this function, so a
 * regex literal whose body holds a comma stays one member.
 *
 * @param body Text between the brackets
 * @returns The members, in order
 *
 * @example
 * ```typescript
 * splitListMembers('a, "b,c", /d,e/'); // ['a', '"b,c"', '/d,e/']
 * ```
 */
export function splitListMembers(body: string): string[] {
  const members: string[] = [];
  let memberStart = 0;
  let index = 0;
  const pushMember = (end: number): void => {
    const member = body.slice(memberStart, end).trim();
    if (member.length > 0) {
      members.push(member);
    }
  };
  while (index < body.length) {
    const literal = readLiteralAt(body, index);
    if (literal.kind !== 'none') {
      index = literal.end;
      continue;
    }
    if (body[index] === ',') {
      pushMember(index);
      memberStart = index + 1;
    }
    index += 1;
  }
  pushMember(body.length);
  return members;
}

/**
 * Whether a trimmed, unquoted range bound is the keyword `null`. No engine
 * orders a column against null, so the bracket rewrite leaves such a range
 * to Liqe, which rejects it, instead of comparing with the text `"null"`.
 *
 * @param bound One side of a `[min TO max]` range, trimmed
 * @returns True for the bare word `null`
 */
export function isRejectedNullRangeBound(bound: string): boolean {
  return bound === 'null';
}

/**
 * Whether a trimmed, unquoted range bound is the keyword `true` or `false`.
 * The bracket rewrite leaves such a range to Liqe, which rejects it, instead
 * of comparing with the texts `"true"` and `"false"`.
 *
 * @param bound One side of a `[min TO max]` range, trimmed
 * @returns True for the bare word `true` or `false`
 */
export function isBooleanRangeEndpoint(bound: string): boolean {
  return bound === 'true' || bound === 'false';
}

/**
 * A `field:[...]`, `field:{...}` or `field:in[...]` span, read the way the
 * parser's bracket rewrite reads it.
 */
export interface IBracketExpressionSpan {
  /**
   * Index of the field's first character.
   */
  start: number;
  /**
   * Index just past the closing bracket.
   */
  end: number;
  /**
   * The field as written, quoted or bare.
   */
  field: string;
  /**
   * `membership` for `in[...]` and `not in[...]`, `bracket` for a plain
   * opener, and `rejected` when the rewrite leaves the text to Liqe: an
   * opener with no closer, or a membership list whose closer is not `]`.
   */
  kind: 'membership' | 'bracket' | 'rejected';
  opener: string;
  closer: string;
  /**
   * Text between the brackets.
   */
  body: string;
  /**
   * Index of the body's first character.
   */
  bodyStart: number;
}

/**
 * Read the bracket expression the parser's rewrite would consume at
 * `index`: a field no name character precedes, a colon, then either the
 * membership operator and a `[`, or a `[` or `{` opener, through the
 * matching closer. A membership list whose closer is not `]` is not a span.
 *
 * @param input Query text
 * @param index Index where a field might begin
 * @returns The span, or null when no bracket expression begins here
 */
export function readBracketExpression(
  input: string,
  index: number
): IBracketExpressionSpan | null {
  if (followsNameCharacter(input, index)) {
    return null;
  }
  const field = readBracketFieldToken(input, index);
  if (!field || input[field.end] !== ':') {
    return null;
  }
  // `field:!=[...]` is rewritten to `NOT field:[...]` before the bracket
  // rewrite, so the not-equals operator may stand before the opener.
  const operatorEnd = input.startsWith(':!=', field.end)
    ? field.end + 3
    : field.end + 1;
  const membership = MEMBERSHIP_OPENER.exec(input.slice(operatorEnd));
  const kind = membership ? 'membership' : 'bracket';
  const openerIndex = operatorEnd + (membership ? membership[0].length : 0);
  const opener = input[openerIndex] ?? '';
  if (opener !== '[' && opener !== '{') {
    return null;
  }
  const closeIndex = readBracketEnd(input, openerIndex);
  const closer = closeIndex === null ? '' : (input[closeIndex] ?? '');
  const isRejected =
    closeIndex === null || (kind === 'membership' && closer !== ']');
  return {
    start: index,
    end: closeIndex === null ? openerIndex + 1 : closeIndex + 1,
    field: field.text,
    kind: isRejected ? 'rejected' : kind,
    opener,
    closer,
    body: closeIndex === null ? '' : input.slice(openerIndex + 1, closeIndex),
    bodyStart: openerIndex + 1
  };
}

/**
 * Whether the rewrite would leave a closed bracket body in place for Liqe,
 * which rejects it: a body of only whitespace; a range (no comma, one
 * ` TO `) with a `null` or boolean bound, both bounds `*`, or an empty
 * bound; or a `{...}` body that is neither a comma list nor a range.
 *
 * @param span A bracket span
 * @returns True when the parser does not rewrite the body
 */
export function isRejectedBracketBody(span: IBracketExpressionSpan): boolean {
  if (span.kind !== 'bracket') {
    return false;
  }
  if (span.body.trim().length === 0) {
    return true;
  }
  if (hasCodeComma(span.body)) {
    return false;
  }
  const bounds = splitRangeBounds(span.body);
  if (!bounds) {
    return span.opener === '{';
  }
  const { min, max } = bounds;
  return (
    (min === '*' && max === '*') ||
    (min !== '*' && min.length === 0) ||
    (max !== '*' && max.length === 0) ||
    isRejectedNullRangeBound(min) ||
    isRejectedNullRangeBound(max) ||
    isBooleanRangeEndpoint(min) ||
    isBooleanRangeEndpoint(max)
  );
}

/**
 * Whether a bracket expression in `input` is one the parser's rewrite does
 * not consume whole: an unclosed opener, a membership list with the wrong
 * closer, or a body `isRejectedBracketBody` names.
 *
 * @param input Query text
 * @returns True when such an expression is written
 */
export function hasRejectedBracketExpression(input: string): boolean {
  return someBracketExpression(
    input,
    span => span.kind === 'rejected' || isRejectedBracketBody(span)
  );
}

/**
 * Whether a span's body is rewritten member by member: a comma list with
 * either opener, or a `[...]` body with no range separator.
 *
 * @param span A bracket span
 * @returns True for a list body
 */
export function isListBody(span: IBracketExpressionSpan): boolean {
  if (span.kind !== 'bracket' || span.body.trim().length === 0) {
    return false;
  }
  if (hasCodeComma(span.body)) {
    return true;
  }
  return span.opener === '[' && splitRangeBounds(span.body) === null;
}

/**
 * Whether a token begins and ends with the same quote, which the rewrite
 * copies as written.
 *
 * @param token A list member or range bound, trimmed
 * @returns True for a token the rewrite treats as already quoted
 */
export function isQuotedToken(token: string): boolean {
  return (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  );
}

/**
 * Whether the rewrite writes a list member back unquoted: it is not a quoted
 * token and holds no whitespace, parenthesis or colon, so Liqe reads it as
 * typed.
 *
 * @param member A list member, trimmed
 * @returns True when the member reaches Liqe unquoted
 */
export function writesBackUnquoted(member: string): boolean {
  return !isQuotedToken(member) && !/\s|[():]/.test(member);
}

/**
 * Whether a list in `input` has a member the rewrite writes back unquoted
 * that `isRejectedMember` refuses. Membership lists and ranges are not
 * lists here; their members are quoted or decoded by the parser.
 *
 * @param input Query text
 * @param isRejectedMember Decides one unquoted member
 * @returns True when such a member is written
 *
 * @example
 * ```typescript
 * hasRejectedListMember('status:[x, AND]', member => member === 'AND'); // true
 * ```
 */
export function hasRejectedListMember(
  input: string,
  isRejectedMember: (member: string) => boolean
): boolean {
  return someBracketExpression(
    input,
    span =>
      isListBody(span) &&
      splitListMembers(span.body).some(
        member => writesBackUnquoted(member) && isRejectedMember(member)
      )
  );
}

/**
 * Whether a bracket member or bound is copied as written with a tail glued
 * to its literal: an unquoted list member that begins with a quote or regex
 * but does not end with that literal; a range bound the rewrite treats as
 * quoted that is not one closed literal; or a quoted membership member that
 * is not one closed literal, which the membership decode refuses.
 *
 * @param input Query text
 * @returns True when such a member is written
 */
export function hasCopiedBracketMember(input: string): boolean {
  return someBracketExpression(input, span => {
    if (span.kind === 'membership') {
      return splitListMembers(span.body).some(
        member => isQuotedToken(member) && !isOneClosedLiteral(member)
      );
    }
    if (isListBody(span)) {
      return splitListMembers(span.body).some(
        member =>
          (isQuotedToken(member) ||
            (writesBackUnquoted(member) && /^["'/]/.test(member))) &&
          !isOneClosedLiteral(member)
      );
    }
    const bounds = readRangeBounds(span);
    return (
      bounds !== null &&
      [bounds.min, bounds.max].some(
        bound => isQuotedToken(bound) && !isOneClosedLiteral(bound)
      )
    );
  });
}

function isOneClosedLiteral(token: string): boolean {
  const literal = readLiteralAt(token, 0);
  return (
    literal.kind !== 'none' && literal.closed && literal.end === token.length
  );
}

/**
 * The decimals Liqe reads and the spellings the parser turns into one.
 */
const SPELLED_DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Whether a `[`, `]`, `{` or `}` in `input` reaches Liqe where Liqe does not
 * read one: outside the bracket expressions the rewrite consumes and
 * outside Liqe's own `field:>[decimal TO decimal]` range, or inside a list
 * member written back unquoted. Brackets in literals, in ranges (whose
 * bounds are quoted) and in membership lists (whose members are decoded)
 * are values.
 *
 * @param input Query text
 * @returns True when a bracket is stray
 */
export function hasStrayBracket(input: string): boolean {
  let index = 0;
  while (index < input.length) {
    const span = readBracketExpression(input, index);
    if (span) {
      if (isListBody(span) && listMemberHoldsBracket(span)) {
        return true;
      }
      index = span.end;
      continue;
    }
    const rangeEnd = readLiqeRangeEnd(input, index);
    if (rangeEnd !== null) {
      index = rangeEnd;
      continue;
    }
    const literal = readLiteralAt(input, index);
    if (literal.kind !== 'none') {
      index = literal.end;
      continue;
    }
    if (/[[\]{}]/.test(input[index] ?? '')) {
      return true;
    }
    index += 1;
  }
  return false;
}

function listMemberHoldsBracket(span: IBracketExpressionSpan): boolean {
  return splitListMembers(span.body).some(
    member =>
      writesBackUnquoted(member) &&
      segmentQueryText(member).some(
        segment => segment.kind === 'code' && /[[\]{}]/.test(segment.text)
      )
  );
}

/**
 * The end of Liqe's own range at `index`: a field no name character
 * precedes, a colon, an ordered operator, and `[decimal TO decimal]` or the
 * `{...}` form with exactly one space on each side of `TO`.
 */
function readLiqeRangeEnd(input: string, index: number): number | null {
  if (followsNameCharacter(input, index)) {
    return null;
  }
  const field = readBracketFieldToken(input, index);
  if (!field || input[field.end] !== ':') {
    return null;
  }
  const operator = /^(?:>=|<=|>|<|=)/.exec(input.slice(field.end + 1));
  if (!operator) {
    return null;
  }
  const openerIndex = field.end + 1 + operator[0].length;
  if (!/[[{]/.test(input[openerIndex] ?? '')) {
    return null;
  }
  const closeIndex = readBracketEnd(input, openerIndex);
  if (closeIndex === null) {
    return null;
  }
  const bounds = input.slice(openerIndex + 1, closeIndex).split(' TO ');
  if (
    bounds.length !== 2 ||
    !bounds.every(bound => SPELLED_DECIMAL.test(bound))
  ) {
    return null;
  }
  return closeIndex + 1;
}

/**
 * Find the bracket that closes the one opened at `openIndex`, skipping
 * literals and nested brackets.
 *
 * @param input Query text
 * @param openIndex Index of a `[` or `{`
 * @returns Index of the closer, or null when the bracket is unclosed
 */
export function readBracketEnd(
  input: string,
  openIndex: number
): number | null {
  let depth = 1;
  let index = openIndex + 1;
  while (index < input.length) {
    const literal = readLiteralAt(input, index);
    if (literal.kind !== 'none') {
      index = literal.end;
      continue;
    }
    const char = input[index];
    if (char === '[' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return null;
}

/**
 * Whether a bracket body holds a comma outside its literals, which makes
 * the parser rewrite it as a list rather than a range.
 *
 * @param body Text between the brackets
 * @returns True when a comma is syntax in the body
 */
export function hasCodeComma(body: string): boolean {
  let index = 0;
  while (index < body.length) {
    const literal = readLiteralAt(body, index);
    if (literal.kind !== 'none') {
      index = literal.end;
      continue;
    }
    if (body[index] === ',') {
      return true;
    }
    index += 1;
  }
  return false;
}

/**
 * Split a bracket body at its one ` TO ` separator outside literals, the
 * way the parser's range rewrite does.
 *
 * @param body Text between the brackets
 * @returns The trimmed bounds, or null when the body has no single separator
 */
export function splitRangeBounds(
  body: string
): { min: string; max: string } | null {
  const separators: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < body.length) {
    const literal = readLiteralAt(body, index);
    if (literal.kind !== 'none') {
      index = literal.end;
      continue;
    }
    const separator = /^\s+to\s+/i.exec(body.slice(index));
    if (separator) {
      separators.push({ start: index, end: index + separator[0].length });
      index += separator[0].length;
      continue;
    }
    index += 1;
  }
  const separator = separators[0];
  if (separators.length !== 1 || !separator) {
    return null;
  }
  return {
    min: body.slice(0, separator.start).trim(),
    max: body.slice(separator.end).trim()
  };
}

/**
 * The bounds of a `field:[min TO max]` span the parser's rewrite would
 * format as comparisons: no comma in the body and exactly one separator.
 *
 * @param span A bracket span
 * @returns The trimmed bounds, or null when the span is not such a range
 */
export function readRangeBounds(
  span: IBracketExpressionSpan
): { min: string; max: string } | null {
  if (span.kind !== 'bracket' || hasCodeComma(span.body)) {
    return null;
  }
  return splitRangeBounds(span.body);
}

/**
 * Call `visit` for every bracket expression in `input` that the parser's
 * rewrite would consume, skipping literals and the spans themselves.
 *
 * @param input Query text
 * @param visit Receives each span; return true to stop and report it
 * @returns True when `visit` returned true for a span
 */
export function someBracketExpression(
  input: string,
  visit: (span: IBracketExpressionSpan) => boolean
): boolean {
  let index = 0;
  while (index < input.length) {
    const span = readBracketExpression(input, index);
    if (span) {
      if (visit(span)) {
        return true;
      }
      index = span.end;
      continue;
    }
    const literal = readLiteralAt(input, index);
    index = literal.kind === 'none' ? index + 1 : literal.end;
  }
  return false;
}

/**
 * Whether a range in `input` has an unquoted `null` bound, which the
 * parser's rewrite leaves for Liqe to reject.
 *
 * @param input Query text
 * @returns True when such a range is written
 */
export function hasNullRangeEndpoint(input: string): boolean {
  return someBracketExpression(input, span => {
    const bounds = readRangeBounds(span);
    return (
      bounds !== null &&
      (isRejectedNullRangeBound(bounds.min) ||
        isRejectedNullRangeBound(bounds.max))
    );
  });
}

/**
 * Whether a range in `input` has an unquoted `true` or `false` bound, which
 * the parser's rewrite leaves for Liqe to reject.
 *
 * @param input Query text
 * @returns True when such a range is written
 */
export function hasBooleanRangeEndpoint(input: string): boolean {
  return someBracketExpression(input, span => {
    const bounds = readRangeBounds(span);
    return (
      bounds !== null &&
      (isBooleanRangeEndpoint(bounds.min) || isBooleanRangeEndpoint(bounds.max))
    );
  });
}

/**
 * The parser's membership operator, read just after the field's colon.
 */
const MEMBERSHIP_OPENER = /^(?:not\s+in|in)\s*(?=\[)/i;

/**
 * Whether the character before `index` could continue a name, in which case
 * no field begins at `index`.
 */
function followsNameCharacter(input: string, index: number): boolean {
  return index > 0 && /[\w$.]/.test(input[index - 1] ?? '');
}

function readBracketFieldToken(
  input: string,
  index: number
): { text: string; end: number } | null {
  const literal = readLiteralAt(input, index);
  if (literal.kind === 'string' && literal.closed) {
    return { text: input.slice(index, literal.end), end: literal.end };
  }
  const match = /^[A-Za-z_$][\w$.]*/.exec(input.slice(index));
  if (!match) {
    return null;
  }
  return { text: match[0], end: index + match[0].length };
}

function readStringLiteral(
  input: string,
  start: number,
  quote: '"' | "'"
): ILiteralSpan {
  let index = start + 1;
  while (index < input.length) {
    if (input[index] === '\\' && index + 1 < input.length) {
      index += 2;
      continue;
    }
    if (input[index] === quote) {
      return { kind: 'string', end: index + 1, closed: true };
    }
    index += 1;
  }
  return { kind: 'string', end: input.length, closed: false };
}

function readRegexLiteral(input: string, start: number): ILiteralSpan {
  const liqeEnd = liqeRegexSpans(input)?.get(start);
  if (liqeEnd !== undefined) {
    return { kind: 'regex', end: liqeEnd, closed: true };
  }
  return scanRegexLiteral(input, start);
}

/**
 * The regex spans of Liqe's unique parse of `input`, keyed by start index,
 * or null when Liqe rejects the text or reads it two ways. Only a text that
 * holds a slash is parsed.
 */
function liqeRegexSpans(input: string): Map<number, number> | null {
  if (!input.includes('/')) {
    return null;
  }
  const reading = readLiqe(input);
  if (!reading.ast) {
    return null;
  }
  if (!reading.regexSpans) {
    reading.regexSpans = new Map();
    collectRegexSpans(reading.ast, reading.regexSpans);
  }
  return reading.regexSpans;
}

function collectRegexSpans(node: unknown, spans: Map<number, number>): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  const token = node as {
    type?: string;
    location?: { start: number; end: number };
    expression?: unknown;
    left?: unknown;
    right?: unknown;
    operand?: unknown;
  };
  if (token.type === 'RegexExpression' && token.location) {
    spans.set(token.location.start, token.location.end);
    return;
  }
  collectRegexSpans(token.expression, spans);
  collectRegexSpans(token.left, spans);
  collectRegexSpans(token.right, spans);
  collectRegexSpans(token.operand, spans);
}

function scanRegexLiteral(input: string, start: number): ILiteralSpan {
  let index = start + 1;
  let isInClass = false;
  while (index < input.length) {
    const char = input[index];
    if (char === '\\' && index + 1 < input.length) {
      index += 2;
      continue;
    }
    if (isInClass) {
      isInClass = char !== ']';
    } else if (char === '[') {
      isInClass = true;
    } else if (char === '/') {
      return {
        kind: 'regex',
        end: readRegexFlagsEnd(input, index + 1),
        closed: true
      };
    }
    index += 1;
  }
  return { kind: 'regex', end: input.length, closed: false };
}

function readRegexFlagsEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length && /[gmiyusd]/.test(input[index] ?? '')) {
    index += 1;
  }
  return index;
}

function segmentQueryText(input: string): IQueryTextSegment[] {
  const segments: IQueryTextSegment[] = [];
  let codeStart = 0;
  let index = 0;
  const pushCode = (end: number): void => {
    if (end <= codeStart) {
      return;
    }
    segments.push({
      kind: 'code',
      text: input.slice(codeStart, end),
      start: codeStart,
      closed: true
    });
  };
  while (index < input.length) {
    const literal = readLiteralAt(input, index);
    if (literal.kind === 'none') {
      index += 1;
      continue;
    }
    pushCode(index);
    segments.push({
      kind: literal.kind,
      text: input.slice(index, literal.end),
      start: index,
      closed: literal.closed
    });
    index = literal.end;
    codeStart = index;
  }
  pushCode(input.length);
  return segments;
}
