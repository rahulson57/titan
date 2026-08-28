/**
 * The follow graph (SPEC-004 / SPEC-009).
 *
 * > A Follow where `followerId === followingId` is rejected with a
 * > `SelfFollowError`.
 *
 * A named error rather than a boolean or a silent no-op: SPEC-009 maps this to
 * an HTTP 400, which needs to be distinguishable from "the toggle turned
 * following off". A no-op would be indistinguishable, and is the shape this
 * bug usually ships in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import {
  SelfFollowError,
  follow,
  getFollowerCount,
  getFollowingCount,
  isFollowing,
  listFollowingIds,
  toggleFollow,
  unfollow,
} from '../../lib/db/social';

const AT = new Date('2026-01-01T00:00:00.000Z');

let db: TestDatabase;
let alice = '';
let bob = '';
let cara = '';

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
  const make = async (handle: string) =>
    (
      await createUser({
        email: `${handle}@titan.local`,
        passwordHash: 'x',
        handle,
        name: handle,
        createdAt: AT,
      })
    ).id;
  alice = await make('alice');
  bob = await make('bob');
  cara = await make('cara');
});

describe('SPEC-004 — a user cannot follow themselves', () => {
  it('rejects follow() with SelfFollowError and writes nothing', async () => {
    await expect(follow(alice, alice, AT)).rejects.toBeInstanceOf(SelfFollowError);
    expect(await getFollowerCount(alice)).toBe(0);
  });

  it('rejects the toggle before it can decide a direction', async () => {
    // If the guard sat after the "am I already following?" read, a self-toggle
    // would fall through to the unfollow branch and quietly return {following:
    // false} — a 200 where SPEC-009 requires a 400.
    await expect(toggleFollow(alice, alice, AT)).rejects.toBeInstanceOf(SelfFollowError);
  });

  it('carries the user id, so the action can report which call was refused', async () => {
    await expect(follow(alice, alice, AT)).rejects.toThrow(alice);
  });
});

describe('SPEC-009 — following is an idempotent toggle', () => {
  it('toggles on then off and reports the resulting state', async () => {
    expect(await toggleFollow(alice, bob, AT)).toEqual({ following: true, followerCount: 1 });
    expect(await toggleFollow(alice, bob, AT)).toEqual({ following: false, followerCount: 0 });
  });

  it('is safe to call follow() twice — one edge, not two', async () => {
    await follow(alice, bob, AT);
    await follow(alice, bob, AT);
    expect(await getFollowerCount(bob)).toBe(1);
    expect(await isFollowing(alice, bob)).toBe(true);
  });

  it('is safe to unfollow something that was never followed', async () => {
    await unfollow(alice, bob);
    expect(await isFollowing(alice, bob)).toBe(false);
  });

  it('keeps the two directions distinct', async () => {
    await follow(alice, bob, AT);
    expect(await isFollowing(bob, alice)).toBe(false);
  });
});

describe('SPEC-004 — followerCount is a read-time aggregate, never stored', () => {
  it('equals COUNT(*) of the incoming edges', async () => {
    await follow(alice, cara, AT);
    await follow(bob, cara, AT);
    expect(await getFollowerCount(cara)).toBe(2);
    expect(await getFollowingCount(alice)).toBe(1);

    const rows = await db.client.$queryRawUnsafe<Array<{ n: bigint }>>(
      'SELECT COUNT(*) AS n FROM "Follow" WHERE followingId = ?',
      cara,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('drops to match after a followed user is deleted', async () => {
    await follow(alice, cara, AT);
    await follow(bob, cara, AT);
    await db.client.$executeRawUnsafe('DELETE FROM "User" WHERE id = ?', bob);
    expect(await getFollowerCount(cara)).toBe(1);
  });

  it('lists the author ids that fill a viewer Following timeline', async () => {
    await follow(alice, bob, AT);
    await follow(alice, cara, AT);
    expect((await listFollowingIds(alice)).sort()).toEqual([bob, cara].sort());
    expect(await listFollowingIds(bob)).toEqual([]);
  });
});
