import { QueryParser } from '../../parser';
import { IParserOptions } from '../../parser/types';
import { filterByExpression } from './match-expression';

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
 * @param query QueryKit query string
 * @param records Rows to filter. Matches keep their original order and identity.
 * @param parserOptions Field mappings and case-insensitive field names
 * @returns The subset of `records` that match the Drizzle predicate
 * @throws {QueryParseError} When `query` is not valid QueryKit syntax
 *
 * @example
 * const open = filterInMemory('status:done AND priority:>2', tasks);
 */
export function filterInMemory<T extends object>(
  query: string,
  records: readonly T[],
  parserOptions?: IParserOptions
): T[] {
  const expression = new QueryParser(parserOptions).parse(query);
  return filterByExpression(expression, records);
}
