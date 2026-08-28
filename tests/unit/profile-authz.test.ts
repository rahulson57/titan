/**
 * Profile write authorization (SPEC-010 / SPEC-005).
 *
 * > Saving `/settings/profile` while authenticated as user A with a payload
 * > targeting user B's id returns HTTP 403 and leaves both rows unchanged.
 *
 * ── Why the payload can name a target at all ──────────────────────────────
 * If the write derived its row from the session alone, this criterion could
 * never be exercised: there would be no way to *express* "a payload targeting
 * user B", so the rule would be true and unobservable, and the first change
 * that broke it would break it silently. `saveProfile` therefore accepts a
 * `targetUserId`, compares it once, and never uses it to build anything — on
 * the accepted path the write goes to `actor.id`. A hostile value can only
 * produce a 403. DEC-034 approved exactly this shape for the upload handler,
 * for exactly this reason, and the last assertion below is the one that keeps
 * it honest: it proves the ACCEPTED path writes the session user's row.
 *
 * ── Why "leaves both rows unchanged" is asserted by reading both rows ─────
 * Not by trusting the status. A `saveProfile` that returned 403 *after*
 * updating the row would satisfy every status assertion in this file; only a
 * read-back distinguishes them, and that is the bug the clause exists for.
 *
 * ── Why this suite reaches the rule twice ─────────────────────────────────
 * `ownsProfile` and `requireProfileOwner` (SPEC-005, `lib/auth/session.ts`) are
 * pure and exhaustively enumerable in microseconds; `saveProfile` is the thing
 * a request actually calls. Testing only the pure rule proves nothing about
 * whether the write path consults it, and testing only the write path leaves
 * the rule itself covered by one example. Both, therefore.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  hasMigratableSchema,
  type TestDatabase,
} from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser, findUserById, type UserRecord } from '../../lib/db/users';
import {
  ForbiddenError,
  NotAuthenticatedError,
  ownsProfile,
  requireProfileOwner,
  type SessionUser,
} from '../../lib/auth/session';
import { saveProfile, type ProfileInput } from '../../lib/profile/validation';

const AVAILABLE = hasMigratableSchema();
const AT = new Date('2026-01-01T00:00:00.000Z');

let db: TestDatabase;
let alice: UserRecord;
let bob: UserRecord;

function sessionUser(user: UserRecord): SessionUser {
  return { id: user.id, handle: user.handle, name: user.name, avatarPath: user.avatarPath };
}

/** A payload that would be perfectly valid if the caller were allowed to send it. */
const HOSTILE_PAYLOAD: ProfileInput = {
  name: 'Taken Over',
  handle: 'takenover',
  bio: 'Rewritten by someone else.',
  twitter: 'attacker',
  github: '',
  website: 'https://attacker.example/',
};

// ---------------------------------------------------------------------------
// The pure rule (no database, no request scope)
// ---------------------------------------------------------------------------

describe('SPEC-005 — ownsProfile, enumerated', () => {
  const user: SessionUser = { id: 'user_a', handle: 'a', name: 'A', avatarPath: null };

  it('is true only for the user\'s own id', () => {
    expect(ownsProfile(user, 'user_a')).toBe(true);
    expect(ownsProfile(user, 'user_b')).toBe(false);
  });

  it('is false for an anonymous caller, whatever the target', () => {
    expect(ownsProfile(null, 'user_a')).toBe(false);
    expect(ownsProfile(null, '')).toBe(false);
  });

  it('is false for an empty or bogus target rather than throwing', () => {
    // A malformed id must be a denial, not a 500 on a public form.
    expect(ownsProfile(user, '')).toBe(false);
    expect(ownsProfile(user, 'USER_A')).toBe(false);
  });

  it('maps to 403 for a stranger and 401 for anonymous', () => {
    expect(() => requireProfileOwner(user, 'user_b')).toThrow(ForbiddenError);
    expect(() => requireProfileOwner(null, 'user_a')).toThrow(NotAuthenticatedError);
    expect(new ForbiddenError().status).toBe(403);
    expect(new NotAuthenticatedError().status).toBe(401);
    expect(requireProfileOwner(user, 'user_a')).toBe(user);
  });
});

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

describe.skipIf(!AVAILABLE)('SPEC-010 — a cross-user save is 403 and writes nothing', () => {
  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
  }, 120_000);

  afterAll(async () => {
    if (!AVAILABLE) return;
    await disconnectDb();
    await db.drop();
  });

  beforeEach(async () => {
    await db.client.$executeRawUnsafe('DELETE FROM "User"');
    alice = await createUser({
      email: 'alice@titan.local',
      passwordHash: 'x',
      handle: 'alice',
      name: 'Alice',
      bio: 'Alice wrote this.',
      socials: { twitter: 'alice' },
      createdAt: AT,
    });
    bob = await createUser({
      email: 'bob@titan.local',
      passwordHash: 'x',
      handle: 'bob',
      name: 'Bob',
      bio: 'Bob wrote this.',
      socials: { github: 'bob' },
      createdAt: AT,
    });
  });

  /** Every column this action can write, so "unchanged" means all of them. */
  function snapshot(user: UserRecord) {
    return {
      handle: user.handle,
      name: user.name,
      bio: user.bio,
      avatarPath: user.avatarPath,
      coverPath: user.coverPath,
      socials: user.socials,
    };
  }

  it('returns 403 when A saves a payload targeting B', async () => {
    const before = { alice: snapshot(alice), bob: snapshot(bob) };

    const result = await saveProfile({
      actor: sessionUser(alice),
      targetUserId: bob.id,
      input: HOSTILE_PAYLOAD,
      now: AT,
    });

    expect(result.state.status).toBe(403);
    expect(result.user).toBeUndefined();
    // Not a field error: this is not something the form can fix by editing an
    // input, and rendering it beside a text box would be a lie about the cause.
    expect(result.state.errors).toEqual([]);
    expect(result.state.formError).toBeTruthy();
    expect(result.state.savedAt).toBeNull();

    const [afterAlice, afterBob] = await Promise.all([
      findUserById(alice.id),
      findUserById(bob.id),
    ]);
    expect(snapshot(afterAlice!)).toEqual(before.alice);
    expect(snapshot(afterBob!)).toEqual(before.bob);
  });

  it('does not fall back to writing the ACTOR\'s row on a rejected save', async () => {
    // The plausible wrong fix for the criterion above: ignore `targetUserId`
    // and write `actor.id` regardless. That returns 200 and leaves B intact,
    // so a test that only read B's row would pass — while A's profile was
    // silently overwritten by a payload A never chose to submit to their own
    // row. Alice's snapshot in the previous test covers this; naming it here
    // makes the intent explicit rather than incidental.
    await saveProfile({
      actor: sessionUser(alice),
      targetUserId: bob.id,
      input: HOSTILE_PAYLOAD,
      now: AT,
    });
    const after = await findUserById(alice.id);
    expect(after?.name).toBe('Alice');
    expect(after?.handle).toBe('alice');
  });

  it('returns 403 for a target id that does not exist', async () => {
    // 403 rather than 404: answering "no such user" would make the form an
    // oracle for which ids exist, and the caller is not entitled to either
    // answer. The check is on ownership, so a bogus id fails it like any other.
    const result = await saveProfile({
      actor: sessionUser(alice),
      targetUserId: 'no_such_user',
      input: HOSTILE_PAYLOAD,
      now: AT,
    });
    expect(result.state.status).toBe(403);
    expect((await findUserById(alice.id))?.name).toBe('Alice');
  });

  it('returns 401 for an anonymous caller, even targeting a real row', async () => {
    const result = await saveProfile({
      actor: null,
      targetUserId: alice.id,
      input: HOSTILE_PAYLOAD,
      now: AT,
    });
    expect(result.state.status).toBe(401);
    expect((await findUserById(alice.id))?.name).toBe('Alice');
  });

  it('rejects BEFORE validating, so error messages cannot be used as a probe', async () => {
    // A stranger submitting a handle that is taken must learn 403, not "that
    // handle is taken" — the second answer is a membership oracle over the
    // handle namespace, obtainable without owning anything.
    const result = await saveProfile({
      actor: sessionUser(alice),
      targetUserId: bob.id,
      input: { ...HOSTILE_PAYLOAD, handle: 'bob' },
      now: AT,
    });
    expect(result.state.status).toBe(403);
    expect(result.state.errors).toEqual([]);
  });

  it('writes the session user\'s own row on the accepted path', async () => {
    // The other half of the `targetUserId` bargain: the field is compared and
    // discarded, and the write is addressed by `actor.id`. If a later change
    // started trusting the field to name the row, this assertion is what fails
    // rather than a user's profile being silently escalated.
    const result = await saveProfile({
      actor: sessionUser(alice),
      targetUserId: alice.id,
      input: { name: 'Alice A.', handle: 'alice', bio: 'Edited.' },
      now: AT,
    });

    expect(result.state.status).toBe(200);
    expect(result.state.savedAt).toBe(AT.toISOString());
    expect(result.user?.id).toBe(alice.id);
    expect((await findUserById(alice.id))?.name).toBe('Alice A.');
    // And B is untouched by a save that had nothing to do with them.
    expect(snapshot((await findUserById(bob.id))!)).toEqual(snapshot(bob));
  });
});
