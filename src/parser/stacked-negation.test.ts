/**
 * NOT precedence and stacked negation.
 *
 * `NOT` binds to the clause right after it, `AND` and `OR` share one
 * left-to-right level, and two clauses with no operator are an `AND`.
 * `field:!=value` is rewritten to `NOT field:value` before Liqe sees it, so
 * a `NOT` or a minus stacked on another negation reaches Liqe as `NOT NOT`,
 * which it rejects; the search box is incomplete for the same text.
 */

import { createQueryKit } from '../index';
import { filterInMemory, inMemoryAdapter } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

interface IItem {
  id: number;
  status: string;
  label: string;
}

const rows: IItem[] = [
  { id: 1, status: 'open', label: 'x' },
  { id: 2, status: 'closed', label: 'x' },
  { id: 3, status: 'open', label: 'y' },
  { id: 4, status: 'closed', label: 'y' }
];

describe('stacked negation', () => {
  const parser = new QueryParser();
  const tolerantKit = createQueryKit({
    adapter: inMemoryAdapter({ records: { items: rows } }),
    schema: { items: { id: 'number', status: 'string', label: 'string' } },
    tolerant: true
  });

  async function tolerantIds(query: string): Promise<number[]> {
    const results = await tolerantKit.query('items').where(query).execute();
    return (results as IItem[]).map(row => row.id);
  }

  it.each([
    [
      'NOT status:open AND label:x',
      `(NOT ("status" = 'open')) AND ("label" = 'x')`,
      [2]
    ],
    [
      'NOT status:open OR label:x',
      `(NOT ("status" = 'open')) OR ("label" = 'x')`,
      [1, 2, 4]
    ],
    [
      'label:x AND NOT status:open OR status:closed',
      `(("label" = 'x') AND (NOT ("status" = 'open'))) OR ("status" = 'closed')`,
      [2, 4]
    ],
    ['status:open label:x', `("status" = 'open') AND ("label" = 'x')`, [1]],
    [
      'status:open OR label:x AND status:closed',
      `(("status" = 'open') OR ("label" = 'x')) AND ("status" = 'closed')`,
      [2]
    ],
    [
      'NOT status:open label:x',
      `(NOT ("status" = 'open')) AND ("label" = 'x')`,
      [2]
    ],
    [
      'status:open NOT label:x',
      `("status" = 'open') AND (NOT ("label" = 'x'))`,
      [3]
    ],
    [
      '-status:open AND label:x',
      `(NOT ("status" = 'open')) AND ("label" = 'x')`,
      [2]
    ],
    [
      'not status:open and label:x',
      `(NOT ("status" = 'open')) AND ("label" = 'x')`,
      [2]
    ],
    [
      'NOT (status:open AND label:x)',
      `NOT (("status" = 'open') AND ("label" = 'x'))`,
      [2, 3, 4]
    ],
    [
      'NOT (status:!=open) AND label:x',
      `(NOT (NOT ("status" = 'open'))) AND ("label" = 'x')`,
      [1]
    ],
    [
      'NOT (-status:open) AND label:x',
      `(NOT (NOT ("status" = 'open'))) AND ("label" = 'x')`,
      [1]
    ],
    [
      'NOT status:open AND -label:x',
      `(NOT ("status" = 'open')) AND (NOT ("label" = 'x'))`,
      [4]
    ],
    [
      'status:!=open AND label:x',
      `(NOT ("status" = 'open')) AND ("label" = 'x')`,
      [2]
    ],
    [
      '-status:open OR label:x',
      `(NOT ("status" = 'open')) OR ("label" = 'x')`,
      [1, 2, 4]
    ],
    [
      'NOT status:-1 AND label:x',
      `(NOT (("status" IS NULL AND NULL) OR (typeof("status") IN ('integer', 'real') AND "status" = -1))) AND ("label" = 'x')`,
      [1, 2]
    ],
    [
      'label:"NOT -x" AND status:open',
      `("label" = 'NOT -x') AND ("status" = 'open')`,
      []
    ]
  ])('keeps %p complete, parsed as %p', async (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(parser.parseWithContext(query).ast).toEqual(expression);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    await expect(tolerantIds(query)).resolves.toEqual(ids);
  });

  it.each([
    ['NOT status:!=open AND label:x', 8],
    ['NOT status:!=open OR label:x', 8],
    ['label:x AND NOT status:!=open OR status:closed', 20],
    ['NOT -status:open AND label:x', 6],
    ['NOT -status:open OR label:x', 6],
    ['label:x AND NOT -status:open OR status:closed', 18],
    ['status:open AND NOT -label:x', 22],
    ['-NOT status:open AND label:x', 5],
    ['-status:!=open AND label:x', 5],
    ['status:open AND -label:!=x', 21],
    ['not status:!=open and label:x', 8],
    ['NOT  -status:open AND label:x', 7],
    ['NOT\tstatus:!=open AND label:x', 8],
    ['NOT "status":!=open AND label:x', 8],
    ['NOT status:!=open label:x', 8],
    ['label:x NOT -status:open', 14],
    ['NOT NOT status:open AND label:x', 8],
    ['--status:open AND label:x', 3]
  ])('treats %p as incomplete and rejected', async (query, column) => {
    expect(isInputComplete(query)).toBe(false);
    const message = `Syntax error at line 1 column ${column}`;
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.success).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(context.recovery?.autofix).toBeUndefined();
    await expect(tolerantIds(query)).rejects.toThrow(message);
  });

  it('keeps a regex holding NOT and a minus one literal', () => {
    expect(isInputComplete('label:/NOT -x/ AND status:open')).toBe(true);
    expect(parser.parse('label:/NOT -x/ AND status:open')).toMatchObject({
      type: 'logical',
      operator: 'AND',
      left: { field: 'label', operator: 'REGEX', value: '/NOT -x/' },
      right: { field: 'status', operator: '==', value: 'open' }
    });
  });
});
