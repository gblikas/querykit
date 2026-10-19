/**
 * The root export list.
 *
 * `src/index.ts` re-exports whole modules, so a name added to a module
 * barrel reaches every user of the package. This list is the public value
 * surface of the root import; a barrel change that adds or drops a name
 * fails here as a visible diff instead of shipping unnoticed. Type exports
 * leave no trace at runtime and are not pinned.
 */

import * as root from './index';

const expectedRootValueExports: readonly string[] = [
  'DEFAULT_SECURITY_OPTIONS',
  'DrizzleAdapter',
  'DrizzleAdapterError',
  'DrizzleTranslationError',
  'DrizzleTranslator',
  'InMemoryAdapter',
  'InMemoryAdapterError',
  'QueryBuilder',
  'QueryBuilderError',
  'QueryParseError',
  'QueryParser',
  'QuerySecurityError',
  'QuerySecurityValidator',
  'SqlTranslationError',
  'SqlTranslator',
  'createDrizzleQueryKit',
  'createQueryBuilder',
  'createQueryKit',
  'createQueryParser',
  'dateWithinDays',
  'drizzleAdapter',
  'extractKeyValue',
  'filterInMemory',
  'findTrailingLogicalOperator',
  'getTermAtPosition',
  'inMemoryAdapter',
  'isInputComplete',
  'jsonbContains',
  'parseQueryInput',
  'parseQueryTokens',
  'resolveVirtualFields'
];

describe('the root export list', () => {
  it('exports exactly the pinned public values', () => {
    const actualRootValueExports = Object.keys(root).sort();
    expect(actualRootValueExports).toEqual(expectedRootValueExports);
  });
});
