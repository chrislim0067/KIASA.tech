/**
 * Client-side mirror of the database's blank/invisible-value rule.
 *
 * The authority is `public.is_blank_or_invisible(text)` in
 * `supabase/migrations/20260907000011_whitespace_and_helper_cleanup.sql`, which
 * deletes an explicit set of code points with `translate()` and asks whether
 * anything remains. This file reproduces that set and that logic exactly so the
 * application can give fast feedback; the database remains the sole authority,
 * and `scripts/test-validation-parity.mjs` fails if the two sets ever diverge.
 *
 * Why not a regex: `\s` in JavaScript and `[[:space:]]` in PostgreSQL are both
 * defined by their host's notion of "space". Neither covers U+200B or U+FEFF,
 * and PostgreSQL's depends on the database ctype. `trim()` and `btrim()` are
 * narrower still — single-argument `btrim` strips only U+0020, which is the
 * defect migration 11 exists to fix. Exact code-point matching is the only
 * approach that is identical on both sides.
 *
 * Every code point is written as a numeric literal. A source file containing
 * real invisible characters cannot be reviewed, and any editor that trims
 * trailing whitespace or rewrites line endings would silently change the rule.
 */

/**
 * The 28 code points the database treats as invisible, in the same order as the
 * SQL `U&'...'` literal.
 */
export const INVISIBLE_CODE_POINTS: readonly number[] = Object.freeze([
  0x0020, // SPACE
  0x0009, // CHARACTER TABULATION
  0x000a, // LINE FEED
  0x000b, // LINE TABULATION
  0x000c, // FORM FEED
  0x000d, // CARRIAGE RETURN
  0x00a0, // NO-BREAK SPACE
  0x1680, // OGHAM SPACE MARK
  0x2000, // EN QUAD
  0x2001, // EM QUAD
  0x2002, // EN SPACE
  0x2003, // EM SPACE
  0x2004, // THREE-PER-EM SPACE
  0x2005, // FOUR-PER-EM SPACE
  0x2006, // SIX-PER-EM SPACE
  0x2007, // FIGURE SPACE
  0x2008, // PUNCTUATION SPACE
  0x2009, // THIN SPACE
  0x200a, // HAIR SPACE
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x2028, // LINE SEPARATOR
  0x2029, // PARAGRAPH SEPARATOR
  0x202f, // NARROW NO-BREAK SPACE
  0x205f, // MEDIUM MATHEMATICAL SPACE
  0x3000, // IDEOGRAPHIC SPACE
  0xfeff, // ZERO WIDTH NO-BREAK SPACE (BOM)
]);

const INVISIBLE_SET: ReadonlySet<number> = new Set(INVISIBLE_CODE_POINTS);

/**
 * True when `value` is null/undefined or consists only of invisible code points.
 *
 * Mirrors `public.is_blank_or_invisible`: a value is blank only if EVERY code
 * point is in the set, so any visible character anywhere — ASCII, accented
 * Latin, CJK, emoji — makes it valid. Iterating the string with `for...of`
 * walks whole code points, so an astral character is judged as one character
 * rather than as two surrogate halves.
 *
 * This function inspects; it never returns a modified string. Candidate text is
 * stored byte-for-byte.
 */
export function isBlankOrInvisible(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  for (const ch of value) {
    if (!INVISIBLE_SET.has(ch.codePointAt(0) as number)) return false;
  }
  return true;
}
