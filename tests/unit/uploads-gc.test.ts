/**
 * Orphan collection (SPEC-006).
 *
 * > Orphans | `npm run uploads:gc` deletes files under `public/uploads/`
 * > (excluding `seed/`) not referenced by any `User.avatarPath`,
 * > `User.coverPath`, `Article.coverPath`, or any `image` node in any
 * > `Article.bodyJson`.
 *
 * Oracle: "`npm run uploads:gc` deletes an unreferenced file, leaves every
 * referenced file and everything under `seed/` intact, asserted by
 * tests/unit/uploads-gc.test.ts."
 *
 * -- The criterion names the npm script, so the npm script is what runs -------
 * `scripts/uploads-gc.mjs` is importable and could be driven in-process, which
 * would be faster and would give better stack traces. It would also leave the
 * `"uploads:gc"` line in `package.json` completely untested -- and that line is
 * half of what the criterion asserts. So the headline case below shells out to
 * `npm run uploads:gc` for real, exactly as an operator would type it. The
 * finer-grained cases drive the script directly, where the speed is worth
 * having.
 *
 * -- Why all four reference roots get their own file --------------------------
 * SPEC-006 names four places a path can be referenced from, and three of them
 * are easy: two columns on User and one on Article. The fourth -- "any `image`
 * node in any `Article.bodyJson`" -- is a JSON document walk, and it is the one
 * that will break, because it is the only root whose shape is not enforced by
 * the database. So the fixture below places a distinct real file behind each of
 * the four roots. A collector that forgot any single one deletes exactly one
 * file and the assertion names which root was dropped.
 *
 * -- On deleting things in a test --------------------------------------------
 * Everything happens inside a `mkdtemp` directory handed to the script through
 * `TITAN_UPLOADS_ROOT`, so a bug here cannot reach the repository's own
 * `public/uploads`. The database is a throwaway file from
 * `tests/helpers/db.ts`, per SPEC-002's determinism rules.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  createTestDatabase,
  hasMigratableSchema,
  waitingOn,
  type TestDatabase,
} from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import {
  collectImageReferences,
  garbageCollect,
  listStoredFiles,
  normalizeReference,
} from '../../lib/media/store';

const ALICE = 'ua1zx9k4m7q2vnp8trwchdb3';
const BOB = 'ub7nq2v9k1x4mpr8tzcwhjd5';

/** The four reference roots SPEC-006 names, plus the files that must survive. */
const AVATAR = `/uploads/avatars/${ALICE}/avatarrefaaaaaaaaaaaaaa.webp`;
const USER_COVER = `/uploads/covers/${ALICE}/usercoverbbbbbbbbbbbbb.webp`;
const ARTICLE_COVER = `/uploads/covers/${ALICE}/articlecovercccccccccc.webp`;
const INLINE = `/uploads/inline/${ALICE}/inlinerefdddddddddddddd.webp`;

/** Files nothing points at. These are the ones a run must remove. */
const ORPHANS = [
  `/uploads/inline/${ALICE}/orphaneeeeeeeeeeeeeeeee.webp`,
  `/uploads/avatars/${BOB}/orphanffffffffffffffff.webp`,
  `/uploads/covers/${BOB}/orphangggggggggggggggg.webp`,
];

/** Tracked fixtures. Referenced by nothing, by design, and never deletable. */
const SEEDS = ['/uploads/seed/demo.webp', '/uploads/seed/nested/inline-a.webp'];

const REFERENCED = [AVATAR, USER_COVER, ARTICLE_COVER, INLINE];
const ALL = [...REFERENCED, ...ORPHANS, ...SEEDS];

let db: TestDatabase;
let root: string;
let previousDatabaseUrl: string | undefined;

const absolute = (publicPath: string) => join(root, publicPath.replace('/uploads/', ''));

/** Re-create every fixture file, so each case starts from the same disk. */
async function layOutFiles(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const publicPath of ALL) {
    const target = absolute(publicPath);
    await mkdir(join(target, '..'), { recursive: true });
    // The bytes do not matter to the collector; a marker makes a stray survivor
    // identifiable in a failure message.
    await writeFile(target, `fixture:${publicPath}\n`);
  }
}

const suite = hasMigratableSchema() ? describe : describe.skip;
if (!hasMigratableSchema()) {
  console.warn(
    `tests/unit/uploads-gc.test.ts skipped: ${waitingOn('prisma/schema.prisma with migrations', 'TASK-003 (Persistence)')}`,
  );
}

suite('SPEC-006 - npm run uploads:gc collects orphans and nothing else', () => {
  beforeAll(async () => {
    db = await createTestDatabase();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;

    root = await mkdtemp(join(tmpdir(), 'titan-uploads-gc-'));

    // Alice: an avatar and a profile cover.
    await createUser({
      id: ALICE,
      email: 'alice@example.com',
      passwordHash: 'x',
      handle: 'alice',
      name: 'Alice',
      avatarPath: AVATAR,
      coverPath: USER_COVER,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Bob references nothing at all -- so his directory is pure orphan, and a
    // collector that only looked at the FIRST user would leave it behind.
    await createUser({
      id: BOB,
      email: 'bob@example.com',
      passwordHash: 'x',
      handle: 'bob',
      name: 'Bob',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    // One article carrying the other two roots: a cover column and an inline
    // image node nested two levels down inside bodyJson.
    await createArticle({
      authorId: ALICE,
      title: 'A post with a picture in it',
      bodyJson: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Words before the picture.' }] },
          {
            type: 'figure',
            content: [
              { type: 'image', attrs: { src: INLINE, alt: 'a picture' } },
              { type: 'caption', content: [{ type: 'text', text: 'A caption.' }] },
            ],
          },
        ],
      },
      bodyHtml: '<p>Words before the picture.</p>',
      coverPath: ARTICLE_COVER,
      now: new Date('2026-01-02T00:00:00Z'),
    });

    await disconnectDb();
  });

  afterAll(async () => {
    await disconnectDb();
    await db.drop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await rm(root, { recursive: true, force: true });
  });

  describe('through the npm script, exactly as the criterion words it', () => {
    let result: ReturnType<typeof spawnSync>;

    beforeAll(async () => {
      await layOutFiles();
      // `npm run uploads:gc` -- not `node scripts/uploads-gc.mjs`. The criterion
      // names the npm script, so the package.json line is under test too.
      result = spawnSync('npm', ['run', '--silent', 'uploads:gc'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: db.url, TITAN_UPLOADS_ROOT: root },
      });
    });

    it('exits 0', () => {
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    });

    it('deletes every unreferenced file', () => {
      for (const orphan of ORPHANS) {
        expect(existsSync(absolute(orphan)), `${orphan} survived`).toBe(false);
      }
    });

    it('leaves every referenced file intact', () => {
      // One assertion per reference root, so a failure says which one was
      // dropped rather than "something was deleted".
      expect(existsSync(absolute(AVATAR)), 'User.avatarPath').toBe(true);
      expect(existsSync(absolute(USER_COVER)), 'User.coverPath').toBe(true);
      expect(existsSync(absolute(ARTICLE_COVER)), 'Article.coverPath').toBe(true);
      expect(existsSync(absolute(INLINE)), 'image node in Article.bodyJson').toBe(true);
    });

    it('leaves everything under seed/ intact', () => {
      for (const seed of SEEDS) {
        expect(existsSync(absolute(seed)), `${seed} was collected`).toBe(true);
      }
    });

    it('reports what it did', () => {
      expect(result.stdout).toContain('uploads:gc');
      expect(result.stdout).toMatch(/deleted 3 orphan/);
    });

    it('is idempotent - a second run finds nothing left to do', () => {
      const again = spawnSync('npm', ['run', '--silent', 'uploads:gc'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: db.url, TITAN_UPLOADS_ROOT: root },
      });
      expect(again.status).toBe(0);
      expect(again.stdout).toMatch(/deleted 0 orphan/);
      for (const survivor of [...REFERENCED, ...SEEDS]) {
        expect(existsSync(absolute(survivor)), survivor).toBe(true);
      }
    });
  });

  describe('--dry-run reports without deleting', () => {
    it('names the same orphans and removes none of them', async () => {
      await layOutFiles();
      const result = spawnSync('node', ['scripts/uploads-gc.mjs', '--dry-run'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: db.url, TITAN_UPLOADS_ROOT: root },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/would delete 3 orphan/);
      for (const path of ALL) {
        expect(existsSync(absolute(path)), path).toBe(true);
      }
    });
  });

  describe('an unparseable body aborts the run rather than collecting blindly', () => {
    it('exits non-zero and deletes nothing', async () => {
      // The failure mode this guards: a body that cannot be read is a body
      // whose inline images cannot be accounted for, and an unaccounted image
      // looks exactly like an orphan. Aborting is the only safe answer, because
      // the deletion is not recoverable -- the original upload was never stored.
      await layOutFiles();
      const broken = await createTestDatabase();
      try {
        await broken.client.$executeRawUnsafe(
          `INSERT INTO User (id, email, passwordHash, handle, name, socials, createdAt)
           VALUES ('ubroken2v9k1x4mpr8tzcwh', 'b@example.com', 'x', 'broken', 'Broken', '{}', 0)`,
        );
        await broken.client.$executeRawUnsafe(
          `INSERT INTO Article
             (id, authorId, slug, title, bodyJson, bodyHtml, bodyText,
              readingMinutes, status, version, createdAt, updatedAt)
           VALUES ('abroken2v9k1x4mpr8tzcwh', 'ubroken2v9k1x4mpr8tzcwh', 'broken',
                   'Broken', '{not json at all', '', '', 1, 'DRAFT', 1, 0, 0)`,
        );

        const result = spawnSync('node', ['scripts/uploads-gc.mjs'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: broken.url, TITAN_UPLOADS_ROOT: root },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/unreadable bodyJson/);
        for (const path of ALL) {
          expect(existsSync(absolute(path)), path).toBe(true);
        }
      } finally {
        await broken.drop();
      }
    });
  });
});

describe('SPEC-006 - the collector, as a function', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'titan-gc-unit-'));
    for (const path of ALL) {
      const target = join(scratch, path.replace('/uploads/', ''));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'x');
    }
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('never lists anything under seed/, so no caller can collect one by mistake', async () => {
    const listed = (await listStoredFiles(scratch)).map((file) => file.publicPath);
    expect(listed).toEqual(expect.arrayContaining([...REFERENCED, ...ORPHANS]));
    for (const seed of SEEDS) expect(listed).not.toContain(seed);
  });

  it('returns an empty list for a root that does not exist yet', async () => {
    // A fresh clone has no uploads directory at all. That is not an error, and
    // it must not be an exception either -- `npm run setup` would fail on it.
    expect(await listStoredFiles(join(scratch, 'does-not-exist'))).toEqual([]);
  });

  it('deletes exactly the complement of the reference set', async () => {
    const result = await garbageCollect({ referenced: REFERENCED, root: scratch, dryRun: true });
    expect(result.kept.sort()).toEqual([...REFERENCED].sort());
    expect(result.deleted.sort()).toEqual([...ORPHANS].sort());
    expect(result.scanned).toBe(REFERENCED.length + ORPHANS.length);
  });

  it('an empty reference set means everything outside seed/ goes', async () => {
    // Stated as a test because it is the behaviour that makes the script's
    // "abort rather than proceed on a partial reference set" rule necessary.
    const result = await garbageCollect({ referenced: [], root: scratch, dryRun: true });
    expect(result.deleted.sort()).toEqual([...REFERENCED, ...ORPHANS].sort());
    expect(result.kept).toEqual([]);
  });
});

describe('SPEC-006 - finding image references inside a ProseMirror body', () => {
  it('finds an image nested arbitrarily deep', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
        {
          type: 'blockquote',
          content: [
            {
              type: 'figure',
              content: [{ type: 'image', attrs: { src: '/uploads/inline/u/a.webp' } }],
            },
          ],
        },
      ],
    };
    expect([...collectImageReferences(doc)]).toEqual(['/uploads/inline/u/a.webp']);
  });

  it('finds every image, not just the first', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: '/uploads/inline/u/a.webp' } },
        { type: 'image', attrs: { src: '/uploads/inline/u/b.webp' } },
        { type: 'image', attrs: { src: '/uploads/inline/u/a.webp' } },
      ],
    };
    expect([...collectImageReferences(doc)].sort()).toEqual([
      '/uploads/inline/u/a.webp',
      '/uploads/inline/u/b.webp',
    ]);
  });

  it('contributes nothing rather than throwing on a malformed document', () => {
    // The direction of this failure is what matters: an exception in the walk
    // would abort a run, which is safe; a THROWN-AWAY reference would delete a
    // live file, which is not. Neither happens -- unrecognisable input yields
    // no references and no error, and the script's own abort rule covers the
    // case where the document could not be parsed at all.
    for (const rubbish of [null, undefined, 42, 'a string', [], {}, { type: 'image' }]) {
      expect(() => collectImageReferences(rubbish)).not.toThrow();
      expect([...collectImageReferences(rubbish)]).toEqual([]);
    }
    expect([...collectImageReferences({ type: 'image', attrs: { src: 42 } })]).toEqual([]);
    expect([...collectImageReferences({ type: 'image', attrs: null })]).toEqual([]);
  });

  it('ignores images that are not ours', () => {
    // A remote src cannot be a local orphan, and `next.config.ts` forbids one
    // ever rendering -- but it must not be silently rewritten into a local path
    // either, which is what a careless normalisation would do.
    const doc = { type: 'image', attrs: { src: 'https://example.com/x.png' } };
    expect([...collectImageReferences(doc)]).toEqual(['https://example.com/x.png']);
  });
});

describe('SPEC-006 - a reference is recognised however it was written down', () => {
  it('reduces the spellings that name the same file to one', () => {
    const canonical = '/uploads/avatars/u1/abcdefghijklmnopqrstuvwx.webp';
    expect(normalizeReference(canonical)).toBe(canonical);
    expect(normalizeReference(`public${canonical}`)).toBe(canonical);
    expect(normalizeReference(`.${canonical}`)).toBe(canonical);
    expect(normalizeReference(`${canonical}?v=2`)).toBe(canonical);
    expect(normalizeReference(`${canonical}#top`)).toBe(canonical);
    expect(normalizeReference(`  ${canonical}  `)).toBe(canonical);
    expect(normalizeReference(canonical.replace(/\//g, '\\'))).toBe(canonical);
  });

  it('leaves a reference it does not recognise alone', () => {
    // Undercounting references is the dangerous direction, so anything
    // unrecognised is preserved verbatim and simply fails to match a stored
    // file -- it never becomes a different file's path.
    expect(normalizeReference('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(normalizeReference('')).toBe('');
  });

  it('a query-stringed reference still protects its file', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'titan-gc-norm-'));
    try {
      const path = '/uploads/inline/u1/abcdefghijklmnopqrstuvwx.webp';
      const target = join(scratch, path.replace('/uploads/', ''));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'x');

      const result = await garbageCollect({
        referenced: [`public${path}?cachebust=91`],
        root: scratch,
        dryRun: true,
      });
      expect(result.kept).toEqual([path]);
      expect(result.deleted).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
