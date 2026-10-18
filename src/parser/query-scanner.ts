/**
 * Quote- and regex-aware scanning for query text.
 *
 * Structural checks (parentheses, boolean words, brackets) must ignore
 * characters that live inside string or regex literals. Liqe treats `/.../`
 * as a regex value and quotes as literals; counting those characters as
 * syntax changes the meaning of a query the parser has already accepted.
 * Inside a regex, a slash within a character class such as `[/]` does not
 * close the literal.
 */

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
