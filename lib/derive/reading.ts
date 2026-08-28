/**
 * The canonical derivations from a ProseMirror document (SPEC-004).
 *
 * | Derived value    | Source     | Formula                                  |
 * |------------------|------------|------------------------------------------|
 * | `bodyText`       | `bodyJson` | recursive text-node concat, single-space |
 * | `readingMinutes` | `bodyText` | `max(1, ceil(wordCount / 238))`          |
 *
 * "One canonical derivation each" is the load-bearing phrase. `bodyText` feeds
 * BOTH the FTS5 index and the read-time estimate, so if the editor computed a
 * word count one way and search tokenised another, an article's stated reading
 * time would disagree with the text a reader can actually find. Everything
 * that needs either value calls into here.
 *
 * This module is deliberately free of any database or Tiptap import: it is
 * pure, so `tests/unit/derive.test.ts` can assert the formula against
 * generated documents without standing up a schema, and so `prisma/seed.ts`
 * can call it while building rows that do not exist yet.
 */

/** Words per minute. SPEC-004 fixes this at 238; it is not a tunable. */
export const WORDS_PER_MINUTE = 238;

/**
 * The subset of a ProseMirror node this module reads. Intentionally structural
 * rather than an import from Tiptap: the closed schema is SPEC-007's to define,
 * and a derivation that only needs `type`/`text`/`content` should not be
 * coupled to it.
 */
export interface ProseMirrorNode {
  type?: string;
  text?: string;
  content?: ProseMirrorNode[];
  [key: string]: unknown;
}

/** Collapse any run of whitespace to one space and trim the ends. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Every text node in document order, as an array.
 *
 * Exported because the acceptance criterion is stated against the text nodes
 * themselves — "`bodyText` word count matches the ProseMirror text nodes
 * exactly" — so the test needs the same enumeration the derivation uses, not a
 * second implementation of it.
 */
export function textNodes(node: ProseMirrorNode | null | undefined): string[] {
  if (!node || typeof node !== 'object') return [];
  const out: string[] = [];
  if (typeof node.text === 'string' && node.text.length > 0) out.push(node.text);
  if (Array.isArray(node.content)) {
    for (const child of node.content) out.push(...textNodes(child));
  }
  return out;
}

/**
 * The plaintext projection: text nodes concatenated in document order, joined
 * by a single space.
 *
 * Joining with a space rather than an empty string is what makes the word
 * count correct across block boundaries — ProseMirror stores no whitespace
 * between a heading's text node and the next paragraph's, so concatenating
 * directly would fuse the last word of one block onto the first of the next
 * and undercount by one word per block.
 */
export function toBodyText(doc: ProseMirrorNode | null | undefined): string {
  return collapse(textNodes(doc).join(' '));
}

/** Words in a plaintext string. Whitespace-delimited; empty text is 0 words. */
export function countWords(text: string): number {
  const trimmed = collapse(text);
  return trimmed.length === 0 ? 0 : trimmed.split(' ').length;
}

/**
 * `max(1, ceil(wordCount / 238))`.
 *
 * The floor of 1 is not cosmetic: a one-line article would otherwise render
 * "0 min read", which reads as a bug to a reader and is wrong anyway — no
 * article takes zero time to read.
 */
export function readingMinutesForWords(wordCount: number): number {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return 1;
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
}

/** `readingMinutes` straight from plaintext. */
export function readingMinutesForText(text: string): number {
  return readingMinutesForWords(countWords(text));
}

export interface DerivedReading {
  bodyText: string;
  wordCount: number;
  readingMinutes: number;
}

/**
 * The one call every article write path makes. Returning all three values
 * together is what keeps them consistent — a caller cannot store a `bodyText`
 * derived from one document and a `readingMinutes` derived from another.
 */
export function deriveReading(doc: ProseMirrorNode | null | undefined): DerivedReading {
  const bodyText = toBodyText(doc);
  const wordCount = countWords(bodyText);
  return { bodyText, wordCount, readingMinutes: readingMinutesForWords(wordCount) };
}
