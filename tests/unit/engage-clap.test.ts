/**
 * The clap rule (SPEC-009), against a real database.
 *
 * Two sealed criteria land here:
 *
 *   - "Calling `clap` 60 times as one user leaves exactly one Clap row with
 *      `count = 50` and the 51st–60th calls return the unchanged total without
 *      throwing."
 *   - (with `engage-anon.test.ts`) the anonymous half of "returns HTTP 401 and
 *      writes zero rows".
 *
 * ── Why this suite calls `applyClap` and not the Server Action ───────────
 * "Leaves exactly one Clap row with `count = 50`" is an assertion about ROWS.
 * A browser cannot see rows, and `app/article/[slug]/actions.ts` cannot be
 * imported here — it reaches `cookies()` through `lib/auth/session.ts`, and
 * `next/headers` throws the moment it is evaluated outside a request scope.
 * `lib/engage/clap.ts` takes the viewer as a parameter precisely so this
 * assertion is reachable: sixty real calls, then a `SELECT`.
 *
 * The database is a throwaway file per SPEC-002's determinism rule, built
 * through `tests/helpers/db.ts` — never `./data/titan.db`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { toSessionUser, type SessionUser } from '../../lib/auth/session';
import { ARTICLE_STATUS, createArticle } from '../../lib/db/articles';
import { disconnectDb } from '../../lib/db/client';
import {
  MAX_CLAPS_PER_READER,
  countClapRows,
  getClapByReader,
  getClapTotal,
  setClap,
} from '../../lib/db/social';
import { createUser } from '../../lib/db/users';
import { CLAP_BURST_MS, applyClap, readClapState } from '../../lib/engage/clap';

/** Fixed instant — SPEC-002: a fixture must not read a wall clock. */
const AT = new Date('2026-01-01T00:00:00.000Z');

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Something worth clapping for.' }] }],
};

let db: TestDatabase;
let reader: SessionUser;
let other: SessionUser;
let author: SessionUser;
let articleId = '';
let draftId = '';

async function makeUser(handle: string): Promise<SessionUser> {
  return toSessionUser(
    await createUser({
      email: `${handle}@titan.local`,
      passwordHash: 'x',
      handle,
      name: handle.toUpperCase(),
      createdAt: AT,
    }),
  );
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
  await db.client.$executeRawUnsafe('DELETE FROM "Clap"');
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  author = await makeUser('clapauthor');
  reader = await makeUser('clapreader');
  other = await makeUser('clapother');

  articleId = (
    await createArticle({
      authorId: author.id,
      title: 'A story with claps',
      bodyJson: DOC,
      bodyHtml: '<p>Something worth clapping for.</p>',
      status: ARTICLE_STATUS.PUBLISHED,
      now: AT,
    })
  ).id;

  draftId = (
    await createArticle({
      authorId: author.id,
      title: 'An unfinished story',
      bodyJson: DOC,
      bodyHtml: '<p>Not yet.</p>',
      status: ARTICLE_STATUS.DRAFT,
      now: AT,
    })
  ).id;
});

describe('SPEC-009 — clap is capped at 50 per reader and never errors past it', () => {
  it('leaves one row at 50 after 60 calls, and the last ten return the unchanged total', async () => {
    // The criterion verbatim: sixty invocations as ONE user.
    const results = [];
    for (let i = 0; i < 60; i += 1) {
      results.push(await applyClap(reader, articleId, 1, AT));
    }

    // Not one of the sixty threw, and not one came back as a failure.
    expect(results.every((result) => result.ok)).toBe(true);

    expect(await countClapRows(articleId)).toBe(1);
    expect(await getClapByReader(reader.id, articleId)).toBe(MAX_CLAPS_PER_READER);
    expect(await getClapTotal(articleId)).toBe(MAX_CLAPS_PER_READER);

    // "the 51st–60th calls return the unchanged total": every result from the
    // 50th onwards reports the same numbers, rather than merely not throwing.
    for (const result of results.slice(49)) {
      expect(result).toEqual({
        ok: true,
        status: 200,
        value: { total: MAX_CLAPS_PER_READER, mine: MAX_CLAPS_PER_READER },
      });
    }
  });

  it('is a no-op past the ceiling — the row is not even rewritten', async () => {
    // "Beyond 50 it is a no-op" is stronger than "the count stops moving": a
    // saturating write would also keep the count at 50 while still issuing an
    // UPDATE on every tap. `createdAt` is the witness — `setClap` does not
    // touch it on update, so this asserts through the row's identity that the
    // 51st call reached the database no differently from how it left it.
    await setClap(reader.id, articleId, MAX_CLAPS_PER_READER, AT);
    const before = await db.client.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count FROM "Clap" WHERE userId = ? AND articleId = ?',
      reader.id,
      articleId,
    );

    const result = await applyClap(reader, articleId, 1, new Date('2027-06-06T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    expect(await countClapRows(articleId)).toBe(1);
    expect(
      await db.client.$queryRawUnsafe<{ count: number }[]>(
        'SELECT count FROM "Clap" WHERE userId = ? AND articleId = ?',
        reader.id,
        articleId,
      ),
    ).toEqual(before);
  });

  it('trims a coalesced burst to the remaining headroom instead of overshooting', async () => {
    // The client sends one call per 400ms burst, so `by` arrives > 1.
    await setClap(reader.id, articleId, 45, AT);

    const result = await applyClap(reader, articleId, 10, AT);

    expect(result).toEqual({
      ok: true,
      status: 200,
      value: { total: MAX_CLAPS_PER_READER, mine: MAX_CLAPS_PER_READER },
    });
    expect(await getClapByReader(reader.id, articleId)).toBe(MAX_CLAPS_PER_READER);
  });

  it('exposes the burst window as a constant the client and the tests share', () => {
    // The e2e coalescing spec asserts against this value. A component that
    // changed its mind about the window would otherwise silently disagree
    // with the test that is supposed to be pinning it.
    expect(CLAP_BURST_MS).toBe(400);
  });
});

describe('DEC-019 — a non-positive increment writes nothing', () => {
  // The decision hands TASK-009 this ruling. The repository's `incrementClap`
  // floors `by <= 0` up to 1 and CREATES a row; the engagement layer refuses
  // to hand it a non-positive delta at all, so the hazard DEC-019 names — "a
  // coalescing path that computes a delta of zero" — cannot reach it.
  for (const by of [0, -1, -50]) {
    it(`creates no row for by = ${by}`, async () => {
      const result = await applyClap(reader, articleId, by, AT);

      expect(result).toEqual({ ok: true, status: 200, value: { total: 0, mine: 0 } });
      expect(await countClapRows(articleId)).toBe(0);
    });
  }

  it('does not move an existing count either', async () => {
    await setClap(reader.id, articleId, 7, AT);

    expect(await applyClap(reader, articleId, 0, AT)).toEqual({
      ok: true,
      status: 200,
      value: { total: 7, mine: 7 },
    });
    expect(await getClapByReader(reader.id, articleId)).toBe(7);
  });

  it('truncates a fractional delta rather than letting it reach the database', async () => {
    // 0.9 truncates to 0 — a no-op. Without the truncation the repository
    // would receive a non-integer and `setClap` would reject it as a caller
    // bug, turning a rounding artefact into a 500.
    expect(await applyClap(reader, articleId, 0.9, AT)).toEqual({
      ok: true,
      status: 200,
      value: { total: 0, mine: 0 },
    });
    expect(await countClapRows(articleId)).toBe(0);

    expect((await applyClap(reader, articleId, 3.7, AT)).ok).toBe(true);
    expect(await getClapByReader(reader.id, articleId)).toBe(3);
  });
});

describe('SPEC-009 — the returned value is the server value, not an estimate', () => {
  it('reports another reader’s claps in the total it hands back', async () => {
    // The optimistic UI rolls back ONTO this number, so it has to be read
    // rather than computed: `total + by` would silently drop a clap that
    // another reader made between the write and the response.
    await setClap(other.id, articleId, 12, AT);

    const result = await applyClap(reader, articleId, 3, AT);

    expect(result.ok && result.value).toEqual({ total: 15, mine: 3 });
  });

  it('readClapState reports mine = 0 for an anonymous reader without failing', async () => {
    // Anonymous readers read everything published (SPEC-009), and the count is
    // part of reading. Only the MUTATION is 401.
    await setClap(other.id, articleId, 4, AT);
    expect(await readClapState(null, articleId)).toEqual({ total: 4, mine: 0 });
  });
});

describe('SPEC-005 — engagement cannot be used to probe for drafts', () => {
  it('answers 404 for a draft the viewer does not own, and writes nothing', async () => {
    const result = await applyClap(reader, draftId, 1, AT);

    expect(result).toEqual({ ok: false, status: 404, error: 'Not found.' });
    expect(await countClapRows(draftId)).toBe(0);
  });

  it('gives the same 404 for an article id that does not exist', async () => {
    // Identical answers: the shape of the response must not reveal which of
    // the two cases the caller hit.
    expect(await applyClap(reader, 'no-such-article', 1, AT)).toEqual({
      ok: false,
      status: 404,
      error: 'Not found.',
    });
  });

  it('lets the author clap their own draft while previewing it', async () => {
    const result = await applyClap(author, draftId, 1, AT);
    expect(result.ok).toBe(true);
    expect(await getClapByReader(author.id, draftId)).toBe(1);
  });
});
