/**
 * Glued parentheses and a lone minus.
 *
 * Liqe's implicit operator needs whitespace between two clauses or groups,
 * `NOT` needs whitespace before its operand, and a minus must touch a tag.
 * `AND` and `OR` accept a group with no whitespace. Nothing is inserted, so
 * `(status:open)(label:x)` is not `status:open label:x`.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open', label: 'x' },
  { id: 2, status: 'closed', label: 'x' },
  { id: 3, status: 'open', label: 'y' }
];

describe('glued parentheses and a lone minus', () => {
  const parser = new QueryParser();

  it.each([
    '(status:open)(label:x)',
    'status:open(label:x)',
    '(status:open)label:x',
    '-(status:open)',
    'status:open - label:x',
    'NOT(status:open)',
    '((status:open))(label:x)',
    '(status:open)-label:x',
    '(status:open)NOT label:x',
    '(status:open)ANDlabel:x',
    '(status:open)"label":x',
    'label:"a"(status:open)',
    'status:open NOT(label:x)',
    'not(status:open)',
    'NOT(status:open) AND label:x',
    'label:x NOT(status:open)',
    '-(status:open) AND label:x',
    'label:x AND -(status:open)',
    '-((status:open))',
    '(-(status:open))',
    'status:open -',
    '- status:open',
    '(status:open -)',
    'status:open (- label:x)',
    'status:open AND - label:x',
    'status:open\t- label:x',
    'status:open AND -',
    '-',
    '(-)',
    'status:open\u2003(label:x)',
    '(status:open)\u2003(label:x)',
    'status:open\r(label:x)'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.success).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  const AND_SQL = `("status" = 'open') AND ("label" = 'x')`;

  it.each([
    ['status:open label:x', AND_SQL, [1]],
    ['(status:open) (label:x)', AND_SQL, [1]],
    ['(status:open) label:x', AND_SQL, [1]],
    ['status:open (label:x)', AND_SQL, [1]],
    ['(status:open)\n(label:x)', AND_SQL, [1]],
    ['(status:open)AND label:x', AND_SQL, [1]],
    ['(status:open)and label:x', AND_SQL, [1]],
    ['status:open AND(label:x)', AND_SQL, [1]],
    ['(status:open)AND(label:x)', AND_SQL, [1]],
    [
      '(status:open)OR(label:x)',
      `("status" = 'open') OR ("label" = 'x')`,
      [1, 2, 3]
    ],
    ['(status:open)', `"status" = 'open'`, [1, 3]],
    ['((status:open))', `"status" = 'open'`, [1, 3]],
    ['-status:open', `NOT ("status" = 'open')`, [2]],
    ['-"status":open', `NOT ("status" = 'open')`, [2]],
    ['( -status:open )', `NOT ("status" = 'open')`, [2]],
    ['NOT (status:open)', `NOT ("status" = 'open')`, [2]],
    ['NOT\t(status:open)', `NOT ("status" = 'open')`, [2]],
    [
      'status:open -label:x',
      `("status" = 'open') AND (NOT ("label" = 'x'))`,
      [3]
    ],
    [
      '(status:open) -label:x',
      `("status" = 'open') AND (NOT ("label" = 'x'))`,
      [3]
    ],
    ['status:open label:"(x)"', `("status" = 'open') AND ("label" = '(x)')`, []]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps a minus inside a value or a list', () => {
    for (const query of ['status:-1', 'count:>-1', 'status:[-5 TO 5]']) {
      expect(isInputComplete(query)).toBe(true);
      expect(() => parser.parse(query)).not.toThrow();
    }
    expect(isInputComplete('status:in[1, - 2]')).toBe(true);
    expect(parser.parse('status:in[1, - 2]')).toMatchObject({
      operator: 'IN',
      value: [1, '- 2']
    });
    expect(filterInMemory('status:in[1, - 2]', rows)).toEqual([]);
  });

  it('keeps a regex with parentheses one literal', () => {
    expect(isInputComplete('label:/(x)/ status:open')).toBe(true);
    expect(parser.parse('label:/(x)/ status:open')).toMatchObject({
      type: 'logical',
      operator: 'AND',
      left: { operator: 'REGEX', value: '/(x)/' }
    });
  });
});
