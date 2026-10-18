/**
 * A quoted bracket member followed by more text inside the brackets.
 *
 * The bracket rewrite copies a list member or range bound that begins and
 * ends with the same quote as written, so `status:["a" OR status:"c"]`
 * reached Liqe as `status:"a" OR status:"c"` and parsed to a two-clause OR,
 * a query no reading of the typed text yields, and `NOT status:["a" OR
 * status:"c"]` negated only the first clause. The search box already read
 * the member as a quoted token that is not one closed literal and called
 * the text incomplete, so the two disagreed. The parser now records where
 * each quoted member or bound it copies lands in the rewritten text and,
 * once Liqe has parsed, requires the literal Liqe read there to end where
 * the member ends, as `assertRegexMembersRead` guards a regex member; a
 * member with whitespace after its first literal that Liqe read as an
 * implicit-field term (`status:["a" "b"]`) is rejected the same way, and
 * a glued quote (`status:["a"b"c"]`) stays Liqe's own syntax error. A
 * member Liqe never reads, because a regex it reads from the text before
 * it swallows the member, stays as the search box reads it. A member the
 * rewrite quotes whole, because it does not end with the quote it begins
 * with, stays one value.
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
import { hasQuotedMemberTail, readBracketExpression } from './query-scanner';
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
  { id: 3, status: 'a b', label: 'x' },
  { id: 4, status: 'c', label: 'x' },
  { id: 5, status: 'x', label: 'x' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  label: text('label')
});

const QUOTED_MEMBER_MESSAGE =
  'A quoted list member or range bound was not read as one quoted literal';

describe('quoted member tail', () => {
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
    message: string = QUOTED_MEMBER_MESSAGE
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
    // an operator and a second clause smuggled through a list member
    'status:["a" OR status:"c"]',
    "status:['a' OR status:'c']",
    'status:["a" or status:"c"]',
    'status:["a" AND status:"c"]',
    'status:["a" NOT status:"c"]',
    'status:["a" OR NOT status:"c"]',
    'status:["a" status:"c"]',
    'status:["a" -status:"c"]',
    'status:["a" OR label:"x"]',
    'status:["a" OR status:>"c"]',
    'status:["" OR status:"c"]',
    'status:["a" ORstatus:"c"]',
    'status:["a" OR status:"c" OR status:"x"]',
    'status:["\\u0061" OR status:"c"]',
    'status:["a\\"b" OR status:"c"]',
    'status:["a"  OR  status:"c"]',
    'status:[ "a" OR status:"c"]',
    'status:["a" OR status:"c" ]',
    'status:["a" OR status:"c", x]',
    'status:[x, "a" OR status:"c"]',
    '"status":["a" OR status:"c"]',
    'label:["x" OR status:"c"]',
    // the member inside a larger query
    'status:["a" OR status:"c"] AND label:x',
    'label:x AND status:["a" OR status:"c"]',
    'NOT status:["a" OR status:"c"]',
    '-status:["a" OR status:"c"]',
    'status:!=["a" OR status:"c"]',
    '(status:["a" OR status:"c"])',
    // the same text as a quoted range bound
    'status:["a" OR status:"c" TO d]',
    'status:[x TO "a" OR status:"c"]',
    'status:["a" OR status:"c" TO *]',
    'status:[* TO "a" OR status:"c"]',
    'status:{"a" OR status:"c" TO d}'
  ])('rejects %p instead of reading a second clause', query =>
    expectRejected(query)
  );

  it.each([
    // whitespace after the first literal, which Liqe read as an implicit field
    'status:["a" "b"]',
    'status:["a"\t"b"]',
    'status:["a" OR "b"]',
    'status:["a" AND "b"]',
    'status:["a" "b", x]',
    'status:["a" "b" TO d]',
    'status:["a" OR "c" TO d]',
    'status:["a" TO "b" TO "c"]'
  ])('rejects %p with the same message', query => expectRejected(query));

  it.each(['status:["a"b"c"]', "status:['a'b'c']"])(
    'rejects %p, a glued quote, as Liqe does',
    query => expectRejected(query, 'Syntax error at line 1 column 11')
  );

  it('leaves a copied member to the regex Liqe reads across it', () => {
    // `x:[a]` keeps Liqe from reading the typed text, so the rewrite closes
    // `//` at its second slash and consumes the list, but Liqe reads the
    // rewritten `n://(y:"a" OR z:"b"/` as one regex; the member is never a
    // literal to it, and the search box reads the same regex.
    const query = 'x:[a] n://(y:["a" OR z:"b"]/';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'logical',
      operator: 'AND',
      left: { type: 'comparison', field: 'x', operator: '==', value: 'a' },
      right: {
        type: 'comparison',
        field: 'n',
        operator: 'REGEX',
        value: '//(y:"a" OR z:"b"/'
      }
    });
    expect(() => filterInMemory(query, rows)).toThrow(
      'Unsupported operator: REGEX'
    );
  });

  it.each([
    // the rewrite quotes a member that does not end with its opening quote
    ['status:[x "a"]', `"status" = 'x "a"'`, []],
    ['status:["a" b]', `"status" = '"a" b'`, []],
    ['status:["a" AND label:x]', `"status" = '"a" AND label:x'`, []],
    ['status:["a" OR label:x]', `"status" = '"a" OR label:x'`, []],
    ['status:["a" OR status:[c]]', `"status" = '"a" OR status:[c]'`, []],
    ['status:["a" OR (status:"c")]', `"status" = '"a" OR (status:"c")'`, []],
    ['status:[\'a\' OR status:"c"]', `"status" = '''a'' OR status:"c"'`, []],
    ['status:[/a/ OR status:"c"]', `"status" = '/a/ OR status:"c"'`, []],
    [
      'status:["a" OR x TO d]',
      `("status" >= '"a" OR x') AND ("status" <= 'd')`,
      [1, 2, 3, 4]
    ],
    ['status:[x "a" TO d]', `("status" >= 'x "a"') AND ("status" <= 'd')`, []],
    // one quoted literal, with or without whitespace or an escape inside it
    ['status:["a b"]', `"status" = 'a b'`, [3]],
    ['status:["a"]', `"status" = 'a'`, [1]],
    ['status:["a", "c"]', `("status" = 'a') OR ("status" = 'c')`, [1, 4]],
    ['status:["\\u0061", "c"]', `("status" = 'a') OR ("status" = 'c')`, [1, 4]],
    ['status:["a\\"b", "c"]', `("status" = 'a"b') OR ("status" = 'c')`, [4]],
    [
      'status:["a\\"b" TO "c"]',
      `("status" >= 'a"b') AND ("status" <= 'c')`,
      [2, 4]
    ],
    [
      'status:["a" TO "c"]',
      `("status" >= 'a') AND ("status" <= 'c')`,
      [1, 2, 3, 4]
    ],
    // the assigned controls
    ['status:["AND"]', `"status" = 'AND'`, []],
    ['status:[x, y]', `("status" = 'x') OR ("status" = 'y')`, [5]],
    ['status:[a TO b]', `("status" >= 'a') AND ("status" <= 'b')`, [1, 2, 3]],
    ['status:in ["a"b]', `"status" IN ('"a"b')`, []],
    ['status:in ["a", "a b"]', `"status" IN ('a', 'a b')`, [1, 3]]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(engineIds(expression, query)).toEqual([ids, ids, ids, ids, ids]);
  });

  it.each([
    ['status:["a" OR status:"c"]', true],
    ["status:['a' OR status:'c']", true],
    ['status:["a" "b"]', true],
    ['status:["a"b"c"]', true],
    ['status:[x, "a" OR status:"c"]', true],
    ['status:["a" OR status:"c" TO d]', true],
    ['status:[x TO "a" OR status:"c"]', true],
    ['status:["a" OR status:"c" TO *]', true],
    ['status:["a b"]', false],
    ['status:["a\\"b"]', false],
    ['status:["a", "c"]', false],
    ['status:["a" TO "c"]', false],
    ['status:["a" b]', false],
    ['status:["a"b]', false],
    ['status:[\'a\' OR status:"c"]', false],
    ['status:["a" OR x TO d]', false],
    ['status:[a TO b]', false],
    ['status:in ["a" "b"]', false]
  ])('reads the quoted member tail of %p as %p', (query, expected) => {
    const span = readBracketExpression(query, 0);
    expect(span).not.toBeNull();
    expect(hasQuotedMemberTail(span as NonNullable<typeof span>)).toBe(
      expected
    );
  });

  it('keeps the OR a comma list writes, not the one a member smuggles', () => {
    expect(parser.parse('status:["a", "c"]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: { type: 'comparison', field: 'status', operator: '==', value: 'a' },
      right: { type: 'comparison', field: 'status', operator: '==', value: 'c' }
    });
    expect(() => parser.parse('status:["a" OR status:"c"]')).toThrow(
      QUOTED_MEMBER_MESSAGE
    );
  });
});
