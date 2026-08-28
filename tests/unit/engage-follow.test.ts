/**
 * The follow rule (SPEC-009), against a real database.
 *
 * The sealed criterion:
 *
 *   > "`follow` on self returns a 400 `SelfFollowError`; `follow` twice on
 *   >  another user toggles on then off and `followerCount` matches `COUNT(*)`
 *   >  exactly."
 *
 * The last clause is the interesting one. `followerCount` is a READ-TIME
 * aggregate — SPEC-004 forbids storing it — so "matches `COUNT(*)` exactly" is
 * not a tautology to assert: it is the difference between the number the
 * control shows and a denormalised counter that would start lying the first
 * time a cascade deleted rows out from under it. So every assertion below
 * compares the returned count against a `SELECT COUNT(*)` run through the raw
 * client, not against the repository function that produced it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { toSessionUser, type SessionUser } from '../../lib/auth/session';
import { disconnectDb } from '../../lib/db/client';
import { getFollowerCount, isFollowing } from '../../lib/db/social';
import { createUser, deleteUser } from '../../lib/db/users';
import { SELF_FOLLOW_CODE, SelfFollowError, applyFollow, readFollowState } from '../../lib/engage/follow';

const AT = new Date('2026-01-01T00:00:00.000Z');

let db: TestDatabase;
let viewer: SessionUser;
let target: SessionUser;
let bystander: SessionUser;

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

/** `COUNT(*)` straight from SQLite — the number the criterion measures against. */
async function rawFollowerCount(userId: string): Promise<number> {
  const rows = await db.client.$queryRawUnsafe<{ n: bigint | number }[]>(
    'SELECT COUNT(*) AS n FROM "Follow" WHERE followingId = ?',
    userId,
  );
  return Number(rows[0]?.n ?? 0);
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
  await db.client.$executeRawUnsafe('DELETE FROM "Follow"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  viewer = await makeUser('follower');
  target = await makeUser('followed');
  bystander = await makeUser('bystander');
});

describe('SPEC-009 — self-follow is a 400 SelfFollowError', () => {
  it('returns 400 with the SelfFollowError code and writes nothing', async () => {
    const result = await applyFollow(viewer, viewer.id, AT);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400, code: SELF_FOLLOW_CODE });
    expect(await rawFollowerCount(viewer.id)).toBe(0);
  });

  it('names the error rather than only describing it in prose', async () => {
    // A client that had to string-match an English message to tell one 400
    // from another would break the first time the wording changed. The code is
    // the stable half; the message is the human half.
    const result = await applyFollow(viewer, viewer.id, AT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(SelfFollowError.name);
    expect(result.error).toContain(viewer.id);
  });
});

describe('SPEC-009 — follow is an idempotent toggle and the count is COUNT(*)', () => {
  it('toggles on then off across two calls', async () => {
    const first = await applyFollow(viewer, target.id, AT);
    expect(first).toEqual({
      ok: true,
      status: 200,
      value: { following: true, followerCount: 1 },
    });
    expect(await isFollowing(viewer.id, target.id)).toBe(true);

    const second = await applyFollow(viewer, target.id, AT);
    expect(second).toEqual({
      ok: true,
      status: 200,
      value: { following: false, followerCount: 0 },
    });
    expect(await isFollowing(viewer.id, target.id)).toBe(false);
  });

  it('returns a followerCount equal to SELECT COUNT(*) at every step', async () => {
    // Two followers, then one unfollow, checking the returned number against
    // raw SQL each time — not against `getFollowerCount`, which is the same
    // code path that produced it.
    const steps: { actor: SessionUser; expected: number }[] = [
      { actor: viewer, expected: 1 },
      { actor: bystander, expected: 2 },
      { actor: viewer, expected: 1 },
      { actor: bystander, expected: 0 },
    ];

    for (const { actor, expected } of steps) {
      const result = await applyFollow(actor, target.id, AT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.followerCount).toBe(expected);
      expect(result.value.followerCount).toBe(await rawFollowerCount(target.id));
    }
  });

  it('keeps the count honest when a follower row is cascaded away', async () => {
    // The reason SPEC-004 forbids storing this number. A denormalised counter
    // would survive the user deletion and start over-reporting; a COUNT(*)
    // follows the rows down.
    await applyFollow(viewer, target.id, AT);
    await applyFollow(bystander, target.id, AT);
    expect(await getFollowerCount(target.id)).toBe(2);

    await deleteUser(bystander.id);

    expect(await getFollowerCount(target.id)).toBe(1);
    expect(await rawFollowerCount(target.id)).toBe(1);
  });

  it('does not double-count a follow that is already in place', async () => {
    await applyFollow(viewer, target.id, AT);
    await applyFollow(viewer, target.id, AT); // off
    await applyFollow(viewer, target.id, AT); // on again

    expect(await rawFollowerCount(target.id)).toBe(1);
  });
});

describe('SPEC-009 — readFollowState renders the control before any mutation', () => {
  it('reports the real count with following=false for an anonymous viewer', async () => {
    // The follower count is public information on a public byline; only the
    // MUTATION is 401. An anonymous viewer sees the number and a control that
    // routes to /signin.
    await applyFollow(bystander, target.id, AT);

    expect(await readFollowState(null, target.id)).toEqual({
      following: false,
      followerCount: 1,
    });
  });

  it('reports following=true once the viewer follows', async () => {
    expect(await readFollowState(viewer, target.id)).toEqual({
      following: false,
      followerCount: 0,
    });

    await applyFollow(viewer, target.id, AT);

    expect(await readFollowState(viewer, target.id)).toEqual({
      following: true,
      followerCount: 1,
    });
  });
});

describe('SPEC-009 — following a user who is not there', () => {
  it('answers 404 without writing a row', async () => {
    const result = await applyFollow(viewer, 'no-such-user', AT);

    expect(result).toEqual({ ok: false, status: 404, error: 'Not found.' });
    expect(await db.client.$queryRawUnsafe('SELECT * FROM "Follow"')).toEqual([]);
  });
});
