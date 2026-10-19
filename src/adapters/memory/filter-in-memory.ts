import { QueryParser } from '../../parser';
import { IParserOptions } from '../../parser/types';
import { filterByExpression } from './match-expression';
import { IInMemoryFilterOptions } from './types';

/**
 * Filter plain objects with a QueryKit query string.
 *
 * The string is parsed by the existing `QueryParser`. Rows are kept when
 * they satisfy the same operators the Drizzle translator emits: `==` is
 * equality, and `*` / `?` are SQL LIKE. This function does not parse a
 * second grammar, rank rows, or build an index.
 *
 * `status:active` keeps `active` and drops `inactive`. `priority:2` keeps
 * `2` and drops `12`. A quoted `*` and an unquoted `*` are both LIKE.
 *
 * The rows have no table, so the column of any single `table.column` is
 * read; pass `options.tableScope` to check the qualifier.
 *
 * @param query QueryKit query string
 * @param records Rows to filter. Matches keep their original order and identity.
 * @param parserOptions Field mappings and case-insensitive field names
 * @param options The shared security checks (allowlist, value length, depth
 * and clause caps, enforced exclusions), run on the parsed query before any
 * row is read, plus adapter-style field mappings applied after them
 * @returns The subset of `records` that match the Drizzle predicate
 * @throws {QueryParseError} When `query` is not valid QueryKit syntax
 * @throws {QuerySecurityError} When the query breaks a cap or names a field
 * outside `options.allowedFields`, with the validator's wording
 * @throws {InMemoryAdapterError} When the parsed expression cannot be applied
 * in memory (REGEX, raw SQL, a non-string LIKE, a non-array IN / NOT IN, or a
 * missing operand). This is checked before any row is read.
 *
 * @example
 * const open = filterInMemory('status:done AND priority:>2', tasks);
 * const safe = filterInMemory('status:done', tasks, undefined, {
 *   allowedFields: ['status']
 * });
 */
export function filterInMemory<T extends object>(
  query: string,
  records: readonly T[],
  parserOptions?: IParserOptions,
  options: IInMemoryFilterOptions = {}
): T[] {
  const expression = new QueryParser(parserOptions).parse(query);
  return filterByExpression(expression, records, options);
}
