/**
 * The client's filename goes nowhere (SPEC-006).
 *
 * > Filename | Server-generated cuid2 + `.webp`. The client-supplied filename
 * > is discarded entirely (no path traversal surface).
 *
 * Oracle: "A client-supplied filename of `../../../etc/passwd.png` results in a
 * server-generated cuid2 filename inside the user's own directory and no file
 * outside `public/uploads/`."
 *
 * -- What "no path traversal surface" means, and what it does not ------------
 * There is a weaker property this suite could assert -- "the dangerous filename
 * was sanitised" -- and it is the wrong one. Sanitising means an
 * attacker-controlled string still reaches a path operation, with a cleaning
 * function standing between them that has to be right forever, against `..%2f`,
 * against `....//`, against unicode normalisation, against whatever the next
 * Node release changes about `path.resolve`.
 *
 * The property SPEC-006 actually buys is stronger and simpler: the name is not
 * an input. `allocate()` takes a kind and a user id and invents a name from the
 * CSPRNG; `route.ts` never reads `file.name`. So the assertions below are not
 * "the traversal was neutralised" but "the stored name bears no relationship to
 * the submitted one" -- which is a property no future encoding trick can
 * subvert, because there is nothing to encode into.
 *
 * The temporary uploads root is created inside a WRAPPER directory with a
 * sentinel file beside it. If a traversal ever did escape, it would land in the
 * wrapper -- so the census assertions can prove absence rather than just
 * asserting the happy path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import sharp from 'sharp';

import { handleUpload } from '../../app/api/upload/route';
import {
  MEDIA_ID_LENGTH,
  allocate,
  assertInside,
  assertSafeSegment,
  createMediaId,
  isMediaFilename,
} from '../../lib/media/store';
import type { SessionUser } from '../../lib/auth/session';

const USER: SessionUser = {
  id: 'uk7m2q9x4v1nprd8tzcwhjb5',
  handle: 'ada',
  name: 'Ada',
  avatarPath: null,
};

const HOSTILE_NAME = '../../../etc/passwd.png';

let wrapper: string;
let root: string;

beforeAll(async () => {
  wrapper = await mkdtemp(join(tmpdir(), 'titan-upload-traversal-'));
  root = join(wrapper, 'uploads');
  await mkdir(root, { recursive: true });
  // The canary: if anything escapes `root`, it lands here beside this file.
  await writeFile(join(wrapper, 'CANARY'), 'nothing should join me\n');
  process.env.TITAN_UPLOADS_ROOT = root;
});

afterAll(async () => {
  delete process.env.TITAN_UPLOADS_ROOT;
  await rm(wrapper, { recursive: true, force: true });
});

function census(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      if (statSync(child).isDirectory()) walk(child);
      else out.push(relative(wrapper, child).split(sep).join('/'));
    }
  };
  walk(directory);
  return out.sort();
}

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 26, g: 137, b: 23 } },
  })
    .png()
    .toBuffer();
}

function upload(bytes: Buffer, filename: string, kind = 'avatar'): Request {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], filename, { type: 'image/png' }));
  form.set('kind', kind);
  return new Request('http://localhost:3000/api/upload', { method: 'POST', body: form });
}

describe('SPEC-006 - a hostile filename has nowhere to go', () => {
  let stored: { path: string };

  beforeAll(async () => {
    const response = await handleUpload(upload(await tinyPng(), HOSTILE_NAME), USER);
    expect(response.status).toBe(201);
    stored = (await response.json()) as { path: string };
  });

  it('stores under a server-generated name of the shape SPEC-006 pins', () => {
    expect(stored.path).toMatch(
      new RegExp(`^/uploads/avatars/${USER.id}/[a-z0-9]{${MEDIA_ID_LENGTH}}\\.webp$`),
    );
  });

  it('keeps nothing of the submitted name - not the stem, not the extension', () => {
    expect(stored.path).not.toContain('passwd');
    expect(stored.path).not.toContain('etc');
    expect(stored.path).not.toContain('..');
    expect(stored.path.endsWith('.png')).toBe(false);
  });

  it('lands inside the uploading user own directory', () => {
    expect(stored.path.startsWith(`/uploads/avatars/${USER.id}/`)).toBe(true);
  });

  it('writes no file outside the uploads root', () => {
    // The canary is still alone in the wrapper; everything else is under
    // `uploads/`.
    const wrapperEntries = readdirSync(wrapper).sort();
    expect(wrapperEntries).toEqual(['CANARY', 'uploads']);
    for (const path of census(root)) expect(path.startsWith('uploads/')).toBe(true);
  });

  it('is unmoved by the other spellings of the same trick', async () => {
    const spellings = [
      '..\\..\\..\\windows\\system32\\config\\sam.png',
      '....//....//etc/shadow.png',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd.png',
      '/absolute/path/photo.png',
      'photo.png .php',
      '.',
      '..',
    ];
    for (const spelling of spellings) {
      const response = await handleUpload(upload(await tinyPng(), spelling), USER);
      expect(response.status, spelling).toBe(201);
      const body = (await response.json()) as { path: string };
      expect(body.path, spelling).toMatch(
        new RegExp(`^/uploads/avatars/${USER.id}/[a-z0-9]{${MEDIA_ID_LENGTH}}\\.webp$`),
      );
    }
    expect(readdirSync(wrapper).sort()).toEqual(['CANARY', 'uploads']);
  });

  it('an empty filename never arrives as a file at all, and answers 400', async () => {
    // Worth pinning because it is genuinely surprising: a multipart part with
    // `filename=""` is decoded by undici as a plain string field, not a File.
    // So the empty name is not a traversal case that the handler neutralises --
    // it is a request with no file part in it, and the honest answer is 400
    // rather than a 201 for something that was never uploaded.
    const response = await handleUpload(upload(await tinyPng(), ''), USER);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'missing_file' });
    expect(readdirSync(wrapper).sort()).toEqual(['CANARY', 'uploads']);
  });
});

describe('SPEC-006 - the name generator', () => {
  it('produces exactly the shape the oracle matches', () => {
    for (let i = 0; i < 200; i++) {
      const id = createMediaId();
      expect(id).toMatch(new RegExp(`^[a-z0-9]{${MEDIA_ID_LENGTH}}$`));
      expect(isMediaFilename(`${id}.webp`)).toBe(true);
    }
  });

  it('does not repeat itself', () => {
    // Not a randomness test - a collision here would silently overwrite another
    // user's file, so "distinct" is the property that matters, not "uniform".
    const seen = new Set(Array.from({ length: 2000 }, () => createMediaId()));
    expect(seen.size).toBe(2000);
  });

  it('uses the whole alphabet, so the sampling is not biased into a corner', () => {
    // Rejection sampling exists precisely so `byte % 36` does not make the
    // first four symbols ~14% more likely. Over 40k symbols every one of the
    // 36 should appear; a modulo-biased generator would still pass this, but a
    // generator that lost the tail of the alphabet entirely would not.
    const symbols = new Set(Array.from({ length: 1700 }, () => createMediaId()).join(''));
    expect(symbols.size).toBe(36);
  });

  it('always ends in .webp, whatever came in', () => {
    const allocation = allocate('inline', USER.id, root);
    expect(allocation.filename.endsWith('.webp')).toBe(true);
    expect(allocation.publicPath.endsWith('.webp')).toBe(true);
  });
});

describe('SPEC-006 - the one interpolated segment is checked anyway', () => {
  it('refuses a user id that could mean more than one directory', () => {
    // The user id comes from the session, not the request, so this cannot be
    // reached from outside today. It is checked because "comes from the
    // session" is a property of code in another file that could change without
    // this file's author noticing.
    for (const hostile of ['..', '.', 'a/b', 'a\\b', '../etc', 'a b', '', 'x'.repeat(65)]) {
      expect(() => assertSafeSegment(hostile), hostile).toThrowError(/invalid/i);
    }
  });

  it('accepts the id shapes this repository actually produces', () => {
    expect(assertSafeSegment('ux4k2m9v7p1qb3ncd8trwzhy')).toBe('ux4k2m9v7p1qb3ncd8trwzhy');
    expect(assertSafeSegment('user-1')).toBe('user-1'); // the auth fixtures' shape
    expect(assertSafeSegment('user_2')).toBe('user_2');
  });

  it('refuses to hand back a path outside the root', () => {
    expect(() => assertInside(root, join(wrapper, 'CANARY'))).toThrowError(/outside/i);
    expect(() => assertInside(root, root)).toThrowError(/outside/i);
    expect(() => assertInside(root, join(root, 'avatars', 'u', 'x.webp'))).not.toThrow();
  });

  it('an allocation is only ever inside the root it was given', () => {
    for (const kind of ['avatar', 'cover', 'inline'] as const) {
      const allocation = allocate(kind, USER.id, root);
      expect(() => assertInside(root, allocation.absolutePath)).not.toThrow();
    }
  });

  it('refuses a kind it does not recognise, even called directly', () => {
    // The route validates `kind` before it gets here, so this is the second
    // check of the same thing - deliberately. `allocate` is the function that
    // decides a filesystem path, and every later slice will call it; a caller
    // that skipped the route's validation must not be able to invent a fourth
    // directory under the uploads root by passing a string.
    expect(() => allocate('banner' as never, USER.id, root)).toThrowError(/unknown upload kind/i);
    expect(() => allocate('' as never, USER.id, root)).toThrowError(/unknown upload kind/i);
    expect(() => allocate('../avatars' as never, USER.id, root)).toThrowError(
      /unknown upload kind/i,
    );
  });

  it('defaults to the configured uploads root when none is passed', () => {
    // `TITAN_UPLOADS_ROOT` is set for this suite, so the default path resolves
    // inside the temporary tree rather than the repository's own public/.
    const allocation = allocate('avatar', USER.id);
    expect(() => assertInside(root, allocation.absolutePath)).not.toThrow();
  });

  it('allocating creates nothing - a rejected upload leaves no directory behind', () => {
    const before = readdirSync(root).sort();
    allocate('cover', 'someone-else-entirely', root);
    expect(readdirSync(root).sort()).toEqual(before);
  });
});
