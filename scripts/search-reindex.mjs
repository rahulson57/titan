/**
 * `npm run search:reindex` — SPEC-008's reindex escape hatch.
 *
 * > `npm run search:reindex` rebuilds `article_fts` from `Article` — used
 * > after a bulk seed, and proves the trigger-maintained index and a
 * > from-scratch rebuild agree.
 *
 * Two jobs, and the second is the interesting one. Rebuilding is trivial;
 * being a CHECK on the triggers is what earns the script its place. A
 * `'rebuild'` re-derives the entire index from `article_fts_source`, so if the
 * result differs from what the triggers had been maintaining, the triggers are
 * wrong — and `tests/unit/search-reindex.test.ts` compares the two index
 * states term by term to prove they do not. This script is the half of that
 * proof that a human can run by hand.
 *
 * ── Why this runs under `tsx` and not bare `node` ─────────────────────────
 * The trigger DDL lives in `lib/search/fts.ts`, because a trigger definition
 * that exists in two files is a trigger definition that will exist in two
 * VERSIONS. `node` cannot import TypeScript, so a plain `.mjs` entry point
 * would have to carry its own copy of the SQL — the exact duplication the
 * module header of `fts.ts` argues against. `tsx` is already the runner for
 * `npm run db:seed` (`prisma/seed.ts`), so this adds no dependency and no new
 * idea; it just lets the script import the one definition.
 *
 * ── Exit codes ────────────────────────────────────────────────────────────
 *   0  the index was rebuilt and passed FTS5's integrity check
 *   1  there is no database to reindex, or the index is inconsistent
 *
 * Failing loudly on a missing database rather than creating one is deliberate:
 * this is a repair tool, and a repair tool that silently invents an empty
 * subject reports success for having done nothing.
 */

import { getDb, disconnectDb, databaseUrl } from '../lib/db/client.ts';
import {
  checkSearchIndexIntegrity,
  countIndexedArticles,
  ensureSearchIndex,
  FTS_TABLE,
  rebuildSearchIndex,
} from '../lib/search/fts.ts';

/** Is the FTS5 virtual table actually there to be rebuilt? */
async function indexExists() {
  const rows = await getDb().$queryRawUnsafe(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?`,
    FTS_TABLE,
  );
  return rows.length > 0;
}

/** How many PUBLISHED articles there are — what the index SHOULD hold. */
async function publishedCount() {
  const rows = await getDb().$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM "Article" WHERE "status" = 'PUBLISHED'`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  if (!(await indexExists())) {
    console.error(
      `search:reindex — no "${FTS_TABLE}" table in ${databaseUrl()}.\n` +
        'Run `npm run setup` first: the virtual table is created by the initial migration.',
    );
    return 1;
  }

  const installed = await ensureSearchIndex();
  if (installed) {
    // Worth saying out loud rather than absorbing silently: it means this
    // database had been taking writes with nothing maintaining its index.
    console.log('search:reindex — installed the FTS5 write triggers (they were missing)');
  }

  const before = await countIndexedArticles();
  await rebuildSearchIndex();
  const after = await countIndexedArticles();
  const published = await publishedCount();

  // FTS5's own check. It compares the index against the content source and
  // throws on any disagreement, which is the only way a silently-corrupt
  // external-content index announces itself.
  await checkSearchIndexIntegrity();

  if (after !== published) {
    console.error(
      `search:reindex — rebuilt index holds ${after} documents but there are ` +
        `${published} published articles. The content view and the index disagree.`,
    );
    return 1;
  }

  console.log(
    `search:reindex — rebuilt "${FTS_TABLE}" from Article: ` +
      `${after} documents (was ${before}), integrity check passed.`,
  );
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('search:reindex — failed:', error instanceof Error ? error.message : error);
  code = 1;
} finally {
  await disconnectDb();
}
process.exit(code);
