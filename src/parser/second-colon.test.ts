/**
 * Second colon and glued field names.
 *
 * A colon is not a value character to Liqe, and a field name must begin a
 * clause. `status:a:b`, `status:openlabel:x` and a name glued to a value,
 * a quote or a consumed bracket are syntax errors; a colon inside quotes or
 * a bracket body stays in the value. A hyphen never names a field.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete, parseQueryInput } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open', label: 'bug', state: 'closed' },
  { id: 2, status: 'a:b', label: 'x', state: 'closed' },
  {
    id: 3,
    status: 'openlabel:x',
    label: 'bug',
    state: 'open',
    'sta:tus': 'open'
  },
  { id: 4, status: 'open', label: 'x', state: 'closed' }
];

describe('second colon', () => {
  const parser = new QueryParser();

  it.each([
    'status:openlabel:x',
    'status:a:b',
    'status::open',
    'status:open:',
    'status:a:b:c',
    'status:open:label:x',
    'label:x:',
    'url:http://x',
    'time:12:30',
    'status:>1:2',
    'count:>=1:2',
    'count:>1:',
    'status:a:b AND label:x',
    'label:x status:a:b',
    'status:open AND label:x:y',
    'NOT status:a:b',
    '-status:a:b',
    '(status:a:b)',
    'status:"a":b',
    "status:'a':b",
    'status:"a:b":c',
    'status:a:"b"',
    'status:"a"b:c',
    'status:"open"label:x',
    'label:"a"status:b',
    'status:a.b:c',
    'status:a-b:c',
    'status:a_b:c',
    'status:a$:b',
    'status:a*b:c',
    'status:a:ü',
    'status:a:-b',
    'status:a:1',
    'status:1:a',
    'status:a:>b',
    'status:a:!=b',
    'status:!=a:b',
    'status:a:in[b]',
    'status:a:[b TO c]',
    'status:[a TO b]label:x',
    'status:{a TO b}label:x',
    'status:in[a]label:x',
    'status:in [a]label:x',
    'sta-tus:a',
    'status:a-:b',
    'status:a -:b',
    '-:b',
    'a-b:c',
    'last-updated:yesterday',
    'status:/a/:b'
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
    ['status:"a:b"', `"status" = 'a:b'`, [2]],
    ["status:'a:b'", `"status" = 'a:b'`, [2]],
    ['status:"openlabel:x"', `"status" = 'openlabel:x'`, [3]],
    ['"sta:tus":open', `"sta:tus" = 'open'`, [3]],
    ['status:open', `"status" = 'open'`, [1, 4]],
    ['label:x', `"label" = 'x'`, [2, 4]],
    ['status:open label:x', AND_SQL, [4]],
    ['status:open AND label:x', AND_SQL, [4]],
    ['(status:open) label:x', AND_SQL, [4]],
    ['status:"a:b" label:x', `("status" = 'a:b') AND ("label" = 'x')`, [2]],
    ['-status:open', `NOT ("status" = 'open')`, [2, 3]],
    ['-"status":open', `NOT ("status" = 'open')`, [2, 3]],
    ['status:in [a:b]', `"status" IN ('a:b')`, [2]],
    ['status:in[a:b, c:d]', `"status" IN ('a:b', 'c:d')`, [2]],
    ['status:[a:b TO c]', `("status" >= 'a:b') AND ("status" <= 'c')`, [2]],
    ['status:[a TO b:c]', `("status" >= 'a') AND ("status" <= 'b:c')`, [2]]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('does not read a hyphen as part of a field name', () => {
    const result = parseQueryInput('last-updated:yesterday');
    expect(result.terms[0]).toMatchObject({ key: null, value: 'last' });
    expect(result.terms[1]).toMatchObject({ key: '-updated', operator: ':' });
    expect(parseQueryInput('-status:open').terms[0]).toMatchObject({
      key: '-status',
      value: 'open'
    });
  });
});
