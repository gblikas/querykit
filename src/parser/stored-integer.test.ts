/**
 * Integers a SQLite INTEGER column can store, at the parser.
 *
 * Liqe reads a decimal with `Number`, so an integer past 2^53 is rounded
 * before the AST exists. The parser reads the written digits back: an
 * integer inside the signed 64-bit range that `Number` would round, or whose
 * `String(Number)` is not the written digits, is kept as a bigint; a plain
 * integer or a spelled exponent outside that range is rejected, except the
 * exact 2^63, which stays the number it already was; and an exponent whose
 * decimal underflows to zero is rejected rather than compared as 0.
 *
 * These are the parser-level cases of docs/bugs/bigint-equal.md,
 * int64-edge.md, int64-order.md, int64-neighbor.md, exponent-integer.md,
 * exact-wide-integer.md and exponent-underflow.md. Their engine-parity
 * tests (`src/adapters/memory/*.test.ts`) need the translators and the
 * in-memory adapter to carry a bigint and land with those layers; the
 * search-box completeness of a rejected spelling is the input parser's rule.
 */

import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import {
  exactSqliteInteger,
  isUnstorableInteger,
  spellNumeralToken,
  spellNumerals
} from './stored-integer';
import { IComparisonExpression, QueryExpression } from './types';

const INT64_MAX = '9223372036854775807';
const INT64_MIN = '-9223372036854775808';
const TWO_TO_63 = '9223372036854775808';

function comparison(
  operator: IComparisonExpression['operator'],
  value: IComparisonExpression['value'],
  field = 'count'
): IComparisonExpression {
  return { type: 'comparison', field, operator, value };
}

describe('stored integers', () => {
  const parser = new QueryParser();

  function rangeError(written: string): string {
    return `Failed to parse query: Integer is outside the signed 64-bit range: ${written}`;
  }

  describe('exact integers inside the signed range', () => {
    it('keeps 2^53 + 1 as the written bigint', () => {
      expect(parser.parse('count:9007199254740993')).toEqual(
        comparison('==', 9007199254740993n)
      );
      expect(parser.parse('count:>=9007199254740993')).toEqual(
        comparison('>=', 9007199254740993n)
      );
      // Liqe reports the literal's end from the stringified number, so the
      // digits are read from its start; a leading zero does not hide them.
      expect(parser.parse('count:09007199254740993 AND x:1')).toEqual({
        type: 'logical',
        operator: 'AND',
        left: comparison('==', 9007199254740993n),
        right: comparison('==', 1, 'x')
      });
    });

    it('keeps small and exactly representable integers as numbers', () => {
      expect(parser.parse('count:1')).toEqual(comparison('==', 1));
      expect(parser.parse('count:007')).toEqual(comparison('==', 7));
      expect(parser.parse('count:-0')).toEqual(comparison('==', 0));
      expect(parser.parse('count:9007199254740992')).toEqual(
        comparison('==', 9007199254740992)
      );
      expect(parser.parse('count:9000000000000000000')).toEqual(
        comparison('==', 9e18)
      );
    });

    it('keeps the signed 64-bit maximum and minimum as bigints', () => {
      expect(parser.parse(`count:${INT64_MAX}`)).toEqual(
        comparison('==', 9223372036854775807n)
      );
      expect(parser.parse(`count:${INT64_MIN}`)).toEqual(
        comparison('==', -9223372036854775808n)
      );
      expect(parser.parse(`count:>${INT64_MIN}`)).toEqual(
        comparison('>', -9223372036854775808n)
      );
      expect(parser.parse(`count:>=${INT64_MIN}`)).toEqual(
        comparison('>=', -9223372036854775808n)
      );
    });

    it('keeps an integer whose decimal spelling rounds, such as 2^60', () => {
      expect(parser.parse('count:1152921504606846976')).toEqual(
        comparison('==', 1152921504606846976n)
      );
      expect(parser.parse('count:4611686018427387904')).toEqual(
        comparison('==', 4611686018427387904n)
      );
    });

    it('keeps 2^63 as the number it already was', () => {
      expect(parser.parse(`count:${TWO_TO_63}`)).toEqual(
        comparison('==', 9223372036854775808)
      );
      expect(parser.parse(`count:<=${TWO_TO_63}`)).toEqual(
        comparison('<=', 9223372036854775808)
      );
    });

    it('carries the bigint through parseWithContext', () => {
      const result = parser.parseWithContext('count:9007199254740993');
      expect(result.success).toBe(true);
      expect(result.ast).toEqual(comparison('==', 9007199254740993n));
    });
  });

  describe('plain integers outside the signed range', () => {
    it.each([
      'count:9223372036854775809',
      'count:>9223372036854775809',
      'count:<=9223372036854775809'
    ])('rejects %s, which Number rounds onto 2^63', query => {
      const parse = (): QueryExpression => parser.parse(query);
      expect(parse).toThrow(QueryParseError);
      expect(parse).toThrow(rangeError('9223372036854775809'));
    });

    it('rejects one past the minimum, which Number rounds onto the minimum', () => {
      expect(() => parser.parse('count:-9223372036854775809')).toThrow(
        rangeError('-9223372036854775809')
      );
    });

    it.each(['count:1000000000000000000000', 'count:<=1000000000000000000000'])(
      'rejects %s, the digit spelling of 10^21 that Number keeps',
      query => {
        expect(() => parser.parse(query)).toThrow(
          rangeError('1000000000000000000000')
        );
      }
    );

    it('leaves a digit string Number cannot hold as a finite integer', () => {
      const digits = '1'.repeat(400);
      expect(parser.parse(`count:${digits}`)).toEqual(
        comparison('==', Infinity)
      );
    });
  });

  describe('exponents', () => {
    it.each([
      '1e21',
      '1e+21',
      '1E21',
      '1.0e21',
      '1.5e21',
      '-1e21',
      '1e19',
      '1e20',
      '2e19',
      '10e20',
      '1e309',
      '-1e309',
      '2e308',
      '1.5e309',
      '1e400'
    ])('rejects %s as an integer outside the signed 64-bit range', written => {
      const parse = (): QueryExpression => parser.parse(`count:${written}`);
      expect(parse).toThrow(QueryParseError);
      expect(parse).toThrow(rangeError(written));
      expect(() => parser.parse(`count:<=${written}`)).toThrow(
        rangeError(written)
      );
    });

    it.each(['1e-400', '1e-324', '-1e-400', '-1e-324', '1.5e-400'])(
      'rejects %s, whose decimal underflows to zero',
      written => {
        const parse = (): QueryExpression => parser.parse(`count:${written}`);
        expect(parse).toThrow(QueryParseError);
        expect(parse).toThrow(
          `Failed to parse query: Exponent underflows to zero: ${written}`
        );
      }
    );

    it('keeps an in-range exponent as its number', () => {
      expect(parser.parse('count:1e2')).toEqual(comparison('==', 100));
      expect(parser.parse('count:1e18')).toEqual(comparison('==', 1e18));
      expect(parser.parse('count:1.5e2')).toEqual(comparison('==', 150));
      expect(parser.parse('count:1e0')).toEqual(comparison('==', 1));
      expect(parser.parse('count:1e-2')).toEqual(comparison('==', 0.01));
      expect(parser.parse('count:1.25e1')).toEqual(comparison('==', 12.5));
      expect(parser.parse('count:100e-2')).toEqual(comparison('==', 1));
    });

    it('keeps an exponent that spells a rounding integer as a bigint', () => {
      expect(parser.parse('count:9.223372036854775807e18')).toEqual(
        comparison('==', 9223372036854775807n)
      );
    });

    it('keeps exact zero and the smallest subnormals', () => {
      expect(parser.parse('count:0e-400')).toEqual(comparison('==', 0));
      expect(parser.parse('count:-0e-400')).toEqual(comparison('==', 0));
      expect(parser.parse('count:1e-323')).toEqual(comparison('==', 1e-323));
      expect(parser.parse('count:5e-324')).toEqual(comparison('==', 5e-324));
      expect(parser.parse('count:4e-324')).toEqual(comparison('==', 5e-324));
    });

    it('leaves an exponent past the spelling limit to Liqe', () => {
      expect(() => parser.parse('count:1e401')).toThrow(/Syntax error/);
      expect(() => parser.parse('count:1e-401')).toThrow(/Syntax error/);
    });
  });

  describe('spellings that are not numerals', () => {
    it('keeps a quoted spelling a string', () => {
      expect(parser.parse('count:"9223372036854775809"')).toEqual(
        comparison('==', '9223372036854775809')
      );
      expect(parser.parse('count:"-9223372036854775809"')).toEqual(
        comparison('==', '-9223372036854775809')
      );
      expect(parser.parse('count:"1e21"')).toEqual(comparison('==', '1e21'));
      expect(parser.parse('count:"1e-400"')).toEqual(
        comparison('==', '1e-400')
      );
      expect(parser.parse('count:"1000000000000000000000"')).toEqual(
        comparison('==', '1000000000000000000000')
      );
    });

    it('keeps a regex literal and a field name as written', () => {
      expect(parser.parse('name:/1e21/')).toEqual(
        comparison('REGEX', '/1e21/', 'name')
      );
      expect(parser.parse('batch1e21:1')).toEqual(
        comparison('==', 1, 'batch1e21')
      );
    });
  });

  describe('the shared helpers', () => {
    it('exactSqliteInteger keeps only an in-range integer a number would misspell', () => {
      expect(exactSqliteInteger('1')).toBeNull();
      expect(exactSqliteInteger('007')).toBeNull();
      expect(exactSqliteInteger('9007199254740992')).toBeNull();
      expect(exactSqliteInteger('9007199254740993')).toBe(9007199254740993n);
      expect(exactSqliteInteger(INT64_MAX)).toBe(9223372036854775807n);
      expect(exactSqliteInteger(INT64_MIN)).toBe(-9223372036854775808n);
      expect(exactSqliteInteger('1152921504606847000')).toBe(
        1152921504606847000n
      );
      expect(exactSqliteInteger(TWO_TO_63)).toBeNull();
      expect(exactSqliteInteger('1000000000000000000000')).toBeNull();
    });

    it('isUnstorableInteger names the integers the parser rejects', () => {
      expect(isUnstorableInteger('1')).toBe(false);
      expect(isUnstorableInteger(INT64_MAX)).toBe(false);
      expect(isUnstorableInteger(INT64_MIN)).toBe(false);
      expect(isUnstorableInteger(TWO_TO_63)).toBe(false);
      expect(isUnstorableInteger('9223372036854775809')).toBe(true);
      expect(isUnstorableInteger('-9223372036854775809')).toBe(true);
      expect(isUnstorableInteger('1000000000000000000000')).toBe(true);
      expect(isUnstorableInteger('1'.repeat(400))).toBe(false);
    });

    it('spellNumeralToken spells one token the way the parser does', () => {
      expect(spellNumeralToken('1e-7')).toBe('0.0000001');
      expect(spellNumeralToken('2E3')).toBe('2000');
      expect(spellNumeralToken('-1.5e+2')).toBe('-150');
      expect(spellNumeralToken('+1')).toBe('1');
      expect(spellNumeralToken('1.')).toBe('1');
      expect(spellNumeralToken('.5')).toBe('0.5');
      expect(spellNumeralToken('-.5')).toBe('-0.5');
      expect(spellNumeralToken('+9007199254740993')).toBe('9007199254740993');
      expect(spellNumeralToken('9007199254740993.')).toBe('9007199254740993');
      expect(spellNumeralToken('007')).toBe('007');
      expect(spellNumeralToken('-0')).toBe('-0');
      expect(spellNumeralToken('1e401')).toBe('1e401');
      expect(spellNumeralToken('.0000001')).toBe('.0000001');
      expect(spellNumeralToken('abc')).toBe('abc');
      expect(() => spellNumeralToken('1e21')).toThrow(
        'Integer is outside the signed 64-bit range: 1e21'
      );
      expect(() => spellNumeralToken('1e-400')).toThrow(
        'Exponent underflows to zero: 1e-400'
      );
    });

    it('spellNumerals rewrites unquoted numerals outside literals only', () => {
      expect(spellNumerals('count:1e-7 AND name:"1e-7" OR note:/2E3/')).toBe(
        'count:0.0000001 AND name:"1e-7" OR note:/2E3/'
      );
      expect(spellNumerals('count:[1e-7 TO 1e3] count:in[+1,.5,1.]')).toBe(
        'count:[0.0000001 TO 1000] count:in[1,0.5,1]'
      );
      expect(spellNumerals('count:!=+1 count:>=.5 (count:2E3)')).toBe(
        'count:!=1 count:>=0.5 (count:2000)'
      );
      expect(spellNumerals('batch1e2:1 a.5:x count:1.* count:.5* x:1e2y')).toBe(
        'batch1e2:1 a.5:x count:1.* count:.5* x:1e2y'
      );
      expect(spellNumerals('count:++1 count:--1 count:1.2.3')).toBe(
        'count:++1 count:--1 count:1.2.3'
      );
    });
  });

  describe('search-box completeness', () => {
    it.each([
      'count:9223372036854775809',
      'count:>=9223372036854775809',
      'count:-9223372036854775809',
      'count:1000000000000000000000',
      'count:[1000000000000000000000]',
      'count:[1 TO 1000000000000000000000]',
      'count:1e21',
      'count:1e+21',
      'count:1E21',
      'count:1.5e21',
      'count:-1e21',
      'count:[1e21 TO 5]',
      'count:in[1e21]',
      'count:1e-400',
      'count:1e-324',
      'count:-1e-400'
    ])('treats the rejected spelling %p as incomplete', query => {
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(isInputComplete(query)).toBe(false);
    });

    it.each([
      'count:9223372036854775808',
      'count:9223372036854775807',
      'count:-9223372036854775808',
      'count:9007199254740993',
      'count:1e18',
      'count:1e2',
      'count:0e-400',
      'count:1e-323',
      'count:"1e21"',
      'count:"-9223372036854775809"',
      'count:"1000000000000000000000"',
      'count:"1e-400"',
      'count:in[1000000000000000000000]'
    ])('keeps %p complete', query => {
      expect(() => parser.parse(query)).not.toThrow();
      expect(isInputComplete(query)).toBe(true);
    });
  });
});
