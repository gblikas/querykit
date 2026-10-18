import {
  IComparisonExpression,
  QueryExpression,
  QueryValue
} from '../parser/types';
import {
  DEFAULT_SECURITY_OPTIONS,
  DeniedValue,
  EnforcedExclusions,
  ISecurityOptions
} from './types';

/**
 * Error thrown when a query violates security constraints
 *
 * This error is thrown when a query attempts to bypass security settings
 * such as accessing unauthorized fields, exceeding complexity limits,
 * or using potentially dangerous patterns.
 *
 * @example
 * ```typescript
 * try {
 *   queryValidator.validate(parsedQuery);
 * } catch (error) {
 *   if (error instanceof QuerySecurityError) {
 *     console.error('Security violation:', error.message);
 *     // Return appropriate error response to client
 *   }
 * }
 * ```
 */
export class QuerySecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuerySecurityError';
  }
}

/**
 * The one message every field rejection uses, so a caller cannot tell a
 * denied field from an unlisted one and enumerate the schema.
 */
const INVALID_QUERY_PARAMETERS = 'Invalid query parameters';

/** Largest membership list any engine accepts. Not an option. */
const MAX_ARRAY_ITEMS = 100;

/**
 * Collect the field name of every comparison under a node. A missing node,
 * which an empty expression or a logical node with no left operand produces,
 * contributes nothing, so the caller keeps its own error for that shape.
 */
function collectFieldNames(
  expression: QueryExpression | null | undefined,
  fieldSet: Set<string>
): void {
  if (!expression) {
    return;
  }
  if (expression.type === 'comparison') {
    fieldSet.add(expression.field);
  } else if (expression.type === 'logical') {
    collectFieldNames(expression.left, fieldSet);
    collectFieldNames(expression.right, fieldSet);
  }
  // Raw expressions don't expose field names for collection
}

/**
 * Whether a field is on an allowlist. The match is exact: the allowlist
 * ignores neither ASCII case nor a `table.` qualifier, so `status` admits
 * neither `STATUS` nor `items.status`. `createQueryKit` closes the list
 * under `fieldMappings` (see `aliasSecurityFields`) and, under
 * `caseInsensitiveFields`, respells it by the schema before this comparison;
 * the `parseWithContext` pre-check matches by this same function over the
 * same closed list.
 *
 * @param field - The field as the parser resolved it
 * @param allowedNames - The allowlist entries
 * @returns True when the field is an entry
 *
 * @example
 * ```typescript
 * isAllowedName('status', new Set(['status'])); // true
 * isAllowedName('STATUS', new Set(['status'])); // false
 * ```
 */
export function isAllowedName(
  field: string,
  allowedNames: ReadonlySet<string>
): boolean {
  return allowedNames.has(field);
}

/**
 * Reject a query that names a field outside a non-empty allowlist. An
 * omitted or empty list allows every field, which is the default. Every
 * engine calls this before it builds SQL or walks rows, with the same
 * wording the validator uses, so a field the kit would reject is rejected
 * by a translator or an adapter used on its own too.
 *
 * @param expression - The parsed query, or nothing when the caller has its
 * own error for a missing node
 * @param allowedFields - The allowlist; omitted or empty allows every field
 * @throws {QuerySecurityError} `Invalid query parameters` for a field outside
 * the list
 *
 * @example
 * ```typescript
 * assertAllowedFields(parser.parse('status:open'), ['status']); // returns
 * assertAllowedFields(parser.parse('secret:1'), ['status']); // throws
 * ```
 */
export function assertAllowedFields(
  expression: QueryExpression | null | undefined,
  allowedFields?: readonly string[]
): void {
  if (!expression || !allowedFields || allowedFields.length === 0) {
    return;
  }
  const allowedNames = new Set<string>(allowedFields);
  const fields = new Set<string>();
  collectFieldNames(expression, fields);
  for (const field of fields) {
    if (!isAllowedName(field, allowedNames)) {
      throw new QuerySecurityError(INVALID_QUERY_PARAMETERS);
    }
  }
}

/**
 * Reject a membership list longer than the 100-item cap. The cap is not an
 * option and does not move with `maxValueLength`.
 *
 * @param value - A comparison value; anything but an array is ignored
 * @throws {QuerySecurityError} `Array values cannot exceed 100 items`
 */
function rejectOversizedArray(value: unknown): void {
  if (Array.isArray(value) && value.length > MAX_ARRAY_ITEMS) {
    throw new QuerySecurityError(
      `Array values cannot exceed ${MAX_ARRAY_ITEMS} items`
    );
  }
}

/**
 * Check one comparison value: a string against the cap, a list against the
 * item cap first and then each string member against the cap, and no object
 * anywhere.
 */
function assertComparisonValueLength(
  value: QueryValue,
  maxValueLength: number
): void {
  if (typeof value === 'string') {
    if (value.length > maxValueLength) {
      throw new QuerySecurityError(
        `Query contains a string value that exceeds maximum length of ${maxValueLength} characters`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    rejectOversizedArray(value);
    for (const item of value) {
      if (typeof item === 'string' && item.length > maxValueLength) {
        throw new QuerySecurityError(
          `Query contains a string value in array that exceeds maximum length of ${maxValueLength} characters`
        );
      }
      if (typeof item === 'object' && item !== null) {
        throw new QuerySecurityError('Object values are not allowed in arrays');
      }
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    throw new QuerySecurityError('Object values are not allowed');
  }
}

/**
 * Reject a string value longer than `maxValueLength`, a membership list of
 * more than 100 items, or a list member longer than the cap, with the
 * validator's wording. The list cap is checked before the members, so a long
 * list is rejected before a long string inside it. Every engine calls this
 * before it builds SQL or walks rows; a caller that raised the cap passes it
 * so the raised limit is not forced back to the default.
 *
 * @param expression - The parsed query, or nothing when the caller has its
 * own error for a missing node
 * @param maxValueLength - The cap, default 1000
 * @throws {QuerySecurityError} For an over-long string or list
 *
 * @example
 * ```typescript
 * assertMaxValueLength(parser.parse(`label:"${'a'.repeat(1001)}"`)); // throws
 * assertMaxValueLength(parser.parse(`label:"${'a'.repeat(1001)}"`), 1001);
 * ```
 */
export function assertMaxValueLength(
  expression: QueryExpression | null | undefined,
  maxValueLength: number = DEFAULT_SECURITY_OPTIONS.maxValueLength
): void {
  if (!expression) {
    return;
  }
  if (expression.type === 'comparison') {
    assertComparisonValueLength(expression.value, maxValueLength);
  } else if (expression.type === 'logical') {
    assertMaxValueLength(expression.left, maxValueLength);
    assertMaxValueLength(expression.right, maxValueLength);
  }
  // Raw expressions are skipped - they handle their own values
}

/**
 * The depth cap to enforce: the given cap, or the default of 10.
 *
 * @param maxQueryDepth - A caller's cap, if any
 * @returns The cap to pass to `assertQueryComplexity`
 */
export function resolveMaxQueryDepth(maxQueryDepth?: number): number {
  return maxQueryDepth ?? DEFAULT_SECURITY_OPTIONS.maxQueryDepth;
}

/**
 * The clause cap to enforce: the given cap, or the default of 50.
 *
 * @param maxClauseCount - A caller's cap, if any
 * @returns The cap to pass to `assertQueryComplexity`
 */
export function resolveMaxClauseCount(maxClauseCount?: number): number {
  return maxClauseCount ?? DEFAULT_SECURITY_OPTIONS.maxClauseCount;
}

/**
 * Depth of a node: each logical node adds one level and a comparison adds
 * none, so `n` comparisons joined in a chain have depth `n - 1`.
 */
function measureQueryDepth(
  expression: QueryExpression | null | undefined
): number {
  if (!expression || expression.type !== 'logical') {
    return 0;
  }
  return (
    1 +
    Math.max(
      measureQueryDepth(expression.left),
      measureQueryDepth(expression.right)
    )
  );
}

/**
 * Number of clauses under a node. A comparison and a raw expression each
 * count as one.
 */
function countClauses(expression: QueryExpression | null | undefined): number {
  if (!expression) {
    return 0;
  }
  if (expression.type !== 'logical') {
    return 1;
  }
  return countClauses(expression.left) + countClauses(expression.right);
}

/**
 * Reject a query deeper than `maxQueryDepth` or with more than
 * `maxClauseCount` clauses, with the validator's wording. Depth is counted
 * one level per logical node; a clause is one comparison. Every engine calls
 * this before it builds SQL or walks rows, after the value-length check; a
 * caller that raised a cap passes it.
 *
 * @param expression - The parsed query, or nothing when the caller has its
 * own error for a missing node
 * @param maxQueryDepth - The depth cap, default 10
 * @param maxClauseCount - The clause cap, default 50
 * @throws {QuerySecurityError} `Query exceeds maximum depth of N` or
 * `Query exceeds maximum clause count of N (found M)`
 *
 * @example
 * ```typescript
 * assertQueryComplexity(deepQuery, resolveMaxQueryDepth(options.maxQueryDepth));
 * ```
 */
export function assertQueryComplexity(
  expression: QueryExpression | null | undefined,
  maxQueryDepth: number = DEFAULT_SECURITY_OPTIONS.maxQueryDepth,
  maxClauseCount: number = DEFAULT_SECURITY_OPTIONS.maxClauseCount
): void {
  if (!expression) {
    return;
  }
  if (measureQueryDepth(expression) > maxQueryDepth) {
    throw new QuerySecurityError(
      `Query exceeds maximum depth of ${maxQueryDepth}`
    );
  }
  const count = countClauses(expression);
  if (count > maxClauseCount) {
    throw new QuerySecurityError(
      `Query exceeds maximum clause count of ${maxClauseCount} (found ${count})`
    );
  }
}

/**
 * Inject enforced exclusion filters into a query expression.
 *
 * For each own key of `enforceExcludedValues` with at least one value,
 * appends `AND field NOT IN (values)` to the expression, so those records are
 * never returned regardless of what the user queried. An omitted or empty
 * map, or an empty value list, returns the expression as given.
 *
 * `createQueryKit` applies this after security validation, so the exclusions
 * are invisible to the validator; a translator or adapter used on its own
 * applies it when it is given the map, after the allowlist and complexity
 * checks.
 *
 * @param expression - The original query expression
 * @param enforceExcludedValues - Map of field to excluded values
 * @returns A new expression with the exclusion filters AND-ed in, or the
 * original when nothing is injected
 *
 * @example
 * ```typescript
 * applyEnforcedExclusions(parser.parse('status:open'), { secret: [1] });
 * // status == "open" AND secret NOT IN [1]
 * ```
 */
export function applyEnforcedExclusions(
  expression: QueryExpression,
  enforceExcludedValues?: EnforcedExclusions
): QueryExpression {
  if (!enforceExcludedValues) {
    return expression;
  }
  const entries = Object.entries(enforceExcludedValues).filter(
    ([, values]) => values.length > 0
  );
  if (entries.length === 0) {
    return expression;
  }
  const exclusions: QueryExpression[] = entries.map(([field, values]) => ({
    type: 'comparison' as const,
    field,
    operator: 'NOT IN' as const,
    value: values
  }));
  return exclusions.reduce<QueryExpression>(
    (acc, exclusion) => ({
      type: 'logical' as const,
      operator: 'AND' as const,
      left: acc,
      right: exclusion
    }),
    expression
  );
}

/**
 * Fold `A-Z` to `a-z` and nothing else, the case rule SQLite applies to an
 * identifier and both adapters apply when they resolve a field to a column.
 */
function foldAsciiCase(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

/**
 * The spellings under which a deny-list entry or a field is matched: the
 * name with `A-Z` folded to `a-z`, plus the column part of a single
 * `table.column` qualifier folded the same way. A name with no dot, with
 * more than one dot, or with an empty side is one spelling, since no adapter
 * resolves it to a column by any other. The `parseWithContext` deny
 * pre-check matches by these same forms.
 *
 * @param name - A deny-list entry, a `denyValues` key, or a query field
 * @returns One or two spellings
 *
 * @example
 * ```typescript
 * deniedNameForms('Items.Secret'); // ['items.secret', 'secret']
 * deniedNameForms('SECRET'); // ['secret']
 * deniedNameForms('a.b.secret'); // ['a.b.secret']
 * ```
 */
export function deniedNameForms(name: string): string[] {
  const folded = foldAsciiCase(name);
  const parts = folded.split('.');
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
    return [folded, parts[1]];
  }
  return [folded];
}

/**
 * The union of `deniedNameForms` over every entry of a deny list.
 *
 * @param denyFields - The configured `denyFields`
 * @returns Every spelling the list denies
 *
 * @example
 * ```typescript
 * deniedNameSet(['SECRET', 'items.token']);
 * // Set { 'secret', 'items.token', 'token' }
 * ```
 */
export function deniedNameSet(denyFields: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const entry of denyFields) {
    for (const form of deniedNameForms(entry)) {
      names.add(form);
    }
  }
  return names;
}

/**
 * Whether a deny list names a field: true when one of the field's
 * `deniedNameForms` is in the set, so an entry matches regardless of ASCII
 * case and of a single `table.` qualifier on either side.
 *
 * @param field - The field as the parser resolved it
 * @param deniedNames - A `deniedNameSet`
 * @returns True when the field is denied
 *
 * @example
 * ```typescript
 * const denied = deniedNameSet(['secret']);
 * isDeniedName('Items.secret', denied); // true
 * isDeniedName('status', denied); // false
 * ```
 */
export function isDeniedName(
  field: string,
  deniedNames: ReadonlySet<string>
): boolean {
  return deniedNameForms(field).some(form => deniedNames.has(form));
}

/** One `fieldMappings` entry: the alias a query may write and its target. */
interface IFieldAlias {
  alias: string;
  target: string;
}

/** Whether a listed name names a field, under one list's matching rule. */
type NameMatcher = (listed: string, name: string) => boolean;

/**
 * The own entries of a `fieldMappings` map, in map order. A prototype key is
 * never an alias, as the parser never maps one.
 */
function ownFieldAliases(
  fieldMappings: Record<string, string> | undefined
): IFieldAlias[] {
  if (!fieldMappings) {
    return [];
  }
  return Object.keys(fieldMappings).map(alias => ({
    alias,
    target: fieldMappings[alias]
  }));
}

/**
 * Whether a deny-list entry names a field: the two share a denied form.
 */
function namesDeniedField(listed: string, name: string): boolean {
  return isDeniedName(name, deniedNameSet([listed]));
}

/**
 * The matcher for an allowlist entry: exact own-key spelling, as the parser
 * matches a field against `fieldMappings`, folded to lower case under
 * `caseInsensitiveFields` as the parser folds the field first.
 */
function allowlistMatcher(foldsCase: boolean): NameMatcher {
  if (!foldsCase) {
    return (listed: string, name: string): boolean => listed === name;
  }
  return (listed: string, name: string): boolean =>
    listed.toLowerCase() === name.toLowerCase();
}

/**
 * Close a list of names under the aliases: each entry is kept as written and
 * joined by the target of every alias it names and by every alias whose
 * target it names, each name once.
 */
function withAliasedNames(
  names: readonly string[],
  aliases: readonly IFieldAlias[],
  matches: NameMatcher
): string[] {
  const closed: string[] = [];
  const add = (name: string): void => {
    if (!closed.includes(name)) {
      closed.push(name);
    }
  };
  for (const entry of names) {
    add(entry);
    for (const { alias, target } of aliases) {
      if (matches(entry, alias)) {
        add(target);
      }
      if (matches(entry, target)) {
        add(alias);
      }
    }
  }
  return closed;
}

/** The values denied under one spelling of a field. */
type DeniedValueList = DeniedValue[];

/** The union of two value lists, each value once, in first-seen order. */
function uniteDeniedValues(
  existing: readonly DeniedValue[],
  values: readonly DeniedValue[]
): DeniedValueList {
  const united = [...existing];
  for (const value of values) {
    if (!united.includes(value)) {
      united.push(value);
    }
  }
  return united;
}

/**
 * Close the keys of a value map under the aliases: each key is kept as
 * written and joined by the names `withAliasedNames` adds for it, every
 * resulting key carrying that key's values; two keys that land on one name
 * deny the union of their values.
 */
function withRespelledKeys(
  valuesByKey: Record<string, DeniedValueList>,
  aliases: readonly IFieldAlias[]
): Record<string, DeniedValueList> {
  const respelled: Record<string, DeniedValueList> = {};
  for (const key of Object.keys(valuesByKey)) {
    for (const name of withAliasedNames([key], aliases, namesDeniedField)) {
      respelled[name] = uniteDeniedValues(
        respelled[name] ?? [],
        valuesByKey[key]
      );
    }
  }
  return respelled;
}

/**
 * Move an exclusion keyed by an alias under that alias's target, the name
 * both adapters resolve, and keep a key that names no alias as written. Two
 * keys that land on one target exclude the union of their values.
 */
function exclusionTargets(
  exclusions: EnforcedExclusions,
  aliases: readonly IFieldAlias[]
): EnforcedExclusions {
  const resolved: EnforcedExclusions = {};
  for (const key of Object.keys(exclusions)) {
    const named = aliases.find(({ alias }) => namesDeniedField(key, alias));
    const target = named ? named.target : key;
    resolved[target] = uniteDeniedValues(
      resolved[target] ?? [],
      exclusions[key]
    );
  }
  return resolved;
}

/**
 * Resolve security options under a parser's `fieldMappings`, so an alias and
 * its target are one field for every list. `allowedFields` and `denyFields`
 * are closed under the aliases: each entry is kept as written and joined by
 * the target of every alias it names and by every alias whose target it
 * names. An allowlist entry names an alias or a target as the parser matches
 * a field, by exact own-key spelling, folded to lower case under
 * `caseInsensitiveFields`; a deny-list entry names them under
 * `deniedNameForms`, so `HIDDEN` or `items.hidden` closes `secret` too. The
 * keys of `denyValues` are closed the way the deny list is, two keys that
 * land on one name denying the union of their values. An
 * `enforceExcludedValues` key that names an alias moves under the alias's
 * target. An omitted or empty map returns the options as given.
 *
 * `createQueryKit` applies this before it respells the lists by the schema,
 * the order a field is resolved in (fold, map, respell), and forwards the
 * closed `allowedFields` to the adapters.
 *
 * @param options - The resolved security options
 * @param fieldMappings - The parser's `fieldMappings`, if any
 * @param foldsCase - The parser's `caseInsensitiveFields`
 * @returns The options with the lists and maps closed under the aliases
 *
 * @example
 * ```typescript
 * aliasSecurityFields(
 *   { ...DEFAULT_SECURITY_OPTIONS, denyFields: ['hidden'] },
 *   { hidden: 'secret' },
 *   false
 * ).denyFields; // ['hidden', 'secret']
 * ```
 */
export function aliasSecurityFields(
  options: Required<ISecurityOptions>,
  fieldMappings: Record<string, string> | undefined,
  foldsCase: boolean
): Required<ISecurityOptions> {
  const aliases = ownFieldAliases(fieldMappings);
  if (aliases.length === 0) {
    return options;
  }
  return {
    ...options,
    allowedFields: withAliasedNames(
      options.allowedFields,
      aliases,
      allowlistMatcher(foldsCase)
    ),
    denyFields: withAliasedNames(options.denyFields, aliases, namesDeniedField),
    denyValues: withRespelledKeys(options.denyValues, aliases),
    enforceExcludedValues: exclusionTargets(
      options.enforceExcludedValues,
      aliases
    )
  };
}

/**
 * Index a `denyValues` map by every `deniedNameForms` spelling of each own
 * key (ASCII fold, single `table.` qualifier, bare and qualified), so a field
 * is looked up the way `isDeniedName` matches it. A prototype name such as
 * `constructor` is never a key, so it is no deny list.
 */
function deniedValuesByName(
  denyValues: Record<string, DeniedValueList>
): Map<string, DeniedValueList> {
  const byName = new Map<string, DeniedValueList>();
  for (const key of Object.keys(denyValues)) {
    for (const form of deniedNameForms(key)) {
      byName.set(
        form,
        uniteDeniedValues(byName.get(form) ?? [], denyValues[key])
      );
    }
  }
  return byName;
}

/**
 * Validates query expressions against security constraints
 *
 * The QuerySecurityValidator ensures that queries comply with the security
 * rules defined in the ISecurityOptions. It should be used before executing
 * any query to prevent potential security issues or resource exhaustion.
 *
 * @example
 * ```typescript
 * import { QueryParser, QuerySecurityValidator, ISecurityOptions } from '@gblikas/querykit';
 *
 * // Define security options
 * const securityOptions: ISecurityOptions = {
 *   allowedFields: ['id', 'name', 'createdAt'],
 *   denyFields: ['password'],
 *   maxQueryDepth: 5
 * };
 *
 * // Create validator
 * const validator = new QuerySecurityValidator(securityOptions);
 *
 * // Use in API endpoint
 * app.get('/users', (req, res) => {
 *   try {
 *     // Parse the query from request
 *     const queryStr = req.query.filter || '';
 *     const parsedQuery = new QueryParser().parse(queryStr);
 *
 *     // Validate against security rules
 *     validator.validate(parsedQuery, userSchema);
 *
 *     // If validation passes, execute the query
 *     const results = executeQuery(parsedQuery);
 *     res.json(results);
 *   } catch (error) {
 *     if (error instanceof QuerySecurityError) {
 *       res.status(400).json({ error: error.message });
 *     } else {
 *       res.status(500).json({ error: 'Server error' });
 *     }
 *   }
 * });
 * ```
 */
export class QuerySecurityValidator {
  private options: Required<ISecurityOptions>;

  /** Every denied spelling of every `denyFields` entry. */
  private deniedNames: ReadonlySet<string>;

  /** `denyValues` indexed by every spelling of each key. */
  private deniedValues: ReadonlyMap<string, DeniedValueList>;

  /**
   * Creates a new QuerySecurityValidator instance
   *
   * @param options - Security options to apply. If not provided, default options will be used.
   *
   * @example
   * ```typescript
   * // Create with default security settings
   * const defaultValidator = new QuerySecurityValidator();
   *
   * // Create with custom security settings
   * const strictValidator = new QuerySecurityValidator({
   *   maxQueryDepth: 3,
   *   maxClauseCount: 10,
   *   maxValueLength: 500
   * });
   * ```
   */
  constructor(options: ISecurityOptions = {}) {
    this.options = {
      ...DEFAULT_SECURITY_OPTIONS,
      ...options
    };
    this.deniedNames = deniedNameSet(this.options.denyFields);
    this.deniedValues = deniedValuesByName(this.options.denyValues);
  }

  /**
   * Validate a query expression against security constraints
   *
   * This is the main method that should be called before executing any query.
   * It performs all security checks defined in the options.
   *
   * @param expression - The parsed query expression to validate
   * @param schema - Optional schema definition to validate fields against
   * @throws {QuerySecurityError} If the query violates any security constraints
   *
   * @example
   * ```typescript
   * import { QueryParser, QuerySecurityValidator } from '@gblikas/querykit';
   *
   * const validator = new QuerySecurityValidator();
   *
   * // Simple validation
   * try {
   *   const query = new QueryParser().parse('user.name == "John" && user.priority > 2');
   *   validator.validate(query);
   *   // Query is safe to execute
   * } catch (error) {
   *   // Handle security violation
   * }
   *
   * // Validation with schema
   * const userSchema = {
   *   user: {
   *     id: 'number',
   *     name: 'string',
   *     priority: 'number',
   *     email: 'string'
   *   }
   * };
   *
   * try {
   *   const query = new QueryParser().parse('user.email == "john@example.com"');
   *   validator.validate(query, userSchema);
   *   // Query is safe to execute
   * } catch (error) {
   *   // Handle security violation
   * }
   * ```
   */
  public validate(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): void {
    // Check for dot notation if disabled
    if (!this.options.allowDotNotation) {
      this.validateNoDotNotation(expression);
    }

    // Check for field restrictions if specified
    this.validateFields(expression, schema);

    // Check for denied values if specified
    this.validateDenyValues(expression);

    // Check query complexity
    assertQueryComplexity(
      expression,
      this.options.maxQueryDepth,
      this.options.maxClauseCount
    );

    // Check value lengths
    assertMaxValueLength(expression, this.options.maxValueLength);

    // Sanitize wildcard patterns if enabled
    if (this.options.sanitizeWildcards) {
      this.sanitizeWildcards(expression);
    }
  }

  /**
   * Validate that query fields are allowed and not denied
   *
   * A field is denied when `denyFields` names it under `isDeniedName`, that
   * is, regardless of ASCII case and of a single `table.` qualifier on either
   * side. A non-empty `allowedFields` is checked by `assertAllowedFields`,
   * which matches as written; with the list empty, a schema admits its
   * declared names, bare or as `table.field`, and no schema admits every
   * field.
   *
   * @private
   * @param expression - The query expression to validate
   * @param schema - Optional schema definition to validate fields against
   */
  private validateFields(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): void {
    const fieldSet = new Set<string>();
    collectFieldNames(expression, fieldSet);
    for (const field of fieldSet) {
      // Security fix: Generic error to prevent field enumeration attacks
      if (isDeniedName(field, this.deniedNames)) {
        throw new QuerySecurityError(INVALID_QUERY_PARAMETERS);
      }
    }
    if (this.options.allowedFields.length > 0) {
      assertAllowedFields(expression, this.options.allowedFields);
      return;
    }
    if (!schema) {
      return;
    }
    const schemaFields = new Set<string>();
    for (const table in schema) {
      if (typeof schema[table] === 'object') {
        for (const field in schema[table]) {
          schemaFields.add(`${table}.${field}`);
          schemaFields.add(field);
        }
      }
    }
    for (const field of fieldSet) {
      if (schemaFields.size > 0 && !schemaFields.has(field)) {
        throw new QuerySecurityError(INVALID_QUERY_PARAMETERS);
      }
    }
  }

  /**
   * Validate that field names do not contain dot notation
   *
   * When allowDotNotation is disabled, this method ensures no field names
   * contain dots, which could be used for:
   * - Table-qualified column access (e.g., "users.password")
   * - Nested JSON/JSONB field access (e.g., "metadata.secret")
   * - Probing internal table structures
   *
   * @private
   * @param expression - The query expression to validate
   * @throws {QuerySecurityError} If a field name contains dot notation
   */
  private validateNoDotNotation(expression: QueryExpression): void {
    if (expression.type === 'comparison') {
      const { field } = expression;
      if (field.includes('.')) {
        throw new QuerySecurityError(
          `Dot notation is not allowed in field names. ` +
            `Found "${field}" - use a simple field name without dots instead.`
        );
      }
    } else if (expression.type === 'logical') {
      // Recursively validate logical expressions
      this.validateNoDotNotation(expression.left);
      if (expression.right) {
        this.validateNoDotNotation(expression.right);
      }
    }
    // Raw expressions are skipped - they handle their own field access
  }

  /**
   * Validate that query values are not in the denied values list for their field
   *
   * This method checks each comparison expression to ensure the value being
   * queried is not in the denyValues list for that field. This provides
   * granular control over what values can be queried for specific fields.
   * The field is looked up by every spelling `deniedNameForms` gives it, so a
   * key listed under another ASCII case or with or without a single `table.`
   * qualifier still applies.
   *
   * Any query that references a denied value in any form — including with
   * negation operators like `NOT`, `!=`, or `NOT IN` — is rejected. This
   * prevents users from probing or referencing sensitive values at all,
   * rather than relying on operator semantics to determine intent.
   *
   * To guarantee denied records are never returned (e.g. when the user
   * queries a different field), use `enforceExcludedValues` instead,
   * which injects server-side `NOT IN` filters into every query.
   *
   * @private
   * @param expression - The query expression to validate
   * @throws {QuerySecurityError} If a denied value is found in the query
   */
  private validateDenyValues(expression: QueryExpression): void {
    // Skip if no denyValues configured
    if (this.deniedValues.size === 0) {
      return;
    }

    if (expression.type === 'comparison') {
      const { field, value } = expression;
      const deniedValues = this.deniedValuesFor(field);
      if (deniedValues.length === 0) {
        return;
      }
      // An array is an IN / NOT IN list; every member is checked
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (this.isValueDenied(item, deniedValues)) {
          throw new QuerySecurityError(INVALID_QUERY_PARAMETERS);
        }
      }
    } else if (expression.type === 'logical') {
      // Recursively validate logical expressions
      this.validateDenyValues(expression.left);
      if (expression.right) {
        this.validateDenyValues(expression.right);
      }
    }
    // Raw expressions are skipped - they handle their own values
  }

  /**
   * The values `denyValues` denies for a field, under any of the field's
   * spellings; empty when no key names it.
   *
   * @private
   * @param field - The field as the parser resolved it
   * @returns The denied values, each once
   */
  private deniedValuesFor(field: string): DeniedValueList {
    let denied: DeniedValueList = [];
    for (const form of deniedNameForms(field)) {
      const values = this.deniedValues.get(form);
      if (values) {
        denied = uniteDeniedValues(denied, values);
      }
    }
    return denied;
  }

  /**
   * Check if a value is in the denied values list
   *
   * @private
   * @param value - The value to check
   * @param deniedValues - The list of denied values
   * @returns true if the value is denied, false otherwise
   */
  private isValueDenied(
    value: string | number | boolean | null,
    deniedValues: Array<string | number | boolean | null>
  ): boolean {
    // Use strict equality to match values, handling type coercion properly
    return deniedValues.some(deniedValue => {
      // Handle null comparison explicitly
      if (value === null && deniedValue === null) {
        return true;
      }
      // Handle same-type comparison with strict equality
      if (typeof value === typeof deniedValue) {
        return value === deniedValue;
      }
      // Handle string/number comparison (common case)
      if (typeof value === 'string' && typeof deniedValue === 'number') {
        return value === String(deniedValue);
      }
      if (typeof value === 'number' && typeof deniedValue === 'string') {
        return String(value) === deniedValue;
      }
      return false;
    });
  }

  /**
   * Sanitize wildcard patterns in LIKE queries to prevent regex DoS
   * Security: Enhanced to prevent ReDoS attacks via catastrophic backtracking
   *
   * @private
   * @param expression - The query expression to sanitize
   */
  private sanitizeWildcards(expression: QueryExpression): void {
    if (expression.type === 'comparison') {
      const { operator, value } = expression;

      // Only sanitize LIKE operators with string values
      if (operator === 'LIKE' && typeof value === 'string') {
        // Security fix: Count wildcards to prevent ReDoS
        const wildcardCount = (value.match(/[*?]/g) || []).length;
        if (wildcardCount > 10) {
          throw new QuerySecurityError('Excessive wildcard usage');
        }

        // Security fix: Prevent alternating patterns that cause catastrophic backtracking
        // Pattern like "*a*b*c*d*e*f" (alternating * and non-* chars)
        if (/(\*[^*]+){5,}/.test(value)) {
          throw new QuerySecurityError('Complex wildcard patterns not allowed');
        }

        // Enhanced sanitization: limit consecutive wildcards
        const sanitized = value
          .replace(/\*{2,}/g, '*') // Limit consecutive asterisks
          .replace(/\?{2,}/g, '?'); // Limit consecutive question marks
        (expression as IComparisonExpression).value = sanitized;
      }
    } else if (expression.type === 'logical') {
      this.sanitizeWildcards(expression.left);
      if (expression.right) {
        this.sanitizeWildcards(expression.right);
      }
    }
    // Raw expressions are skipped - they handle their own wildcards
  }
}
