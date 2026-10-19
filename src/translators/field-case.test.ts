/**
 * A field name in another letter case.
 *
 * SQLite resolves the quoted identifiers `"Status"` and `"STATUS"` to the
 * column `status`. The in-memory reader does the same: an exact own key
 * wins, otherwise the one own key differing only by ASCII case is read. The
 * AST field and the SQL identifier stay as written; a row that holds both
 * spellings answers each exactly, and an ambiguous third spelling nothing.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { filterByExpression } from '../adapters/memory/match-expression';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; status: string | null }> = [
  { id: 1, status: 'open' },
  { id: 2, status: 'closed' },
  { id: 3, status: null },
  { id: 4, status: 'Open' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status')
});

describe('a field name in another letter case', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { status: 'TEXT' },
    rows
  });

  it.each(['status:open', 'Status:open', 'STATUS:open'])(
    '%s reads the stored column on every engine',
    query => {
      const expression = parser.parse(query);
      const field = query.split(':')[0];
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value: 'open'
      });
      const run = harness.expectSameIds(query, [1]);
      expect(run.inlineSql).toBe(`"${field}" = 'open'`);
      expect(run.parameterized).toEqual({
        sql: `"${field}" = ?`,
        params: ['open']
      });
      expect(run.drizzle).toEqual({ sql: `"${field}" = ?`, params: ['open'] });
    }
  );

  it('reads an exact own key first and nothing for an ambiguous spelling', () => {
    const twoSpellings = [
      { id: 1, status: 'open', Status: 'closed' },
      { id: 2, status: 'closed', Status: 'open' }
    ];
    expect(filterInMemory('status:open', twoSpellings).map(r => r.id)).toEqual([
      1
    ]);
    expect(filterInMemory('Status:open', twoSpellings).map(r => r.id)).toEqual([
      2
    ]);
    expect(filterInMemory('STATUS:open', twoSpellings)).toEqual([]);
  });

  it('does not fold letters outside ASCII', () => {
    const greek = [{ id: 1, σtatus: 'open' }];
    const equals = (field: string): QueryExpression => ({
      type: 'comparison',
      field,
      operator: '==',
      value: 'open'
    });
    expect(filterByExpression(equals('σtatus'), greek).map(r => r.id)).toEqual([
      1
    ]);
    expect(filterByExpression(equals('Σtatus'), greek)).toEqual([]);
  });
});
