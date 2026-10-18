/**
 * Unicode space next to a logical word.
 *
 * `AND`, `OR` and `NOT` need Liqe whitespace after them, and a Unicode space
 * is a value character to Liqe. A Unicode space the tokenizer skipped,
 * outside every term, is therefore a syntax error; one glued to a value is
 * part of that value on every engine.
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

const EM = '\u2003';

describe('unicode space next to a logical word', () => {
  const parser = new QueryParser();

  it.each([
    `status:open AND${EM}label:x`,
    `NOT${EM}status:open`,
    `status:open\u3000label:x`,
    `status:open AND\u3000label:x`,
    `status:open AND\ufefflabel:x`,
    `status:open OR${EM}label:x`,
    `status:open AND NOT${EM}label:x`,
    `status:open and${EM}label:x`,
    `not${EM}status:open`,
    `NOT\u3000status:open`,
    `NOT\ufeffstatus:open`,
    `NOT${EM}-status:open`,
    `status:open AND${EM}-label:x`,
    `-status:open AND${EM}label:x`,
    `status:open AND ${EM}label:x`,
    `${EM}status:open`,
    'status:open AND\u00a0label:x',
    'NOT\u00a0status:open',
    `status:open AND${EM} label:x`,
    `status:open ${EM}AND label:x`,
    `status:open${EM}AND${EM}label:x`
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
    ['status:open label:x', AND_SQL, [1]],
    ['status:open AND\tlabel:x', AND_SQL, [1]],
    ['status:open AND\nlabel:x', AND_SQL, [1]],
    ['NOT status:open', `NOT ("status" = 'open')`, [2]],
    ['NOT\tstatus:open', `NOT ("status" = 'open')`, [2]],
    [
      'status:open\u00a0AND label:x',
      `("status" = 'open\u00a0AND') AND ("label" = 'x')`,
      []
    ],
    [
      'status:open\ufeffAND label:x',
      `("status" = 'open\ufeffAND') AND ("label" = 'x')`,
      []
    ],
    [
      `status:open${EM}AND label:x`,
      `("status" = 'open${EM}AND') AND ("label" = 'x')`,
      []
    ],
    [
      `status:open${EM} AND label:x`,
      `("status" = 'open${EM}') AND ("label" = 'x')`,
      []
    ],
    [
      `status:open${EM} OR label:x`,
      `("status" = 'open${EM}') OR ("label" = 'x')`,
      [1, 2]
    ],
    [
      `status:open AND label:"x${EM}"`,
      `("status" = 'open') AND ("label" = 'x${EM}')`,
      []
    ]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps a Unicode space inside a bracket list on the list rewrite', () => {
    expect(isInputComplete(`status:in[a,${EM}b]`)).toBe(true);
    expect(parser.parse(`status:in[a,${EM}b]`)).toMatchObject({
      operator: 'IN',
      value: ['a', 'b']
    });
  });
});
