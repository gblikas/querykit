import { DrizzleTranslator } from './index';

describe('DrizzleTranslator', () => {
  let translator: DrizzleTranslator;

  beforeEach(() => {
    translator = new DrizzleTranslator();
  });

  // Helper function to access private wildcardToSqlPattern method
  function testWildcardPattern(pattern: string): string {
    // We need to access a private method for testing - using type assertion
    return (translator as unknown as { 
      wildcardToSqlPattern: (p: string) => string 
    }).wildcardToSqlPattern(pattern);
  }

  // Other tests...

  describe('wildcardToSqlPattern', () => {
    it('should convert * wildcard to % SQL pattern', () => {
      expect(testWildcardPattern('foo*')).toBe('foo%');
      expect(testWildcardPattern('*bar')).toBe('%bar');
      expect(testWildcardPattern('foo*bar')).toBe('foo%bar');
      expect(testWildcardPattern('*foo*')).toBe('%foo%');
    });

    it('should convert ? wildcard to _ SQL pattern', () => {
      expect(testWildcardPattern('foo?')).toBe('foo_');
      expect(testWildcardPattern('?bar')).toBe('_bar');
      expect(testWildcardPattern('foo?bar')).toBe('foo_bar');
    });

    it('should handle mixed wildcards', () => {
      expect(testWildcardPattern('f*o?bar*')).toBe('f%o_bar%');
      expect(testWildcardPattern('*test?')).toBe('%test_');
    });

    it('should escape existing SQL special characters', () => {
      expect(testWildcardPattern('foo%bar')).toBe('foo\\%bar');
      expect(testWildcardPattern('foo_bar')).toBe('foo\\_bar');
      expect(testWildcardPattern('foo_%bar*')).toBe('foo\\_\\%bar%');
    });
  });
}); 