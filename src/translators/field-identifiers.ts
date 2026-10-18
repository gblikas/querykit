/**
 * Field identifiers shared by the SQL and Drizzle translators and the
 * Drizzle adapter's sort path.
 *
 * A field name reaches the translators as the parser stored it. Exactly one
 * dot splits it into `table.column`; a name with no dot, with two or more
 * dots, the name `.`, and a name the parser marked literal (a quoted
 * `"a.b"`, a quoted or unquoted name with an empty side such as `table.` or
 * `.column`) is one identifier. Each identifier is written in quotes with an
 * embedded quote doubled, so a name can hold any character without ending
 * the identifier early.
 */

/** Longest identifier part the schema-less Drizzle path accepts. */
const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Split a field name into the identifiers to quote.
 *
 * @param field - The field name as the parser stored it
 * @param isLiteral - True when the parser marked the name literal, so a
 * single dot is part of the name rather than a qualifier
 * @returns One identifier, or `[table, column]` for a single unmarked dot;
 * either side of that pair may be empty, which the caller rejects or quotes
 *
 * @example
 * ```typescript
 * readFieldIdentifiers('owner.city'); // ['owner', 'city']
 * readFieldIdentifiers('a.b.c'); // ['a.b.c']
 * readFieldIdentifiers('a.b', true); // ['a.b']
 * readFieldIdentifiers('.'); // ['.']
 * ```
 */
export function readFieldIdentifiers(
  field: string,
  isLiteral = false
): string[] {
  if (isLiteral || field === '.') {
    return [field];
  }
  const parts = field.split('.');
  return parts.length === 2 ? parts : [field];
}

/**
 * Write one identifier in quotes, doubling an embedded quote character.
 *
 * @param identifier - The identifier text; may be empty
 * @param quote - The identifier quote character, `"` by default
 * @returns The quoted identifier
 *
 * @example
 * ```typescript
 * quotedIdentifierText('say"hi'); // "say""hi"
 * quotedIdentifierText(''); // ""
 * ```
 */
export function quotedIdentifierText(identifier: string, quote = '"'): string {
  return `${quote}${identifier.split(quote).join(quote + quote)}${quote}`;
}

/**
 * Read a quoted identifier back, undoubling the quote character. Text that
 * is not wrapped in the quote character is returned as given.
 *
 * @param text - Output of {@link quotedIdentifierText}
 * @param quote - The identifier quote character, `"` by default
 * @returns The identifier text
 *
 * @example
 * ```typescript
 * readQuotedIdentifier('"say""hi"'); // say"hi
 * ```
 */
export function readQuotedIdentifier(text: string, quote = '"'): string {
  if (text.length < 2 || !text.startsWith(quote) || !text.endsWith(quote)) {
    return text;
  }
  return text
    .slice(1, -1)
    .split(quote + quote)
    .join(quote);
}

/**
 * Quote every identifier of a field name and join them with a dot.
 *
 * @param field - The field name as the parser stored it
 * @param isLiteral - True when the parser marked the name literal
 * @param quote - The identifier quote character, `"` by default
 * @returns The quoted field, such as `"owner"."city"` or `"a.b"`
 */
export function quoteFieldIdentifiers(
  field: string,
  isLiteral = false,
  quote = '"'
): string {
  return readFieldIdentifiers(field, isLiteral)
    .map(part => quotedIdentifierText(part, quote))
    .join('.');
}

/**
 * Whether one identifier part may be inlined by the schema-less Drizzle
 * path: its contents round-trip through quoting, it holds no `;` or null
 * byte, no reserved `__`, and is at most 64 characters.
 *
 * @param part - One identifier
 * @returns True when the part can be quoted as one identifier
 */
function isQuotedFieldIdentifier(part: string): boolean {
  if (part.length > MAX_IDENTIFIER_LENGTH || part.includes('__')) {
    return false;
  }
  if (part.includes(';') || part.includes('\u0000')) {
    return false;
  }
  return readQuotedIdentifier(quotedIdentifierText(part)) === part;
}

/**
 * Whether a field name may be inlined as quoted identifiers. Every part must
 * pass {@link isQuotedFieldIdentifier}; a qualified `table.column` must have
 * two non-empty parts, while a field whose whole name is empty is the one
 * identifier `""`.
 *
 * @param field - The field name as the parser stored it
 * @param isLiteral - True when the parser marked the name literal
 * @returns True when the name can be quoted
 *
 * @example
 * ```typescript
 * isQuotableFieldName('sta?tus'); // true
 * isQuotableFieldName(''); // true
 * isQuotableFieldName('table.'); // false
 * isQuotableFieldName('table.', true); // true
 * isQuotableFieldName('x; DROP TABLE y'); // false
 * ```
 */
export function isQuotableFieldName(field: string, isLiteral = false): boolean {
  const parts = readFieldIdentifiers(field, isLiteral);
  if (parts.length === 2 && parts.some(part => part === '')) {
    return false;
  }
  return parts.every(isQuotedFieldIdentifier);
}
