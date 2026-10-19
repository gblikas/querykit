/**
 * The query length cap.
 *
 * A 10,000-character bare word costs Liqe about 2 s of synchronous CPU, and
 * every other cap measures the parsed AST. `maxQueryLength` (default 10,000)
 * is checked at the entry of `parse`, `parseWithContext` and
 * `isInputComplete`, before any rewrite or Liqe run, so a 10,001-character
 * input is rejected in well under 5 ms on each; a 10,000-character input is
 * still read. The cap moves with the option, down and up, and `Infinity`
 * switches it off.
 */

import { performance } from 'perf_hooks';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const DEFAULT_CAP = 10000;
const REJECTION_BUDGET_MS = 5;
const overLongBareWord = 'a'.repeat(DEFAULT_CAP + 1);
// A quoted value Liqe reads in a fraction of the bare word's time, so the
// raised cap can be shown on a real parse without a 2 s test.
const overLongQuoted = `status:"${'a'.repeat(DEFAULT_CAP - 8)}"`;
const expectedMessage = `Query exceeds the maximum length of ${DEFAULT_CAP} characters (${DEFAULT_CAP + 1})`;

/** The fastest of three runs, so a busy CI machine does not fail the budget. */
function fastestMs(run: () => void): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - startedAt);
  }
  return fastest;
}

describe('the query length cap', () => {
  const parser = new QueryParser();

  it('is 10,000 characters by default', () => {
    expect(overLongQuoted).toHaveLength(DEFAULT_CAP + 1);
    expect(() => parser.parse(overLongBareWord)).toThrow(QueryParseError);
    expect(() => parser.parse(overLongQuoted)).toThrow(expectedMessage);
    expect(parser.parse(overLongQuoted.slice(0, -2) + '"')).toMatchObject({
      type: 'comparison',
      field: 'status'
    });
  });

  describe('rejects a 10,001-character input before the parser reads it', () => {
    it('parse throws QueryParseError within the budget', () => {
      const elapsedMs = fastestMs(() => {
        expect(() => parser.parse(overLongBareWord)).toThrow(expectedMessage);
      });
      expect(elapsedMs).toBeLessThan(REJECTION_BUDGET_MS);
    });

    it('parseWithContext returns a failed, incomplete result within the budget', () => {
      const elapsedMs = fastestMs(() => {
        const result = parser.parseWithContext(overLongBareWord);
        expect(result).toMatchObject({
          success: false,
          error: { message: expectedMessage, position: DEFAULT_CAP },
          tokens: [],
          activeTokenIndex: -1,
          structure: { isComplete: false, clauseCount: 0, referencedFields: [] }
        });
        expect(result.ast).toBeUndefined();
        expect(result.recovery).toBeUndefined();
      });
      expect(elapsedMs).toBeLessThan(REJECTION_BUDGET_MS);
    });

    it('isInputComplete returns false within the budget', () => {
      const elapsedMs = fastestMs(() => {
        expect(isInputComplete(overLongBareWord)).toBe(false);
      });
      expect(elapsedMs).toBeLessThan(REJECTION_BUDGET_MS);
    });
  });

  describe('moves with the option', () => {
    it('a lower cap rejects a short query on every entry point', () => {
      const capped = new QueryParser({ maxQueryLength: 10 });
      expect(() => capped.parse('status:open')).toThrow(
        'Query exceeds the maximum length of 10 characters (11)'
      );
      expect(capped.parseWithContext('status:open').success).toBe(false);
      expect(isInputComplete('status:open', { maxQueryLength: 10 })).toBe(
        false
      );
      expect(capped.parse('status:ope')).toMatchObject({ field: 'status' });
    });

    it('a raised cap reads a 10,001-character query on every entry point', () => {
      const raised = new QueryParser({ maxQueryLength: DEFAULT_CAP + 1 });
      expect(raised.parse(overLongQuoted)).toMatchObject({
        type: 'comparison',
        field: 'status',
        operator: '=='
      });
      expect(raised.parseWithContext(overLongQuoted)).toMatchObject({
        success: true,
        structure: { isComplete: true, clauseCount: 1 }
      });
      expect(
        isInputComplete(overLongQuoted, { maxQueryLength: DEFAULT_CAP + 1 })
      ).toBe(true);
    });

    it('Infinity switches the cap off', () => {
      const uncapped = new QueryParser({ maxQueryLength: Infinity });
      expect(uncapped.parse(overLongQuoted)).toMatchObject({ field: 'status' });
    });

    it.each([0, -1, 1.5, NaN])('rejects %p as a cap', invalidCap => {
      expect(() => new QueryParser({ maxQueryLength: invalidCap })).toThrow(
        RangeError
      );
      expect(() =>
        isInputComplete('status:open', { maxQueryLength: invalidCap })
      ).toThrow(RangeError);
    });
  });
});
