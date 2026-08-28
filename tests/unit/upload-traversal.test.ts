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
 *
 * -- Why the substring assertions are gone (TASK-027) ------------------------
 * This file used to spell "the submitted name did not survive" as
 * `expect(stored.path).not.toContain('etc')`. That is a coincidence, not a
 * property: the stored name is 24 random symbols over `[a-z0-9]`, so a CORRECT
 * server produces one containing `etc` about once in 2100 runs (22 positions x
 * 36^-3), and the suite goes red having caught nothing. Worse than the noise --
 * `npm test` is `vitest && playwright`, so a unit flake here short-circuits the
 * entire e2e half and reads as a media-slice failure of whatever diff was being
 * gated.
 *
 * The replacement is `expectTraversalSafe` below, which asserts what traversal
 * actually means: (a) the served path is the shape SPEC-006 pins, (b) the
 * stored name is a single segment with no separator and no dot-segment, (c) no
 * dot-segment survives anywhere along the served path, and (d) -- the clause
 * that decides whether a byte can land outside the tree -- the path RESOLVED
 * against the uploads root is still under that root. No clause can be satisfied
 * or broken by a lucky draw from the name generator.
 *
 * Every clause is proved capable of failing (DEC-015) in the last describe
 * block: the same function is run against paths violating one clause each, and
 * a file is dropped where an escape would land to show the on-disk census
 * rejects it. An assertion never observed to reject anything is a comment.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';

import { handleUpload } from '../../app/api/upload/route';
import {
  MEDIA_ID_LENGTH,
  PUBLIC_PREFIX,
  STORED_EXTENSION,
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

/** The two things a path segment must not contain if it is to mean one place. */
const SEPARATOR = /[\\/]/;
const DOT_SEGMENT = /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/;

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

/**
 * What the wrapper directory holds. A traversal that escaped `root` lands here,
 * so this list IS the census assertion -- shared between the test that asserts
 * it and the proof that the assertion can fail.
 */
function wrapperEntries(): string[] {
  return readdirSync(wrapper).sort();
}

/** The served path, mapped back to the filesystem path it names. */
function diskPathFor(publicPath: string): string {
  const withinRoot = publicPath.startsWith(`${PUBLIC_PREFIX}/`)
    ? publicPath.slice(PUBLIC_PREFIX.length + 1)
    : publicPath;
  // `resolve` collapses `..` exactly the way every downstream consumer does,
  // which is the point: the question is where the path ENDS UP, not how it is
  // spelled.
  return resolve(root, withinRoot);
}

/**
 * The traversal property, in one place.
 *
 * Run against every path this suite gets back from the route, and -- in the
 * can-fail block below -- against paths that break exactly one clause each,
 * which is what makes these clauses evidence rather than decoration.
 */
function expectTraversalSafe(publicPath: string, owner: string = USER.id): void {
  // (a) The shape SPEC-006's oracle pins: kind directory, the uploader's own
  //     directory, a generated name, `.webp`. The client's stem and the
  //     client's extension are both structurally excluded -- nothing of the
  //     submitted name can appear except by being drawn from the CSPRNG.
  expect(publicPath).toMatch(
    new RegExp(
      `^${PUBLIC_PREFIX}/avatars/${owner}/[a-z0-9]{${MEDIA_ID_LENGTH}}\\${STORED_EXTENSION}$`,
    ),
  );

  // (b) The stored name is ONE segment: no separator, no `.`/`..`, and a name
  //     the generator itself recognises.
  const name = publicPath.slice(publicPath.lastIndexOf('/') + 1);
  expect(SEPARATOR.test(name), `separator in stored name: ${name}`).toBe(false);
  expect(DOT_SEGMENT.test(name), `dot-segment in stored name: ${name}`).toBe(false);
  expect(isMediaFilename(name), `not a generated name: ${name}`).toBe(true);

  // (c) Nothing anywhere along the served path can climb: no `.` or `..`
  //     segment is left for a later consumer to collapse.
  expect(DOT_SEGMENT.test(publicPath), `dot-segment in served path: ${publicPath}`).toBe(false);

  // (d) The clause that decides whether a byte can land outside the tree:
  //     resolved against the uploads root, the path is still under the root.
  //     This is the module's own last line of defence (`assertInside`), re-run
  //     against the value the route handed back.
  const absolute = diskPathFor(publicPath);
  expect(() => assertInside(root, absolute), `escapes the root: ${absolute}`).not.toThrow();
  expect(absolute.startsWith(root + sep), `outside the root: ${absolute}`).toBe(true);
}

/**
 * Whether `expectTraversalSafe` REJECTS a path.
 *
 * `expect` throws on failure, so catching is how a test asserts that an
 * assertion is capable of failing -- the proof DEC-015 asks for. Nothing else
 * distinguishes a property that holds from one that cannot be violated.
 */
function violatesTraversalSafety(publicPath: string, owner?: string): boolean {
  try {
    expectTraversalSafe(publicPath, owner);
    return false;
  } catch {
    return true;
  }
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

  it('stores under a server-generated name that resolves inside the uploads root', () => {
    expectTraversalSafe(stored.path);
    // ...and the file the served path names is really there, inside the root.
    const absolute = diskPathFor(stored.path);
    expect(existsSync(absolute), absolute).toBe(true);
    expect(statSync(absolute).isFile(), absolute).toBe(true);
  });

  it('invents the name, so it cannot be a function of the submitted one', async () => {
    // The old spelling of this test asked whether the stored path CONTAINED
    // fragments of the hostile name, which a correct server fails by chance
    // (see the header). The property underneath it is that the name does not
    // depend on the input at all -- so submit the identical hostile filename
    // repeatedly and require the results to differ. A server that derived the
    // name from `file.name`, however carefully it sanitised, returns the same
    // path every time.
    const paths = new Set<string>([stored.path]);
    for (let i = 0; i < 3; i++) {
      const response = await handleUpload(upload(await tinyPng(), HOSTILE_NAME), USER);
      expect(response.status).toBe(201);
      const body = (await response.json()) as { path: string };
      expectTraversalSafe(body.path);
      paths.add(body.path);
    }
    expect(paths.size).toBe(4);
  });

  it('lands inside the uploading user own directory', () => {
    expect(stored.path.startsWith(`${PUBLIC_PREFIX}/avatars/${USER.id}/`)).toBe(true);
  });

  it('writes no file outside the uploads root', () => {
    // The canary is still alone in the wrapper; everything else is under
    // `uploads/`.
    expect(wrapperEntries()).toEqual(['CANARY', 'uploads']);
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
      expectTraversalSafe(body.path);
    }
    expect(wrapperEntries()).toEqual(['CANARY', 'uploads']);
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
    expect(wrapperEntries()).toEqual(['CANARY', 'uploads']);
  });
});

describe('SPEC-006 - the name generator', () => {
  it('produces exactly the shape the oracle matches', () => {
    for (let i = 0; i < 200; i++) {
      const id = createMediaId();
      expect(id).toMatch(new RegExp(`^[a-z0-9]{${MEDIA_ID_LENGTH}}$`));
      expect(isMediaFilename(`${id}${STORED_EXTENSION}`)).toBe(true);
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
    expect(allocation.filename.endsWith(STORED_EXTENSION)).toBe(true);
    expect(allocation.publicPath.endsWith(STORED_EXTENSION)).toBe(true);
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

describe('SPEC-006 - the traversal assertions are proved able to fail (DEC-015)', () => {
  // A generated-shape name, so each mutant below differs from a legitimate
  // path in exactly ONE respect: the clause it exists to violate.
  const NAME = `${'a'.repeat(MEDIA_ID_LENGTH)}${STORED_EXTENSION}`;
  const OWNED = `${PUBLIC_PREFIX}/avatars/${USER.id}`;

  const MUTANTS: Array<[clause: string, path: string]> = [
    ['(d) climbs out of the uploads root', `${OWNED}/../../../etc/passwd.png`],
    ['(c) a dot-segment that still resolves inside', `${OWNED}/../${NAME}`],
    ['(c) a single-dot segment', `${OWNED}/./${NAME}`],
    ['(b) a separator smuggled into the stored name', `${OWNED}/nested/${NAME}`],
    ['(b) a backslash climb in the stored name', `${OWNED}/..\\..\\${NAME}`],
    ['(a) the client extension survived', `${OWNED}/${'a'.repeat(MEDIA_ID_LENGTH)}.png`],
    ['(a) the client stem survived', `${OWNED}/passwd${STORED_EXTENSION}`],
    ['(a) the generated name is the wrong length', `${OWNED}/${'a'.repeat(23)}${STORED_EXTENSION}`],
    ['(a) another user directory', `${PUBLIC_PREFIX}/avatars/someone-else/${NAME}`],
    ['(a) the wrong kind directory', `${PUBLIC_PREFIX}/inline/${USER.id}/${NAME}`],
    ['(a) not under the uploads prefix at all', `/etc/passwd${STORED_EXTENSION}`],
  ];

  it('passes the positive control, so the rejections below are not accidents', () => {
    expect(violatesTraversalSafety(`${OWNED}/${NAME}`)).toBe(false);
  });

  it.each(MUTANTS)('rejects %s', (_clause, path) => {
    expect(violatesTraversalSafety(path), path).toBe(true);
  });

  it('the wrapper census notices a file that escaped the uploads root', async () => {
    // The census assertions prove an absence, which is exactly the kind of
    // assertion that keeps passing after it has stopped being able to fail.
    // Put a file where an escape would land and watch the same expression
    // reject it.
    expect(wrapperEntries()).toEqual(['CANARY', 'uploads']);
    const escapee = join(wrapper, 'ESCAPED.webp');
    await writeFile(escapee, 'pretend a traversal succeeded\n');
    try {
      expect(wrapperEntries()).not.toEqual(['CANARY', 'uploads']);
      expect(wrapperEntries()).toEqual(['CANARY', 'ESCAPED.webp', 'uploads']);
    } finally {
      await rm(escapee, { force: true });
    }
    expect(wrapperEntries()).toEqual(['CANARY', 'uploads']);
  });
});
