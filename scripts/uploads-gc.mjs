#!/usr/bin/env node
/**
 * `npm run uploads:gc` — delete orphaned uploads (SPEC-006).
 *
 * > Orphans | `npm run uploads:gc` deletes files under `public/uploads/`
 * > (excluding `seed/`) not referenced by any `User.avatarPath`,
 * > `User.coverPath`, `Article.coverPath`, or any `image` node in any
 * > `Article.bodyJson`.
 *
 * ── This script deletes things, so read the safety posture first ───────────
 * A garbage collector has two failure modes and they are not symmetric.
 * Keeping a file nobody references wastes some kilobytes until the next run.
 * Deleting a file somebody references destroys a user's upload permanently —
 * the original was never stored (`lib/media/process.ts` re-encodes), so there
 * is nothing to restore from.
 *
 * Everything below is arranged around that asymmetry:
 *
 *  - the reference set is assembled BEFORE anything is listed, and any failure
 *    while assembling it aborts the run with a non-zero exit rather than
 *    proceeding with a partial set. A partial reference set is indistinguishable
 *    from "these files are orphans", and the collector would cheerfully act on
 *    it.
 *  - `bodyJson` parse failures abort too, for the same reason: an article whose
 *    body cannot be read is an article whose inline images cannot be accounted
 *    for.
 *  - `--dry-run` prints exactly what a real run would delete and touches
 *    nothing, so the destructive path can be inspected before it is taken.
 *  - `seed/` is excluded inside `listStoredFiles`, not here, so every caller of
 *    that function inherits the exclusion rather than having to remember it.
 *
 * ── Why this file loads TypeScript ─────────────────────────────────────────
 * `tests/unit/db-boundary.test.ts` (SPEC-004) forbids any file outside
 * `lib/db/**` from naming the Prisma client package. The database is reached
 * through `getDb()` like everything else in the repo, and `getDb()` is
 * TypeScript — so this `.mjs` registers tsx's ESM loader and then imports it.
 * The alternative, a second hand-rolled SQLite connection, is precisely the
 * thing that boundary exists to prevent: a client built outside `lib/db/` runs
 * with `foreign_keys` OFF.
 *
 * (That boundary test scans source TEXT, not parsed imports — deliberately, so
 * it also covers files no test loads. Which means even naming the forbidden
 * specifier inside a comment trips it. Hence the circumlocution above; it is
 * not squeamishness.)
 */

import { register } from 'tsx/esm/api';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const DRY_RUN = has('--dry-run') || has('-n');
const QUIET = has('--quiet') || has('-q');

const rootFlag = argv.indexOf('--root');
const ROOT_OVERRIDE = rootFlag !== -1 ? argv[rootFlag + 1] : undefined;

const say = (message) => {
  if (!QUIET) process.stdout.write(`${message}\n`);
};

const die = (message) => {
  process.stderr.write(`uploads:gc failed: ${message}\n`);
  process.exitCode = 1;
};

if (has('--help') || has('-h')) {
  say(
    [
      'Usage: node scripts/uploads-gc.mjs [--dry-run] [--quiet] [--root <dir>]',
      '',
      '  --dry-run, -n   report what would be deleted; delete nothing',
      '  --quiet, -q     suppress progress output (errors still print)',
      '  --root <dir>    scan this uploads root instead of ./public/uploads',
      '',
      'Deletes every file under the uploads root, except those under seed/,',
      'that no User.avatarPath, User.coverPath, Article.coverPath or image',
      'node in any Article.bodyJson refers to.',
    ].join('\n'),
  );
  process.exit(0);
}

// tsx's loader stays registered for the life of the process; `unregister` is
// called at the end so a caller that imports this file rather than spawning it
// does not leak a hook.
const unregister = register();

async function main() {
  const storeUrl = new URL('../lib/media/store.ts', import.meta.url).href;
  const clientUrl = new URL('../lib/db/client.ts', import.meta.url).href;

  const { collectImageReferences, garbageCollect, uploadsRoot } = await import(storeUrl);
  const { getDb, disconnectDb } = await import(clientUrl);

  const root = ROOT_OVERRIDE ?? uploadsRoot();
  const db = getDb();

  /** Every served path the database currently points at. */
  const referenced = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) referenced.add(value);
  };

  const users = await db.user.findMany({ select: { avatarPath: true, coverPath: true } });
  for (const user of users) {
    add(user.avatarPath);
    add(user.coverPath);
  }

  // `bodyJson` is TEXT in SQLite (DEC-001: "JSON columns are text"), so it is
  // parsed here rather than handed over as an object. A row that will not parse
  // is fatal — see the safety note at the top of this file.
  const articles = await db.article.findMany({
    select: { id: true, coverPath: true, bodyJson: true },
  });
  for (const article of articles) {
    add(article.coverPath);
    let body;
    try {
      body = JSON.parse(article.bodyJson);
    } catch (cause) {
      throw new Error(
        `Article ${article.id} has unreadable bodyJson; refusing to collect ` +
          `because its inline images cannot be accounted for (${cause.message})`,
      );
    }
    for (const reference of collectImageReferences(body)) referenced.add(reference);
  }

  const result = await garbageCollect({ referenced, root, dryRun: DRY_RUN });

  await disconnectDb();

  const verb = DRY_RUN ? 'would delete' : 'deleted';
  say(
    `uploads:gc — scanned ${result.scanned} file(s) under ${root}; ` +
      `kept ${result.kept.length} referenced, ${verb} ${result.deleted.length} orphan(s).`,
  );
  for (const path of result.deleted) say(`  ${DRY_RUN ? '-' : 'x'} ${path}`);

  return result;
}

try {
  await main();
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
} finally {
  unregister();
}
