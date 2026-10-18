import { parse as liqeParse } from 'liqe';
import type {
  BooleanOperatorToken,
  ExpressionToken,
  ImplicitBooleanOperatorToken,
  LiqeQuery,
  LogicalExpressionToken,
  ParenthesizedExpressionToken,
  RangeExpressionToken,
  TagToken,
  UnaryOperatorToken
} from 'liqe';
import {
  ComparisonOperator,
  IAutocompleteSuggestions,
  IComparisonExpression,
  IErrorRecovery,
  IFieldSchema,
  IFieldSuggestion,
  IFieldValidationDetail,
  IFieldValidationResult,
  ILogicalExpression,
  IOperatorSuggestion,
  IParserOptions,
  IParseWithContextOptions,
  IQueryParser,
  IQueryParseResult,
  IQueryStructure,
  IQueryToken,
  ISecurityCheckResult,
  ISecurityOptionsForContext,
  ISecurityViolation,
  ISecurityWarning,
  IValueSuggestion,
  QueryExpression,
  QueryValue
} from './types';
import {
  findTrailingLogicalOperator,
  parseQueryTokens,
  isInputComplete,
  QueryToken
} from './input-parser';
import {
  hasUnreadRegexMember,
  IBracketRewrite,
  IMemberSpan,
  IRegexMemberSpan,
  readPlaceholderStart,
  rewriteQueryForLiqe
} from './query-rewrite';
import {
  isQuotedToken,
  measureQueryDelimiters,
  readQuotedLiteralStarts,
  readRegexSpans,
  splitListMembers
} from './query-scanner';
import {
  exactSqliteInteger,
  isPlainInteger,
  isUnstorableInteger,
  numeralAt,
  outsideSignedRangeMessage
} from './stored-integer';
import { foldAsciiCase } from '../security/schema-field-case';
import { DEFAULT_SECURITY_OPTIONS, ISecurityOptions } from '../security/types';
import {
  aliasSecurityFields,
  deniedNameSet,
  isAllowedName,
  isDeniedName
} from '../security/validator';

/**
 * Error thrown when query parsing fails
 */
export class QueryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryParseError';
  }
}

/**
 * Implementation of the QueryKit parser using Liqe
 */
interface IMembershipPlaceholder {
  operator: 'IN' | 'NOT IN';
  value: Array<string | number | boolean | null>;
}

/**
 * State of one `parse()` call. `placeholders` are the membership clauses
 * lifted out of the query, keyed by the start offset of their placeholder
 * literal in the text handed to Liqe; a node is matched by that location,
 * never by its value, so no query content can imitate a placeholder and the
 * placeholder text stays constant. `regexMembers` are the regex list
 * members the bracket rewrite wrote back as typed, as spans of that same
 * text; Liqe must read a regex literal at each. `quotedTails` are the
 * quoted list members and range bounds the rewrite copied as written
 * although they are not one closed literal; Liqe must not read a literal
 * at any. `sourceText` is that same text, read back at a literal's
 * location to recover the digits of an integer `Number` would round.
 */
interface IParseState {
  placeholders: Map<number, IMembershipPlaceholder>;
  regexMembers: IRegexMemberSpan[];
  quotedTails: IMemberSpan[];
  sourceText: string;
}

/**
 * A field as the parser resolved it: the stored name, and whether a
 * translator must keep that name as one identifier.
 */
interface IResolvedField {
  name: string;
  isLiteral: boolean;
}

/**
 * Escapes Liqe decodes after a backslash in either quote style, before the
 * `u` plus four hex digits form. `\'` is accepted in single quotes only.
 */
const LIQE_SIMPLE_ESCAPES = '"/\\bfnrt';

/**
 * Decode one quoted literal exactly as Liqe's string grammar does, without
 * running its Earley parser, whose cost grows superlinearly with the length
 * of the literal. Body characters other than a newline, a backslash, and the
 * literal's own quote pass through; a backslash must start a Liqe escape.
 *
 * @param token Quoted literal including its quotes
 * @returns The decoded value
 * @throws {QueryParseError} When Liqe would not read the token as one quoted literal
 */
function decodeQuotedLiteral(token: string): string {
  const quote = token[0] ?? '';
  const body = token.slice(1, -1);
  let decoded = '';
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? '';
    if (char === '\n' || char === quote) {
      throw new QueryParseError(`Invalid quoted value: ${token}`);
    }
    if (char !== '\\') {
      decoded += char;
      index += 1;
      continue;
    }
    const escape = readLiqeEscape(body, index + 1, quote);
    decoded += escape.value;
    index += 1 + escape.length;
  }
  return decoded;
}

/**
 * Read the escape that follows a backslash at `index`.
 *
 * @param body Literal body without its quotes
 * @param index Position of the character after the backslash
 * @param quote The literal's quote character
 * @returns The decoded character and how many body characters it used
 * @throws {QueryParseError} When the sequence is not one Liqe accepts
 */
function readLiqeEscape(
  body: string,
  index: number,
  quote: string
): { value: string; length: number } {
  const char = body[index] ?? '';
  if (quote === "'" && char === "'") {
    return { value: "'", length: 1 };
  }
  if (char !== '' && LIQE_SIMPLE_ESCAPES.includes(char)) {
    return { value: JSON.parse(`"\\${char}"`) as string, length: 1 };
  }
  const hex = body.slice(index + 1, index + 5);
  if (char === 'u' && /^[\dA-Fa-f]{4}$/.test(hex)) {
    return { value: JSON.parse(`"\\u${hex}"`) as string, length: 5 };
  }
  throw new QueryParseError(`Invalid escape in quoted value: \\${char}`);
}

/**
 * Whether a stored field name is one column whose name holds a dot rather
 * than a `table.column` qualifier: a quoted name with exactly one dot other
 * than `.`, or an unquoted name with one dot and an empty side. A name with
 * two or more dots is already one identifier to every translator.
 *
 * @param name The field name after case folding
 * @param quoted Whether the query wrote the name in quotes
 * @returns True when translators must not split the name
 */
function isLiteralFieldName(name: string, quoted: boolean): boolean {
  const parts = name.split('.');
  if (parts.length !== 2) {
    return false;
  }
  if (quoted) {
    return name !== '.';
  }
  return parts[0] === '' || parts[1] === '';
}

export class QueryParser implements IQueryParser {
  private options: Required<IParserOptions>;
  private parseState: IParseState | null = null;

  constructor(options: IParserOptions = {}) {
    this.options = {
      caseInsensitiveFields: options.caseInsensitiveFields ?? false,
      fieldMappings: options.fieldMappings ?? {}
    };
  }

  /**
   * Parse a query string into a QueryKit AST
   */
  public parse(query: string): QueryExpression {
    const previousState = this.parseState;
    this.parseState = {
      placeholders: new Map(),
      regexMembers: [],
      quotedTails: [],
      sourceText: ''
    };
    try {
      // Pre-process the query to handle IN operator syntax
      const preprocessedQuery = this.preprocessQuery(query);
      this.parseState.sourceText = preprocessedQuery;
      const liqeAst = liqeParse(preprocessedQuery);
      this.assertQuotedTailsUnread(liqeAst);
      const expression = this.convertLiqeAst(liqeAst);
      this.assertMembershipRestored();
      this.assertRegexMembersRead(liqeAst);
      return expression;
    } catch (error) {
      throw new QueryParseError(
        `Failed to parse query: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.parseState = previousState;
    }
  }

  /**
   * Fail instead of dropping a clause when Liqe produced no node at a
   * placeholder's position, which happens when a regex literal swallows the
   * text around it.
   *
   * @throws {QueryParseError} When a lifted membership clause was not placed
   */
  private assertMembershipRestored(): void {
    if (this.parseState && this.parseState.placeholders.size > 0) {
      throw new QueryParseError(
        'A membership list could not be placed in the parsed query'
      );
    }
  }

  /**
   * Fail when Liqe did not read a regex list member the bracket rewrite
   * wrote back as typed as a regex literal of its own. The rewrite drops
   * the brackets of `[//]`, so a regex glued before the field (`x://T:[//]`
   * reaches Liqe as `x://T://`) would otherwise be read as one regex across
   * the join, and a member of a group the rewrite emitted could swallow the
   * ` OR ` and `)` written after it (`r:[//, l]/)` reaches Liqe as
   * `(r:// OR r:l)/)`): queries no reading of the typed text yields. A regex
   * that begins at the one member of a list and runs past the closer into
   * the typed text (`x:[//]/` is `///`) is read from the member and stays,
   * as the search box reads it. The rule is `hasUnreadRegexMember`, which
   * the search box applies to the same text.
   *
   * @param ast Liqe's reading of the rewritten query
   * @throws {QueryParseError} When no regex begins at a member, or the regex
   * at a grouped member runs past it
   */
  private assertRegexMembersRead(ast: LiqeQuery): void {
    const members = this.parseState?.regexMembers ?? [];
    if (members.length === 0) {
      return;
    }
    if (hasUnreadRegexMember(members, readRegexSpans(ast))) {
      throw new QueryParseError(
        'A regex list member was not read as its own regex literal'
      );
    }
  }

  /**
   * Fail when Liqe read the first literal of a quoted list member or range
   * bound the bracket rewrite copied as written although it is not one
   * closed literal. The rewrite copies a member that begins and ends with
   * the same quote, so Liqe reads whatever follows that literal as more
   * query: `status:["a" OR status:"c"]` reaches Liqe as `status:"a" OR
   * status:"c"`, a second clause no reading of the typed text yields, and
   * `status:["a" "b"]` as an implicit-field term. This runs before the AST
   * conversion so the member, not the clause it smuggled, is reported. A
   * member Liqe read no literal at was swallowed by a regex Liqe reads from
   * the text before it (`x:[a] n://(y:["a" OR z:"b"]/` is one regex from
   * `n:` on), which stays as the search box reads it.
   *
   * @param ast Liqe's reading of the rewritten query
   * @throws {QueryParseError} When Liqe read a literal at such a member
   */
  private assertQuotedTailsUnread(ast: LiqeQuery): void {
    const tails = this.parseState?.quotedTails ?? [];
    if (tails.length === 0) {
      return;
    }
    const starts = readQuotedLiteralStarts(ast);
    if (tails.some(tail => starts.has(tail.start))) {
      throw new QueryParseError(
        'A quoted list member or range bound was not read as one quoted literal'
      );
    }
  }

  /**
   * Return the membership clause whose placeholder starts where this literal
   * starts, and forget it. Location, not value, identifies the placeholder.
   */
  private takeMembership(
    expression: ExpressionToken
  ): IMembershipPlaceholder | undefined {
    if (expression.type !== 'LiteralExpression' || !expression.quoted) {
      return undefined;
    }
    const start = expression.location.start;
    const lifted = this.parseState?.placeholders.get(start);
    if (lifted) {
      this.parseState?.placeholders.delete(start);
    }
    return lifted;
  }

  /**
   * Pre-process a query string to convert non-standard syntax to
   * Liqe-compatible syntax, the shared `rewriteQueryForLiqe` the search box
   * reads too: numerals Liqe cannot read are spelled, lowercase operator
   * words uppercased, `field:!=` rewritten, `field:in[...]` lifted out as a
   * placeholder and `field:[val1, val2]` written as
   * `(field:val1 OR field:val2)`. Where each bracket expression lands is
   * recorded for the AST conversion and the checks after Liqe.
   *
   * @throws {Error} When a numeral names an integer outside the signed
   * 64-bit range or an exponent that underflows to zero; `parse` wraps it
   * @throws {QueryParseError} When a quoted membership member is not one
   * Liqe would read
   */
  private preprocessQuery(query: string): string {
    return rewriteQueryForLiqe(query, rewrite =>
      this.recordBracketRewrite(rewrite)
    );
  }

  /**
   * Remember where a lifted membership clause's placeholder, each regex
   * list member written back as typed and each quoted member or bound
   * copied as written that is not one closed literal will sit in the text
   * handed to Liqe. The bracket rewrite is the last preprocessing step, so
   * offsets in its output are offsets in Liqe's input. The membership
   * values are decoded here, as the rewrite reaches them, so an invalid
   * quoted member fails before Liqe runs.
   */
  private recordBracketRewrite(rewrite: IBracketRewrite): void {
    const { span } = rewrite;
    if (span.kind === 'membership') {
      this.parseState?.placeholders.set(readPlaceholderStart(rewrite), {
        operator: span.isNegatedMembership ? 'NOT IN' : 'IN',
        value: this.parseMembershipValues(span.body)
      });
    }
    this.parseState?.regexMembers.push(...rewrite.regexMembers);
    this.parseState?.quotedTails.push(...rewrite.quotedTails);
  }

  private parseMembershipValues(
    body: string
  ): Array<string | number | boolean | null> {
    if (body.trim().length === 0) {
      return [];
    }
    // The split is the scanner's `splitListMembers`, which the search box
    // mirrors, so a comma inside a string or regex literal stays in its
    // member.
    return splitListMembers(body).map(token =>
      this.parseMembershipToken(token)
    );
  }

  private parseMembershipToken(
    token: string
  ): string | number | boolean | null {
    if (isQuotedToken(token)) {
      return decodeQuotedLiteral(token);
    }
    if (token === 'null') {
      return null;
    }
    if (token === 'true') {
      return true;
    }
    if (token === 'false') {
      return false;
    }
    // Unquoted members follow JavaScript's `String(number)`, which the
    // builder emits, so exponent forms are accepted here even though Liqe's
    // own numeral grammar has none.
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      return Number(token);
    }
    return token;
  }

  /**
   * Validate a query string
   */
  public validate(query: string): boolean {
    try {
      this.parse(query);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Nesting depth of a parsed expression, counted the way
   * QuerySecurityValidator counts it: each logical node adds one level and a
   * comparison adds none, so `a AND b` is 1 and `(a OR b) AND c` is 2.
   */
  private measureAstDepth(expression: QueryExpression): number {
    if (expression.type !== 'logical') {
      return 0;
    }
    const leftDepth = this.measureAstDepth(expression.left);
    const rightDepth = expression.right
      ? this.measureAstDepth(expression.right)
      : 0;
    return 1 + Math.max(leftDepth, rightDepth);
  }

  /**
   * Convert a Liqe AST node to a QueryKit expression
   */
  private convertLiqeAst(node: LiqeQuery): QueryExpression {
    if (!node || typeof node !== 'object') {
      throw new QueryParseError('Invalid AST node');
    }

    switch (node.type) {
      case 'LogicalExpression': {
        const logicalNode = node as LogicalExpressionToken;
        const operator = (
          logicalNode.operator as
            | BooleanOperatorToken
            | ImplicitBooleanOperatorToken
        ).operator;
        return this.createLogicalExpression(
          this.convertLogicalOperator(operator),
          logicalNode.left,
          logicalNode.right
        );
      }

      case 'UnaryOperator': {
        const unaryNode = node as UnaryOperatorToken;
        return this.createLogicalExpression('NOT', unaryNode.operand);
      }

      case 'Tag': {
        const tagNode = node as TagToken;
        const field = tagNode.field;
        const expression = tagNode.expression;
        if (!field || !expression) {
          throw new QueryParseError('Invalid field or expression in Tag node');
        }
        if (!('name' in field) || typeof field.name !== 'string') {
          throw new QueryParseError(
            'Implicit field search is not supported; queries must name a field'
          );
        }
        const resolved = this.resolveField(field.name, field.quoted === true);
        const lifted = this.takeMembership(expression);
        if (lifted) {
          return this.createComparisonExpression(
            resolved,
            lifted.operator,
            lifted.value
          );
        }
        if (expression.type === 'RangeExpression') {
          return this.convertRangeExpression(resolved, expression);
        }
        if (expression.type === 'RegexExpression') {
          return this.createComparisonExpression(
            resolved,
            'REGEX',
            expression.value
          );
        }
        if (!tagNode.operator || !('value' in expression)) {
          throw new QueryParseError('Invalid field or expression in Tag node');
        }
        const operator = this.convertLiqeOperator(tagNode.operator.operator);
        const value = this.exactLiteralValue(
          expression,
          this.convertLiqeValue(expression.value)
        );

        // Check for wildcard patterns in string values
        if (
          operator === '==' &&
          typeof value === 'string' &&
          (value.includes('*') || value.includes('?'))
        ) {
          return this.createComparisonExpression(resolved, 'LIKE', value);
        }

        return this.createComparisonExpression(resolved, operator, value);
      }

      case 'EmptyExpression':
        if ('left' in node && node.left) {
          return this.convertLiqeAst(node.left);
        }
        throw new QueryParseError('Invalid empty expression');

      case 'ParenthesizedExpression': {
        const parenNode = node as ParenthesizedExpressionToken;
        if (parenNode.expression) {
          return this.convertLiqeAst(parenNode.expression);
        }
        throw new QueryParseError('Invalid parenthesized expression');
      }

      default:
        throw new QueryParseError(
          `Unsupported node type: ${(node as { type: string }).type}`
        );
    }
  }

  /**
   * Convert a Liqe logical operator to a QueryKit operator
   */
  private convertLogicalOperator(operator: string): 'AND' | 'OR' | 'NOT' {
    switch (operator.toLowerCase()) {
      case 'and':
        return 'AND';
      case 'or':
        return 'OR';
      case 'not':
        return 'NOT';
      default:
        throw new QueryParseError(`Unsupported logical operator: ${operator}`);
    }
  }

  /**
   * Create a logical expression from Liqe nodes
   */
  private createLogicalExpression(
    operator: 'AND' | 'OR' | 'NOT',
    left: LiqeQuery,
    right?: LiqeQuery
  ): ILogicalExpression {
    return {
      type: 'logical',
      operator,
      left: this.convertLiqeAst(left),
      ...(right && { right: this.convertLiqeAst(right) })
    };
  }

  /**
   * Create a comparison expression. `isLiteral` is written only when set,
   * so a plain comparison keeps the shape it always had.
   */
  private createComparisonExpression(
    field: IResolvedField,
    operator: ComparisonOperator,
    value: QueryValue
  ): IComparisonExpression {
    return {
      type: 'comparison',
      field: field.name,
      operator,
      value,
      ...(field.isLiteral && { isLiteral: true as const })
    };
  }

  /**
   * The exact value of an unquoted numeric literal. Liqe reads a decimal
   * with `Number`, so the digits are read back from the text Liqe parsed,
   * starting where the literal starts (Liqe's end offset comes from the
   * stringified number and is not the written length): a plain integer
   * outside the signed 64-bit range that `Number` still holds is rejected,
   * and one inside the range that `Number` would round or misspell becomes
   * a bigint. Any other literal keeps Liqe's value.
   *
   * @throws {QueryParseError} For an integer outside the signed 64-bit range
   */
  private exactLiteralValue(
    expression: ExpressionToken,
    value: QueryValue
  ): QueryValue {
    if (
      typeof value !== 'number' ||
      expression.type !== 'LiteralExpression' ||
      expression.quoted ||
      !this.parseState
    ) {
      return value;
    }
    const written = numeralAt(
      this.parseState.sourceText,
      expression.location.start
    );
    if (written === null || !isPlainInteger(written)) {
      return value;
    }
    if (isUnstorableInteger(written)) {
      throw new QueryParseError(outsideSignedRangeMessage(written));
    }
    return exactSqliteInteger(written) ?? value;
  }

  /**
   * Convert a Liqe RangeExpression to a QueryKit logical AND expression
   * E.g., `field:[2 TO 5]` becomes `(field >= 2 AND field <= 5)`
   */
  private convertRangeExpression(
    field: IResolvedField,
    expression: RangeExpressionToken
  ): QueryExpression {
    const range = expression.range;

    // Handle null/undefined range values
    if (range === null || range === undefined) {
      throw new QueryParseError('Invalid range expression: missing range data');
    }

    const { min, max, minInclusive, maxInclusive } = range;

    // Determine the operators based on inclusivity
    const minOperator: ComparisonOperator = minInclusive ? '>=' : '>';
    const maxOperator: ComparisonOperator = maxInclusive ? '<=' : '<';

    // Create comparison expressions for min and max
    const minComparison = this.createComparisonExpression(
      field,
      minOperator,
      min
    );
    const maxComparison = this.createComparisonExpression(
      field,
      maxOperator,
      max
    );

    // Combine with AND
    return {
      type: 'logical',
      operator: 'AND',
      left: minComparison,
      right: maxComparison
    };
  }

  /**
   * Convert a Liqe operator to a QueryKit operator
   */
  private convertLiqeOperator(operator: string): ComparisonOperator {
    // Handle the case where operator is part of the value for comparison operators
    if (operator === ':') {
      return '==';
    }

    // Check if the operator is prefixed with a colon
    const actualOperator = operator.startsWith(':')
      ? operator.substring(1)
      : operator;

    // Map Liqe operators to QueryKit operators
    const operatorMap: Record<string, ComparisonOperator> = {
      '=': '==',
      '!=': '!=',
      '>': '>',
      '>=': '>=',
      '<': '<',
      '<=': '<=',
      in: 'IN',
      'not in': 'NOT IN'
    };

    const queryKitOperator = operatorMap[actualOperator.toLowerCase()];
    if (!queryKitOperator) {
      throw new QueryParseError(`Unsupported operator: ${operator}`);
    }

    return queryKitOperator;
  }

  /**
   * Convert a Liqe value to a QueryKit value
   * Security: Strict type checking to prevent NoSQL injection via objects
   */
  private convertLiqeValue(value: unknown): QueryValue {
    // Security fix: Strict type checking to prevent object injection
    if (value === null) {
      return null;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value as QueryValue;
    }

    if (Array.isArray(value)) {
      // Security fix: Recursively validate array elements
      const validatedArray = value.map(item => {
        if (typeof item === 'object' && item !== null) {
          throw new QueryParseError('Object values are not allowed in arrays');
        }
        return this.convertLiqeValue(item);
      });
      return validatedArray as QueryValue;
    }

    // Security fix: Reject all object types to prevent NoSQL injection
    if (typeof value === 'object') {
      throw new QueryParseError(
        'Object values are not supported for security reasons'
      );
    }

    throw new QueryParseError(`Unsupported value type: ${typeof value}`);
  }

  /**
   * Normalize a field name based on parser options
   */
  private normalizeFieldName(field: string): string {
    return this.resolveField(field, false).name;
  }

  /**
   * Resolve a written field name: fold its case under
   * `caseInsensitiveFields`, then replace it through an own `fieldMappings`
   * entry. A name the mapping replaced is the schema's own spelling and is
   * never literal; otherwise a quoted name with exactly one dot other than
   * `"."`, or an unquoted name with one dot and an empty side, names one
   * column and is marked so translators keep it as one identifier.
   */
  private resolveField(field: string, quoted: boolean): IResolvedField {
    const normalizedField = this.options.caseInsensitiveFields
      ? field.toLowerCase()
      : field;
    // Bracket access walks the prototype, so `toString` and `constructor`
    // would otherwise become functions instead of field names.
    if (
      Object.prototype.hasOwnProperty.call(
        this.options.fieldMappings,
        normalizedField
      )
    ) {
      return {
        name: this.options.fieldMappings[normalizedField],
        isLiteral: false
      };
    }
    return {
      name: normalizedField,
      isLiteral: isLiteralFieldName(normalizedField, quoted)
    };
  }

  /**
   * Parse a query string with full context information.
   *
   * Unlike `parse()`, this method never throws. Instead, it returns a result object
   * that indicates success or failure along with rich contextual information useful
   * for building search UIs.
   *
   * @param query The query string to parse
   * @param options Optional configuration (cursor position, etc.)
   * @returns Rich parse result with tokens, AST/error, and structural analysis
   *
   * @example
   * ```typescript
   * const result = parser.parseWithContext('status:done AND priority:high');
   *
   * if (result.success) {
   *   // Use result.ast for query execution
   *   console.log('Valid query:', result.ast);
   * } else {
   *   // Show error to user
   *   console.log('Error:', result.error?.message);
   * }
   *
   * // Always available for UI rendering
   * console.log('Tokens:', result.tokens);
   * console.log('Structure:', result.structure);
   * ```
   */
  public parseWithContext(
    query: string,
    options: IParseWithContextOptions = {}
  ): IQueryParseResult {
    // Get tokens from input parser (always works, even for invalid input)
    const tokenResult = parseQueryTokens(query, options.cursorPosition);
    const tokens = this.convertTokens(tokenResult.tokens);

    // Analyze structure
    const structure = this.analyzeStructure(query, tokens);

    // Attempt full parse
    let ast: QueryExpression | undefined;
    let error:
      | { message: string; position?: number; problematicText?: string }
      | undefined;
    let success = false;

    try {
      ast = this.parse(query);
      success = true;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      error = {
        message: errorMessage,
        // Try to extract position from error message if available
        position: this.extractErrorPosition(errorMessage),
        problematicText: this.extractProblematicText(query, errorMessage)
      };
    }
    if (ast) {
      structure.clauseCount = this.countComparisonClauses(ast);
      structure.referencedFields = this.collectComparisonFields(ast);
      structure.complexity = this.determineComplexity(
        structure.clauseCount,
        structure.operatorCount,
        structure.depth
      );
    }
    // `structure.depth` is the parenthesis depth of the text. Rewrites such as
    // `status:[a,b,c]` nest logical nodes without parentheses, and
    // QuerySecurityValidator measures the AST, so the pre-check must too.
    const securityDepth = ast
      ? Math.max(structure.depth, this.measureAstDepth(ast))
      : structure.depth;

    // Determine active token
    const activeToken = tokenResult.activeToken
      ? this.convertSingleToken(tokenResult.activeToken)
      : undefined;

    // Build base result
    const result: IQueryParseResult = {
      success,
      input: query,
      ast,
      error,
      tokens,
      activeToken,
      activeTokenIndex: tokenResult.activeTokenIndex,
      structure
    };

    // Perform field validation if schema provided
    if (options.schema) {
      result.fieldValidation = this.validateFields(
        structure.referencedFields,
        options.schema
      );
    }

    // Perform security pre-check if security options provided
    if (options.securityOptions) {
      result.security = this.performSecurityCheck(
        { ...structure, depth: securityDepth },
        options.securityOptions
      );
    }

    // Generate autocomplete suggestions if cursor position provided
    if (options.cursorPosition !== undefined) {
      result.suggestions = this.generateAutocompleteSuggestions(
        query,
        options.cursorPosition,
        activeToken,
        options.schema
      );
    }

    // Generate error recovery suggestions if parsing failed
    if (!success) {
      result.recovery = this.generateErrorRecovery(query, structure);
    }

    return result;
  }

  /**
   * Convert tokens from input parser format to IQueryToken format
   */
  private convertTokens(tokens: QueryToken[]): IQueryToken[] {
    return tokens.map(token => this.convertSingleToken(token));
  }

  /**
   * Convert a single token from input parser format
   */
  private convertSingleToken(token: QueryToken): IQueryToken {
    if (token.type === 'term') {
      return {
        type: 'term',
        key: token.key,
        operator: token.operator,
        value: token.value,
        startPosition: token.startPosition,
        endPosition: token.endPosition,
        raw: token.raw
      };
    } else {
      return {
        type: 'operator',
        operator: token.operator,
        startPosition: token.startPosition,
        endPosition: token.endPosition,
        raw: token.raw
      };
    }
  }

  /**
   * Analyze the structure of a query
   */
  private analyzeStructure(
    query: string,
    tokens: IQueryToken[]
  ): IQueryStructure {
    const delimiters = measureQueryDelimiters(query);
    const hasBalancedParentheses =
      delimiters.openParentheses === delimiters.closeParentheses;
    const hasBalancedQuotes = delimiters.unclosedQuote === null;
    const termTokens = tokens.filter(token => token.type === 'term');
    const operatorTokens = tokens.filter(token => token.type === 'operator');
    const clauseCount = termTokens.length;
    const operatorCount = operatorTokens.length;
    const referencedFields: string[] = [];
    for (const token of termTokens) {
      if (token.type !== 'term' || token.key === null) {
        continue;
      }
      const resolvedField = this.resolveReferencedField(token.key);
      if (
        resolvedField.length > 0 &&
        !referencedFields.includes(resolvedField)
      ) {
        referencedFields.push(resolvedField);
      }
    }
    const depth =
      query.trim().length > 0 ? Math.max(1, delimiters.maxParenthesisDepth) : 0;
    const isComplete = isInputComplete(query);
    const complexity = this.determineComplexity(
      clauseCount,
      operatorCount,
      depth
    );
    return {
      depth,
      clauseCount,
      operatorCount,
      hasBalancedParentheses,
      hasBalancedQuotes,
      isComplete,
      referencedFields,
      complexity
    };
  }

  /**
   * Map a tokenizer field key onto the name the parser would execute.
   * A leading minus is the unary-not prefix, not part of the field.
   */
  private resolveReferencedField(key: string): string {
    const withoutNegation = key.startsWith('-') ? key.slice(1) : key;
    return this.normalizeFieldName(withoutNegation);
  }

  /**
   * Count comparison nodes in the AST that will actually be executed.
   */
  private countComparisonClauses(expression: QueryExpression): number {
    if (expression.type === 'comparison') {
      return 1;
    }
    if (expression.type !== 'logical') {
      return 0;
    }
    const rightCount = expression.right
      ? this.countComparisonClauses(expression.right)
      : 0;
    return this.countComparisonClauses(expression.left) + rightCount;
  }

  /**
   * Collect field names from comparison nodes, in execution order.
   */
  private collectComparisonFields(expression: QueryExpression): string[] {
    const fields: string[] = [];
    this.walkComparisonFields(expression, fields);
    return fields;
  }

  private walkComparisonFields(
    expression: QueryExpression,
    fields: string[]
  ): void {
    if (expression.type === 'comparison') {
      if (expression.field.length > 0 && !fields.includes(expression.field)) {
        fields.push(expression.field);
      }
      return;
    }
    if (expression.type !== 'logical') {
      return;
    }
    this.walkComparisonFields(expression.left, fields);
    if (expression.right) {
      this.walkComparisonFields(expression.right, fields);
    }
  }

  /**
   * Determine query complexity classification
   */
  private determineComplexity(
    clauseCount: number,
    operatorCount: number,
    depth: number
  ): 'simple' | 'moderate' | 'complex' {
    // Simple: 1-2 clauses, no nesting
    if (clauseCount <= 2 && depth <= 1) {
      return 'simple';
    }

    // Complex: many clauses, deep nesting, or many operators
    if (clauseCount > 5 || depth > 3 || operatorCount > 4) {
      return 'complex';
    }

    return 'moderate';
  }

  /**
   * Try to extract error position from error message
   */
  private extractErrorPosition(errorMessage: string): number | undefined {
    // Try to find position indicators in error messages
    // e.g., "at position 15" or "column 15"
    const posMatch = errorMessage.match(/(?:position|column|offset)\s*(\d+)/i);
    if (posMatch) {
      return parseInt(posMatch[1], 10);
    }
    return undefined;
  }

  /**
   * Try to extract the problematic text from the query based on error
   */
  private extractProblematicText(
    query: string,
    errorMessage: string
  ): string | undefined {
    // If we found a position, extract surrounding text
    const position = this.extractErrorPosition(errorMessage);
    if (position !== undefined && position < query.length) {
      const start = Math.max(0, position - 10);
      const end = Math.min(query.length, position + 10);
      return query.substring(start, end);
    }

    // Try to find quoted text in error message
    const quotedMatch = errorMessage.match(/"([^"]+)"/);
    if (quotedMatch) {
      return quotedMatch[1];
    }

    return undefined;
  }

  /**
   * Validate fields against the provided schema
   */
  private validateFields(
    referencedFields: string[],
    schema: Record<string, IFieldSchema>
  ): IFieldValidationResult {
    const schemaFields = Object.keys(schema);
    const fields: IFieldValidationDetail[] = [];
    const unknownFields: string[] = [];
    let allValid = true;

    for (const field of referencedFields) {
      // `in` walks the prototype, so `toString` looks like a schema field.
      if (Object.prototype.hasOwnProperty.call(schema, field)) {
        const fieldSchema = schema[field];
        fields.push({
          field,
          valid: true,
          expectedType: fieldSchema.type,
          allowedValues: fieldSchema.allowedValues
        });
      } else {
        // Field not in schema - try to find a suggestion
        const suggestion = this.findSimilarField(field, schemaFields);
        fields.push({
          field,
          valid: false,
          reason: 'unknown_field',
          suggestion
        });
        unknownFields.push(field);
        allValid = false;
      }
    }

    return {
      valid: allValid,
      fields,
      unknownFields
    };
  }

  /**
   * Find a similar field name (for typo suggestions)
   */
  private findSimilarField(
    field: string,
    schemaFields: string[]
  ): string | undefined {
    const fieldLower = field.toLowerCase();

    // First, try exact case-insensitive match
    for (const schemaField of schemaFields) {
      if (schemaField.toLowerCase() === fieldLower) {
        return schemaField;
      }
    }

    // Then, try to find fields that start with the same prefix
    const prefix = fieldLower.substring(0, Math.min(3, fieldLower.length));
    for (const schemaField of schemaFields) {
      if (schemaField.toLowerCase().startsWith(prefix)) {
        return schemaField;
      }
    }

    // Try Levenshtein distance for short fields
    if (field.length <= 10) {
      let bestMatch: string | undefined;
      let bestDistance = Infinity;

      for (const schemaField of schemaFields) {
        const distance = this.levenshteinDistance(
          fieldLower,
          schemaField.toLowerCase()
        );
        if (distance <= 2 && distance < bestDistance) {
          bestDistance = distance;
          bestMatch = schemaField;
        }
      }

      if (bestMatch) {
        return bestMatch;
      }
    }

    return undefined;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * The field lists as `createQueryKit` resolves them for a parser with
   * these options: closed under `fieldMappings`, so an alias and its target
   * are one entry. An omitted list is empty.
   */
  private aliasedFieldLists(
    options: ISecurityOptionsForContext
  ): Required<ISecurityOptions> {
    return aliasSecurityFields(
      {
        ...DEFAULT_SECURITY_OPTIONS,
        allowedFields: options.allowedFields ?? [],
        denyFields: options.denyFields ?? []
      },
      this.options.fieldMappings,
      this.options.caseInsensitiveFields
    );
  }

  /**
   * The spelling an allowlist entry or a field is compared by: as written,
   * or with `A-Z` folded under `caseInsensitiveFields`, standing in for the
   * schema respelling the kit applies and the pre-check has no table
   * schema for.
   */
  private allowlistSpelling(name: string): string {
    return this.options.caseInsensitiveFields ? foldAsciiCase(name) : name;
  }

  /**
   * Perform security pre-check against the provided options. The deny and
   * allow checks match a referenced field the way the kit's validator does,
   * over the lists closed under `fieldMappings`: a deny-list entry by any
   * ASCII case and a single `table.` qualifier, an allowlist entry as
   * written, folded under `caseInsensitiveFields`.
   */
  private performSecurityCheck(
    structure: IQueryStructure,
    options: ISecurityOptionsForContext
  ): ISecurityCheckResult {
    const violations: ISecurityViolation[] = [];
    const warnings: ISecurityWarning[] = [];
    const lists = this.aliasedFieldLists(options);

    // Check denied fields
    if (lists.denyFields.length > 0) {
      const deniedNames = deniedNameSet(lists.denyFields);
      for (const field of structure.referencedFields) {
        if (isDeniedName(field, deniedNames)) {
          violations.push({
            type: 'denied_field',
            message: `Field "${field}" is not allowed in queries`,
            field
          });
        }
      }
    }

    // Check allowed fields (if specified, only these fields are allowed)
    if (lists.allowedFields.length > 0) {
      const allowedNames = new Set<string>(
        lists.allowedFields.map(name => this.allowlistSpelling(name))
      );
      for (const field of structure.referencedFields) {
        if (!isAllowedName(this.allowlistSpelling(field), allowedNames)) {
          violations.push({
            type: 'field_not_allowed',
            message: `Field "${field}" is not in the list of allowed fields`,
            field
          });
        }
      }
    }

    // Check dot notation
    if (options.allowDotNotation === false) {
      for (const field of structure.referencedFields) {
        if (field.includes('.')) {
          violations.push({
            type: 'dot_notation',
            message: `Dot notation is not allowed in field names: "${field}"`,
            field
          });
        }
      }
    }

    // Check query depth
    if (options.maxQueryDepth !== undefined) {
      if (structure.depth > options.maxQueryDepth) {
        violations.push({
          type: 'depth_exceeded',
          message: `Query depth (${structure.depth}) exceeds maximum allowed (${options.maxQueryDepth})`
        });
      } else if (structure.depth >= options.maxQueryDepth * 0.8) {
        warnings.push({
          type: 'approaching_depth_limit',
          message: `Query depth (${structure.depth}) is approaching the limit (${options.maxQueryDepth})`,
          current: structure.depth,
          limit: options.maxQueryDepth
        });
      }
    }

    // Check clause count
    if (options.maxClauseCount !== undefined) {
      if (structure.clauseCount > options.maxClauseCount) {
        violations.push({
          type: 'clause_limit',
          message: `Clause count (${structure.clauseCount}) exceeds maximum allowed (${options.maxClauseCount})`
        });
      } else if (structure.clauseCount >= options.maxClauseCount * 0.8) {
        warnings.push({
          type: 'approaching_clause_limit',
          message: `Clause count (${structure.clauseCount}) is approaching the limit (${options.maxClauseCount})`,
          current: structure.clauseCount,
          limit: options.maxClauseCount
        });
      }
    }

    // Add complexity warning
    if (structure.complexity === 'complex') {
      warnings.push({
        type: 'complex_query',
        message: 'This query is complex and may impact performance'
      });
    }

    return {
      passed: violations.length === 0,
      violations,
      warnings
    };
  }

  /**
   * Generate autocomplete suggestions based on cursor position
   */
  private generateAutocompleteSuggestions(
    query: string,
    cursorPosition: number,
    activeToken: IQueryToken | undefined,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    // Determine context based on active token and position
    if (!activeToken) {
      // Cursor is not in a token - check if we're at the start or between tokens
      if (query.trim().length === 0 || cursorPosition === 0) {
        return this.suggestForEmptyContext(schema);
      }
      // Between tokens - suggest logical operators or new field
      return this.suggestBetweenTokens(schema);
    }

    if (activeToken.type === 'operator') {
      // Cursor is in a logical operator
      return {
        context: 'logical_operator',
        logicalOperators: ['AND', 'OR', 'NOT'],
        replaceText: activeToken.raw,
        replaceRange: {
          start: activeToken.startPosition,
          end: activeToken.endPosition
        }
      };
    }

    // Active token is a term
    const term = activeToken;
    const relativePos = cursorPosition - term.startPosition;

    // Determine if cursor is in key, operator, or value part
    if (term.key !== null && term.operator !== null) {
      const keyLength = term.key.length;
      const operatorLength = term.operator.length;

      if (relativePos < keyLength) {
        // Cursor is in the field name
        return this.suggestFields(term.key, schema);
      } else if (relativePos < keyLength + operatorLength) {
        // Cursor is in the operator
        return this.suggestOperators(term.key, schema);
      } else {
        // Cursor is in the value
        return this.suggestValues(term.key, term.value, schema);
      }
    } else if (term.key !== null) {
      // Only key present (incomplete)
      return this.suggestFields(term.key, schema);
    } else {
      // Bare value - could be a field name
      return this.suggestFields(term.value || '', schema);
    }
  }

  /**
   * Suggest for empty/start context
   */
  private suggestForEmptyContext(
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    return {
      context: 'empty',
      fields: this.getFieldSuggestions('', schema),
      logicalOperators: ['NOT']
    };
  }

  /**
   * Suggest between tokens (after a complete term)
   */
  private suggestBetweenTokens(
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    return {
      context: 'logical_operator',
      fields: this.getFieldSuggestions('', schema),
      logicalOperators: ['AND', 'OR', 'NOT']
    };
  }

  /**
   * Suggest field names
   */
  private suggestFields(
    partial: string,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    return {
      context: 'field',
      fields: this.getFieldSuggestions(partial, schema),
      replaceText: partial,
      replaceRange:
        partial.length > 0 ? { start: 0, end: partial.length } : undefined
    };
  }

  /**
   * Get field suggestions based on partial input
   */
  private getFieldSuggestions(
    partial: string,
    schema?: Record<string, IFieldSchema>
  ): IFieldSuggestion[] {
    if (!schema) {
      return [];
    }

    const partialLower = partial.toLowerCase();
    const suggestions: IFieldSuggestion[] = [];

    for (const [field, fieldSchema] of Object.entries(schema)) {
      const fieldLower = field.toLowerCase();
      let score = 0;

      if (partial.length === 0) {
        // No partial - suggest all fields with base score
        score = 50;
      } else if (fieldLower === partialLower) {
        // Exact match
        score = 100;
      } else if (fieldLower.startsWith(partialLower)) {
        // Prefix match
        score = 80 + (partial.length / field.length) * 20;
      } else if (fieldLower.includes(partialLower)) {
        // Contains match
        score = 60;
      } else {
        // Check Levenshtein distance for typos
        const distance = this.levenshteinDistance(partialLower, fieldLower);
        if (distance <= 2) {
          score = 40 - distance * 10;
        }
      }

      if (score > 0) {
        suggestions.push({
          field,
          type: fieldSchema.type,
          description: fieldSchema.description,
          score
        });
      }
    }

    // Sort by score descending
    return suggestions.sort((a, b) => b.score - a.score);
  }

  /**
   * Suggest operators
   */
  private suggestOperators(
    field: string,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    const fieldType = schema?.[field]?.type;
    const operators = this.getOperatorSuggestions(fieldType);

    return {
      context: 'operator',
      currentField: field,
      operators
    };
  }

  /**
   * Get operator suggestions based on field type
   */
  private getOperatorSuggestions(fieldType?: string): IOperatorSuggestion[] {
    const allOperators: IOperatorSuggestion[] = [
      { operator: ':', description: 'equals', applicable: true },
      { operator: ':!=', description: 'not equals', applicable: true },
      {
        operator: ':>',
        description: 'greater than',
        applicable: fieldType === 'number' || fieldType === 'date'
      },
      {
        operator: ':>=',
        description: 'greater than or equal',
        applicable: fieldType === 'number' || fieldType === 'date'
      },
      {
        operator: ':<',
        description: 'less than',
        applicable: fieldType === 'number' || fieldType === 'date'
      },
      {
        operator: ':<=',
        description: 'less than or equal',
        applicable: fieldType === 'number' || fieldType === 'date'
      }
    ];

    // Sort applicable operators first
    return allOperators.sort((a, b) => {
      if (a.applicable && !b.applicable) return -1;
      if (!a.applicable && b.applicable) return 1;
      return 0;
    });
  }

  /**
   * Suggest values
   */
  private suggestValues(
    field: string,
    partialValue: string | null,
    schema?: Record<string, IFieldSchema>
  ): IAutocompleteSuggestions {
    const fieldSchema = schema?.[field];
    const values = this.getValueSuggestions(partialValue || '', fieldSchema);

    return {
      context: 'value',
      currentField: field,
      values,
      replaceText: partialValue || undefined
    };
  }

  /**
   * Get value suggestions based on schema
   */
  private getValueSuggestions(
    partial: string,
    fieldSchema?: IFieldSchema
  ): IValueSuggestion[] {
    if (!fieldSchema?.allowedValues) {
      // Suggest based on type
      if (fieldSchema?.type === 'boolean') {
        return [
          { value: true, label: 'true', score: 100 },
          { value: false, label: 'false', score: 100 }
        ];
      }
      return [];
    }

    const partialLower = partial.toLowerCase();
    const suggestions: IValueSuggestion[] = [];

    for (const value of fieldSchema.allowedValues) {
      const valueStr = String(value).toLowerCase();
      let score = 0;

      if (partial.length === 0) {
        score = 50;
      } else if (valueStr === partialLower) {
        score = 100;
      } else if (valueStr.startsWith(partialLower)) {
        score = 80;
      } else if (valueStr.includes(partialLower)) {
        score = 60;
      }

      if (score > 0) {
        suggestions.push({
          value,
          label: String(value),
          score
        });
      }
    }

    return suggestions.sort((a, b) => b.score - a.score);
  }

  /**
   * Generate error recovery suggestions
   */
  private generateErrorRecovery(
    query: string,
    structure: IQueryStructure
  ): IErrorRecovery {
    const delimiters = measureQueryDelimiters(query);
    if (delimiters.unclosedQuote) {
      const quote = delimiters.unclosedQuote.quote;
      if (quote === "'") {
        return {
          issue: 'unclosed_quote',
          message: 'Unclosed single quote detected',
          suggestion: "Add a closing ' to complete the quoted value",
          autofix: query + "'",
          position: delimiters.unclosedQuote.position
        };
      }
      return {
        issue: 'unclosed_quote',
        message: 'Unclosed double quote detected',
        suggestion: 'Add a closing " to complete the quoted value',
        autofix: query + '"',
        position: delimiters.unclosedQuote.position
      };
    }
    if (!structure.hasBalancedParentheses) {
      const openCount = delimiters.openParentheses;
      const closeCount = delimiters.closeParentheses;
      if (openCount > closeCount) {
        return {
          issue: 'unclosed_parenthesis',
          message: `Missing ${openCount - closeCount} closing parenthesis`,
          suggestion: 'Add closing parenthesis to balance the expression',
          autofix: query + ')'.repeat(openCount - closeCount)
        };
      }
      return {
        issue: 'unclosed_parenthesis',
        message: `Extra ${closeCount - openCount} closing parenthesis`,
        suggestion: 'Remove extra closing parenthesis'
      };
    }
    const trailingOperator = findTrailingLogicalOperator(query);
    if (trailingOperator) {
      const trimmed = query.trimEnd();
      const written = trimmed.slice(
        trailingOperator.position,
        trailingOperator.position + trailingOperator.operator.length
      );
      const recovery: IErrorRecovery = {
        issue: 'trailing_operator',
        message: `Query ends with incomplete "${written}" operator`,
        suggestion: 'Add a condition after the operator or remove it'
      };
      // Dropping a trailing AND or OR leaves the clause the user typed.
      // Dropping a trailing NOT would run the clause it was about to negate,
      // so tolerant execution must not retry `status:open NOT` as `status:open`.
      if (trailingOperator.operator !== 'NOT') {
        recovery.autofix = trimmed.slice(0, trailingOperator.position).trim();
      }
      return recovery;
    }
    const trimmed = query.trim();
    if (/:$/.test(trimmed) || /:\s*$/.test(trimmed)) {
      return {
        issue: 'missing_value',
        message: 'Field is missing a value',
        suggestion: 'Add a value after the colon'
      };
    }

    // Generic syntax error
    return {
      issue: 'syntax_error',
      message: 'Query contains a syntax error',
      suggestion: 'Check the query syntax and try again'
    };
  }
}
