/**
 * Raw line feed inside an unquoted bracket member.
 *
 * The bracket rewrite quotes a list member or range bound that holds
 * whitespace, escaping only backslashes and double quotes, so
 * `status:[a` LF `b]` reaches Liqe as `status:"a` LF `b"`, a string Liqe
 * cannot read, and `parse` throws Liqe's syntax error. The search box looked
 * for a line feed only inside the quotes the user typed and called the text
 * complete. It now reads such a member or bound as incomplete; the line
 * feed is not rewritten into the `\n` escape and no syntax is added. A
 * membership member is decoded by the parser and keeps the line feed, a
 * line feed beside a comma, a `TO` or a bracket is trimmed, every other
 * whitespace character stays in the quoted member, and a regex Liqe reads
 * across the brackets keeps the line feed in its body. Where that regex
 * also swallows a regex list member's joiner or a membership list, the
 * parser rejects Liqe's reading, and the search box now applies the same
 * checks to the same text.
 */

import { createRequire } from 'module';
import {
  SQLiteSyncDialect,
  integer,
  sqliteTable,
  text
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { hasUnreadRegexMember, rewriteQueryForLiqe } from './query-rewrite';
import { QueryExpression } from './types';

const nodeRequire = createRequire(__filename);

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): {
    all(...params: unknown[]): Array<{ id: number }>;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

const rows = [
  { id: 1, status: 'a', label: 'x' },
  { id: 2, status: 'b', label: 'x' },
  { id: 3, status: 'ab', label: 'x' },
  { id: 4, status: 'a\nb', label: 'x' },
  { id: 5, status: 'x', label: 'x' },
  { id: 6, status: 'c', label: 'x' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  label: text('label')
});

const LINE_FEED_MESSAGE = 'Syntax error at line 2 column 0';

describe('newline in a list member', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const Database = nodeRequire('better-sqlite3') as new (
    file: string
  ) => ISqliteDatabase;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, label TEXT)'
  );
  for (const row of rows) {
    database
      .prepare('INSERT INTO items (id, status, label) VALUES (?, ?, ?)')
      .run(row.id, row.status, row.label);
  }

  afterAll((): void => {
    database.close();
  });

  function expectRejected(
    query: string,
    message: string = LINE_FEED_MESSAGE
  ): void {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  }

  function engineIds(expression: QueryExpression, query: string): number[][] {
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as { sql: string; params: unknown[] };
    const drizzle = dialect.sqlToQuery(
      new DrizzleTranslator().translate(expression)
    );
    const withSchema = dialect.sqlToQuery(
      new DrizzleTranslator({ schema: items }).translate(expression)
    );
    const idsOf = (sql: string, params: unknown[]): number[] =>
      database
        .prepare(`SELECT id FROM items WHERE ${sql} ORDER BY id`)
        .all(...params)
        .map(row => row.id);
    return [
      idsOf(inline, []),
      idsOf(parameterized.sql, parameterized.params),
      idsOf(drizzle.sql, drizzle.params),
      idsOf(withSchema.sql, withSchema.params),
      filterInMemory(query, rows).map(row => row.id)
    ];
  }

  it.each([
    // the assigned forms
    'status:[a\nb]',
    'status:[/a\nb/]',
    'status:[a\nb TO c]',
    'status:[x, a\nb]',
    // the member elsewhere in a list or range
    'status:[a\nb, x]',
    'status:[x TO a\nb]',
    'status:[a\nb TO *]',
    'status:[* TO a\nb]',
    'status:{a\nb TO c}',
    'status:{a\nb, c}',
    'status:[a\nb TO c, x]',
    'status:[a\nb TO c\nd]',
    'status:[/a\nb/, c]',
    'status:[/a\nb/ TO c]',
    'status:[a\nb, /c\nd/]',
    // the line feed beside other characters
    'status:[a\r\nb]',
    'status:[a\n b]',
    'status:[a \nb]',
    'status:[a\n\nb]',
    'status:[a:\nb]',
    'status:[a\\\nb]',
    'status:[a\nb*]',
    'status:[1\n2]',
    'status:["a"\nb]',
    'status:[a\n"b"]',
    'status:[\'a\'\n"b"]',
    // the member inside a larger query
    'status:!=[a\nb]',
    '-status:[a\nb]',
    'NOT status:[a\nb]',
    '(status:[a\nb])',
    "'status':[a\nb]",
    '"status":[a\nb]',
    'status:[a\nb] label:x',
    'label:x status:[a\nb]',
    'status:[a\nb] AND label:x',
    'status:[a\nb] OR label:x',
    'status:[a\nb]\nlabel:x'
  ])('treats %p as incomplete and rejected', query => expectRejected(query));

  it.each([
    // a raw line feed inside typed quotes, already incomplete
    ['status:"a\nb"', LINE_FEED_MESSAGE],
    ['status:["a\nb"]', LINE_FEED_MESSAGE],
    // a tail glued to the closer, already incomplete
    ['status:[a\nb]x', LINE_FEED_MESSAGE],
    ['status:[/a\nb/]x', LINE_FEED_MESSAGE],
    // a quoted member with a line feed after its first literal
    [
      'status:["a"\n"b"]',
      'A quoted list member or range bound was not read as one quoted literal'
    ],
    // a brace body that is neither a list nor a range, and an unclosed list
    ['status:{a\nb}', 'Syntax error at line 1 column 9'],
    ['status:[a\nb', 'Syntax error at line 1 column 9'],
    // the two-character escape in an unquoted member is a backslash to Liqe
    ['status:[a\\nb]', 'Syntax error at line 1 column 9']
  ])('keeps %p incomplete and rejected with %p', (query, message) =>
    expectRejected(query, message)
  );

  it('keeps a member with a parenthesis incomplete on the parenthesis path', () => {
    // The recovery counts the member's `(` as an unclosed parenthesis and
    // offers to close it, as it does for `status:[a(` today; the search box
    // and the parser still agree.
    const query = 'status:[a(\nb]';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(LINE_FEED_MESSAGE);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.issue).toBe('unclosed_parenthesis');
  });

  it.each([
    // a membership member keeps the line feed
    ['status:in [a\nb]', `"status" IN ('a\nb')`, [4]],
    ['status:in [a\nb, c]', `"status" IN ('a\nb', 'c')`, [4, 6]],
    ['status:not in [a\nb]', `"status" NOT IN ('a\nb')`, [1, 2, 3, 5, 6]],
    ['status:in [/a\nb/]', `"status" IN ('/a\nb/')`, []],
    // the escaped line feed matches the real-newline row
    ['status:"a\\nb"', `"status" = 'a\nb'`, [4]],
    ['status:["a\\nb"]', `"status" = 'a\nb'`, [4]],
    ['status:["a\\nb", x]', `("status" = 'a\nb') OR ("status" = 'x')`, [4, 5]],
    [
      'status:["a\\nb" TO c]',
      `("status" >= 'a\nb') AND ("status" <= 'c')`,
      [2, 3, 4, 6]
    ],
    // the assigned controls
    ['status:[a b]', `"status" = 'a b'`, []],
    ['status:[a, b]', `("status" = 'a') OR ("status" = 'b')`, [1, 2]],
    [
      'status:[a TO b]',
      `("status" >= 'a') AND ("status" <= 'b')`,
      [1, 2, 3, 4]
    ],
    // a line feed beside a comma, a separator or a bracket is trimmed
    ['status:[a,\nb]', `("status" = 'a') OR ("status" = 'b')`, [1, 2]],
    ['status:[a\n,b]', `("status" = 'a') OR ("status" = 'b')`, [1, 2]],
    ['status:[\na, b\n]', `("status" = 'a') OR ("status" = 'b')`, [1, 2]],
    [
      'status:[a\nTO b]',
      `("status" >= 'a') AND ("status" <= 'b')`,
      [1, 2, 3, 4]
    ],
    [
      'status:[a TO\nb]',
      `("status" >= 'a') AND ("status" <= 'b')`,
      [1, 2, 3, 4]
    ],
    ['status:[\na]', `"status" = 'a'`, [1]],
    ['status:[a\n]', `"status" = 'a'`, [1]],
    ['status:[ab]', `"status" = 'ab'`, [3]],
    ['status:[x, c]', `("status" = 'x') OR ("status" = 'c')`, [5, 6]],
    // every other whitespace character stays in the quoted member
    ['status:[a\rb]', `"status" = 'a\rb'`, []],
    ['status:[a\tb]', `"status" = 'a\tb'`, []],
    ['status:[a\vb]', `"status" = 'a\vb'`, []],
    ['status:[a\fb]', `"status" = 'a\fb'`, []],
    // a line feed between clauses is Liqe whitespace
    ['status:[a]\nlabel:x', `("status" = 'a') AND ("label" = 'x')`, [1]],
    [
      'status:[a,\nb]\nlabel:x',
      `(("status" = 'a') OR ("status" = 'b')) AND ("label" = 'x')`,
      [1, 2]
    ]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(engineIds(expression, query)).toEqual([ids, ids, ids, ids, ids]);
  });

  it('keeps a line feed inside a regex body', () => {
    expect(isInputComplete('status:/a\nb/')).toBe(true);
    expect(parser.parse('status:/a\nb/')).toEqual({
      type: 'comparison',
      field: 'status',
      operator: 'REGEX',
      value: '/a\nb/'
    });
  });

  it('leaves a quoted member to the regex Liqe reads across it', () => {
    // `x:[a]` keeps Liqe from reading the typed text, so the rewrite quotes
    // the member, but Liqe reads the rewritten `n://(y:"a` LF `b"/` as one
    // regex, whose body takes a line feed; the search box reads the same
    // regex.
    const query = 'x:[a] n://(y:[a\nb]/';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'logical',
      operator: 'AND',
      left: { type: 'comparison', field: 'x', operator: '==', value: 'a' },
      right: {
        type: 'comparison',
        field: 'n',
        operator: 'REGEX',
        value: '//(y:"a\nb"/'
      }
    });
    expect(() => filterInMemory(query, rows)).toThrow(
      'Unsupported operator: REGEX'
    );
  });

  it.each([
    ['x:[//] y:[a\nb] e://', '// y:"a\nb" e://'],
    ['x:[//] y:[x, a\nb] e://', '// (y:x OR y:"a\nb") e://'],
    ['x:[//] y:[a\nb TO c] e://', '// (y:>="a\nb" AND y:<="c") e://'],
    ['x:[//]T:[a\nb]/', '//T:"a\nb"/'],
    ['(x:[//] u:[a\nb] OR d:/a/i)', '// u:"a\nb" OR d:/a/i']
  ])('keeps %p complete as the one regex Liqe reads', (query, value) => {
    // Liqe reads the rewritten text one way only, as the regex from the
    // first slash to the last: the other reading meets the line feed inside
    // a string. The same-length stand-in writes the member as a plain
    // string, which Liqe reads two ways, so the rewritten text decides.
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'x',
      operator: 'REGEX',
      value
    });
    expect(() => filterInMemory(query, rows)).toThrow(
      'Unsupported operator: REGEX'
    );
  });

  it.each([
    // the one regex Liqe reads runs past the grouped regex member `//`
    [
      't:[//, a\nb] OR (d:/a/i)',
      'A regex list member was not read as its own regex literal'
    ],
    [
      't:[//, a\nb]\nOR (d:/a/i)',
      'A regex list member was not read as its own regex literal'
    ],
    // the one regex Liqe reads swallows the lifted membership list
    [
      '(t:[//] u:[a\nb] v:in[a] OR d:/a/i)',
      'A membership list could not be placed in the parsed query'
    ],
    // without the line feed Liqe reads the text two ways, as it always did
    ['t:[//, a b] OR (d:/a/i)', 'Ambiguous results.'],
    ['(t:[//] u:[a b] v:in[a] OR d:/a/i)', 'Ambiguous results.']
  ])(
    'rejects %p, whose one reading the parser refuses, as incomplete',
    (query, message) => expectRejected(query, message)
  );

  it.each([
    [{ start: 4, end: 6, isGrouped: true }, [[4, 6]], false],
    [{ start: 4, end: 6, isGrouped: true }, [[4, 9]], true],
    [{ start: 4, end: 6, isGrouped: true }, [[4, 5]], true],
    [{ start: 4, end: 6, isGrouped: true }, [[2, 9]], true],
    [{ start: 4, end: 6, isGrouped: false }, [[4, 9]], false],
    [{ start: 4, end: 6, isGrouped: false }, [[4, 6]], false],
    [{ start: 4, end: 6, isGrouped: false }, [[4, 5]], true],
    [{ start: 4, end: 6, isGrouped: false }, [], true]
  ])(
    'reads the regex member %p against spans %p as unread: %p',
    (member, spans, expected) => {
      expect(
        hasUnreadRegexMember(
          [member],
          new Map(spans as Array<[number, number]>)
        )
      ).toBe(expected);
    }
  );

  it('does not rewrite the typed line feed into the \\n escape', () => {
    expect(rewriteQueryForLiqe('status:[a\nb]')).toBe('status:"a\nb"');
    expect(rewriteQueryForLiqe('status:[a\nb TO c]')).toBe(
      '(status:>="a\nb" AND status:<="c")'
    );
    expect(rewriteQueryForLiqe('status:[a\nb]')).not.toBe('status:"a\\nb"');
  });
});
