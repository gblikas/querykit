import {
  IComparisonExpression,
  ILogicalExpression,
  QueryExpression,
  QueryValue
} from '../../parser/types';
import { LIKE_ESCAPE, toSqlLikePattern } from '../../translators/like-pattern';
import { foldAsciiCase } from '../../translators/own-key-case';
import { InMemoryAdapterError } from './in-memory-adapter-error';
import {
  compareStored,
  isStoredNull,
  likeTextOf,
  StoredValue,
  storedValueOf
} from './stored-value';

/**
 * SQL truth value. `null` means unknown, which a WHERE clause excludes.
 */
type SqlTruth = boolean | null;

/**
 * Messages shared by the up-front shape check and the per-row evaluation,
 * so both paths reject the same node with the same words.
 */
const RAW_SQL_MESSAGE = 'Raw SQL expressions cannot be filtered in memory';
const MISSING_LEFT_MESSAGE = 'Logical expression is missing a left operand';
const MISSING_RIGHT_MESSAGE = 'Logical expression is missing a right operand';
const REGEX_MESSAGE = 'Unsupported operator: REGEX';

/**
 * Filter rows with a QueryKit expression using the same operators the
 * Drizzle translator emits. `==` is equality, and `LIKE` is SQL LIKE
 * (`*` is `%`, `?` is `_`, anchored to the whole value, ASCII letters
 * matching in either case as in SQLite). Values compare the way SQLite
 * compares a column: a boolean is 0 or 1, a bigint and a number compare by
 * value, a Date is its ISO-8601 text, NaN is NULL, and every string is
 * greater than every number.
 *
 * This walks the existing AST. It does not parse a second grammar, rank
 * rows, or build an index.
 *
 * @param expression Expression the Drizzle translator would compile
 * @param records Rows to test. Matches keep their original order and identity.
 * @returns Matching rows
 * @throws {InMemoryAdapterError} When the expression cannot be applied. The
 * check runs before any row is read, so an empty table rejects the same
 * expressions as a populated one.
 *
 * @example
 * const open = filterByExpression(parser.parse('status:active'), tasks);
 */
export function filterByExpression<T extends object>(
  expression: QueryExpression,
  records: readonly T[]
): T[] {
  assertMatchableExpression(expression);
  const matched: T[] = [];
  for (const record of records) {
    if (expressionTruth(expression, record) === true) {
      matched.push(record);
    }
  }
  return matched;
}

/**
 * Report whether an expression can be applied to plain objects.
 * Raw SQL cannot, nor can `REGEX`, a `LIKE` without a string pattern, or a
 * membership test without a list. The check does not look at row values.
 *
 * @param expression Expression to check
 * @returns True when every node is a comparison this engine applies or a complete boolean
 */
export function canMatchExpression(expression: QueryExpression): boolean {
  try {
    assertMatchableExpression(expression);
    return true;
  } catch (error) {
    if (error instanceof InMemoryAdapterError) {
      return false;
    }
    throw error;
  }
}

/**
 * Reject an expression this engine cannot apply, before any row is read.
 * The same errors would otherwise surface only from a row that reaches the
 * offending node, so an empty table would accept what a populated one
 * rejects.
 *
 * @param expression Expression to check
 * @throws {InMemoryAdapterError} When a node is raw SQL, uses an operator this engine lacks, has a malformed value, or lacks an operand
 */
function assertMatchableExpression(expression: QueryExpression): void {
  if (expression.type === 'comparison') {
    assertComparisonShape(expression);
    return;
  }
  if (expression.type !== 'logical') {
    throw new InMemoryAdapterError(RAW_SQL_MESSAGE);
  }
  assertLogicalShape(expression);
}

/**
 * Reject a logical node `logicalTruth` cannot apply: a missing operand or
 * an operator other than AND, OR, and NOT.
 *
 * @param expression Logical node
 * @throws {InMemoryAdapterError} When an operand is missing or the operator is unknown
 */
function assertLogicalShape(expression: ILogicalExpression): void {
  if (!expression.left) {
    throw new InMemoryAdapterError(MISSING_LEFT_MESSAGE);
  }
  assertMatchableExpression(expression.left);
  if (expression.operator === 'NOT') {
    return;
  }
  if (!expression.right) {
    throw new InMemoryAdapterError(MISSING_RIGHT_MESSAGE);
  }
  assertMatchableExpression(expression.right);
  if (expression.operator === 'AND' || expression.operator === 'OR') {
    return;
  }
  const unexpected: never = expression.operator;
  throw new InMemoryAdapterError(
    `Unsupported logical operator: ${String(unexpected)}`
  );
}

/**
 * Reject a comparison whose operator or value shape `comparisonTruth`
 * cannot apply. The switch lists every operator so that a node built
 * outside the type system fails here rather than on the first row.
 *
 * @param expression Comparison node
 * @throws {InMemoryAdapterError} When the operator is `REGEX` or unknown, `LIKE` has no string, or a membership test has no array
 */
function assertComparisonShape(expression: IComparisonExpression): void {
  switch (expression.operator) {
    case '==':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      return;
    case 'LIKE':
      assertLikePattern(expression.value);
      return;
    case 'IN':
    case 'NOT IN':
      assertMembershipList(expression.value);
      return;
    case 'REGEX':
      throw new InMemoryAdapterError(REGEX_MESSAGE);
    default: {
      const unexpected: never = expression.operator;
      throw new InMemoryAdapterError(
        `Unsupported operator: ${String(unexpected)}`
      );
    }
  }
}

/**
 * @param value LIKE operand
 * @throws {InMemoryAdapterError} When the pattern is not a string
 */
function assertLikePattern(value: QueryValue): asserts value is string {
  if (typeof value !== 'string') {
    throw new InMemoryAdapterError('LIKE operator requires a string value');
  }
}

/**
 * @param value Membership operand
 * @throws {InMemoryAdapterError} When the value is not an array
 */
function assertMembershipList(
  value: QueryValue
): asserts value is Extract<QueryValue, unknown[]> {
  if (!Array.isArray(value)) {
    throw new InMemoryAdapterError('IN operator requires an array value');
  }
}

/**
 * Test one row against an expression. Only SQL TRUE is a match.
 *
 * @param expression Expression to apply
 * @param record Row whose fields are read by name
 * @returns True when the row satisfies the expression
 * @throws {InMemoryAdapterError} When the expression cannot be applied
 */
export function matchesExpression(
  expression: QueryExpression,
  record: object
): boolean {
  assertMatchableExpression(expression);
  return expressionTruth(expression, record) === true;
}

/**
 * Evaluate one node to true, false, or unknown.
 *
 * @param expression Expression to apply
 * @param record Row whose fields are read by name
 * @returns SQL truth value
 * @throws {InMemoryAdapterError} When the expression cannot be applied
 */
function expressionTruth(
  expression: QueryExpression,
  record: object
): SqlTruth {
  if (expression.type === 'comparison') {
    return comparisonTruth(expression, record);
  }
  if (expression.type === 'logical') {
    return logicalTruth(expression, record);
  }
  throw new InMemoryAdapterError(RAW_SQL_MESSAGE);
}

/**
 * Apply AND, OR, or NOT. Unknown stays unknown, so NOT of a null
 * comparison does not become a match.
 *
 * @param expression Logical node
 * @param record Row to test
 * @returns SQL truth value
 * @throws {InMemoryAdapterError} When a binary operator has no right side
 */
function logicalTruth(
  expression: ILogicalExpression,
  record: object
): SqlTruth {
  if (expression.operator === 'NOT') {
    return notTruth(expressionTruth(expression.left, record));
  }
  if (!expression.right) {
    throw new InMemoryAdapterError(MISSING_RIGHT_MESSAGE);
  }
  const leftTruth = expressionTruth(expression.left, record);
  const rightTruth = expressionTruth(expression.right, record);
  if (expression.operator === 'AND') {
    return andTruth(leftTruth, rightTruth);
  }
  if (expression.operator === 'OR') {
    return orTruth(leftTruth, rightTruth);
  }
  const unexpected: never = expression.operator;
  throw new InMemoryAdapterError(
    `Unsupported logical operator: ${String(unexpected)}`
  );
}

/**
 * Combine two truth values with SQL AND.
 *
 * @param left Left truth value
 * @param right Right truth value
 * @returns SQL AND
 */
function andTruth(left: SqlTruth, right: SqlTruth): SqlTruth {
  if (left === false || right === false) {
    return false;
  }
  if (left === true && right === true) {
    return true;
  }
  return null;
}

/**
 * Combine two truth values with SQL OR.
 *
 * @param left Left truth value
 * @param right Right truth value
 * @returns SQL OR
 */
function orTruth(left: SqlTruth, right: SqlTruth): SqlTruth {
  if (left === true || right === true) {
    return true;
  }
  if (left === false && right === false) {
    return false;
  }
  return null;
}

/**
 * Apply SQL NOT.
 *
 * @param value Truth value
 * @returns Negated truth value. Unknown stays unknown.
 */
function notTruth(value: SqlTruth): SqlTruth {
  if (value === null) {
    return null;
  }
  return !value;
}

/**
 * Apply one comparison with Drizzle's operator meanings.
 *
 * @param expression Comparison node
 * @param record Row to test
 * @returns SQL truth value
 * @throws {InMemoryAdapterError} When LIKE is given a non-string or IN is not an array
 */
function comparisonTruth(
  expression: IComparisonExpression,
  record: object
): SqlTruth {
  const fieldValue = readField(record, expression.field);
  switch (expression.operator) {
    case '==':
      return equalityTruth(fieldValue, expression.value);
    case '!=':
      return notTruth(equalityTruth(fieldValue, expression.value));
    case '>':
    case '>=':
    case '<':
    case '<=':
      return orderedTruth(fieldValue, expression.value, expression.operator);
    case 'LIKE':
      return likeTruth(fieldValue, expression.value);
    case 'IN':
      return inTruth(fieldValue, expression.value);
    case 'NOT IN':
      return notTruth(inTruth(fieldValue, expression.value));
    case 'REGEX':
      throw new InMemoryAdapterError(REGEX_MESSAGE);
    default: {
      const unexpected: never = expression.operator;
      throw new InMemoryAdapterError(
        `Unsupported operator: ${String(unexpected)}`
      );
    }
  }
}

/**
 * QueryKit `== null` is `IS NULL`. A null field matches, and a non-null
 * field does not. A null field compared with any other value is unknown.
 * Otherwise the two values are equal when SQLite would store them as the
 * same class and value: `true` equals 1, `10n` equals 10, a Date equals its
 * ISO-8601 text, and a string never equals a number.
 *
 * @param left Field value
 * @param right Query value
 * @returns True, false, or unknown
 */
function equalityTruth(left: unknown, right: QueryValue): SqlTruth {
  if (right === null) {
    return isNullish(left);
  }
  const stored = storedValueOf(left);
  if (stored.kind === 'null') {
    return null;
  }
  if (Array.isArray(right)) {
    return false;
  }
  return isSameStoredValue(stored, storedValueOf(right));
}

/**
 * @param left Classified field value
 * @param right Classified query value
 * @returns True when both are numbers of the same value or the same text
 */
function isSameStoredValue(left: StoredValue, right: StoredValue): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'other') {
    return false;
  }
  return compareStored(left, right) === 0;
}

/**
 * Order two values the way SQLite orders a column: numbers (a boolean as 0
 * or 1, a bigint by value) compare numerically, strings and Dates by code
 * point, and every string is greater than every number. A null side is
 * unknown. A field outside those classes is false.
 *
 * @param left Field value
 * @param right Query value
 * @param operator Ordered comparison
 * @returns True, false, or unknown
 */
function orderedTruth(
  left: unknown,
  right: QueryValue,
  operator: '>' | '>=' | '<' | '<='
): SqlTruth {
  if (right === null) {
    return null;
  }
  const stored = storedValueOf(left);
  if (stored.kind === 'null') {
    return null;
  }
  if (Array.isArray(right) || stored.kind === 'other') {
    return false;
  }
  return holdsOrder(compareStored(stored, storedValueOf(right)), operator);
}

/**
 * Read an ordered operator off a three-way comparison.
 *
 * @param compared Negative when the field orders first, positive when the query value does
 * @param operator Ordered comparison
 * @returns True when the comparison holds
 */
function holdsOrder(
  compared: number,
  operator: '>' | '>=' | '<' | '<='
): boolean {
  switch (operator) {
    case '>':
      return compared > 0;
    case '>=':
      return compared >= 0;
    case '<':
      return compared < 0;
    case '<=':
      return compared <= 0;
    default: {
      const unexpected: never = operator;
      throw new InMemoryAdapterError(
        `Unsupported operator: ${String(unexpected)}`
      );
    }
  }
}

/**
 * Match a whole value with SQL LIKE. `*` and `?` are converted by the
 * same helper the SQL and Drizzle translators use, including its escape.
 * The value is the text SQLite would apply the pattern to: a string, a
 * Date's ISO-8601 text, or a number's or bigint's decimal digits.
 *
 * @param fieldValue Field value
 * @param pattern QueryKit wildcard pattern
 * @returns True, false, or unknown
 * @throws {InMemoryAdapterError} When the pattern is not a string
 */
function likeTruth(fieldValue: unknown, pattern: QueryValue): SqlTruth {
  assertLikePattern(pattern);
  if (isNullish(fieldValue)) {
    return null;
  }
  const text = likeTextOf(fieldValue);
  if (text === undefined) {
    return false;
  }
  return matchesLikePattern(toSqlLikePattern(pattern), text);
}

/**
 * One unit of a SQL LIKE pattern: `%`, `_`, or a literal character.
 */
type LikeToken =
  | { kind: 'any' }
  | { kind: 'one' }
  | { kind: 'char'; value: string };

/**
 * Split a SQL LIKE pattern into tokens. {@link LIKE_ESCAPE} makes the next
 * character literal, matching the `ESCAPE` clause the translators emit.
 *
 * @param sqlPattern SQL LIKE pattern
 * @returns Tokens in pattern order
 */
function tokenizeLikePattern(sqlPattern: string): LikeToken[] {
  const tokens: LikeToken[] = [];
  const chars = Array.from(sqlPattern);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? '';
    const next = chars[index + 1];
    if (char === LIKE_ESCAPE && next !== undefined) {
      tokens.push({ kind: 'char', value: next });
      index += 1;
      continue;
    }
    if (char === '%') {
      tokens.push({ kind: 'any' });
      continue;
    }
    if (char === '_') {
      tokens.push({ kind: 'one' });
      continue;
    }
    tokens.push({ kind: 'char', value: char });
  }
  return tokens;
}

/**
 * Match a whole value against a SQL LIKE pattern in O(pattern × value)
 * time. ASCII letters match in either case and every other character
 * exactly, which is SQLite's default LIKE (`open*` keeps `Open`; `ö` and
 * `Ö` stay distinct); an escaped letter folds the same way. The matcher
 * remembers the last `%` and resumes from it instead of backtracking
 * through every split, so a pattern such as `*a*a*a*ab` cannot stall the
 * event loop on a long value the way a compiled regular expression with
 * repeated `.*` groups does.
 *
 * @param sqlPattern SQL LIKE pattern
 * @param value Field value
 * @returns True when the whole value matches
 */
function matchesLikePattern(sqlPattern: string, value: string): boolean {
  const tokens = tokenizeLikePattern(foldAsciiCase(sqlPattern));
  const chars = Array.from(foldAsciiCase(value));
  let tokenIndex = 0;
  let charIndex = 0;
  let lastAnyToken = -1;
  let lastAnyChar = -1;
  while (charIndex < chars.length) {
    const token = tokens[tokenIndex];
    if (token?.kind === 'any') {
      lastAnyToken = tokenIndex;
      lastAnyChar = charIndex;
      tokenIndex += 1;
      continue;
    }
    if (
      token &&
      (token.kind === 'one' ||
        (token.kind === 'char' && token.value === chars[charIndex]))
    ) {
      tokenIndex += 1;
      charIndex += 1;
      continue;
    }
    if (lastAnyToken === -1) {
      return false;
    }
    lastAnyChar += 1;
    charIndex = lastAnyChar;
    tokenIndex = lastAnyToken + 1;
  }
  while (tokens[tokenIndex]?.kind === 'any') {
    tokenIndex += 1;
  }
  return tokenIndex === tokens.length;
}

/**
 * SQL `IN` after the translator's null rewrite. An empty list is false.
 * A null member agrees with `IS NULL` and does not make the other members
 * unknown. A null field with no null member stays unknown. Each other
 * member is tested with the equality rule, so a bigint field matches a
 * numeric member of the same value.
 *
 * @param fieldValue Field value
 * @param value List of members
 * @returns True, false, or unknown
 * @throws {InMemoryAdapterError} When the value is not an array
 */
function inTruth(fieldValue: unknown, value: QueryValue): SqlTruth {
  assertMembershipList(value);
  if (value.length === 0) {
    return false;
  }
  if (isNullish(fieldValue)) {
    return value.includes(null) ? true : null;
  }
  return value.some(
    member => member !== null && equalityTruth(fieldValue, member) === true
  );
}

/**
 * Read a field by the name stored on the AST.
 *
 * @param record Row
 * @param field Field name
 * @returns The field value, or undefined when the row has no such key
 */
function readField(record: object, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return undefined;
  }
  return (record as Record<string, unknown>)[field];
}

/**
 * Treat a missing field, and a stored NaN, the same as SQL null.
 *
 * @param value Field or query value
 * @returns True when the value is null, undefined, NaN or an invalid Date
 */
function isNullish(value: unknown): boolean {
  return isStoredNull(value);
}
