/**
 * The parser barrel's export list.
 *
 * `src/parser/index.ts` re-exports whole modules and the root barrel
 * re-exports it, so a name added to or dropped from a parser module reaches
 * every user of the package, and a module split that loses a name on the
 * way is invisible until a user imports it. This list is the value surface
 * of the parser barrel; a change that adds or drops a name fails here as a
 * visible diff. Type exports leave no trace at runtime and are not pinned.
 */

import * as parserBarrel from './index';

const expectedParserValueExports: readonly string[] = [
  'QueryParseError',
  'QueryParser',
  'extractKeyValue',
  'findTrailingLogicalOperator',
  'getTermAtPosition',
  'isInputComplete',
  'parseQueryInput',
  'parseQueryTokens'
];

describe('the parser barrel export list', () => {
  it('exports exactly the pinned public values', () => {
    const actualParserValueExports = Object.keys(parserBarrel).sort();
    expect(actualParserValueExports).toEqual(expectedParserValueExports);
  });
});
