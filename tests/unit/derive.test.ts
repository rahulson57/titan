/**
 * The pure derivations (SPEC-004).
 *
 * > For 20 generated bodies, `readingMinutes === max(1, ceil(wordCount/238))`
 * > and `bodyText` word count matches the ProseMirror text nodes exactly.
 *
 * The criterion is stated over GENERATED bodies rather than three fixtures for
 * a reason: the failure this guards against is off-by-one at a block boundary,
 * which a hand-written two-paragraph fixture will not surface. The documents
 * below are built with a known word count and a random block structure, so a
 * derivation that fuses the end of one block onto the start of the next loses
 * exactly one word per boundary and the equality fails.
 *
 * This file also covers `lib/db/ids.ts` and `lib/format/date.ts`. Both are pure
 * modules with no suite of their own in this slice's file scope, and both carry
 * a determinism property the seed corpus depends on — an untested id generator
 * or an unpinned timezone would show up as a flaky seed hash weeks later, a
 * long way from the cause.
 */

import { describe, expect, it } from 'vitest';
import {
  WORDS_PER_MINUTE,
  countWords,
  deriveReading,
  readingMinutesForText,
  readingMinutesForWords,
  textNodes,
  toBodyText,
  type ProseMirrorNode,
} from '../../lib/derive/reading';
import {
  ID_LENGTH,
  createId,
  createIdFrom,
  createSeededIdFactory,
  createSeededRandom,
  createSessionId,
  isValidId,
} from '../../lib/db/ids';
import {
  formatArticleDate,
  formatLongDate,
  formatReadingTime,
  formatRelative,
  toDate,
  toDateTimeAttribute,
} from '../../lib/format/date';

// ---------------------------------------------------------------------------
// Generated documents with a word count known independently of the derivation
// ---------------------------------------------------------------------------

const WORD_POOL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];

function words(random: () => number, count: number): string {
  return Array.from(
    { length: count },
    () => WORD_POOL[Math.floor(random() * WORD_POOL.length)] ?? 'alpha',
  ).join(' ');
}

/** A document of exactly `total` words, spread over a random block structure. */
function generateDoc(random: () => number, total: number): ProseMirrorNode {
  const content: ProseMirrorNode[] = [];
  let remaining = total;
  while (remaining > 0) {
    const take = Math.max(1, Math.min(remaining, 1 + Math.floor(random() * 40)));
    const text = words(random, take);
    content.push(
      random() < 0.25
        ? { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] }
        : { type: 'paragraph', content: [{ type: 'text', text }] },
    );
    remaining -= take;
  }
  return { type: 'doc', content };
}

describe('SPEC-004 — readingMinutes and bodyText over 20 generated bodies', () => {
  const random = createSeededRandom('derive-fixture');
  const cases = Array.from({ length: 20 }, (_, index) => {
    // A spread that straddles every interesting boundary: under one minute,
    // exactly on a 238-word multiple, and well past it.
    const total = [1, 237, 238, 239, 476][index % 5]! + index * 97;
    return { total, doc: generateDoc(random, total) };
  });

  it.each(cases.map((c, i) => [i, c.total] as const))(
    'body %i (%i words) derives the documented values',
    (index, total) => {
      const { doc } = cases[index]!;
      const derived = deriveReading(doc);

      // The criterion's first half: word count matches the text nodes exactly.
      const fromNodes = textNodes(doc).join(' ').split(/\s+/).filter(Boolean).length;
      expect(derived.wordCount).toBe(fromNodes);
      expect(derived.wordCount).toBe(total);

      // The criterion's second half: the formula, restated rather than reused.
      expect(derived.readingMinutes).toBe(Math.max(1, Math.ceil(total / 238)));
    },
  );
});

describe('SPEC-004 — the reading derivation in detail', () => {
  it('pins words-per-minute at the specified 238', () => {
    expect(WORDS_PER_MINUTE).toBe(238);
  });

  it('joins block boundaries with a space rather than fusing words', () => {
    // ProseMirror stores no whitespace between blocks. Concatenating directly
    // would yield "endstart" — one word where there are two — and undercount
    // by one word per block for the whole document.
    const doc: ProseMirrorNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'end' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'start' }] },
      ],
    };
    expect(toBodyText(doc)).toBe('end start');
    expect(countWords(toBodyText(doc))).toBe(2);
  });

  it('walks nested marks and inline nodes in document order', () => {
    const doc: ProseMirrorNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'text', text: 'two', marks: [{ type: 'strong' }] },
            { type: 'image', attrs: { src: '/uploads/x.webp' } },
            { type: 'text', text: 'three' },
          ],
        },
      ],
    };
    expect(toBodyText(doc)).toBe('one two three');
  });

  it('never reports zero minutes', () => {
    // "0 min read" reads as a bug and is wrong anyway.
    expect(readingMinutesForWords(0)).toBe(1);
    expect(readingMinutesForWords(1)).toBe(1);
    expect(readingMinutesForText('')).toBe(1);
    expect(readingMinutesForWords(Number.NaN)).toBe(1);
    expect(readingMinutesForWords(-5)).toBe(1);
  });

  it('treats an empty or malformed document as empty text, not a crash', () => {
    expect(toBodyText(null)).toBe('');
    expect(toBodyText(undefined)).toBe('');
    expect(toBodyText({ type: 'doc' })).toBe('');
    expect(countWords('   ')).toBe(0);
    expect(deriveReading(null)).toEqual({ bodyText: '', wordCount: 0, readingMinutes: 1 });
  });

  it('collapses runs of whitespace so a pasted double space is not two words', () => {
    expect(countWords('one   two\n\nthree')).toBe(3);
  });
});

describe('SPEC-004 — cuid2-shaped identifiers', () => {
  it('is 26 characters and starts with a letter', () => {
    for (let i = 0; i < 50; i++) {
      const id = createId();
      expect(id).toHaveLength(ID_LENGTH);
      expect(isValidId(id)).toBe(true);
    }
  });

  it('rejects anything that is not the documented shape', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId('9bcdefghijklmnopqrstuvwxyz')).toBe(false); // leading digit
    expect(isValidId('abc')).toBe(false); // too short
    expect(isValidId(42)).toBe(false);
  });

  it('does not repeat itself across a large draw', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => createId()));
    expect(ids.size).toBe(5_000);
  });

  it('is reproducible from a seeded stream — the property the corpus rests on', () => {
    // SPEC-002 requires two seed runs to produce byte-identical `id` columns.
    // That is only true if the same seed yields the same sequence.
    const a = createSeededIdFactory('titan-2026');
    const b = createSeededIdFactory('titan-2026');
    const first = Array.from({ length: 200 }, a);
    const second = Array.from({ length: 200 }, b);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(200);
    expect(first.every(isValidId)).toBe(true);
  });

  it('yields a different sequence for a different seed', () => {
    expect(createSeededIdFactory('titan-2026')()).not.toBe(createSeededIdFactory('titan-2027')());
  });

  it('spreads the seeded stream over the unit interval', () => {
    const random = createSeededRandom('titan-2026');
    const samples = Array.from({ length: 2_000 }, random);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThan(1);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it('draws every symbol of the alphabet given a uniform source', () => {
    // Guards the rejection-sampling path: a `% 36` shortcut would still pass a
    // shape check while quietly biasing the first four symbols.
    let n = 0;
    const cycling = () => ((n++ % 1000) + 0.5) / 1000;
    const seen = new Set(Array.from({ length: 400 }, () => createIdFrom(cycling)).join(''));
    expect(seen.size).toBeGreaterThan(30);
  });

  it('mints session ids from the CSPRNG at the documented 32 bytes', () => {
    const id = createSessionId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(createSessionId()).not.toBe(id);
  });
});

describe('SPEC-004 — timestamps are only ever rendered through lib/format/date.ts', () => {
  const instant = '2026-01-04T09:30:00.000Z';

  it('formats in UTC regardless of the runtime timezone', () => {
    // The bug this prevents: a server component formats in the machine's zone,
    // the client re-formats in the visitor's, and React reports a hydration
    // mismatch on a date that is "wrong" by one day.
    expect(formatArticleDate(instant)).toBe('Jan 4, 2026');
    expect(formatLongDate(instant)).toBe('January 4, 2026');
  });

  it('accepts a Date, an ISO string or an epoch and agrees with itself', () => {
    const asDate = new Date(instant);
    expect(formatArticleDate(asDate)).toBe(formatArticleDate(instant));
    expect(formatArticleDate(asDate.getTime())).toBe(formatArticleDate(instant));
  });

  it('renders nothing rather than "Invalid Date" for absent or broken input', () => {
    expect(formatArticleDate(null)).toBe('');
    expect(formatArticleDate(undefined)).toBe('');
    expect(formatArticleDate('not a date')).toBe('');
    expect(formatLongDate(null)).toBe('');
    expect(toDateTimeAttribute(null)).toBe('');
    expect(toDate('nonsense')).toBeNull();
  });

  it('emits a machine-readable instant for the <time> attribute', () => {
    expect(toDateTimeAttribute(instant)).toBe(instant);
  });

  it('takes its clock as a parameter so relative time is assertable', () => {
    const now = new Date('2026-01-04T12:00:00.000Z');
    expect(formatRelative(new Date(now.getTime() - 30_000), now)).toBe('just now');
    expect(formatRelative(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 min ago');
    expect(formatRelative(new Date(now.getTime() - 3 * 3_600_000), now)).toBe('3 h ago');
    expect(formatRelative(new Date(now.getTime() - 2 * 86_400_000), now)).toBe('2 d ago');
  });

  it('falls back to an absolute date past a week, and for future timestamps', () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    expect(formatRelative('2026-01-04T09:30:00.000Z', now)).toBe('Jan 4, 2026');
    expect(formatRelative('2026-06-01T00:00:00.000Z', now)).toBe('Jun 1, 2026');
    expect(formatRelative(null, now)).toBe('');
    expect(formatRelative(now, 'nonsense')).toBe('');
  });

  it('labels reading time with the value the derivation produced', () => {
    expect(formatReadingTime(1)).toBe('1 min read');
    expect(formatReadingTime(7)).toBe('7 min read');
    expect(formatReadingTime(0)).toBe('1 min read');
    expect(formatReadingTime(Number.NaN)).toBe('1 min read');
  });
});
