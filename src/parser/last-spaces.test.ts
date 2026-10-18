/**
 * Last Unicode spaces between tokens.
 *
 * U+2001, U+2004, U+2005, U+2006 and U+2008 are value characters to
 * Liqe and whitespace to JavaScript `\s`. The search box keeps them inside an
 * unquoted value, as `parse` does, and is incomplete when such a value
 * swallows a later colon.
 */

import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete, parseQueryInput } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const SPACES: Array<[string, string]> = [
  ['U+2001', '\u2001'],
  ['U+2004', '\u2004'],
  ['U+2005', '\u2005'],
  ['U+2006', '\u2006'],
  ['U+2008', '\u2008']
];

describe.each(SPACES)('last unicode space %s', (_name, space) => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const rows = [
    { id: 1, status: 'open', priority: 1 },
    { id: 2, status: `${space}open`, priority: 1 },
    { id: 3, status: `open${space}closed`, priority: 2 }
  ];

  it('keeps the space after the colon inside the value', () => {
    const query = `status:${space}open`;
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: `${space}open`
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"status" = '${space}open'`);
    expect(
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toEqual({ sql: '"status" = ?', params: [`${space}open`] });
    expect(
      dialect.sqlToQuery(new DrizzleTranslator().translate(expression))
    ).toMatchObject({ sql: '"status" = ?', params: [`${space}open`] });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([2]);
  });

  it('is incomplete when the space glues a later colon into the value', () => {
    const query = `status:open${space}AND${space}priority:1`;
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(
      'Syntax error at line 1 column 25'
    );
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('keeps the space between two words inside one unquoted value', () => {
    const query = `status:open${space}closed`;
    expect(parseQueryInput(query).terms).toHaveLength(1);
    expect(parseQueryInput(query).terms[0]).toMatchObject({
      key: 'status',
      value: `open${space}closed`
    });
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ value: `open${space}closed` });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"status" = 'open${space}closed'`);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([3]);
  });

  it('keeps the space inside a quoted value', () => {
    const query = `status:"open${space}closed"`;
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({
      value: `open${space}closed`
    });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([3]);
  });
});

describe('ASCII space guard', () => {
  const parser = new QueryParser();

  it('keeps status: open incomplete and rejected', () => {
    expect(isInputComplete('status: open')).toBe(false);
    expect(() => parser.parse('status: open')).toThrow(
      'Invalid field or expression in Tag node'
    );
  });

  it('keeps an ASCII-spaced AND a real conjunction', () => {
    expect(isInputComplete('status:open AND priority:1')).toBe(true);
    expect(parser.parse('status:open AND priority:1')).toMatchObject({
      type: 'logical',
      operator: 'AND'
    });
  });
});
