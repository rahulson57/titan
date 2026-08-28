/**
 * Full-text search budget (SPEC-002).
 *
 * > Search query (FTS5, 500 articles) | p95 < 80 ms over 100 runs
 *
 * A two-token query is the interesting case: FTS5 resolves each token to a
 * postings list and intersects them, so this is where a missing or stale
 * index stops being invisible. The budget is 80ms rather than the feed's 50ms
 * because ranking (bm25) is a second pass over the matched set.
 *
 * The failure mode this catches is not "SQLite got slow" — it is the search
 * silently degrading to a `LIKE '%term%'` scan because the FTS5 virtual table
 * was never populated, or its triggers stopped firing. That scan returns
 * correct results, passes every functional test, and is linear in corpus
 * size. Only a timing budget notices.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * The FTS5 table, its triggers and `lib/search/fts.ts` are owned by SPEC-008
 * (TASK-007, Feed & Search), over the schema in SPEC-004 (TASK-003).
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
const BUDGET_MS = 80;

/** Two tokens, per the criterion. */
const QUERY = 'design systems';

const hasSearch = () => existsSync(join(REPO_ROOT, 'lib', 'search', 'fts.ts'));
const READY = hasMigratableSchema() && hasSeedScript();
const REASON =
  'waiting on TASK-003 (Persistence) for the schema + seed corpus, and TASK-007 (Feed & Search) for the FTS5 index';

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? Number.POSITIVE_INFINITY;
}

async function measure(runs: number, fn: () => Promise<unknown>, warmup = 10): Promise<number[]> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return samples;
}

let db: TestDatabase | undefined;

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(!READY)(
  `SPEC-002 — FTS5 search p95 < ${BUDGET_MS}ms${READY ? '' : ` [${REASON}]`}`,
  () => {
    it('has a populated FTS5 index over the seed corpus', async () => {
      db ??= await createTestDatabase();
      execFileSync('npm', ['run', 'db:seed'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        env: { ...process.env, DATABASE_URL: db.url },
      });

      // An empty virtual table is the specific way this budget passes for the
      // wrong reason: nothing to intersect is very fast indeed.
      const tables = await db.client.$queryRawUnsafe<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'",
      );
      expect(tables.length, 'no FTS5 virtual table found — search would fall back to a scan').toBeGreaterThan(0);

      const counted = await db.client.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*) AS n FROM "${tables[0]!.name}"`,
      );
      expect(
        Number(counted[0]?.n),
        'the FTS5 index is empty; its triggers are not firing',
      ).toBe(500);
    });

    it.skipIf(!hasSearch())(
      `answers a two-token query within budget over ${RUNS} runs`,
      async () => {
        db ??= await createTestDatabase();

        const specifier = join(REPO_ROOT, 'lib', 'search', 'fts.ts');
        const search = (await import(specifier)) as {
          searchArticles: (q: string, opts?: { limit?: number }) => Promise<unknown[]>;
        };

        expect(QUERY.trim().split(/\s+/)).toHaveLength(2);

        const samples = await measure(RUNS, () => search.searchArticles(QUERY, { limit: 20 }));
        const observed = p95(samples);

        expect(
          observed,
          `search p95 was ${observed.toFixed(1)}ms against a ${BUDGET_MS}ms budget. ` +
            'If this is far over, check that the query reaches the FTS5 MATCH path ' +
            "rather than falling back to a LIKE '%…%' scan over all 500 articles.",
        ).toBeLessThan(BUDGET_MS);
      },
    );
  },
);
