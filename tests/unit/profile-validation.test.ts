/**
 * Profile-settings validation (SPEC-010).
 *
 * > A bio of 221 chars, a name of 0 or 61 chars, and a handle failing
 * > `^[a-z0-9_]{3,24}$` or already taken are each rejected with a field-level
 * > error and no write.
 *
 * ── Why this suite opens a database ───────────────────────────────────────
 * The criterion has two clauses and only one of them is pure. "A field-level
 * error" can be asserted against the validator; **"and no write"** cannot — it
 * is a statement about a row, and the only way to know a row did not change is
 * to read it back afterwards. A suite that checked the error and trusted the
 * absence of a write would pass just as happily against a `saveProfile` that
 * returned the error *after* updating the row, which is precisely the bug the
 * clause exists to catch.
 *
 * "Already taken" is the same shape: uniqueness is not a property of a string,
 * so it cannot be decided without asking the table.
 *
 * The database is a throwaway file per suite, per SPEC-002's determinism rules,
 * and the suite skips with a named reason if Persistence has not landed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  hasMigratableSchema,
  waitingOn,
  type TestDatabase,
} from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser, findUserById, type UserRecord } from '../../lib/db/users';
import type { SessionUser } from '../../lib/auth/session';
import {
  BIO_MAX,
  NAME_MAX,
  saveProfile,
  validateBio,
  validateHandle,
  validateMediaPath,
  validateName,
  validateProfile,
  type ProfileInput,
} from '../../lib/profile/validation';

const AVAILABLE = hasMigratableSchema();
const AT = new Date('2026-01-01T00:00:00.000Z');

let db: TestDatabase;
let owner: UserRecord;
let stranger: UserRecord;

/** The valid submission every case below perturbs by exactly one field. */
function baseline(overrides: ProfileInput = {}): ProfileInput {
  return {
    name: 'Ada Lovelace',
    handle: 'ada',
    bio: 'Writes about engines.',
    twitter: '',
    github: '',
    website: '',
    ...overrides,
  };
}

function sessionUser(user: UserRecord): SessionUser {
  return { id: user.id, handle: user.handle, name: user.name, avatarPath: user.avatarPath };
}

describe.skipIf(!AVAILABLE)('SPEC-010 — profile validation', () => {
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
    owner = await createUser({
      email: 'ada@titan.local',
      passwordHash: 'x',
      handle: 'ada',
      name: 'Ada Lovelace',
      bio: 'Writes about engines.',
      createdAt: AT,
    });
    stranger = await createUser({
      email: 'grace@titan.local',
      passwordHash: 'x',
      handle: 'grace',
      name: 'Grace Hopper',
      createdAt: AT,
    });
  });

  /** Save, then read the row back. Both halves of every criterion, together. */
  async function attempt(input: ProfileInput) {
    const result = await saveProfile({
      actor: sessionUser(owner),
      targetUserId: owner.id,
      input,
      now: AT,
    });
    const row = await findUserById(owner.id);
    return { result, row };
  }

  // -------------------------------------------------------------------------
  // The criterion, field by field
  // -------------------------------------------------------------------------

  it('rejects a 221-character bio with a field error and no write', async () => {
    const { result, row } = await attempt(baseline({ bio: 'a'.repeat(BIO_MAX + 1) }));

    expect(result.state.status).toBe(400);
    expect(result.state.errors.map((e) => e.field)).toEqual(['bio']);
    expect(result.user).toBeUndefined();
    // The row is untouched — not merely "not the new bio", but exactly what it
    // was. `updateUser` truncates at 220 silently, so a save that reached the
    // repository would have stored a 220-character bio and looked plausible.
    expect(row?.bio).toBe('Writes about engines.');
  });

  it('accepts a bio of exactly 220 characters', async () => {
    // The boundary in the other direction. Without it, an off-by-one that
    // rejected 220 as well would pass every assertion above.
    const bio = 'a'.repeat(BIO_MAX);
    const { result, row } = await attempt(baseline({ bio }));
    expect(result.state.status).toBe(200);
    expect(row?.bio).toBe(bio);
  });

  it.each([
    ['0 characters', ''],
    ['whitespace only', '   '],
    ['61 characters', 'a'.repeat(NAME_MAX + 1)],
  ])('rejects a name of %s with a field error and no write', async (_label, name) => {
    const { result, row } = await attempt(baseline({ name }));

    expect(result.state.status).toBe(400);
    expect(result.state.errors.map((e) => e.field)).toEqual(['name']);
    expect(row?.name).toBe('Ada Lovelace');
  });

  it('accepts a name of exactly 60 characters', async () => {
    const name = 'a'.repeat(NAME_MAX);
    const { result, row } = await attempt(baseline({ name }));
    expect(result.state.status).toBe(200);
    expect(row?.name).toBe(name);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(25)],
    ['a hyphen', 'ada-lovelace'],
    ['a dot', 'ada.lovelace'],
    ['a space', 'ada lovelace'],
    ['empty', ''],
    ['reserved', 'admin'],
  ])('rejects a handle that is %s, with a field error and no write', async (_label, handle) => {
    const { result, row } = await attempt(baseline({ handle }));

    expect(result.state.status).toBe(400);
    expect(result.state.errors.map((e) => e.field)).toEqual(['handle']);
    expect(row?.handle).toBe('ada');
  });

  it('rejects a handle already taken by another user, with no write', async () => {
    const { result, row } = await attempt(baseline({ handle: stranger.handle }));

    expect(result.state.status).toBe(400);
    expect(result.state.errors).toEqual([
      { field: 'handle', message: 'That handle is taken. Choose another.' },
    ]);
    expect(row?.handle).toBe('ada');
    // And the other user's row is untouched too — a "taken handle" check that
    // stole the handle instead would satisfy every assertion above.
    expect((await findUserById(stranger.id))?.handle).toBe('grace');
  });

  it('lowercases a handle rather than rejecting it for its case', async () => {
    // SPEC-010 pins the STORED form to `^[a-z0-9_]{3,24}$`, and `Ada` is not
    // that string — but rejecting it here would make the settings form refuse
    // an input `/signup` already accepts, since `lib/auth/validation.ts`
    // normalises before matching and has since TASK-004. `lib/db/users.ts`
    // states the reason directly: "If sign-up normalised but a profile edit did
    // not, two rows could differ only by case and the unique index would
    // happily allow it." The pattern is the contract for what is WRITTEN, and
    // what is written here is `ada`.
    const { result, row } = await attempt(baseline({ handle: 'Ada' }));
    expect(result.state.status).toBe(200);
    expect(row?.handle).toBe('ada');
  });

  it('treats a differently-cased taken handle as taken', async () => {
    // The corollary, and the one that would be a real defect if missed: if
    // case survived to the uniqueness check, `Grace` would look free.
    const { result, row } = await attempt(baseline({ handle: 'GRACE' }));
    expect(result.state.status).toBe(400);
    expect(result.state.errors.map((e) => e.field)).toEqual(['handle']);
    expect(row?.handle).toBe('ada');
  });

  it('lets a user re-save their OWN handle', async () => {
    // The uniqueness check must not treat the row it is about to write as a
    // conflict with itself: otherwise editing only the bio fails on the handle.
    const { result, row } = await attempt(baseline({ handle: 'ada', bio: 'New bio.' }));
    expect(result.state.status).toBe(200);
    expect(row?.bio).toBe('New bio.');
  });

  it('changes the profile URL when the handle changes (SPEC-010)', async () => {
    const { result, row } = await attempt(baseline({ handle: 'ada_l' }));
    expect(result.state.status).toBe(200);
    expect(result.state.handle).toBe('ada_l');
    expect(row?.handle).toBe('ada_l');
  });

  it('rejects a javascript: website with a field error and no write', async () => {
    const { result, row } = await attempt(baseline({ website: 'javascript:alert(1)' }));

    expect(result.state.status).toBe(400);
    expect(result.state.errors.map((e) => e.field)).toEqual(['website']);
    // The security half of the criterion: the string never reaches the column.
    expect(row?.socials).toEqual({});
  });

  it('normalizes socials on the way in', async () => {
    const { result, row } = await attempt(
      baseline({ twitter: 'https://x.com/ada', github: '@ada', website: 'https://ada.example/' }),
    );
    expect(result.state.status).toBe(200);
    expect(row?.socials).toEqual({
      twitter: 'ada',
      github: 'ada',
      website: 'https://ada.example/',
    });
  });

  it('reports every bad field at once rather than one per round trip', async () => {
    const { result, row } = await attempt(
      baseline({ name: '', handle: 'A', bio: 'a'.repeat(BIO_MAX + 1), website: 'nope' }),
    );
    expect(result.state.errors.map((e) => e.field)).toEqual([
      'name',
      'handle',
      'bio',
      'website',
    ]);
    expect(row?.name).toBe('Ada Lovelace');
  });

  // -------------------------------------------------------------------------
  // Media paths
  // -------------------------------------------------------------------------

  it('accepts an avatar path inside the acting user\'s own directory', async () => {
    const path = `/uploads/avatars/${owner.id}/${'a'.repeat(24)}.webp`;
    const { result, row } = await attempt(baseline({ avatarPath: path }));
    expect(result.state.status).toBe(200);
    expect(row?.avatarPath).toBe(path);
  });

  it.each([
    ['another user\'s directory', (o: string, s: string) => `/uploads/avatars/${s}/${'a'.repeat(24)}.webp`, 'avatar'],
    ['the wrong kind', (o: string) => `/uploads/covers/${o}/${'a'.repeat(24)}.webp`, 'avatar'],
    ['a traversal', (o: string) => `/uploads/avatars/${o}/../../covers/${o}/x.webp`, 'avatar'],
    ['outside uploads', () => 'https://tracker.example/pixel.gif', 'avatar'],
    ['a bare filesystem path', () => '/etc/passwd', 'avatar'],
  ])('rejects an avatar path naming %s, with no write', async (_label, build) => {
    const { result, row } = await attempt(
      baseline({ avatarPath: (build as (o: string, s: string) => string)(owner.id, stranger.id) }),
    );
    expect(result.state.status).toBe(400);
    expect(result.state.errors.map((e) => e.field)).toEqual(['avatar']);
    expect(row?.avatarPath).toBeNull();
  });

  it('clears the avatar when the field is submitted empty', async () => {
    const path = `/uploads/avatars/${owner.id}/${'a'.repeat(24)}.webp`;
    await attempt(baseline({ avatarPath: path }));
    const { result, row } = await attempt(baseline({ avatarPath: '' }));
    expect(result.state.status).toBe(200);
    expect(row?.avatarPath).toBeNull();
  });

  it('leaves the column alone when the field is absent', async () => {
    const path = `/uploads/covers/${owner.id}/${'a'.repeat(24)}.webp`;
    await attempt(baseline({ coverPath: path }));
    const { result, row } = await attempt(baseline({ bio: 'Edited.' }));
    expect(result.state.status).toBe(200);
    // An absent key is "I did not submit this", which must not be read as
    // "delete it" — otherwise every text-only save wipes the user's cover.
    expect(row?.coverPath).toBe(path);
  });
});

// ---------------------------------------------------------------------------
// The pure rules, which need no database at all
// ---------------------------------------------------------------------------

describe('SPEC-010 — the field rules, in isolation', () => {
  const actor: SessionUser = { id: 'user123', handle: 'ada', name: 'Ada', avatarPath: null };

  it('counts a bio in code points, not UTF-16 units', () => {
    // 200 astral characters are 400 UTF-16 units. A bound measured in `.length`
    // would reject this bio for being 400 characters long.
    expect(validateBio('😀'.repeat(200))).toBeNull();
    expect(validateBio('😀'.repeat(BIO_MAX + 1))).not.toBeNull();
  });

  it('does not strip markup from a bio', () => {
    // "Plain text only (no markup rendered)" is a statement about the renderer.
    // Someone writing about HTML is not an attacker, and eating their `<` would
    // make the stored value differ from what they watched themselves type.
    const bio = 'I write about <b>engines</b> & other machines.';
    expect(validateBio(bio)).toBeNull();
    const parsed = validateProfile(actor, { name: 'Ada', handle: 'ada', bio });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.bio).toBe(bio);
  });

  it('trims a name and a handle before judging them', () => {
    expect(validateName('  Ada  ')).toBeNull();
    expect(validateHandle('  @Ada  ')).toBeNull();
  });

  it('normalizes a handle to the form the URL uses', () => {
    const parsed = validateProfile(actor, { name: 'Ada', handle: '@ADA', bio: '' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.handle).toBe('ada');
  });

  it('stores an empty bio as null rather than an empty string', () => {
    const parsed = validateProfile(actor, { name: 'Ada', handle: 'ada', bio: '   ' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.bio).toBeNull();
  });

  it('accepts a media path only for its own kind and owner', () => {
    const mine = `/uploads/avatars/${actor.id}/${'a'.repeat(24)}.webp`;
    expect(validateMediaPath(actor, 'avatar', mine)).toEqual({ ok: true, value: mine });
    expect(validateMediaPath(actor, 'cover', mine).ok).toBe(false);
    expect(validateMediaPath(actor, 'avatar', '').ok).toBe(true);
  });
});
