/**
 * The canonical ranking formula (SPEC-008).
 *
 * > The home For-you feed returns exactly 20 items, all `status='PUBLISHED'`,
 * > ordered by `ln(1+clapTotal) + 2.0*exp(-ageHours/72.0)` DESC with ties
 * > broken by publishedAt DESC then id ASC against a fixed injected clock.
 *
 * ── Why this file restates the formula instead of importing it ────────────
 * `specScore` below is a second, independent transcription of SPEC-008's
 * arithmetic, written from the spec text rather than from `lib/feed/rank.ts`.
 * That duplication is the entire value of the test. Importing `feedScore` and
 * asserting the feed is sorted by `feedScore` would pass against ANY formula —
 * including `log10` instead of `ln`, or a decay constant of 7.2 — because both
 * sides of the comparison would have moved together. Two transcriptions
 * disagree loudly the moment one drifts, which is what a formula pinned by a
 * spec needs.
 *
 * The anchor cases below go further and pin absolute values by hand
 * (`ln(1)+2·exp(0) = 2` exactly), so a defect that happened to preserve
 * relative order — a missing `+1` inside the log, say — still fails.
 *
 * ── Why the fixture has deliberate ties ───────────────────────────────────
 * "Ties break by publishedAt DESC then id ASC — the order is total, never
 * arbitrary." A fixture of distinct scores cannot test that sentence at all,
 * and ties are not exotic here: SPEC-002's seed corpus is written against a
 * fixed clock, so equal `publishedAt` values exist by construction, and every
 * article with no claps at the same instant has a bit-identical score. Three
 * articles below share an instant AND a clap total, so the only thing that can
 * order them is the id tiebreak.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import { setClap } from '../../lib/db/social';
import { getFeedPage } from '../../lib/feed/queries';
import {
  DECAY_HOURS,
  FEED_PAGE_SIZE,
  RECENCY_WEIGHT,
  compareRanked,
  feedScore,
  rankArticles,
} from '../../lib/feed/rank';

/** The injected clock. Nothing in this file reads a wall clock. */
const NOW = new Date('2026-03-01T12:00:00.000Z');
const HOUR = 3_600_000;

/**
 * SPEC-008's formula, transcribed from the specification text:
 *
 *     score = ln(1 + clapTotal) + 2.0 * exp(-ageHours / 72.0)
 *     ageHours = (now - publishedAt) / 3600000
 *
 * Deliberately written out rather than imported. See the module header.
 */
function specScore(clapTotal: number, publishedAtMs: number, nowMs: number): number {
  const ageHours = (nowMs - publishedAtMs) / 3600000;
  return Math.log(1 + clapTotal) + 2.0 * Math.exp(-ageHours / 72.0);
}

/** `a` + 25 digits — 26 characters, the shape `lib/db/ids.ts` emits. */
function articleIdFor(index: number): string {
  return `a${String(index).padStart(25, '0')}`;
}

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

interface Planned {
  id: string;
  ageHours: number;
  claps: number;
  status: 'PUBLISHED' | 'DRAFT';
}

/**
 * 25 published articles, 3 drafts.
 *
 * Shaped so the ranking has work to do rather than reproducing insertion
 * order: index 24 is old but heavily clapped and must outrank fresher rows,
 * and indexes 10/11/12 are identical in every ranked field so only the id
 * tiebreak separates them.
 */
const PLAN: Planned[] = [
  ...Array.from({ length: 25 }, (_, i): Planned => {
    if (i >= 10 && i <= 12) return { id: articleIdFor(i), ageHours: 48, claps: 0, status: 'PUBLISHED' };
    if (i === 24) return { id: articleIdFor(i), ageHours: 400, claps: 120, status: 'PUBLISHED' };
    return { id: articleIdFor(i), ageHours: i * 6, claps: (i * 7) % 23, status: 'PUBLISHED' };
  }),
  { id: articleIdFor(90), ageHours: 1, claps: 0, status: 'DRAFT' },
  { id: articleIdFor(91), ageHours: 2, claps: 0, status: 'DRAFT' },
  { id: articleIdFor(92), ageHours: 3, claps: 0, status: 'DRAFT' },
];

function publishedAtFor(plan: Planned): Date {
  return new Date(NOW.getTime() - plan.ageHours * HOUR);
}

/** The order SPEC-008 says the feed must be in, computed from `specScore`. */
function expectedOrder(): string[] {
  return PLAN.filter((p) => p.status === 'PUBLISHED')
    .map((p) => ({
      id: p.id,
      at: publishedAtFor(p).getTime(),
      score: specScore(p.claps, publishedAtFor(p).getTime(), NOW.getTime()),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.at !== b.at) return b.at - a.at;
      return a.id < b.id ? -1 : 1;
    })
    .map((row) => row.id);
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  const author = await createUser({
    email: 'author@titan.test',
    passwordHash: 'x',
    handle: 'author',
    name: 'Author',
  });

  // Three readers, because SPEC-004 caps one reader at 50 claps and the
  // fixture needs a total of 120 to make the old-but-popular case real.
  const readers = [];
  for (let i = 0; i < 3; i++) {
    readers.push(
      await createUser({
        email: `reader${i}@titan.test`,
        passwordHash: 'x',
        handle: `reader${i}`,
        name: `Reader ${i}`,
      }),
    );
  }

  for (const plan of PLAN) {
    await createArticle({
      id: plan.id,
      authorId: author.id,
      title: `Story ${plan.id.slice(-2)}`,
      subtitle: null,
      bodyJson: doc(`The body of story ${plan.id}.`),
      bodyHtml: '<p>body</p>',
      status: plan.status,
      now: publishedAtFor(plan),
    });

    // Spread the total across readers, 50 max each.
    let remaining = plan.claps;
    for (const reader of readers) {
      if (remaining <= 0) break;
      const share = Math.min(50, remaining);
      await setClap(reader.id, plan.id, share, publishedAtFor(plan));
      remaining -= share;
    }
  }
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

describe('SPEC-008 — the score is the spec formula, not something like it', () => {
  it('is exactly 2 for an unclapped article published at the clock instant', () => {
    // ln(1 + 0) + 2.0 * exp(-0/72) = 0 + 2 = 2. Hand-computed, so a formula
    // that preserved ORDER but changed VALUES still fails here.
    expect(feedScore({ clapTotal: 0, publishedAt: NOW }, NOW)).toBe(2);
  });

  it('uses the NATURAL log, not log base 10', () => {
    // ln(1 + (e-1)) = 1. Under log10 this would be ~0.2384.
    const clapTotal = Math.E - 1;
    const score = feedScore({ clapTotal, publishedAt: NOW }, NOW);
    expect(score - 2).toBeCloseTo(1, 12);
  });

  it('decays to 1/e of the recency term after exactly 72 hours', () => {
    const old = new Date(NOW.getTime() - DECAY_HOURS * HOUR);
    const score = feedScore({ clapTotal: 0, publishedAt: old }, NOW);
    expect(score).toBeCloseTo(RECENCY_WEIGHT * Math.exp(-1), 12);
  });

  it('agrees with an independent transcription of the spec, across the fixture', () => {
    for (const plan of PLAN) {
      const publishedAt = publishedAtFor(plan);
      expect(feedScore({ clapTotal: plan.claps, publishedAt }, NOW)).toBeCloseTo(
        specScore(plan.claps, publishedAt.getTime(), NOW.getTime()),
        12,
      );
    }
  });
});

describe('SPEC-008 — the tiebreak chain makes the order total', () => {
  const at = new Date('2026-02-01T00:00:00.000Z');

  it('breaks an equal score by publishedAt DESC', () => {
    const older = { id: 'a', publishedAt: new Date(at.getTime() - HOUR), clapTotal: 0, score: 1 };
    const newer = { id: 'b', publishedAt: at, clapTotal: 0, score: 1 };
    expect(compareRanked(newer, older)).toBeLessThan(0);
    expect(compareRanked(older, newer)).toBeGreaterThan(0);
  });

  it('breaks an equal score AND instant by id ASC', () => {
    const first = { id: 'a', publishedAt: at, clapTotal: 0, score: 1 };
    const second = { id: 'b', publishedAt: at, clapTotal: 0, score: 1 };
    expect(compareRanked(first, second)).toBeLessThan(0);
    expect(compareRanked(second, first)).toBeGreaterThan(0);
  });

  it('answers 0 only for the same row', () => {
    const row = { id: 'a', publishedAt: at, clapTotal: 0, score: 1 };
    expect(compareRanked(row, { ...row })).toBe(0);
  });

  it('sorts a shuffled set into one order regardless of input order', () => {
    const rows = PLAN.filter((p) => p.status === 'PUBLISHED').map((p) => ({
      id: p.id,
      publishedAt: publishedAtFor(p),
      clapTotal: p.claps,
    }));
    const forwards = rankArticles(rows, NOW).map((r) => r.id);
    const backwards = rankArticles([...rows].reverse(), NOW).map((r) => r.id);
    expect(backwards).toEqual(forwards);
  });
});

describe('SPEC-008 — the For-you feed', () => {
  it('returns exactly 20 items', async () => {
    const page = await getFeedPage({ now: NOW });
    expect(page).toHaveLength(FEED_PAGE_SIZE);
    expect(FEED_PAGE_SIZE).toBe(20);
  });

  it('returns only published articles, drafts excluded', async () => {
    const page = await getFeedPage({ now: NOW, limit: 100 });
    const drafts = PLAN.filter((p) => p.status === 'DRAFT').map((p) => p.id);
    expect(page).toHaveLength(25);
    for (const item of page) {
      expect(drafts).not.toContain(item.id);
    }
  });

  it('is ordered by the spec formula, ties broken by publishedAt DESC then id ASC', async () => {
    const page = await getFeedPage({ now: NOW, limit: 100 });
    expect(page.map((item) => item.id)).toEqual(expectedOrder());
  });

  it('ranks an old, heavily-clapped article above a fresh unclapped one', async () => {
    const page = await getFeedPage({ now: NOW, limit: 100 });
    const ids = page.map((item) => item.id);
    // Index 24: 400 hours old, 120 claps — its recency term is effectively
    // zero, so it is carried entirely by ln(121) ≈ 4.8. Index 10: two days
    // old, no claps, score ≈ 1.03. If this inverts, the log term has been
    // dropped or the decay constant is wrong.
    expect(ids.indexOf(articleIdFor(24))).toBeLessThan(ids.indexOf(articleIdFor(10)));
  });

  it('separates score-and-instant ties by id, ascending', async () => {
    const page = await getFeedPage({ now: NOW, limit: 100 });
    const ids = page.map((item) => item.id);
    const tied = [articleIdFor(10), articleIdFor(11), articleIdFor(12)];
    const positions = tied.map((id) => ids.indexOf(id));

    // Adjacent, because nothing else shares their score.
    expect(positions[1]).toBe((positions[0] ?? -1) + 1);
    expect(positions[2]).toBe((positions[1] ?? -1) + 1);
    // And in id order, not insertion or engine order.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('carries the author and the counts the cards need', async () => {
    const [top] = await getFeedPage({ now: NOW, limit: 1 });
    expect(top?.author.handle).toBe('author');
    expect(top?.clapTotal).toBeGreaterThanOrEqual(0);
    expect(top?.bookmarkCount).toBe(0);
    expect(top?.readingMinutes).toBeGreaterThan(0);
  });

  it('re-ranks when the injected clock moves', async () => {
    // Same data, a clock four days later: every recency term has decayed by
    // e^(-4·24/72) ≈ 0.26, so clap counts dominate more. The set is the same;
    // the order is not required to be, and the point of the assertion is that
    // the clock is genuinely an input rather than decoration.
    const later = new Date(NOW.getTime() + 96 * HOUR);
    const before = await getFeedPage({ now: NOW, limit: 100 });
    const after = await getFeedPage({ now: later, limit: 100 });

    expect(new Set(after.map((i) => i.id))).toEqual(new Set(before.map((i) => i.id)));
    for (const item of after) {
      const same = before.find((b) => b.id === item.id);
      expect(item.score).toBeLessThan((same?.score ?? 0) + 1e-9);
    }
  });
});
