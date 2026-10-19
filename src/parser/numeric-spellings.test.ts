/**
 * Unquoted numeric spellings Liqe rejects.
 *
 * Liqe's decimal is an optional minus, digits, and an optional fraction, so
 * a leading plus (`+1`), a leading dot (`.5`) and a trailing dot (`1.`) are
 * syntax errors as values and are quoted as text inside a range or a
 * membership list. The parser spells those three forms as the plain decimal
 * Liqe accepts, before the bracket rewrite and outside quotes and regex
 * literals, so every engine compares the stored number. Spellings Liqe
 * already reads (`007`, `00.50`, `-0`) are left alone, as are a quoted
 * value, a regex, a wildcard glued to the token and a digit inside a field
 * name.
 */

import { integer, real, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParseError, QueryParser } from './parser';
import { IComparisonExpression } from './types';
import { IParameterizedSql, openSqliteHarness } from '../test-support';

interface IItem {
  id: number;
  priority: number;
}

interface IEngineRun {
  value: unknown;
  inlineSql: string;
  parameterized: IParameterizedSql;
  drizzle: IParameterizedSql;
  schemaDrizzle: IParameterizedSql;
  ids: number[];
}

const rows: IItem[] = [
  { id: 1, priority: 7 },
  { id: 2, priority: 1 },
  { id: 3, priority: 0.5 },
  { id: 4, priority: 0 },
  { id: 5, priority: 2 },
  { id: 6, priority: 5 },
  { id: 7, priority: 50 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  priority: real('priority')
});

function comparison(
  operator: IComparisonExpression['operator'],
  value: IComparisonExpression['value'],
  field = 'priority'
): IComparisonExpression {
  return { type: 'comparison', field, operator, value };
}

describe('unquoted numeric spellings', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { priority: 'REAL' },
    rows
  });

  /** Run one query through every engine and require them to agree. */
  function runEverywhere(query: string): IEngineRun {
    const run = harness.expectSameIds(query);
    return {
      value:
        run.expression.type === 'comparison' ? run.expression.value : undefined,
      inlineSql: run.inlineSql,
      parameterized: run.parameterized,
      drizzle: run.drizzle,
      schemaDrizzle: run.schemaDrizzle,
      ids: run.ids
    };
  }

  it.each([
    ['priority:007', 7, '"priority" = 7', [1]],
    ['priority:00.50', 0.5, '"priority" = 0.5', [3]],
    ['priority:-0', 0, '"priority" = 0', [4]]
  ])(
    'leaves %s to Liqe and matches the stored number',
    (query, value, inlineSql, ids) => {
      const run = runEverywhere(query);
      expect(run.value).toBe(value);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: '"priority" = ?',
        params: [value]
      });
      expect(run.drizzle).toEqual({ sql: '"priority" = ?', params: [value] });
      expect(run.schemaDrizzle).toEqual({
        sql: '"items"."priority" = ?',
        params: [value]
      });
      expect(run.ids).toEqual(ids);
    }
  );

  it.each([
    ['priority:+1', 1, '"priority" = 1', [2]],
    ['priority:1.', 1, '"priority" = 1', [2]],
    ['priority:.5', 0.5, '"priority" = 0.5', [3]]
  ])(
    'spells %s as the plain decimal and matches the stored number',
    (query, value, inlineSql, ids) => {
      const run = runEverywhere(query);
      expect(run.value).toBe(value);
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: '"priority" = ?',
        params: [value]
      });
      expect(run.drizzle).toEqual({ sql: '"priority" = ?', params: [value] });
      expect(run.schemaDrizzle).toEqual({
        sql: '"items"."priority" = ?',
        params: [value]
      });
      expect(run.ids).toEqual(ids);
    }
  );

  it('keeps a spelled range bound numeric', () => {
    expect(parser.parse('priority:[.5 TO 1]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('>=', 0.5),
      right: comparison('<=', 1)
    });
    const run = runEverywhere('priority:[.5 TO 1]');
    expect(run.parameterized.params).toEqual([0.5, 1]);
    expect(run.ids).toEqual([2, 3]);
  });

  it('keeps spelled membership members numeric', () => {
    expect(parser.parse('priority:in[+1,.5,1.]')).toEqual(
      comparison('IN', [1, 0.5, 1])
    );
    const run = runEverywhere('priority:in[+1,.5,1.]');
    expect(run.parameterized.params).toEqual([1, 0.5, 1]);
    expect(run.ids).toEqual([2, 3]);
  });

  it('leaves quotes, regexes, wildcards, field names and exponents alone', () => {
    expect(parser.parse('note:"+1"')).toEqual(comparison('==', '+1', 'note'));
    expect(parser.parse('name:/.5/')).toEqual(
      comparison('REGEX', '/.5/', 'name')
    );
    expect(parser.parse('batch1e2:1')).toEqual(comparison('==', 1, 'batch1e2'));
    expect(parser.parse('a.5:open')).toEqual(comparison('==', 'open', 'a.5'));
    expect(parser.parse('priority:1e-7')).toEqual(comparison('==', 1e-7));
    // A wildcard glued to the token is not a numeral, so Liqe still rejects it.
    expect(() => parser.parse('priority:1.*')).toThrow(QueryParseError);
    expect(() => parser.parse('priority:.5*')).toThrow(QueryParseError);
  });
});
