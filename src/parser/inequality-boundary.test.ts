/**
 * The `field:!=value` rewrite fires only where a field may begin.
 *
 * The parser turns `field:!=value` into `NOT field:value` before Liqe reads
 * the text. The field must begin a clause: the start of the text, Liqe
 * whitespace, `(` or a clause-leading minus precedes it, the boundary the
 * search box requires of every field colon. A `:!=` whose field is glued to
 * the value before it (`status:a*y:!=b`) stays as typed, which Liqe rejects
 * at the second colon, instead of writing `NOT ` into that value and running
 * `status == "a*NOT" AND y == b`.
 */

import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open', label: 'x', count: 1 },
  { id: 2, status: 'a*NOT', label: 'or', count: 7 },
  { id: 3, status: 'closed', label: 'y', count: 3 },
  { id: 4, status: 'open', label: 'z', count: 5 }
];

describe('inequality rewrite boundary', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();

  it.each([
    'status:a*y:!=b',
    'label:OR\u2003a.b:!=or',
    '_f:[AND]_f:!=/a/',
    'a:b\u2003--"sta tus":!=1e-7',
    'status:a?y:!=b',
    'status:a@y:!=b',
    'status:a-y:!=b',
    'status:a,y:!=b',
    'status:[a]y:!=b',
    'status:!=a*y:!=b',
    'status:open\ry:!=b'
  ])('rejects %p instead of writing NOT into the value before it', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it('hands a glued :!= to Liqe as typed', () => {
    expect(() => parser.parse('status:a*y:!=b')).toThrow(
      'Syntax error at line 1 column 11'
    );
  });

  it.each([
    [
      'status:!=open',
      `NOT ("status" = 'open')`,
      'NOT ("status" = ?)',
      ['open'],
      [2, 3]
    ],
    [
      '(status:!=open)',
      `NOT ("status" = 'open')`,
      'NOT ("status" = ?)',
      ['open'],
      [2, 3]
    ],
    [
      'status:open AND label:!=x',
      `("status" = 'open') AND (NOT ("label" = 'x'))`,
      '("status" = ?) AND (NOT ("label" = ?))',
      ['open', 'x'],
      [4]
    ],
    [
      'status:open label:!=x',
      `("status" = 'open') AND (NOT ("label" = 'x'))`,
      '("status" = ?) AND (NOT ("label" = ?))',
      ['open', 'x'],
      [4]
    ],
    [
      'status:open\tlabel:!=x',
      `("status" = 'open') AND (NOT ("label" = 'x'))`,
      '("status" = ?) AND (NOT ("label" = ?))',
      ['open', 'x'],
      [4]
    ],
    [
      'status:open\nlabel:!=x',
      `("status" = 'open') AND (NOT ("label" = 'x'))`,
      '("status" = ?) AND (NOT ("label" = ?))',
      ['open', 'x'],
      [4]
    ],
    [
      'status:open OR (label:!=x)',
      `("status" = 'open') OR (NOT ("label" = 'x'))`,
      '("status" = ?) OR (NOT ("label" = ?))',
      ['open', 'x'],
      [1, 2, 3, 4]
    ],
    ['count:!=>5', `NOT ("count" > 5)`, 'NOT ("count" > ?)', [5], [1, 3, 4]],
    [
      '"status":!=open',
      `NOT ("status" = 'open')`,
      'NOT ("status" = ?)',
      ['open'],
      [2, 3]
    ],
    [
      'count:1 "status":!=open',
      `(("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 1)) AND (NOT ("status" = 'open'))`,
      '("count" = ?) AND (NOT ("status" = ?))',
      [1, 'open'],
      []
    ]
  ])(
    'keeps %p as %p on every executor',
    (query, inlineSql, parameterizedSql, params, ids) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(
        new SqlTranslator({ useParameters: false }).translate(expression)
      ).toBe(inlineSql);
      expect(
        new SqlTranslator({ useParameters: true }).translate(expression)
      ).toEqual({ sql: parameterizedSql, params });
      expect(
        dialect.sqlToQuery(new DrizzleTranslator().translate(expression))
      ).toMatchObject({ sql: parameterizedSql, params });
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
      expect(parser.parseWithContext(query).success).toBe(true);
    }
  );

  it.each([
    ['NOT status:!=open', 'Syntax error at line 1 column 8'],
    ['-status:!=open', 'Syntax error at line 1 column 5'],
    ['(-status:!=open)', 'Syntax error at line 1 column 6'],
    ['status:open -label:!=x', 'Syntax error at line 1 column 17']
  ])(
    'still rewrites %p into the doubled negation Liqe rejects',
    (query, message) => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(message);
      expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    }
  );
});
