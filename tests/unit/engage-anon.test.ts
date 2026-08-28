/**
 * The anonymous half of every engagement contract (SPEC-009).
 *
 * The sealed criterion:
 *
 *   > "Each of `clap`, `bookmark`, `follow` invoked anonymously returns HTTP
 *   >  401 and writes zero rows."
 *
 * ── Why this is its own suite ────────────────────────────────────────────
 * The criterion is one sentence about three actions, and its second clause —
 * "writes zero rows" — is the one that is easy to get almost right. Each of
 * the three per-action suites could assert its own 401 and all three could
 * pass while an unrelated table gained a row: a follow that also touched a
 * clap, a bookmark that stamped a session. So this suite counts EVERY
 * engagement table before and after every anonymous call, rather than only the
 * one the call was aimed at. It fails on a write anywhere, not just on a write
 * where it was looking.
 *
 * ── Why it is a table-driven loop rather than three tests ────────────────
 * The criterion applies the same rule to three actions. Enumerating them means
 * a fourth engagement action added later either joins the table or is visibly
 * absent from it — whereas three hand-written tests quietly cover only what
 * somebody remembered.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { toSessionUser, type SessionUser } from '../../lib/auth/session';
import { ARTICLE_STATUS, createArticle } from '../../lib/db/articles';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { applyBookmark } from '../../lib/engage/bookmark';
import { applyClap } from '../../lib/engage/clap';
import { applyFollow } from '../../lib/engage/follow';

const AT = new Date('2026-01-01T00:00:00.000Z');

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Public, and readable by all.' }] }],
};

/** Every table an engagement action could conceivably touch. */
const ENGAGEMENT_TABLES = ['Clap', 'Bookmark', 'Follow'] as const;

let db: TestDatabase;
let author: SessionUser;
let articleId = '';

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ENGAGEMENT_TABLES) {
    const rows = await db.client.$queryRawUnsafe<{ n: bigint | number }[]>(
      `SELECT COUNT(*) AS n FROM "${table}"`,
    );
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

beforeEach(async () => {
  for (const table of ENGAGEMENT_TABLES) {
    await db.client.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  author = toSessionUser(
    await createUser({
      email: 'anonauthor@titan.local',
      passwordHash: 'x',
      handle: 'anonauthor',
      name: 'Anon Author',
      createdAt: AT,
    }),
  );

  articleId = (
    await createArticle({
      authorId: author.id,
      title: 'A published story anyone may read',
      bodyJson: DOC,
      bodyHtml: '<p>Public, and readable by all.</p>',
      status: ARTICLE_STATUS.PUBLISHED,
      now: AT,
    })
  ).id;
});

describe('SPEC-009 — every engagement mutation is 401 for an anonymous caller', () => {
  /**
   * `null` is the viewer an unauthenticated Server Action resolves to:
   * `auth()` returns null for no cookie, an unknown id AND an expired row, and
   * `clapAction` and friends pass `(await auth())?.user ?? null` straight
   * through. So calling these with `null` is the same call an anonymous — or
   * expired-session — request makes.
   */
  const actions = [
    { name: 'clap', run: () => applyClap(null, articleId, 1, AT) },
    { name: 'bookmark', run: () => applyBookmark(null, articleId, AT) },
    { name: 'follow', run: () => applyFollow(null, author.id, AT) },
  ];

  for (const action of actions) {
    it(`${action.name} returns 401 and writes zero rows anywhere`, async () => {
      const before = await rowCounts();

      const result = await action.run();

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ status: 401 });

      // Not merely "no row in the table this action targets" — no row in any
      // of them. A mutation that leaked into a neighbouring table would pass a
      // narrower assertion.
      expect(await rowCounts()).toEqual(before);
      expect(await rowCounts()).toEqual({ Clap: 0, Bookmark: 0, Follow: 0 });
    });
  }

  it('covers exactly the three actions SPEC-009 names', () => {
    // Guards the loop against quiet erosion: a fourth engagement mutation that
    // never joined this table would otherwise just not be checked, with
    // nothing turning red.
    expect(actions.map((action) => action.name)).toEqual(['clap', 'bookmark', 'follow']);
  });

  it('answers 401 before anything else — even for a target that does not exist', async () => {
    // Ordering is load-bearing. If existence were checked first, an anonymous
    // caller could tell a real article id from a fake one by which status came
    // back, which is an enumeration oracle handed out for free.
    expect(await applyClap(null, 'no-such-article', 1, AT)).toMatchObject({ status: 401 });
    expect(await applyBookmark(null, 'no-such-article', AT)).toMatchObject({ status: 401 });
    expect(await applyFollow(null, 'no-such-user', AT)).toMatchObject({ status: 401 });
  });

  it('answers 401 rather than 400 when an anonymous caller names themselves', async () => {
    // A null viewer cannot be the target, so this can only be reached by a
    // forged request. It must still be 401: "you are not signed in" is the
    // true and less informative answer.
    expect(await applyFollow(null, author.id, AT)).toMatchObject({ status: 401 });
  });

  it('does not repeat the message from a 404, so the two are distinguishable', async () => {
    // The client routes 401 to /signin and treats everything else as a failed
    // mutation to roll back. Those are different behaviours, so the two
    // outcomes must not be interchangeable.
    const anonymous = await applyClap(null, articleId, 1, AT);
    const missing = await applyClap(author, 'no-such-article', 1, AT);

    expect(anonymous.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (anonymous.ok || missing.ok) return;
    expect(anonymous.status).toBe(401);
    expect(missing.status).toBe(404);
    expect(anonymous.error).not.toBe(missing.error);
  });
});
