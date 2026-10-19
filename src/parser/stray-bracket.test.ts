/**
 * Stray brackets.
 *
 * A bracket the parser's rewrite does not consume reaches Liqe, which only
 * reads `[decimal TO decimal]` after a comparison operator. A `[`, `]`, `{`
 * or `}` anywhere else, including inside an unquoted list member, is a
 * syntax error. Brackets inside quotes, regex, ranges and membership lists
 * stay values.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a', count: 3 },
  { id: 2, status: 'b', count: 3 }
];

describe('stray bracket', () => {
  const parser = new QueryParser();

  it.each([
    'status:a]',
    ']',
    'status:a[b]',
    '[status:a]',
    'status:in {}',
    'status:[[a]]',
    'status:]',
    'status:a ]',
    ']status:a',
    'status:a [b]',
    'status:a AND [status:b]',
    '[1 TO 5]',
    'status:[a]]',
    'status:in[a]]',
    'status:in {a}',
    'status:in{a}',
    'status:not in {}',
    'status:[{a}]',
    'status:[a, [b]]',
    'status:[a, {b}]',
    'status:{a, [b]}',
    'count:>[a TO b]',
    'count:>[1 to 5]',
    'count:>[1  TO 5]',
    'count:>[ 1 TO 5 ]',
    'count:>[1, 5]',
    'count:>[5]',
    'count:>[1 TO',
    'count:>[1 TO 5]]',
    'count:>[[1 TO 5]]'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.success).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  const RANGE_SQL = `(("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" >= 1) OR (typeof("count") = 'text')) AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" <= 5))`;

  it.each([
    ['count:>[1 TO 5]', RANGE_SQL, [1, 2]],
    ['count:=[1 TO 5]', RANGE_SQL, [1, 2]],
    ['count:>=[1 TO 5]', RANGE_SQL, [1, 2]],
    ['count:<[1 TO 5]', RANGE_SQL, [1, 2]],
    ['count:<=[1 TO 5]', RANGE_SQL, [1, 2]],
    ['"count":>[1 TO 5]', RANGE_SQL, [1, 2]],
    ['(count:>[1 TO 5])', RANGE_SQL, [1, 2]],
    ['count:>[+1 TO 5]', RANGE_SQL, [1, 2]],
    ['count:>[1. TO 5]', RANGE_SQL, [1, 2]],
    ['count:>[1e0 TO 5e0]', RANGE_SQL, [1, 2]],
    [
      'count:>[.5 TO 5]',
      `(("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" >= 0.5) OR (typeof("count") = 'text')) AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" <= 5))`,
      [1, 2]
    ],
    [
      'count:>{1 TO 3}',
      `(("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" > 1) OR (typeof("count") = 'text')) AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" < 3))`,
      []
    ],
    [
      '-count:>[1 TO 5]',
      `NOT ((("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" >= 1) OR (typeof("count") = 'text')) AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" <= 5)))`,
      []
    ],
    [
      'NOT count:>[1 TO 5]',
      `NOT ((("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" >= 1) OR (typeof("count") = 'text')) AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" <= 5)))`,
      []
    ],
    ['status:[a TO b]', `("status" >= 'a') AND ("status" <= 'b')`, [1, 2]],
    ['status:{a TO b}', `("status" > 'a') AND ("status" < 'b')`, []],
    ['status:in [a, b]', `"status" IN ('a', 'b')`, [1, 2]],
    ['status:in[[a]]', `"status" IN ('[a]')`, []],
    ['status:in[a, b:[]]', `"status" IN ('a', 'b:[]')`, [1]],
    ['status:[[a] TO b]', `("status" >= '[a]') AND ("status" <= 'b')`, [1, 2]],
    ['status:[[a TO b]]', `("status" >= '[a') AND ("status" <= 'b]')`, [1, 2]],
    ['status:[[a b]]', `"status" = '[a b]'`, []],
    ['status:["[a]"]', `"status" = '[a]'`, []],
    ['status:"a]"', `"status" = 'a]'`, []]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each(['status:/[a]/', 'status:/a]/'])('keeps %p a regex', query => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
  });
});
