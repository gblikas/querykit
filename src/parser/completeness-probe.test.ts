/**
 * Seeded probe of the search box against the parser.
 *
 * Each composition is a clean query of one to four clauses to which zero,
 * one or two mutations from the families the search-box hunts recorded are
 * applied: operators, brackets, quotes, regex, Unicode spaces, control
 * characters, numerals and keywords, with parentheses, glue, bare words,
 * colons, negation and comments. The generator is deterministic for its
 * seed, so a failure names a reproducible composition, shrunk by
 * single-character deletion to a minimal form.
 *
 * Direction A, `isInputComplete` true while `parse` throws, is the one a
 * user typing sees and must be zero. Direction B, false while `parse`
 * accepts, is recorded as a ceiling a later change may only lower.
 *
 * CI runs 2,000 compositions. To run more locally:
 *
 * ```sh
 * QUERYKIT_PROBE_COUNT=50000 CI=true pnpm exec jest \
 *   src/parser/completeness-probe.test.ts --coverage=false
 * ```
 */

import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const LF = '\n';
const CR = '\r';

const FIELDS: readonly string[] = [
  'status',
  'x',
  's',
  'T',
  'l',
  'n',
  '_x',
  '$',
  'a.b',
  'x1',
  '"a b"',
  "'q'",
  '""',
  "''",
  'not.priority',
  'Status',
  'label'
];

const OPERATORS: readonly string[] = [
  ':',
  ':',
  ':',
  ':',
  ':>',
  ':>=',
  ':<',
  ':<=',
  ':=',
  ':!=',
  ':!=',
  ':!=>',
  ':!=<='
];

const PLAIN_VALUES: readonly string[] = [
  'open',
  'a',
  'D',
  'done*',
  'a?b',
  'a*',
  'x-y',
  'true',
  'false',
  'null',
  'é',
  '日本',
  '@x',
  '#t',
  '*',
  'a.b',
  'and',
  'Open',
  'x1',
  '_',
  'a\u2003b',
  'a\u00a0b'
];

const NUMERALS: readonly string[] = [
  '1',
  '-1',
  '+1',
  '1.',
  '.5',
  '1.5',
  '-1.5',
  '1e5',
  '1e-7',
  '1.e5',
  '1E5',
  '0',
  '-0',
  '1e18',
  '9223372036854775807',
  '-9223372036854775808',
  '42'
];

const QUOTED_VALUES: readonly string[] = [
  '"a"',
  "'a'",
  '"a b"',
  '""',
  "''",
  '"a\\"b"',
  '"a\\\\b"',
  '"\\u0041"',
  "'\\''",
  '"a\\nb"',
  '"AND"',
  '"a:b"',
  '"(a)"',
  '"/a/"',
  '"[a]"',
  '"a,b"',
  '"a\tb"',
  `"a${CR}b"`,
  '"\\b"',
  '"\\\\"',
  '"a\u2003b"',
  '"\\/"'
];

const REGEX_VALUES: readonly string[] = [
  '/a/',
  '//',
  '////',
  '/a/i',
  '/\\//',
  '/[/]/',
  '/a,b/',
  '/(/',
  '/ /',
  '/a\\/b/',
  '/a b/',
  '/"/',
  '/a:b/',
  '/*/',
  '/)/',
  '/[a-z]+/',
  `/a${LF}b/`,
  '/\u2003/'
];

const BRACKET_BODIES: readonly string[] = [
  '[a, b]',
  '[a]',
  '[a,b,c]',
  '[1 TO 5]',
  '{1 TO 5]',
  '[1 TO 5}',
  '{1 TO 5}',
  '[1 TO *]',
  '[* TO 5]',
  '[//]',
  '[////]',
  '[//, a]',
  '[a, //]',
  '[/a,b/]',
  '[/a/]',
  '[/\\//]',
  '[a b]',
  '["a b"]',
  "['a']",
  '["a", \'b\']',
  '[and]',
  '[-1]',
  '[-1.5]',
  '[.5]',
  '[1e5]',
  '[+1]',
  '[9223372036854775807]',
  '[a TO b]',
  '["a" TO \'b\']',
  '{a TO b}',
  '[1 to 5]',
  '[1  TO  5]',
  '[1 TO 5 ]',
  '[a\tb]',
  `[a${CR}b]`,
  '[""]',
  "['']",
  '["",a]',
  '[a, "b c", /d,e/]',
  '[1, 2, 3]',
  '[a, 1 TO 5]',
  '[a:b]',
  '[a(b]',
  '[#a]',
  '[@a]',
  '[$a]',
  '[a-b]',
  '[a*]',
  '[a?b]',
  '[,]',
  '[,a]',
  '[a,]',
  '[x "a"]',
  '["a" AND label:x]',
  '[/a/ TO b]',
  `[a,${LF}b]`,
  `[${LF}a]`,
  '[a\u2003b]',
  '[a\u00a0b]',
  '[/[/]',
  '[/a/, b]',
  '[/a/i, b]'
];

const MEMBERSHIP_BODIES: readonly string[] = [
  'in[a, b]',
  'in [a]',
  'in[]',
  'not in[a]',
  'not in [a, b]',
  'NOT IN[a]',
  'In [1, 2]',
  'IN[a]',
  'in[/a/]',
  'in[//]',
  'in[1, "2", true, null]',
  `in[a${LF}b]`,
  'in\t[a]',
  'in[a b]',
  'in[a(b]',
  'in [a, /b,c/]',
  'in  [a]',
  'in[,]',
  'in[a,]',
  'in[9223372036854775808]',
  'in["a\\u0041"]'
];

const JOINERS: readonly string[] = [
  ' AND ',
  ' AND ',
  ' OR ',
  ' OR ',
  ' and ',
  ' or ',
  ' And ',
  ' AND NOT ',
  ' OR NOT ',
  ' ',
  ' ',
  ' ',
  '  ',
  '\t',
  LF,
  '\v',
  '\f',
  ' NOT ',
  ' -'
];

const OPERATOR_MUTATIONS: readonly string[] = [
  ': ',
  ' :',
  '::',
  ':!',
  ':==',
  ':>>',
  ':!=!',
  ':=>',
  ':< ',
  ':>-',
  '=',
  ' = ',
  ':!=:'
];

const JOINER_MUTATIONS: readonly string[] = [
  ' AND  OR ',
  ' NOT NOT ',
  ' AND AND ',
  ' OR OR ',
  ' && ',
  ' || ',
  '&',
  '|',
  'AND',
  'OR',
  ' AND',
  'AND ',
  ' OR',
  ' A ',
  ' TO ',
  ' , ',
  ',',
  ' -- ',
  ' NOT -',
  ' -NOT ',
  ' - ',
  ' ! ',
  ' ? ',
  ' ; ',
  ' ^ ',
  ' ~ ',
  ' NOT',
  'NOT ',
  ' AND -',
  ' --',
  ' AND\tNOT\t',
  ' nOt ',
  ' ANDNOT ',
  ' NOTAND ',
  ' not not '
];

const BRACKET_MUTATIONS: readonly string[] = [
  '[]',
  '[ ]',
  '{}',
  '{abc}',
  '{a, b}',
  '[a TO ]',
  '[ TO b]',
  '[* TO *]',
  '[,,]',
  '[,//,////]',
  '[//,//,]',
  '[/a/, /b/, x]',
  '[x, /a/, /b/]',
  '[/a/,/b/, x]',
  '[/\\\\/]',
  '[/\\\\/ TO b]',
  '[/a',
  '["a" OR status:"c"]',
  '["a" "b"]',
  '["a" "b" TO d]',
  '["a"b]',
  '["a"b"c"]',
  '["a" -status:"c"]',
  '[AND]',
  '[ and ]',
  '[NOT]',
  '[1x]',
  '[[a]]',
  '[a[b]',
  '[a]b]',
  '[a)b]',
  '[a;b]',
  '[null TO 5]',
  '[true TO 5]',
  '[1 TO null]',
  '[a TO false]',
  `[a${LF}b]`,
  `[x, a${LF}b]`,
  `[/a${LF}b/]`,
  `[a${LF}b TO c]`,
  `["a${LF}b"]`,
  `[a${LF}b, x]`,
  `[/${LF}/]`,
  '[1e]',
  '[9223372036854775808]',
  '[1 TO 9223372036854775808]',
  '[a TO b TO c]',
  '[a',
  '{a',
  '[a}',
  '{a]',
  '[a\u0000b]',
  '[\\]',
  '[a\\b]',
  '["\\"]',
  '[a=b]',
  '[a%b]',
  '[-x]',
  '[//]/',
  '[//]x',
  '[a]b',
  '[1]x',
  '[a, b]x',
  '[a]AND',
  '[a]/b/',
  '[.5]x',
  '[AND]x',
  '[//2]/',
  '[,a]',
  '{,5]',
  '[a,]',
  '[/\\//]/',
  '[//]/)',
  'in[a}',
  'in{a]',
  'in{a}',
  'in["a"b]',
  'in["a" "b"]',
  'in ["a" OR x:"c"]',
  'in[a',
  'in[[a]]',
  'in[a TO b]',
  `in${LF}[a]`,
  'in\u2003[a]',
  'in[a]b',
  'in[a]/',
  'in["a\\q"]',
  'in[]/',
  'in[a]AND'
];

const QUOTE_MUTATIONS: readonly string[] = [
  '"a\\q"',
  '"\\U0041"',
  '"\\u00"',
  '"\\\'"',
  '"a',
  "'a",
  '"a\'',
  '"a""b"',
  '"a"b',
  'a"b"',
  `"a${LF}b"`,
  '"a"c"',
  '"a\\"',
  '"a"/',
  '"a":',
  '"a"(',
  '"a")',
  '""""',
  "''''",
  '"\\"',
  '"a\\u004"'
];

const REGEX_MUTATIONS: readonly string[] = [
  '///',
  '/////',
  '/a/gi',
  '/a/x',
  '/a/ib',
  '/\\\\/',
  '/[/',
  '/a',
  '/a/b',
  `/a${LF}b/`,
  '/\\\\//',
  '/[]/',
  '/a//',
  '/\u2003/',
  '//x',
  '/a/"',
  '/a/)',
  '/a/(',
  '/a/\\',
  '/\\/',
  '/a/ AND /b/',
  '/a/ OR x://'
];

const UNICODE_SPACE_JOINERS: readonly string[] = [
  '\u2003',
  '\u00a0',
  '\u3000',
  '\ufeff',
  '\u2028',
  '\u1680',
  ' AND\u2003',
  '\u2003AND ',
  ' OR\u00a0',
  ' and\u2003',
  '\u00a0AND\u00a0',
  ' NOT\u2003'
];

const UNICODE_SPACES: readonly string[] = [
  '\u2003',
  '\u00a0',
  '\u3000',
  '\ufeff',
  '\u2028',
  '\u202f'
];

const CONTROL_CHARACTERS: readonly string[] = [
  '\u0000',
  '\u0001',
  '\u007f',
  CR,
  `${CR}${LF}`,
  '\u001b',
  '\u0008'
];

const NUMERAL_MUTATIONS: readonly string[] = [
  '1e',
  '1e401',
  '1e-400',
  '0x10',
  '1_0',
  '1.2.3',
  '--1',
  '+',
  '.',
  '-',
  '+-1',
  '1,5',
  '9223372036854775808',
  '-9223372036854775809',
  '18446744073709551616',
  '1e19',
  '2nd',
  '1x',
  '٣',
  '01',
  '00',
  '1e+',
  '1.e',
  '.e5',
  '1e5.5',
  '+.',
  '-.',
  '1-',
  '1+1',
  '0.0e0',
  '1e-401',
  '9.3e18',
  '-9.3e18',
  '1.5e18',
  '1e18.0'
];

const KEYWORD_MUTATIONS: readonly string[] = [
  'AND',
  'OR',
  'NOT',
  'and',
  'or',
  'not',
  'TO',
  'in',
  'IN',
  'NOT IN',
  'And',
  'nOt',
  'ANDx',
  'xAND',
  'NOTa',
  'TRUE',
  'NULL'
];

const PAREN_PREFIXES: readonly string[] = [
  '(',
  '((',
  '( ',
  'NOT(',
  '-(',
  '(NOT ',
  '(-',
  ')',
  ') ',
  '()',
  '( )',
  'NOT ()',
  '(('
];

const PAREN_SUFFIXES: readonly string[] = [
  ')',
  '))',
  ' )',
  ' (',
  '(',
  ')(',
  ' AND )',
  '()',
  ' ()',
  ' AND(',
  ' NOT(',
  '))'
];

const GLUE_MUTATIONS: readonly string[] = [
  '',
  ')',
  '(',
  ')AND(',
  ')AND (',
  ') AND(',
  ')OR(',
  'AND(',
  ')AND',
  '"a"',
  '/a/',
  '-',
  'NOT',
  'x',
  '1',
  '[a]',
  ':'
];

const BARE_CLAUSES: readonly string[] = [
  'open',
  '"hello world"',
  '""',
  '1',
  '/re/',
  'x',
  '-x',
  'NOT x',
  '*',
  'a?b',
  "'a'",
  '1e5',
  '-1',
  '(open)',
  'a.b',
  '.5'
];

const COLON_MUTATIONS: readonly string[] = [
  ':a',
  ':',
  '::',
  ' :',
  ': ',
  ':a:b',
  '"a":',
  '1x:a',
  '.col:a',
  'a-b:c',
  'a b:c',
  'status: open',
  'status :open',
  'status:open:x',
  'in:a',
  'not:a',
  'to:a',
  'ét:a',
  '$:a',
  '_:a',
  'x.:a',
  '.x:a',
  'x..y:a',
  'x:',
  'x:>',
  'x:!=',
  'x:>=',
  'x:(a)',
  'x: (a)',
  'x:()'
];

const NEGATION_MUTATIONS: readonly string[] = [
  '--',
  '- ',
  'NOT NOT ',
  'NOT -',
  '-NOT ',
  'NOT  NOT ',
  'NOT\tNOT ',
  'NOT ',
  '-',
  'NOT\u2003',
  'not not ',
  '-(',
  'NOT(',
  'NOT -(',
  'NOT NOT(',
  '---'
];

const COMMENT_MUTATIONS: readonly string[] = [
  '/* c */',
  '// c',
  '# c',
  '-- c',
  '/*',
  '*/',
  '<!-- c -->',
  ';'
];

const SYMBOL_INSERTIONS: readonly string[] = [
  '&',
  '|',
  ';',
  '^',
  '~',
  '!',
  '?',
  '`',
  '\\',
  '%',
  '=',
  '<',
  '>',
  '+',
  '[',
  ']',
  '{',
  '}',
  '(',
  ')',
  '"',
  "'",
  '/',
  ',',
  ':',
  '*',
  '-',
  '.',
  '#',
  '@',
  '$',
  '_',
  'x',
  ' ',
  LF,
  '\t',
  '\u2003',
  '\u00a0',
  '\u0000',
  CR
];

const GLUED_PREFIXES: readonly string[] = [
  'x',
  '"a"',
  'NOT',
  '-',
  '1',
  '/a/',
  ')',
  ':'
];

const VALUE_TAILS: readonly string[] = [
  'x',
  '/',
  '"',
  ')',
  '(',
  ']',
  '[',
  'i',
  'b',
  '\\',
  ':',
  '*',
  ',',
  '-',
  '.',
  ' ',
  '\u2003',
  LF
];

const ODD_FIELDS: readonly string[] = [
  '1x',
  '.col',
  'a-b',
  'ét',
  'x..y',
  '',
  ' ',
  '"a',
  "'",
  'x y',
  'a:b',
  'x.',
  '$$',
  '__'
];

const TRAILING_WORDS: readonly string[] = [
  ' AND',
  ' OR',
  ' NOT',
  ' and',
  ' -',
  'AND'
];

const CONTROL_JOINERS: readonly string[] = [
  CR,
  `${CR}${LF}`,
  '\u0000',
  ' \u007f '
];

type Random = () => number;

/**
 * A pseudo-random number generator with a 32-bit state (mulberry32),
 * deterministic for a seed, so a composition is reproducible from its seed
 * and index.
 */
function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface IClause {
  field: string;
  operator: string;
  value: string;
  prefix: string;
  suffix: string;
}

interface IComposition {
  prefix: string;
  clauses: IClause[];
  joiners: string[];
  suffix: string;
}

function pick(random: Random, pool: readonly string[]): string {
  return pool[Math.floor(random() * pool.length)] ?? '';
}

function pickIndex(random: Random, length: number): number {
  return Math.floor(random() * Math.max(length, 1));
}

function pickClause(random: Random, composition: IComposition): IClause {
  return composition.clauses[pickIndex(random, composition.clauses.length)];
}

function pickCleanValue(random: Random): string {
  const roll = random();
  if (roll < 0.2) {
    return pick(random, PLAIN_VALUES);
  }
  if (roll < 0.34) {
    return pick(random, NUMERALS);
  }
  if (roll < 0.5) {
    return pick(random, QUOTED_VALUES);
  }
  if (roll < 0.66) {
    return pick(random, REGEX_VALUES);
  }
  if (roll < 0.9) {
    return pick(random, BRACKET_BODIES);
  }
  return pick(random, MEMBERSHIP_BODIES);
}

function isBracketValue(value: string): boolean {
  return /^(?:(?:not\s+)?in\s*)?[[{]/i.test(value);
}

function composeCleanClause(random: Random): IClause {
  const value = pickCleanValue(random);
  const operator =
    isBracketValue(value) && random() < 0.85
      ? pick(random, [':', ':', ':', ':!='])
      : pick(random, OPERATORS);
  const clause: IClause = {
    field: pick(random, FIELDS),
    operator,
    value,
    prefix: '',
    suffix: ''
  };
  const wrap = random();
  if (wrap < 0.08) {
    clause.prefix = '(';
    clause.suffix = ')';
  } else if (wrap < 0.12) {
    clause.prefix = 'NOT ';
  } else if (wrap < 0.15) {
    clause.prefix = '-';
  } else if (wrap < 0.18) {
    clause.prefix = 'NOT (';
    clause.suffix = ')';
  }
  return clause;
}

function composeClean(random: Random): IComposition {
  const clauseCount = 1 + Math.floor(random() * 4);
  const clauses: IClause[] = [];
  const joiners: string[] = [];
  for (let index = 0; index < clauseCount; index += 1) {
    clauses.push(composeCleanClause(random));
    if (index > 0) {
      joiners.push(pick(random, JOINERS));
    }
  }
  if (clauseCount >= 2 && random() < 0.2) {
    const start = pickIndex(random, clauseCount - 1);
    const end = start + 1 + pickIndex(random, clauseCount - start - 1);
    const negation = random() < 0.3 ? 'NOT ' : '';
    clauses[start].prefix = `${negation}(${clauses[start].prefix}`;
    clauses[end].suffix += ')';
  }
  return { prefix: '', clauses, joiners, suffix: '' };
}

function render(composition: IComposition): string {
  let text = composition.prefix;
  composition.clauses.forEach((clause, index) => {
    if (index > 0) {
      text += composition.joiners[index - 1] ?? ' ';
    }
    const { prefix, field, operator, value, suffix } = clause;
    text += `${prefix}${field}${operator}${value}${suffix}`;
  });
  return text + composition.suffix;
}

function insertAt(text: string, random: Random, piece: string): string {
  const index = pickIndex(random, text.length + 1);
  return text.slice(0, index) + piece + text.slice(index);
}

function insertClause(
  composition: IComposition,
  random: Random,
  value: string
): void {
  const clause: IClause = {
    field: '',
    operator: '',
    value,
    prefix: '',
    suffix: ''
  };
  const at = pickIndex(random, composition.clauses.length + 1);
  composition.clauses.splice(at, 0, clause);
  composition.joiners.push(pick(random, JOINERS));
}

function replaceJoiner(
  composition: IComposition,
  random: Random,
  pool: readonly string[],
  fallback: (composition: IComposition) => void
): void {
  if (composition.joiners.length === 0) {
    fallback(composition);
    return;
  }
  composition.joiners[pickIndex(random, composition.joiners.length)] = pick(
    random,
    pool
  );
}

/**
 * One mutation of a composition: it edits the composition in place and
 * returns null, or returns the mutated text when it edits the rendered
 * text directly.
 */
type Mutation = (composition: IComposition, random: Random) => string | null;

const MUTATIONS: readonly Mutation[] = [
  (c, r): null => {
    pickClause(r, c).operator = pick(r, OPERATOR_MUTATIONS);
    return null;
  },
  (c, r): null => {
    replaceJoiner(c, r, JOINER_MUTATIONS, composition => {
      composition.suffix += pick(r, TRAILING_WORDS);
    });
    return null;
  },
  (c, r): null => {
    const clause = pickClause(r, c);
    clause.value = pick(r, BRACKET_MUTATIONS);
    if (r() < 0.8) {
      clause.operator = pick(r, [':', ':', ':!=']);
    }
    return null;
  },
  (c, r): string => insertAt(render(c), r, pick(r, ['[', ']', '{', '}'])),
  (c, r): null => {
    pickClause(r, c).value = pick(r, QUOTE_MUTATIONS);
    return null;
  },
  (c, r): string => insertAt(render(c), r, pick(r, ['"', "'", '\\'])),
  (c, r): null => {
    pickClause(r, c).value = pick(r, REGEX_MUTATIONS);
    return null;
  },
  (c, r): string => (r() < 0.5 ? insertAt(render(c), r, '/') : `${render(c)}/`),
  (c, r): null => {
    replaceJoiner(c, r, UNICODE_SPACE_JOINERS, composition => {
      composition.prefix = pick(r, UNICODE_SPACES);
    });
    return null;
  },
  (c, r): string => insertAt(render(c), r, pick(r, UNICODE_SPACES)),
  (c, r): string => insertAt(render(c), r, pick(r, CONTROL_CHARACTERS)),
  (c, r): null => {
    replaceJoiner(c, r, CONTROL_JOINERS, composition => {
      composition.suffix += pick(r, CONTROL_CHARACTERS);
    });
    return null;
  },
  (c, r): null => {
    pickClause(r, c).value = pick(r, NUMERAL_MUTATIONS);
    return null;
  },
  (c, r): null => {
    insertClause(c, r, pick(r, NUMERAL_MUTATIONS));
    return null;
  },
  (c, r): null => {
    const clause = pickClause(r, c);
    if (r() < 0.7) {
      clause.value = pick(r, KEYWORD_MUTATIONS);
    } else {
      clause.field = pick(r, KEYWORD_MUTATIONS);
    }
    return null;
  },
  (c, r): null => {
    insertClause(c, r, pick(r, KEYWORD_MUTATIONS));
    return null;
  },
  (c, r): null => {
    if (r() < 0.5) {
      c.prefix = pick(r, PAREN_PREFIXES) + c.prefix;
    } else {
      c.suffix += pick(r, PAREN_SUFFIXES);
    }
    return null;
  },
  (c, r): string =>
    insertAt(render(c), r, pick(r, ['(', ')', '()', '( )', ' (', ') '])),
  (c, r): null => {
    replaceJoiner(c, r, GLUE_MUTATIONS, composition => {
      const clause = composition.clauses[0];
      clause.suffix = pick(r, GLUE_MUTATIONS) + clause.suffix;
    });
    return null;
  },
  (c, r): null => {
    const clause = pickClause(r, c);
    clause.prefix = pick(r, GLUED_PREFIXES) + clause.prefix;
    return null;
  },
  (c, r): null => {
    insertClause(c, r, pick(r, BARE_CLAUSES));
    return null;
  },
  (c, r): null => {
    const clause = pickClause(r, c);
    clause.field = '';
    clause.operator = '';
    clause.value = pick(r, COLON_MUTATIONS);
    return null;
  },
  (c, r): null => {
    const clause = pickClause(r, c);
    clause.prefix = pick(r, NEGATION_MUTATIONS) + clause.prefix;
    return null;
  },
  (c, r): null => {
    const clause = pickClause(r, c);
    const comment = pick(r, COMMENT_MUTATIONS);
    if (r() < 0.5) {
      clause.suffix += ` ${comment}`;
    } else {
      clause.prefix = `${comment} ${clause.prefix}`;
    }
    return null;
  },
  (c, r): string => insertAt(render(c), r, pick(r, SYMBOL_INSERTIONS)),
  (c, r): string => {
    const text = render(c);
    if (text.length < 2) {
      return text;
    }
    const index = pickIndex(r, text.length);
    return text.slice(0, index) + text.slice(index + 1);
  },
  (c, r): null => {
    const clause = pickClause(r, c);
    clause.value += pick(r, VALUE_TAILS);
    return null;
  },
  (c, r): null => {
    pickClause(r, c).field = pick(r, ODD_FIELDS);
    return null;
  }
];

/**
 * Compose one query: a clean composition with zero, one or two mutations.
 */
function composeQuery(random: Random): string {
  const composition = composeClean(random);
  const roll = random();
  const mutationCount = roll < 0.3 ? 0 : roll < 0.85 ? 1 : 2;
  for (let index = 0; index < mutationCount; index += 1) {
    const mutation = MUTATIONS[pickIndex(random, MUTATIONS.length)];
    const mutated = mutation(composition, random);
    if (mutated !== null) {
      return mutated;
    }
  }
  return render(composition);
}

/**
 * The first `count` compositions for `seed`, in order.
 */
function generateCompositions(seed: number, count: number): string[] {
  const random = createRandom(seed);
  const compositions: string[] = [];
  for (let index = 0; index < count; index += 1) {
    compositions.push(composeQuery(random));
  }
  return compositions;
}

/**
 * Shrink `query` by single-character deletions while `holds` stays true.
 */
function shrinkQuery(
  query: string,
  holds: (candidate: string) => boolean
): string {
  let current = query;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = current.slice(0, index) + current.slice(index + 1);
      if (candidate.length > 0 && holds(candidate)) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

interface IJudgement {
  isComplete: boolean;
  isAccepted: boolean;
  error: string | null;
}

const parser = new QueryParser();

function judge(query: string): IJudgement {
  const isComplete = isInputComplete(query);
  try {
    parser.parse(query);
    return { isComplete, isAccepted: true, error: null };
  } catch (error) {
    if (!(error instanceof QueryParseError)) {
      throw error;
    }
    return { isComplete, isAccepted: false, error: error.message };
  }
}

function isDirectionA(query: string): boolean {
  const judgement = judge(query);
  return judgement.isComplete && !judgement.isAccepted;
}

function isDirectionB(query: string): boolean {
  const judgement = judge(query);
  return !judgement.isComplete && judgement.isAccepted;
}

const PROBE_SEED = 1;
const DEFAULT_PROBE_COUNT = 2000;
const PROBE_COUNT = Number(
  process.env.QUERYKIT_PROBE_COUNT ?? DEFAULT_PROBE_COUNT
);

/**
 * Compositions `isInputComplete` reads as incomplete while `parse` accepts,
 * on the 2,000 compositions CI runs. Lower it when a change lowers the
 * count; never raise it. The forms behind it are regex literals Liqe reads
 * across a bracket closer or a `:!=`, where the same-length stand-in the
 * search box reads its regex spans from is read differently.
 */
const DIRECTION_B_CEILING = 0;

describe('completeness probe', () => {
  it(
    `agrees with parse on ${PROBE_COUNT} seeded compositions`,
    () => {
      const compositions = generateCompositions(PROBE_SEED, PROBE_COUNT);
      const directionA: string[] = [];
      const directionB: string[] = [];
      for (const query of compositions) {
        const judgement = judge(query);
        if (judgement.isComplete && !judgement.isAccepted) {
          directionA.push(query);
        } else if (!judgement.isComplete && judgement.isAccepted) {
          directionB.push(query);
        }
      }
      const minimalA = directionA.map(query => ({
        query,
        minimal: shrinkQuery(query, isDirectionA),
        error: judge(query).error
      }));
      expect(minimalA).toEqual([]);
      const isOverCeiling =
        PROBE_COUNT === DEFAULT_PROBE_COUNT &&
        directionB.length > DIRECTION_B_CEILING;
      const minimalB = isOverCeiling
        ? directionB.map(query => ({
            query,
            minimal: shrinkQuery(query, isDirectionB)
          }))
        : [];
      expect(minimalB).toEqual([]);
      if (PROBE_COUNT === DEFAULT_PROBE_COUNT) {
        expect(directionB.length).toBeLessThanOrEqual(DIRECTION_B_CEILING);
      }
    },
    Math.max(5000, PROBE_COUNT * 10)
  );

  it('composes the same queries for the same seed', () => {
    const first = generateCompositions(PROBE_SEED, 50);
    const second = generateCompositions(PROBE_SEED, 50);
    expect(second).toEqual(first);
    expect(first[0]).toBe('label:!=<=日本\u2003label:>=/a:b/ AND s:false');
    expect(first.join('\u0000').length).toBe(1926);
  });
});

/**
 * Minimal forms the probe found, pinned.
 */
describe('a bracket member glued to text that spells a numeral', () => {
  // The parser spells numerals before its bracket rewrite, so the one
  // member of `x:[1]` joined to the text after the closer reaches Liqe
  // unspelled: `1.` and `1e5` are not Liqe's decimal.
  it.each([
    'x:[1].',
    'x:[-1].',
    'x:[1]e5',
    'x:[1].e5',
    'x:[1 TO *].',
    'x:[* TO 1]e5',
    '$:// AND(x:!=[1].)'
  ])('%j is incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
  });

  it.each(['x:[1].5', 'x:[.5]5', 'x:[1]5', 'x:[-1]5', 'x:[1].0', 'x:[a].'])(
    '%j stays complete and parses',
    query => {
      expect(isInputComplete(query)).toBe(true);
      expect(() => parser.parse(query)).not.toThrow();
    }
  );
});
