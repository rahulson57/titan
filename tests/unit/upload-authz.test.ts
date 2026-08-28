/**
 * You may only write into your own directory (SPEC-006, SPEC-005).
 *
 * > Ownership | `kind=avatar|cover` writes only under the session user's own
 * > id; a mismatch is 403.
 *
 * Oracle: "An upload with `kind=avatar` while authenticated as user A cannot
 * write under user B's directory - the attempt returns 403, asserted by
 * tests/unit/upload-authz.test.ts."
 *
 * -- Where the attack surface actually is -----------------------------------
 * The oracle describes an attempt, which means there has to be a way to make
 * one. The stored path is `/uploads/<kind>/<userId>/<name>.webp`, and every one
 * of those segments is chosen by the server -- so if the handler simply ignored
 * any client input about ownership, "user A cannot write under user B's
 * directory" would be true and untestable, and the 403 the spec asks for could
 * never be observed.
 *
 * So the handler accepts an explicit `userId` form field naming the directory
 * to write into, defaulting to the session user's own id. An honest client
 * never sends it. A later slice (Profiles, Editor) may send it to be explicit.
 * And a hostile client sends someone else's id -- which is the attempt, and it
 * is answered with exactly one comparison. That is the design SPEC-005's
 * sentence "Only the owning user may ... upload to their avatar/cover paths"
 * asks for, made observable.
 *
 * -- 401 and 403 are different answers ---------------------------------------
 * `approach.md`'s Identity -> Media interface reads "401/403 when
 * absent/mismatched". Collapsing them would tell a signed-out visitor that they
 * lack permission, when what they lack is a session -- and the actionable next
 * step differs (sign in vs. stop).
 *
 * -- On `ownsUploadPath` -----------------------------------------------------
 * `lib/auth/session.ts` (SPEC-005, TASK-004) exports `ownsUploadPath`. When
 * this slice landed it read the KIND segment where SPEC-006's storage table
 * puts the user id -- `/uploads/<kind>/<userId>/...` -- and so answered false
 * for the owner of every upload the product emits. TASK-015 repaired it, and
 * the last describe block below now pins the repaired behaviour against a real
 * stored path.
 *
 * The handler still enforces ownership DIRECTLY rather than delegating to the
 * helper, and that is not an oversight left over from the bug. The two guard
 * different things: the helper answers "does this existing path belong to this
 * user", while the handler must reject a mismatched `userId` field BEFORE any
 * path exists to ask about (DEC-034). Rewiring the handler onto the helper is
 * out of scope here and would not be a simplification.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { handleUpload } from '../../app/api/upload/route';
import { ownsUploadPath, type SessionUser } from '../../lib/auth/session';

const ALICE: SessionUser = {
  id: 'ua1zx9k4m7q2vnp8trwchdb3',
  handle: 'alice',
  name: 'Alice',
  avatarPath: null,
};

const BOB: SessionUser = {
  id: 'ub7nq2v9k1x4mpr8tzcwhjd5',
  handle: 'bob',
  name: 'Bob',
  avatarPath: null,
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'titan-upload-authz-'));
  process.env.TITAN_UPLOADS_ROOT = root;
});

afterAll(async () => {
  delete process.env.TITAN_UPLOADS_ROOT;
  await rm(root, { recursive: true, force: true });
});

function census(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      if (statSync(child).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk(directory);
  return out.sort();
}

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 48, height: 48, channels: 3, background: { r: 36, g: 36, b: 36 } },
  })
    .png()
    .toBuffer();
}

async function upload(fields: Record<string, string>): Promise<Request> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(await tinyPng())], 'me.png', { type: 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request('http://localhost:3000/api/upload', { method: 'POST', body: form });
}

describe('SPEC-006 - Alice cannot write into Bob directory', () => {
  let before: string[];

  beforeEach(() => {
    before = census(root);
  });

  it('answers 403 for kind=avatar', async () => {
    const response = await handleUpload(
      await upload({ kind: 'avatar', userId: BOB.id }),
      ALICE,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_owner' });
  });

  it('writes nothing at all - not into Bob directory, not into Alice own', () => {
    // The second half matters as much as the first. A handler that "helpfully"
    // fell back to the caller's own directory would answer 201 for a request
    // that asked to write somewhere else, and the caller would have no way to
    // know their upload went somewhere they did not name.
    expect(census(root)).toEqual(before);
    expect(existsSync(join(root, 'avatars', BOB.id))).toBe(false);
  });

  it('answers 403 for every kind, not only avatar', async () => {
    for (const kind of ['avatar', 'cover', 'inline']) {
      const response = await handleUpload(await upload({ kind, userId: BOB.id }), ALICE);
      expect(response.status, kind).toBe(403);
    }
    expect(census(root)).toEqual(before);
  });

  it('refuses before decoding anything - a hostile owner beats a hostile image', async () => {
    // Ordering assertion: ownership is checked before the bytes are read, so a
    // cross-user attempt costs no sharp decode. Both rules would reject this
    // request; the one that fires first is the one whose status comes back.
    const form = new FormData();
    form.set('file', new File([new Uint8Array(Buffer.from('%PDF-1.4 not an image'))], 'x.png'));
    form.set('kind', 'avatar');
    form.set('userId', BOB.id);
    const response = await handleUpload(
      new Request('http://localhost:3000/api/upload', { method: 'POST', body: form }),
      ALICE,
    );
    expect(response.status).toBe(403);
    expect(census(root)).toEqual(before);
  });

  it('is not fooled by a userId that merely looks like Alice own', async () => {
    const lookalikes = [
      `${ALICE.id} `,
      ` ${ALICE.id}`,
      ALICE.id.toUpperCase(),
      `${ALICE.id}x`,
      ALICE.id.slice(0, -1),
      `${BOB.id}/../${ALICE.id}`,
    ];
    for (const userId of lookalikes) {
      const response = await handleUpload(await upload({ kind: 'avatar', userId }), ALICE);
      expect(response.status, userId).toBe(403);
    }
    expect(census(root)).toEqual(before);
  });
});

describe('SPEC-006 - the legitimate cases still work', () => {
  it('Alice may upload without naming an owner at all', async () => {
    const response = await handleUpload(await upload({ kind: 'avatar' }), ALICE);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string };
    expect(body.path.startsWith(`/uploads/avatars/${ALICE.id}/`)).toBe(true);
  });

  it('Alice may name herself explicitly, which is what a careful client does', async () => {
    const response = await handleUpload(
      await upload({ kind: 'avatar', userId: ALICE.id }),
      ALICE,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string };
    expect(body.path.startsWith(`/uploads/avatars/${ALICE.id}/`)).toBe(true);
  });

  it('Bob signed in as Bob writes under Bob - the rule is symmetric', async () => {
    const response = await handleUpload(await upload({ kind: 'cover', userId: BOB.id }), BOB);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string };
    expect(body.path.startsWith(`/uploads/covers/${BOB.id}/`)).toBe(true);
  });

  it('the stored path always carries the SESSION user id, never a submitted one', async () => {
    // The strongest form of the rule: even in the accepted case the path is
    // built from `user.id`, so a future change that started trusting the form
    // field would fail here rather than silently.
    const response = await handleUpload(await upload({ kind: 'inline' }), ALICE);
    const body = (await response.json()) as { path: string };
    expect(body.path.split('/')[3]).toBe(ALICE.id);
    expect(body.path).not.toContain(BOB.id);
  });
});

describe('SPEC-005/006 - absent and mismatched are different answers', () => {
  it('an anonymous upload is 401, not 403', async () => {
    const response = await handleUpload(await upload({ kind: 'avatar' }), null);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('an anonymous upload naming someone else is still 401', async () => {
    // Authentication is resolved before ownership, so the answer names the
    // thing the caller can actually fix.
    const response = await handleUpload(await upload({ kind: 'avatar', userId: BOB.id }), null);
    expect(response.status).toBe(401);
  });
});

describe('SPEC-005/006 - ownsUploadPath agrees with the storage layout', () => {
  it('recognises the owner of a real stored path', () => {
    // The assertion this replaces pinned the OPPOSITE result. It was correct
    // when it was written -- the helper read `segments[uploadsAt + 1]`, the
    // kind, and compared 'avatars' to a cuid2 -- and it was deliberately left
    // failing-by-design so the repair could not land silently. TASK-015 moved
    // the read to `segments[uploadsAt + 2]`, so the owner of a path this slice
    // actually writes is now recognised.
    const realStoredPath = `/uploads/avatars/${ALICE.id}/abcdefghijklmnopqrstuvwx.webp`;
    expect(ownsUploadPath(ALICE, realStoredPath)).toBe(true);
    expect(ownsUploadPath(BOB, realStoredPath)).toBe(false);

    // All three per-user kinds, since the helper now validates the kind rather
    // than stepping over it.
    for (const kind of ['avatars', 'covers', 'inline']) {
      expect(ownsUploadPath(ALICE, `/uploads/${kind}/${ALICE.id}/x.webp`)).toBe(true);
      expect(ownsUploadPath(BOB, `/uploads/${kind}/${ALICE.id}/x.webp`)).toBe(false);
    }

    // And the layout it was mistakenly written for is no longer honoured --
    // the uploader has never emitted a path shaped like this.
    expect(ownsUploadPath(ALICE, `/uploads/${ALICE.id}/x.webp`)).toBe(false);
  });

  it('answers about the path the handler actually wrote', async () => {
    // Closing the loop end to end: take the path this slice's own uploader
    // returns and hand it straight to the helper. This is the assertion that
    // would have caught the original defect, because it never names a layout
    // -- it asks the writer where the file went and asks the guard who owns
    // it. If the two ever disagree again, this goes red first.
    const response = await handleUpload(await upload({ kind: 'avatar' }), ALICE);
    expect(response.status).toBe(201);

    const body = (await response.json()) as { path: string };
    expect(ownsUploadPath(ALICE, body.path)).toBe(true);
    expect(ownsUploadPath(BOB, body.path)).toBe(false);
  });

  it('the handler enforces the same property independently', async () => {
    // Unchanged in intent from what this slice landed. The helper being
    // correct does not make this redundant: the handler rejects a mismatched
    // `userId` field before a path exists (DEC-034), which is a check the
    // helper is not positioned to make.
    const response = await handleUpload(
      await upload({ kind: 'avatar', userId: BOB.id }),
      ALICE,
    );
    expect(response.status).toBe(403);
  });
});
