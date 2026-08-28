/**
 * The seed-determinism gate (SPEC-002).
 *
 * > Two consecutive `npm run db:seed` runs against a fresh DB produce
 * > identical row hashes for User, Article, Clap (id, slug, createdAt).
 *
 * This is the property every other perf and feature test leans on: if the
 * corpus differs between runs, a p95 budget is measuring a different dataset
 * each time and a failure carries no information. So the check is a real
 * double-seed against a throwaway database, not an inspection of the seed
 * script's source.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * `prisma/seed.ts` is owned by SPEC-004 (TASK-003, Persistence). The hashing
 * contract below — canonical, order-insensitive, column-scoped — is live now
 * and unit-tested; the double-seed run arms itself when the seed script lands.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  createTestDatabase,
  hasMigratableSchema,
  hasSeedScript,
  REPO_ROOT,
  type TestDatabase,
} from '../helpers/db';
import {
  DETERMINISTIC_COLUMNS,
  SEED_BASE_TIMESTAMP,
  SEED_PRNG_SEED,
  canonicalise,
  fingerprint,
  hashModel,
  hashRows,
} from '../helpers/seed-hash';

const READY = hasMigratableSchema() && hasSeedScript();
const REASON = 'waiting on TASK-003 (Persistence): prisma/seed.ts does not exist yet';

// ---------------------------------------------------------------------------
// The hashing contract itself — live now, because a determinism gate built on
// a hash that ignores key order or row order would pass on a broken seed.
// ---------------------------------------------------------------------------

describe('SPEC-002 — the determinism fingerprint is trustworthy', () => {
  it('is insensitive to key order within a row', () => {
    const a = { id: 'u1', slug: 'a', createdAt: SEED_BASE_TIMESTAMP };
    const b = { createdAt: SEED_BASE_TIMESTAMP, slug: 'a', id: 'u1' };
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('is insensitive to row order within a set', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(hashRows(rows)).toBe(hashRows([...rows].reverse()));
  });

  it('treats a Date and its ISO string as the same value', () => {
    expect(canonicalise({ createdAt: new Date(SEED_BASE_TIMESTAMP) })).toBe(
      canonicalise({ createdAt: SEED_BASE_TIMESTAMP }),
    );
  });

  it('is sensitive to content — a changed id changes the hash', () => {
    expect(hashRows([{ id: 'a' }])).not.toBe(hashRows([{ id: 'b' }]));
  });

  it('is sensitive to cardinality — a duplicated row changes the hash', () => {
    // Without folding the row count in, [a] and [a, a] would collide after
    // sorting, and a seed that double-inserted would look deterministic.
    expect(hashRows([{ id: 'a' }])).not.toBe(hashRows([{ id: 'a' }, { id: 'a' }]));
  });

  it('scopes each model to exactly the columns that identify one of its rows', () => {
    expect(DETERMINISTIC_COLUMNS.Article).toEqual(['id', 'slug', 'createdAt']);
    expect(DETERMINISTIC_COLUMNS.User).toEqual(['id', 'createdAt']);
    // Clap's key is composite — `@@id([userId, articleId])` per SPEC-004 —
    // so there is no `id` column to project. Naming one hashed null for every
    // row; see the pairing test below for what that concealed.
    expect(DETERMINISTIC_COLUMNS.Clap).toEqual(['userId', 'articleId', 'createdAt']);
    expect(DETERMINISTIC_COLUMNS.Clap).not.toContain('id');
  });

  it('ignores columns outside that set, so a legitimately volatile field cannot fail the gate', () => {
    const base = { id: 'a1', slug: 's', createdAt: SEED_BASE_TIMESTAMP };
    expect(hashModel('Article', [{ ...base, viewCount: 1 }])).toBe(
      hashModel('Article', [{ ...base, viewCount: 999 }]),
    );
  });

  // ── The Clap pairing regression ──────────────────────────────────────────
  // The three pairing tests below each FAIL against the previous
  // `['id', 'createdAt']` projection: with no `id` column on the model, every
  // clap row canonicalised to `{"createdAt":<iso>,"id":null}`, so the identity
  // of a clap was invisible to the hash. The fourth passes either way — it
  // pins the deliberately narrow projection that must survive this repair.

  it('detects a clap reassigned to a different article', () => {
    const at = SEED_BASE_TIMESTAMP;
    const original = [
      { userId: 'u1', articleId: 'a1', count: 3, createdAt: at },
      { userId: 'u2', articleId: 'a2', count: 7, createdAt: at },
    ];
    // Same users, same articles, same timestamps, same cardinality — only WHO
    // clapped WHAT is swapped. This is the seed regression the gate is for.
    const permuted = [
      { userId: 'u1', articleId: 'a2', count: 3, createdAt: at },
      { userId: 'u2', articleId: 'a1', count: 7, createdAt: at },
    ];
    expect(hashModel('Clap', permuted)).not.toBe(hashModel('Clap', original));
  });

  it('detects a clap reassigned to a different user', () => {
    const base = { articleId: 'a1', count: 1, createdAt: SEED_BASE_TIMESTAMP };
    expect(hashModel('Clap', [{ ...base, userId: 'u1' }])).not.toBe(
      hashModel('Clap', [{ ...base, userId: 'u2' }]),
    );
  });

  it('does not collapse distinct claps that share a timestamp', () => {
    // The sharpest form of the old defect: three different rows hashing as one
    // repeated row. Distinct pairings must stay distinguishable from a set that
    // merely repeats a single pairing the same number of times.
    const at = SEED_BASE_TIMESTAMP;
    const distinct = [
      { userId: 'u1', articleId: 'a1', createdAt: at },
      { userId: 'u2', articleId: 'a2', createdAt: at },
      { userId: 'u3', articleId: 'a3', createdAt: at },
    ];
    const repeated = [
      { userId: 'u1', articleId: 'a1', createdAt: at },
      { userId: 'u1', articleId: 'a1', createdAt: at },
      { userId: 'u1', articleId: 'a1', createdAt: at },
    ];
    expect(hashModel('Clap', distinct)).not.toBe(hashModel('Clap', repeated));
  });

  it('still ignores a clap column the criterion does not name', () => {
    // `count` is mutable engagement state (SPEC-004: 1..50 per reader), not
    // row identity. The projection stays narrow on Clap for the same reason it
    // does on Article — widening it is how a later legitimate change breaks
    // this gate for the wrong reason.
    const base = { userId: 'u1', articleId: 'a1', createdAt: SEED_BASE_TIMESTAMP };
    expect(hashModel('Clap', [{ ...base, count: 1 }])).toBe(
      hashModel('Clap', [{ ...base, count: 50 }]),
    );
  });

  it('rolls the three models into one comparable fingerprint', () => {
    const snapshot = {
      User: [{ id: 'u1', createdAt: SEED_BASE_TIMESTAMP }],
      Article: [{ id: 'a1', slug: 's', createdAt: SEED_BASE_TIMESTAMP }],
      Clap: [{ userId: 'u1', articleId: 'a1', count: 5, createdAt: SEED_BASE_TIMESTAMP }],
    };
    expect(fingerprint(snapshot)).toBe(fingerprint({ ...snapshot }));
    expect(fingerprint(snapshot)).not.toBe(fingerprint({ ...snapshot, Clap: [] }));
  });

  it('pins the seed constants the corpus must be derived from', () => {
    expect(SEED_PRNG_SEED).toBe('titan-2026');
    expect(SEED_BASE_TIMESTAMP).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

let db: TestDatabase | undefined;

afterAll(async () => {
  await db?.drop();
});

async function snapshot(target: TestDatabase) {
  const table = async (name: string) =>
    target.client.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "${name}"`);
  return {
    User: await table('User'),
    Article: await table('Article'),
    Clap: await table('Clap'),
  };
}

function runSeed(databaseUrl: string) {
  execFileSync('npm', ['run', 'db:seed'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

describe.skipIf(!READY)(
  `SPEC-002 — two seed runs agree${READY ? '' : ` [${REASON}]`}`,
  () => {
    it('produces an identical fingerprint across two consecutive runs on a fresh database', async () => {
      db ??= await createTestDatabase();

      runSeed(db.url);
      const first = fingerprint(await snapshot(db));

      // A fresh database for the second run: re-seeding a populated one would
      // test idempotency, which is a different (and weaker) property.
      const second = await createTestDatabase();
      try {
        runSeed(second.url);
        expect(fingerprint(await snapshot(second))).toBe(first);
      } finally {
        await second.drop();
      }
    });

    it('derives every createdAt from the fixed base timestamp, not from wall-clock time', async () => {
      db ??= await createTestDatabase();
      runSeed(db.url);
      const { Article } = await snapshot(db);
      expect(Article.length).toBeGreaterThan(0);

      const base = Date.parse(SEED_BASE_TIMESTAMP);
      for (const row of Article) {
        const created = new Date(row.createdAt as string | Date).getTime();
        expect(
          created,
          'a createdAt before the fixed base timestamp means the seed used wall-clock time',
        ).toBeGreaterThanOrEqual(base);
      }
    });

    it('seeds the corpus size the performance budgets assume', async () => {
      // SPEC-002 states the budgets against "50 users / 500 articles / 2 000
      // claps". A smaller corpus would make every p95 below pass for the
      // wrong reason.
      //
      // DEC-009: that "500 articles" is the PUBLISHED count, not the total.
      // SPEC-004 seeds 540 rows (500 PUBLISHED + 40 DRAFT) and its own
      // criterion says so outright; the budgets are stated against the
      // published corpus, so the assertion is scoped by status rather than
      // relaxed. The total is pinned too, so neither half can drift.
      db ??= await createTestDatabase();
      runSeed(db.url);
      const { User, Article, Clap } = await snapshot(db);
      expect(User.length).toBe(50);
      expect(Article.filter((row) => row.status === 'PUBLISHED')).toHaveLength(500);
      expect(Article.filter((row) => row.status === 'DRAFT')).toHaveLength(40);
      expect(Article.length).toBe(540);
      expect(Clap.length).toBe(2000);
    });
  },
);

describe('SPEC-002 — the seed script honours the determinism rules', () => {
  it.skipIf(!hasSeedScript())('pins the PRNG seed and base timestamp in prisma/seed.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(REPO_ROOT, 'prisma', 'seed.ts'), 'utf8');
    expect(source).toContain(SEED_PRNG_SEED);
    expect(source).toMatch(/2026-01-01T00:00:00/);
    // Wall-clock reads are exactly what a fixed base timestamp is meant to
    // replace; either one makes the corpus differ between runs.
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(\s*\)/);
  });
});
