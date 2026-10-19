/**
 * A bigint field compared with a number.
 *
 * SQLite stores `10n` and `10` as the same integer, so `amount:>2` and
 * `amount:10` keep both rows and `amount:<3` keeps neither. Memory compares
 * a bigint field with a finite number by integer value instead of `===`.
 * A bigint query value cannot be written in the language; `amount:10n` is a
 * syntax error.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { QueryParseError } from '../../parser/parser';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; amount: bigint | number }> = [
  { id: 1, amount: 10n },
  { id: 2, amount: 10 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  amount: integer('amount')
});

describe('a bigint field compared with a number', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { amount: 'INTEGER' },
    rows
  });

  it.each([
    ['amount:>2', [1, 2]],
    ['amount:10', [1, 2]],
    ['amount:<3', []],
    ['amount:>=10.5', []],
    ['amount:<10.5', [1, 2]]
  ])('%s matches the same rows on every engine', (query, expectedIds) => {
    harness.expectSameIds(query, expectedIds);
  });

  it.each(['amount:10n', 'amount:>10n', 'amount:<3n'])(
    'cannot write a bigint query value as %s',
    query => {
      expect(() => parser.parse(query)).toThrow(QueryParseError);
    }
  );
});
