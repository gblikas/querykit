/**
 * Error thrown when a QueryBuilder call cannot be written as query text.
 *
 * The builder emits a Liqe string, and a value with no Liqe spelling, such
 * as a non-finite number, would otherwise come back from the parser as a
 * different value or a syntax error.
 *
 * @example
 * ```typescript
 * try {
 *   createQueryBuilder().where('score', '==', NaN);
 * } catch (error) {
 *   if (error instanceof QueryBuilderError) {
 *     console.error(error.message); // Non-finite numbers are not supported. Got: NaN
 *   }
 * }
 * ```
 */
export class QueryBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryBuilderError';
  }
}
