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

  it('scopes each model to exactly the columns the criterion names', () => {
    expect(DETERMINISTIC_COLUMNS.Article).toEqual(['id', 'slug', 'createdAt']);
    expect(DETERMINISTIC_COLUMNS.User).toEqual(['id', 'createdAt']);
    expect(DETERMINISTIC_COLUMNS.Clap).toEqual(['id', 'createdAt']);
  });

  it('ignores columns outside that set, so a legitimately volatile field cannot fail the gate', () => {
    const base = { id: 'a1', slug: 's', createdAt: SEED_BASE_TIMESTAMP };
    expect(hashModel('Article', [{ ...base, viewCount: 1 }])).toBe(
      hashModel('Article', [{ ...base, viewCount: 999 }]),
    );
  });

  it('rolls the three models into one comparable fingerprint', () => {
    const snapshot = {
      User: [{ id: 'u1', createdAt: SEED_BASE_TIMESTAMP }],
      Article: [{ id: 'a1', slug: 's', createdAt: SEED_BASE_TIMESTAMP }],
      Clap: [{ id: 'c1', createdAt: SEED_BASE_TIMESTAMP }],
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
      db ??= await createTestDatabase();
      runSeed(db.url);
      const { User, Article, Clap } = await snapshot(db);
      expect(User.length).toBe(50);
      expect(Article.length).toBe(500);
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
