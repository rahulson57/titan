/**
 * The reindex escape hatch (SPEC-008).
 *
 * > `npm run search:reindex` produces an `article_fts` whose row set is
 * > identical to the trigger-maintained index for the seed corpus.
 *
 * > Used after a bulk seed, and proves the trigger-maintained index and a
 * > from-scratch rebuild agree.
 *
 * ── Getting a genuinely TRIGGER-maintained index to compare against ───────
 * The obvious test — seed, snapshot, reindex, compare — proves nothing, and it
 * took reading `prisma/seed.ts` to see why: the seed's last act is already
 * `INSERT INTO article_fts(article_fts) VALUES('rebuild')`. So the "before"
 * snapshot would itself be a from-scratch rebuild, and the test would be
 * comparing a rebuild to a rebuild. It would pass with every trigger deleted.
 *
 * So this file drives the index somewhere a rebuild has never been: after
 * seeding it unpublishes, publishes and retitles articles, each of which
 * reaches the index ONLY through the triggers. That state is the "before".
 * `npm run search:reindex` then recomputes the whole index from the content
 * view, and the two must be identical. A trigger that handles a transition
 * wrongly — the wrong `COALESCE`, a missed delete, a stale posting left behind
 * — shows up as a difference here and essentially nowhere else.
 *
 * ── What "row set" is compared ────────────────────────────────────────────
 * Not the articles: `SELECT * FROM article_fts` reads through the content
 * VIEW, so it would answer identically whatever the index contained — the
 * question would be begged. `fts5vocab(..., 'row')` exposes the index's own
 * contents as `(term, doc, cnt)`: every term, how many documents hold it, and
 * how many times in total. That is the inverted index itself, which is the
 * thing the triggers maintain and the thing a rebuild recomputes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestDatabase, REPO_ROOT, type TestDatabase } from '../helpers/db';
import { disconnectDb, getDb } from '../../lib/db/client';
import {
  SEARCH_TRIGGER_NAMES,
  countIndexedArticles,
  ensureSearchIndex,
  searchTriggersInstalled,
} from '../../lib/search/fts';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const VOCAB_TABLE = 'reindex_test_vocab';

interface VocabRow {
  term: string;
  doc: number;
  cnt: number;
}

let db: TestDatabase;

/** Run the escape hatch exactly as the acceptance gate does. */
function runReindex(): string {
  return execFileSync('npm', ['run', 'search:reindex'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: db.url },
  });
}

/**
 * The inverted index, as data. `fts5vocab` is a read-only view over the index
 * itself rather than over the content, which is what makes the comparison
 * meaningful.
 */
async function indexContents(): Promise<VocabRow[]> {
  await getDb().$executeRawUnsafe(
    `CREATE VIRTUAL TABLE IF NOT EXISTS "${VOCAB_TABLE}" USING fts5vocab('article_fts', 'row')`,
  );
  const rows = await getDb().$queryRawUnsafe<Array<{ term: string; doc: bigint | number; cnt: bigint | number }>>(
    `SELECT "term", "doc", "cnt" FROM "${VOCAB_TABLE}" ORDER BY "term"`,
  );
  return rows.map((row) => ({ term: row.term, doc: Number(row.doc), cnt: Number(row.cnt) }));
}

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  // Triggers first, so everything the seed writes goes through them too.
  await ensureSearchIndex();

  execFileSync('npm', ['run', 'db:seed'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: db.url },
  });
}, 180_000);

afterAll(async () => {
  await getDb()
    .$executeRawUnsafe(`DROP TABLE IF EXISTS "${VOCAB_TABLE}"`)
    .catch(() => {
      /* the database may already be gone */
    });
  await disconnectDb();
  await db.drop();
});

describe('SPEC-008 — the escape hatch exists and is wired up', () => {
  it('is a script in package.json, so `npm run search:reindex` resolves', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['search:reindex']).toBeDefined();
    expect(pkg.scripts?.['search:reindex']).toContain('scripts/search-reindex.mjs');
  });

  it('rebuilds the index and reports what it did', () => {
    const output = runReindex();
    expect(output).toContain('rebuilt');
    expect(output).toContain('integrity check passed');
  });
});

describe('SPEC-008 — trigger-maintained and rebuilt indexes agree', () => {
  it('over the seed corpus after trigger-only mutations', async () => {
    const published = await getDb().article.findMany({
      where: { status: 'PUBLISHED' },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 12,
    });
    const drafts = await getDb().article.findMany({
      where: { status: 'DRAFT' },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 8,
    });
    expect(published.length).toBe(12);
    expect(drafts.length).toBe(8);

    // Every one of these reaches the index ONLY through a trigger. No rebuild
    // runs between here and the snapshot.
    for (const row of published.slice(0, 6)) {
      await getDb().article.update({
        where: { id: row.id },
        data: { status: 'DRAFT', updatedAt: NOW },
      });
    }
    for (const row of published.slice(6)) {
      await getDb().article.update({
        where: { id: row.id },
        data: { title: `Retitled ${row.id.slice(-6)} narwhal`, updatedAt: NOW },
      });
    }
    for (const row of drafts) {
      await getDb().article.update({
        where: { id: row.id },
        data: { status: 'PUBLISHED', publishedAt: NOW, updatedAt: NOW },
      });
    }

    const triggerMaintained = await indexContents();
    const countBefore = await countIndexedArticles();

    // Sanity: the mutations really did move the index, so the comparison below
    // is not between two identical no-ops.
    expect(triggerMaintained.some((row) => row.term === 'narwhal')).toBe(true);

    runReindex();

    const rebuilt = await indexContents();
    expect(await countIndexedArticles()).toBe(countBefore);
    expect(rebuilt).toEqual(triggerMaintained);
  }, 60_000);

  it('holds exactly the published rows after the rebuild', async () => {
    const published = await getDb().article.count({ where: { status: 'PUBLISHED' } });
    expect(await countIndexedArticles()).toBe(published);
  });
});

describe('SPEC-008 — the hatch works on a database that never ran the app', () => {
  it('installs the triggers itself rather than assuming they are there', async () => {
    // A database migrated but never opened by the app has no triggers: the
    // migration deliberately does not create them. The escape hatch is exactly
    // the tool someone reaches for in that state, so it has to bootstrap.
    for (const name of SEARCH_TRIGGER_NAMES) {
      await getDb().$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}"`);
    }
    expect(await searchTriggersInstalled()).toBe(false);

    const output = runReindex();

    expect(output).toContain('installed the FTS5 write triggers');
    expect(await searchTriggersInstalled()).toBe(true);
  }, 60_000);

  it('leaves a working index behind, so the next publish is tracked', async () => {
    const before = await countIndexedArticles();
    const [draft] = await getDb().article.findMany({
      where: { status: 'DRAFT' },
      select: { id: true },
      take: 1,
    });
    if (!draft) throw new Error('the seed corpus should contain drafts');

    await getDb().article.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: NOW, updatedAt: NOW },
    });

    expect(await countIndexedArticles()).toBe(before + 1);
  });
});
