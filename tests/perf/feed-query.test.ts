/**
 * Feed query budget (SPEC-002).
 *
 * > Feed query (server, 20 items + author + counts) | p95 < 50 ms over 100 runs
 *
 * Assumptions this measurement is only valid under, restated from SPEC-002 so
 * a failure can be read correctly: Apple-silicon-class laptop, SQLite in WAL
 * mode, warm page cache, and the 50 user / 500 article / 2 000 clap seed
 * corpus. A p95 measured against an empty database is meaningless, so the
 * corpus size is asserted before any timing is taken.
 *
 * Why p95 and not a mean: the failure this budget exists to catch is an N+1 —
 * one query per article for its author or clap count. An N+1 barely moves the
 * mean on a warm cache but shows up hard in the tail, which is also what a
 * reader actually experiences.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * The feed query lives in `lib/feed/queries.ts` (SPEC-008, TASK-007) over the
 * schema in SPEC-004 (TASK-003). Both the timing rig and the budget below are
 * complete; they arm themselves when those land.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTestDatabase,
  hasMigratableSchema,
  hasSeedScript,
  REPO_ROOT,
  type TestDatabase,
} from '../helpers/db';

const RUNS = 100;
const BUDGET_MS = 50;
const PAGE_SIZE = 20;

const hasFeedQueries = () => existsSync(join(REPO_ROOT, 'lib', 'feed', 'queries.ts'));
const READY = hasMigratableSchema() && hasSeedScript();
const REASON =
  'waiting on TASK-003 (Persistence) for the schema + seed corpus, and TASK-007 (Feed & Search) for lib/feed/queries.ts';

/**
 * Nearest-rank p95 over a sorted sample. Deliberately not an interpolating
 * percentile: with 100 samples the nearest-rank value is an observation that
 * actually happened, which is the right thing to hold a budget against.
 */
export function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? Number.POSITIVE_INFINITY;
}

/** Time `fn` `runs` times after a short warm-up, returning per-run milliseconds. */
export async function measure(
  runs: number,
  fn: () => Promise<unknown>,
  warmup = 10,
): Promise<number[]> {
  // The first few executions pay for query planning and cache population.
  // SPEC-002 states the budget against a warm cache, so those are excluded
  // rather than allowed to dominate the tail.
  for (let i = 0; i < warmup; i++) await fn();

  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return samples;
}

describe('the timing rig itself', () => {
  it('takes p95 by nearest rank', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(p95(samples)).toBe(95);
  });

  it('is dominated by the tail, not the mean', () => {
    // 94 fast runs and 6 slow ones: the mean stays comfortably inside the
    // budget while p95 blows straight through it. This is exactly the N+1
    // shape the budget exists to catch — and the reason the criterion is
    // written against p95 rather than an average.
    const samples = [...Array.from({ length: 94 }, () => 1), ...Array.from({ length: 6 }, () => 400)];
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeLessThan(BUDGET_MS);
    expect(p95(samples)).toBeGreaterThan(BUDGET_MS);
  });

  it('collects exactly the requested number of samples', async () => {
    const samples = await measure(5, async () => undefined, 1);
    expect(samples).toHaveLength(5);
  });
});

let db: TestDatabase | undefined;

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(!READY)(
  `SPEC-002 — feed query p95 < ${BUDGET_MS}ms${READY ? '' : ` [${REASON}]`}`,
  () => {
    it('measures against the corpus the budget assumes', async () => {
      db ??= await createTestDatabase();
      execFileSync('npm', ['run', 'db:seed'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        env: { ...process.env, DATABASE_URL: db.url },
      });

      // DEC-009: SPEC-002's "500 articles" is the PUBLISHED count, which is
      // what the budget is measured against. The seed corpus is 540 rows
      // (500 PUBLISHED + 40 DRAFT) per SPEC-004; only the published half is
      // ever on a feed page, so the count is scoped rather than loosened.
      const counted = await db.client.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*) AS n FROM "Article" WHERE status = 'PUBLISHED'`,
      );
      expect(
        Number(counted[0]?.n),
        'the 50/500-published/2000 corpus is what the budget is stated against',
      ).toBe(500);
    });

    it.skipIf(!hasFeedQueries())(
      `returns ${PAGE_SIZE} articles with author and counts within budget over ${RUNS} runs`,
      async () => {
        db ??= await createTestDatabase();

        const specifier = join(REPO_ROOT, 'lib', 'feed', 'queries.ts');
        const feed = (await import(specifier)) as {
          getFeedPage: (args: { limit: number }) => Promise<unknown[]>;
        };

        const samples = await measure(RUNS, () => feed.getFeedPage({ limit: PAGE_SIZE }));
        const observed = p95(samples);

        expect(
          observed,
          `feed p95 was ${observed.toFixed(1)}ms against a ${BUDGET_MS}ms budget. ` +
            'The usual cause is an N+1: one extra query per article for its author ' +
            'or its clap/bookmark count. Check that the counts are aggregated in ' +
            'the same statement rather than resolved per row.',
        ).toBeLessThan(BUDGET_MS);
      },
    );
  },
);
