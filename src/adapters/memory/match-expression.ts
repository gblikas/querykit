import {
  IComparisonExpression,
  ILogicalExpression,
  QueryExpression,
  QueryValue
} from '../../parser/types';
import { LIKE_ESCAPE, toSqlLikePattern } from '../../translators/like-pattern';
import { InMemoryAdapterError } from './in-memory-adapter-error';

/**
 * SQL truth value. `null` means unknown, which a WHERE clause excludes.
 */
type SqlTruth = boolean | null;

/**
 * Filter rows with a QueryKit expression using the same operators the
 * Drizzle translator emits. `==` is equality, and `LIKE` is SQL LIKE
 * (`*` is `%`, `?` is `_`, case-sensitive, anchored to the whole value).
 *
 * This walks the existing AST. It does not parse a second grammar, rank
 * rows, or build an index.
 *
 * @param expression Expression the Drizzle translator would compile
 * @param records Rows to test. Matches keep their original order and identity.
 * @returns Matching rows
 * @throws {InMemoryAdapterError} When the expression is raw SQL or a LIKE value is not a string
 *
 * @example
 * const open = filterByExpression(parser.parse('status:active'), tasks);
 */
export function filterByExpression<T extends object>(
  expression: QueryExpression,
  records: readonly T[]
): T[] {
  const matched: T[] = [];
  for (const record of records) {
    if (matchesExpression(expression, record)) {
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
  if (expression.type === 'comparison') {
    return canMatchComparison(expression);
  }
  if (expression.type !== 'logical') {
    return false;
  }
  if (!canMatchExpression(expression.left)) {
    return false;
  }
  if (expression.operator === 'NOT') {
    return true;
  }
  return expression.right ? canMatchExpression(expression.right) : false;
}

/**
 * Report whether one comparison has an operator and value shape that
 * `comparisonTruth` accepts without throwing.
 *
 * @param expression Comparison node
 * @returns True when execution would not reject the node up front
 */
function canMatchComparison(expression: IComparisonExpression): boolean {
  switch (expression.operator) {
    case 'LIKE':
      return typeof expression.value === 'string';
    case 'IN':
    case 'NOT IN':
      return Array.isArray(expression.value);
    case 'REGEX':
      return false;
    default:
      return true;
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
  throw new InMemoryAdapterError(
    'Raw SQL expressions cannot be filtered in memory'
  );
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
    throw new InMemoryAdapterError(
      'Logical expression is missing a right operand'
    );
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
      throw new InMemoryAdapterError('Unsupported operator: REGEX');
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
 *
 * @param left Field value
 * @param right Query value
 * @returns True, false, or unknown
 */
function equalityTruth(left: unknown, right: QueryValue): SqlTruth {
  if (right === null) {
    return isNullish(left);
  }
  if (isNullish(left)) {
    return null;
  }
  if (Array.isArray(right)) {
    return false;
  }
  return left === right;
}

/**
 * Compare numbers numerically and strings lexicographically.
 * A null side is unknown. Different types are false.
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
  if (isNullish(left) || right === null) {
    return null;
  }
  if (Array.isArray(right)) {
    return false;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return applyOrder(left, right, operator);
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return applyOrder(left, right, operator);
  }
  return false;
}

/**
 * Apply an ordered operator to two values of the same comparable type.
 *
 * @param left Field value
 * @param right Query value
 * @param operator Ordered comparison
 * @returns True when the comparison holds
 */
function applyOrder<T extends number | string>(
  left: T,
  right: T,
  operator: '>' | '>=' | '<' | '<='
): boolean {
  switch (operator) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    default: {
      const unexpected: never = operator;
      throw new InMemoryAdapterError(
        `Unsupported operator: ${String(unexpected)}`
      );
    }
  }
}

/**
 * Match a whole string with SQL LIKE. `*` and `?` are converted by the
 * same helper the SQL and Drizzle translators use, including its escape.
 *
 * @param fieldValue Field value
 * @param pattern QueryKit wildcard pattern
 * @returns True, false, or unknown
 * @throws {InMemoryAdapterError} When the pattern is not a string
 */
function likeTruth(fieldValue: unknown, pattern: QueryValue): SqlTruth {
  if (typeof pattern !== 'string') {
    throw new InMemoryAdapterError('LIKE operator requires a string value');
  }
  if (isNullish(fieldValue)) {
    return null;
  }
  if (typeof fieldValue !== 'string') {
    return false;
  }
  return matchesLikePattern(toSqlLikePattern(pattern), fieldValue);
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
 * Match a whole value against a SQL LIKE pattern, case-sensitively, in
 * O(pattern × value) time. The matcher remembers the last `%` and resumes
 * from it instead of backtracking through every split, so a pattern such as
 * `*a*a*a*ab` cannot stall the event loop on a long value the way a compiled
 * regular expression with repeated `.*` groups does.
 *
 * @param sqlPattern SQL LIKE pattern
 * @param value Field value
 * @returns True when the whole value matches
 */
function matchesLikePattern(sqlPattern: string, value: string): boolean {
  const tokens = tokenizeLikePattern(sqlPattern);
  const chars = Array.from(value);
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
 * unknown. A null field with no null member stays unknown.
 *
 * @param fieldValue Field value
 * @param value List of members
 * @returns True, false, or unknown
 * @throws {InMemoryAdapterError} When the value is not an array
 */
function inTruth(fieldValue: unknown, value: QueryValue): SqlTruth {
  if (!Array.isArray(value)) {
    throw new InMemoryAdapterError('IN operator requires an array value');
  }
  if (value.length === 0) {
    return false;
  }
  const fieldIsNull = isNullish(fieldValue);
  let sawNullMember = false;
  for (const item of value) {
    if (item === null) {
      sawNullMember = true;
      continue;
    }
    if (!fieldIsNull && fieldValue === item) {
      return true;
    }
  }
  if (fieldIsNull) {
    return sawNullMember ? true : null;
  }
  return false;
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
 * Treat a missing field the same as SQL null.
 *
 * @param value Field or query value
 * @returns True when the value is null or undefined
 */
function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}
