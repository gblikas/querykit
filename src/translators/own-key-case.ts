/**
 * Own-key lookup by ASCII case, the rule SQLite applies to an identifier.
 */

/**
 * Fold `A-Z` to `a-z` and nothing else, the case rule SQLite applies to an
 * identifier and to the characters of a LIKE pattern.
 *
 * @param name - Text to fold
 * @returns The text with ASCII capitals lowered; `Σ` and `ö` are unchanged
 */
export function foldAsciiCase(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

/**
 * Find the own key of a record that a name resolves to: the exact own key
 * when there is one, else the single own key whose `A-Z` fold matches the
 * name's. Two keys that fold alike resolve nothing, a difference outside
 * ASCII (`Σ` against `σ`) resolves nothing, and a prototype name such as
 * `toString` or `constructor` is never a key.
 *
 * @param record - The object whose own keys are the candidates
 * @param name - The name to resolve
 * @returns The resolved own key, or undefined
 *
 * @example
 * ```typescript
 * findOwnKeyIgnoringCase({ createdAt: 1 }, 'CreatedAt'); // 'createdAt'
 * findOwnKeyIgnoringCase({ status: 1, Status: 2 }, 'STATUS'); // undefined
 * findOwnKeyIgnoringCase({ status: 1 }, 'toString'); // undefined
 * ```
 */
export function findOwnKeyIgnoringCase(
  record: object,
  name: string
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(record, name)) {
    return name;
  }
  const folded = foldAsciiCase(name);
  let match: string | undefined;
  for (const key of Object.keys(record)) {
    if (foldAsciiCase(key) !== folded) {
      continue;
    }
    if (match !== undefined) {
      return undefined;
    }
    match = key;
  }
  return match;
}
