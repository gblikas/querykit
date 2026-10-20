/**
 * Read a boolean limit or offset the way SQLite reads `TRUE` and `FALSE`.
 *
 * `true` is 1 and `false` is 0. Any other value, including `undefined` and
 * a number, is returned unchanged. `Number.isInteger` and `Number.isFinite`
 * both reject a boolean, and better-sqlite3 cannot bind one, so a boolean
 * window would otherwise throw while `LIMIT true` returns rows.
 *
 * @param value - Limit or offset as the caller passed it
 * @returns `1` for `true`, `0` for `false`, otherwise the same value
 * @example
 * booleanWindowCount(true); // 1
 * booleanWindowCount(false); // 0
 * booleanWindowCount(2); // 2
 */
export function booleanWindowCount(value: unknown): unknown {
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  return value;
}
