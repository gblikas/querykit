/**
 * Value quoting.
 *
 * A single quote inside a string value is doubled, and a double quote and a
 * backslash stay inside the single-quoted literal, on inline SQL; the other
 * engines bind the string. A value that also holds U+0000 cannot be written
 * into statement text, since SQLite stops reading at the zero byte, so
 * inline SQL splits the string there and joins the quoted pieces with
 * `CHAR(0)`. Every engine then returns the same row.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { openSqliteHarness } from '../test-support';

const ZERO = '\u0000';

const rows = [
  { id: 1, status: `a'b`, note: 'x' },
  { id: 2, status: `a"b`, note: 'x' },
  { id: 3, status: 'x', note: 'a\\b' },
  { id: 4, status: `a'b"c\\d`, note: 'x' },
  { id: 5, status: 'a', note: 'x' },
  { id: 6, status: `a'${ZERO}"b\\c`, note: 'x' },
  { id: 7, status: `a'`, note: 'x' },
  { id: 8, status: `a'"b\\c`, note: 'x' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  note: text('note')
});

describe('value quoting', () => {
  const harness = openSqliteHarness({
    table: items,
    columns: { status: 'TEXT', note: 'TEXT' },
    rows
  });

  it.each([
    [`status:"a'b"`, 'status', `a'b`, `"status" = 'a''b'`, [1]],
    [`status:"a\\"b"`, 'status', `a"b`, `"status" = 'a"b'`, [2]],
    [`note:"a\\\\b"`, 'note', 'a\\b', `"note" = 'a\\b'`, [3]],
    [
      `status:"a'b\\"c\\\\d"`,
      'status',
      `a'b"c\\d`,
      `"status" = 'a''b"c\\d'`,
      [4]
    ]
  ])(
    '%s keeps quotes and backslashes inside the literal',
    (query, field, value, inlineSql, expectedIds) => {
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value
      });
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: `"${field}" = ?`,
        params: [value]
      });
      expect(run.drizzle).toEqual({ sql: `"${field}" = ?`, params: [value] });
      expect(run.schemaDrizzle).toEqual({
        sql: `"items"."${field}" = ?`,
        params: [value]
      });
    }
  );

  it('writes a zero byte inside an inline equality as CHAR(0)', () => {
    const value = `a'${ZERO}"b\\c`;
    const run = harness.expectSameIds(`status:"a'${ZERO}\\"b\\\\c"`, [6]);
    expect(run.expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value
    });
    expect(run.inlineSql).toBe(`"status" = ('a''' || CHAR(0) || '"b\\c')`);
    expect(run.inlineSql).not.toContain(ZERO);
    expect(run.parameterized).toEqual({ sql: '"status" = ?', params: [value] });
    expect(run.drizzle).toEqual({ sql: '"status" = ?', params: [value] });
  });

  it('writes a zero byte inside an inline membership member as CHAR(0)', () => {
    const value = `a'${ZERO}"b\\c`;
    const run = harness.expectSameIds(`status:in["a'${ZERO}\\"b\\\\c"]`, [6]);
    expect(run.expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: 'IN',
      value: [value]
    });
    expect(run.inlineSql).toBe(`"status" IN (('a''' || CHAR(0) || '"b\\c'))`);
    expect(run.parameterized).toEqual({
      sql: '"status" IN (?)',
      params: [value]
    });
    expect(run.drizzle).toEqual({ sql: '"status" in (?)', params: [value] });
  });
});
