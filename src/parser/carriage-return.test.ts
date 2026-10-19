/**
 * Carriage return or control character between tokens.
 *
 * Liqe's whitespace is tab, line feed, vertical tab, form feed and space. A
 * carriage return and every other ASCII control character parse nowhere
 * outside a quoted string or a regex, so one outside quotes, regex and
 * bracket lists is a syntax error. The character is not replaced by a space.
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

describe('carriage return and control characters', () => {
  const parser = new QueryParser();

  it.each([
    'status:open AND\rlabel:x',
    'NOT\rstatus:open',
    'status:open\r\nlabel:x',
    'status:open\rAND label:x',
    'status:open\u001flabel:x',
    'status:open\rlabel:x',
    'status:open\r\rlabel:x',
    'status:open \r label:x',
    'status:open OR\rlabel:x',
    'status:open AND NOT\rlabel:x',
    'status:open and\rlabel:x',
    'not\rstatus:open',
    'NOT \rstatus:open',
    '-status:open\rlabel:x',
    'status:open\r-label:x',
    '\rstatus:open',
    'status:open\r',
    'status:open AND label:x\r',
    '"status":\ropen',
    'status:"open"\rlabel:x',
    'status:in[a]\rlabel:x',
    'status:in\r{a}',
    'status:open\u001f label:x',
    'status:open \u001flabel:x',
    'status:open\t\u001flabel:x',
    'status:open AND\u001flabel:x',
    'NOT\u001fstatus:open',
    'status:\u001fopen',
    '\u001fstatus:open',
    'status:open\u001f',
    'status:open\u0000label:x',
    'status:open\u0001label:x',
    'status:open\u001blabel:x',
    'status:open\u007flabel:x',
    'status:open AND\u0000label:x',
    'status:\ropen',
    '(status:open)\rlabel:x'
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
    ['status:open AND label:x', AND_SQL, [1]],
    ['status:open\nlabel:x', AND_SQL, [1]],
    ['status:open\tlabel:x', AND_SQL, [1]],
    ['status:open\vlabel:x', AND_SQL, [1]],
    ['status:open\flabel:x', AND_SQL, [1]],
    ['status:open AND\vlabel:x', AND_SQL, [1]],
    ['NOT status:open', `NOT ("status" = 'open')`, [2]],
    ['NOT\vstatus:open', `NOT ("status" = 'open')`, [2]],
    [
      'status:"open\r" label:x',
      `("status" = 'open\r') AND ("label" = 'x')`,
      []
    ],
    [
      'status:"open\u001f" label:x',
      `("status" = 'open\u001f') AND ("label" = 'x')`,
      []
    ],
    [
      'status:open AND label:"x\r"',
      `("status" = 'open') AND ("label" = 'x\r')`,
      []
    ],
    ['status:in[open\rx]', `"status" IN ('open\rx')`, []],
    ['status:in[open\u001fx]', `"status" IN ('open\u001fx')`, []],
    ['status:in\r[open]', `"status" IN ('open')`, [1, 3]],
    ['status:in[a,\rb]', `"status" IN ('a', 'b')`, []],
    ['count:[1\rTO 5]', `("count" >= 1) AND ("count" <= 5)`, []]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps a control character inside a regex and a C1 control in a value', () => {
    expect(isInputComplete('status:/open\r/')).toBe(true);
    expect(parser.parse('status:/open\r/')).toMatchObject({
      operator: 'REGEX'
    });
    const query = 'status:open\u0085AND label:x';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({
      left: { value: 'open\u0085AND' }
    });
  });
});
