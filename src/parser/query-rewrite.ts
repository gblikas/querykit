/**
 * The rewrites that turn query text into the text Liqe parses.
 *
 * Liqe has no not-equals or membership operator, reads only the uppercase
 * operator words and only numeric ranges, and has no bracket lists. The
 * parser therefore spells the numerals Liqe cannot read, uppercases `and`,
 * `or` and `not`, rewrites `field:!=` to `NOT field:`, lifts
 * `field:in[...]` out as a placeholder literal, writes `field:[a, b]` as
 * `(field:a OR field:b)` and `field:[a TO b]` as two comparisons.
 * `rewriteQueryForLiqe` is pure, and a caller that must know where each
 * bracket expression landed passes `visit`. A regex member is copied as
 * text; nothing here compiles or runs one.
 */

import {
  hasQuotedTail,
  IBracketExpressionSpan,
  isLiqeWhitespace,
  isQuotedToken,
  isRejectedBracketBody,
  QUOTED_MEMBER_CHARACTERS,
  readBracketExpression,
  readFieldToken,
  readLiteralAt,
  readRangeBounds,
  splitListMembers,
  uppercaseBooleanOperators
} from './query-scanner';
import { spellNumerals } from './stored-integer';

/**
 * Inert quoted value written where a membership clause was lifted out. It
 * is found again by position, so it never has to be unique, and a caller
 * value that decodes to the same text is left alone. No randomness is
 * needed, and the parser keeps working in browsers, where Node's `crypto`
 * module is not available.
 */
export const MEMBERSHIP_PLACEHOLDER = '"\uE000"';

/**
 * The text the list rewrite joins its clauses with.
 */
export const OR_JOINER = ' OR ';

/**
 * Where a list member or range bound the bracket rewrite wrote as typed
 * sits in the rewritten text: `start` and the offset just past it.
 */
export interface IMemberSpan {
  start: number;
  end: number;
}

/**
 * Where a regex list member the bracket rewrite wrote back as typed sits in
 * the rewritten text, and whether it stands inside a group the rewrite
 * emitted, whose ` OR ` joiner and closer a regex must not swallow.
 */
export interface IRegexMemberSpan extends IMemberSpan {
  isGrouped: boolean;
}

/**
 * One bracket expression the rewrite consumed: the span as read from the
 * text the bracket rewrite walked, where its replacement begins in the
 * rewritten text, and two kinds of member written as typed, as spans of
 * the rewritten text: the regex list members, and the quoted members and
 * bounds that are not one closed literal (`quotedTails`). The rewrite
 * copies a member that begins and ends with the same quote, so Liqe reads
 * the text after such a member's first literal as more query
 * (`status:["a" OR status:"c"]` reaches Liqe as `status:"a" OR
 * status:"c"`); the parser rejects the query when Liqe reads a literal at
 * one, while no literal begins at a member a regex Liqe reads from the
 * text before it has swallowed.
 */
export interface IBracketRewrite {
  span: IBracketExpressionSpan;
  offset: number;
  regexMembers: IRegexMemberSpan[];
  quotedTails: IMemberSpan[];
}

/**
 * Where the placeholder literal of a lifted membership clause begins in the
 * rewritten text: just after the field and its colon. The parser puts the
 * clause back where Liqe reads a quoted literal beginning there.
 *
 * @param rewrite A consumed membership expression
 * @returns The offset of the placeholder's opening quote
 */
export function readPlaceholderStart(rewrite: IBracketRewrite): number {
  return rewrite.offset + rewrite.span.field.length + 1;
}

/**
 * Whether Liqe did not read a regex list member the bracket rewrite wrote
 * back as typed as a regex literal of its own, given the regex spans of
 * Liqe's reading keyed by start index: no regex begins at the member, the
 * regex at a grouped member does not end where the member ends, so it
 * swallowed the ` OR ` joiner or the closer written after it, or the regex
 * at an ungrouped member ends before it. A regex that begins at the one
 * member of a list and runs past the closer into the typed text
 * (`x:[//]/` is `///`) is read from the member and stays. The parser
 * rejects such a reading.
 *
 * @param members The regex members the rewrite located
 * @param regexSpans Start index to end index of each regex Liqe read
 * @returns True when a member was not read as its own regex literal
 */
export function hasUnreadRegexMember(
  members: readonly IRegexMemberSpan[],
  regexSpans: ReadonlyMap<number, number>
): boolean {
  return members.some(member => {
    const end = regexSpans.get(member.start);
    if (end === undefined) {
      return true;
    }
    return member.isGrouped ? end !== member.end : end < member.end;
  });
}

/**
 * The replacement for one consumed bracket expression, with its regex
 * members and quoted tails located relative to the replacement's own start.
 */
interface IBracketReplacement {
  span: IBracketExpressionSpan;
  text: string;
  regexMembers: IRegexMemberSpan[];
  quotedTails: IMemberSpan[];
}

/**
 * The text the parser hands Liqe for `query`: numerals spelled, operator
 * words uppercased, each clause-leading `field:!=` rewritten, then the
 * bracket expressions.
 *
 * @param query Query text
 * @param visit Receives each bracket expression the rewrite consumed, in order
 * @returns The rewritten text
 * @throws {Error} When a numeral names an integer outside the signed 64-bit
 * range or an exponent that underflows to zero
 *
 * @example
 * ```typescript
 * rewriteQueryForLiqe('status:!=[a, b] and n:1e2');
 * // 'NOT (status:a OR status:b) AND n:100'
 * ```
 */
export function rewriteQueryForLiqe(
  query: string,
  visit?: (rewrite: IBracketRewrite) => void
): string {
  // Spell exponents and the leading-plus, leading-dot and trailing-dot
  // forms as plain decimals first, so the bracket rewrite sees numbers and
  // keeps range bounds and list members numeric.
  const spelled = spellNumerals(query);
  // Liqe only recognizes uppercase AND, OR, NOT as boolean operators; a
  // lowercase word is a bare search term to it.
  const uppercased = uppercaseBooleanOperators(spelled);
  // The input parser and autocomplete both advertise `:!=`, so it is
  // rewritten before the brackets, whose field it would otherwise follow.
  const negated = rewriteInequalityOperators(uppercased);
  // Liqe ranges only accept numbers, and a naive `field:[...]` replace
  // corrupts dotted names and quoted text.
  return rewriteBracketExpressions(negated, visit);
}

/**
 * Rewrite `field:!=value` to `NOT field:value` outside of literals, where
 * the field begins a clause. The field may be bare or quoted, so this scans
 * with the same field reader the bracket rewrite uses instead of a regex
 * over the unquoted text.
 *
 * @param query Query text, its operator words uppercased
 * @returns The text with each clause-leading `field:!=` rewritten
 */
export function rewriteInequalityOperators(query: string): string {
  let result = '';
  let index = 0;
  while (index < query.length) {
    const rewritten = matchInequality(query, index);
    if (rewritten) {
      result += rewritten.text;
      index = rewritten.end;
      continue;
    }
    const literal = readLiteralAt(query, index);
    if (literal.kind !== 'none') {
      result += query.slice(index, literal.end);
      index = literal.end;
      continue;
    }
    result += query[index] ?? '';
    index += 1;
  }
  return result;
}

function matchInequality(
  query: string,
  index: number
): { text: string; end: number } | null {
  if (!beginsClause(query, index)) {
    return null;
  }
  const field = readFieldToken(query, index);
  if (!field || !query.startsWith(':!=', field.end)) {
    return null;
  }
  return { text: `NOT ${field.text}:`, end: field.end + 3 };
}

/**
 * Whether a field may begin at `index`: the start of the text, Liqe
 * whitespace, `(` or a clause-leading minus precedes it. A `:!=` glued to
 * the value before it (`status:a*y:!=b`) is left as typed for Liqe to
 * reject, instead of writing `NOT ` into that value.
 */
function beginsClause(query: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const before = query[index - 1] ?? '';
  if (before === '-') {
    return index === 1 || separatesClauses(query[index - 2]);
  }
  return separatesClauses(before);
}

function separatesClauses(char: string | undefined): boolean {
  return isLiqeWhitespace(char) || char === '(';
}

/**
 * Rewrite every `field:[...]`, `field:{...}` and `field:in[...]` the parser
 * consumes, outside literals, in a text the inequality rewrite has walked.
 * A span whose operator is still `:!=` did not begin a clause there, so it
 * is left as typed for Liqe to reject, as is a body the rewrite does not
 * read (`isRejectedBracketBody`, an unclosed opener, a membership list
 * whose closer is not `]`).
 *
 * @param query Query text after the inequality rewrite
 * @param visit Receives each consumed expression with its offsets in the result
 * @returns The rewritten text
 */
export function rewriteBracketExpressions(
  query: string,
  visit?: (rewrite: IBracketRewrite) => void
): string {
  let result = '';
  let index = 0;
  while (index < query.length) {
    const replacement = readBracketReplacement(query, index);
    if (replacement) {
      visit?.(locateBracketRewrite(replacement, result.length));
      result += replacement.text;
      index = replacement.span.end;
      continue;
    }
    const literal = readLiteralAt(query, index);
    if (literal.kind !== 'none') {
      result += query.slice(index, literal.end);
      index = literal.end;
      continue;
    }
    result += query[index] ?? '';
    index += 1;
  }
  return result;
}

function locateBracketRewrite(
  replacement: IBracketReplacement,
  offset: number
): IBracketRewrite {
  const shift = <T extends IMemberSpan>(member: T): T => ({
    ...member,
    start: offset + member.start,
    end: offset + member.end
  });
  return {
    span: replacement.span,
    offset,
    regexMembers: replacement.regexMembers.map(shift),
    quotedTails: replacement.quotedTails.map(shift)
  };
}

/**
 * The replacement for the bracket expression the rewrite consumes at
 * `index`, or null when none begins there or the rewrite leaves it to Liqe.
 */
function readBracketReplacement(
  query: string,
  index: number
): IBracketReplacement | null {
  const span = readBracketExpression(query, index);
  if (
    span === null ||
    span.operator === ':!=' ||
    span.kind === 'rejected' ||
    isRejectedBracketBody(span)
  ) {
    return null;
  }
  if (span.kind === 'membership') {
    const text = `${span.field}:${MEMBERSHIP_PLACEHOLDER}`;
    return { span, text, regexMembers: [], quotedTails: [] };
  }
  const bounds = readRangeBounds(span);
  if (bounds) {
    return writeRangeRewrite(span, bounds.min, bounds.max);
  }
  return writeListRewrite(span);
}

/**
 * The text the range rewrite joins its two comparisons with.
 */
const AND_JOINER = ' AND ';

/**
 * The two comparisons a `[min TO max]` range becomes, or the one of a
 * one-sided range, locating in them each quoted bound copied as written
 * that is not one closed literal; `isRejectedBracketBody` has already
 * excluded a range with both bounds open, an empty bound, or a `null` or
 * boolean bound.
 */
function writeRangeRewrite(
  span: IBracketExpressionSpan,
  min: string,
  max: string
): IBracketReplacement {
  const minOperator = span.opener === '{' ? '>' : '>=';
  const maxOperator = span.closer === '}' ? '<' : '<=';
  const bounds: string[] = [];
  const clauses: string[] = [];
  if (min !== '*') {
    bounds.push(min);
    clauses.push(writeComparison(span.field, minOperator, min));
  }
  if (max !== '*') {
    bounds.push(max);
    clauses.push(writeComparison(span.field, maxOperator, max));
  }
  const isGrouped = clauses.length === 2;
  const text = isGrouped ? `(${clauses.join(AND_JOINER)})` : (clauses[0] ?? '');
  const quotedTails = locateQuotedTailBounds(bounds, clauses, isGrouped);
  return { span, text, regexMembers: [], quotedTails };
}

/**
 * Where each quoted bound `writeComparison` copied as written that is not
 * one closed literal sits once the comparisons are joined with
 * `AND_JOINER`, after the `(` of a group, relative to the start of the
 * range's replacement. A copied bound ends its comparison.
 */
function locateQuotedTailBounds(
  bounds: string[],
  clauses: string[],
  isGrouped: boolean
): IMemberSpan[] {
  const located: IMemberSpan[] = [];
  let start = isGrouped ? 1 : 0;
  clauses.forEach((clause, index) => {
    const bound = bounds[index] ?? '';
    if (hasQuotedTail(bound)) {
      const end = start + clause.length;
      located.push({ start: end - bound.length, end });
    }
    start += clause.length + AND_JOINER.length;
  });
  return located;
}

function writeComparison(
  field: string,
  operator: string,
  bound: string
): string {
  if (/^-?(?:\d+)(?:\.\d+)?$/.test(bound)) {
    return `${field}:${operator}${bound}`;
  }
  if (isQuotedToken(bound)) {
    return `${field}:${operator}${bound}`;
  }
  const escaped = bound.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${field}:${operator}"${escaped}"`;
}

/**
 * The OR expression a comma list becomes, `(field:a OR field:b OR ...)`, or
 * the one clause of a one-member list, locating in it each regex member
 * written back as typed and each quoted member copied as written that is
 * not one closed literal.
 */
function writeListRewrite(span: IBracketExpressionSpan): IBracketReplacement {
  const members = splitListMembers(span.body);
  const clauses = members.map(member => writeListClause(span.field, member));
  if (clauses.length === 0) {
    const text = `${span.field}:""`;
    return { span, text, regexMembers: [], quotedTails: [] };
  }
  const isGrouped = clauses.length >= 2;
  const text = isGrouped ? `(${clauses.join(OR_JOINER)})` : (clauses[0] ?? '');
  const locate = (isLocated: (member: string) => boolean): IMemberSpan[] =>
    locateMembers(span, members, clauses, isGrouped, isLocated);
  const regexMembers = locate(isTypedRegexMember).map(member => ({
    ...member,
    isGrouped
  }));
  return { span, text, regexMembers, quotedTails: locate(hasQuotedTail) };
}

/**
 * The clause the list rewrite writes for one member: a quoted member as
 * written, a member holding whitespace, a parenthesis or a colon quoted
 * with its backslashes and double quotes escaped, and any other member as
 * typed. Backslashes are escaped first so a later quote escape is not
 * doubled, and so `\b` stays a backslash rather than a backspace.
 *
 * @param field The field as written
 * @param member One list member, trimmed
 * @returns `field:value` as Liqe will read it
 */
export function writeListClause(field: string, member: string): string {
  if (isQuotedToken(member)) {
    return `${field}:${member}`;
  }
  if (QUOTED_MEMBER_CHARACTERS.test(member)) {
    const escaped = member.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `${field}:"${escaped}"`;
  }
  return `${field}:${member}`;
}

/**
 * Where each member `isLocated` selects sits, as the value of its clause,
 * once the clauses are joined with `OR_JOINER`, after the `(` of a group,
 * relative to the start of the list's replacement. Only a member written
 * back as typed or copied as written is located, so its clause's value is
 * the member itself.
 */
function locateMembers(
  span: IBracketExpressionSpan,
  members: string[],
  clauses: string[],
  isGrouped: boolean,
  isLocated: (member: string) => boolean
): IMemberSpan[] {
  const located: IMemberSpan[] = [];
  let start = isGrouped ? 1 : 0;
  clauses.forEach((clause, index) => {
    if (isLocated(members[index] ?? '')) {
      located.push({
        start: start + span.field.length + 1,
        end: start + clause.length
      });
    }
    start += clause.length + OR_JOINER.length;
  });
  return located;
}

/**
 * Whether `writeListClause` writes `member` back as typed and Liqe reads a
 * regex literal there: an unquoted member that begins with a slash and
 * holds no character that makes the rewrite quote it.
 */
function isTypedRegexMember(member: string): boolean {
  return member.startsWith('/') && !QUOTED_MEMBER_CHARACTERS.test(member);
}
