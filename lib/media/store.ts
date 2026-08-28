/**
 * Where a file goes, and what it is called (SPEC-006).
 *
 * > `public/uploads/<kind>/<userId>/<cuid2>.<ext>` … Filename | Server-generated
 * > cuid2 + `.webp`. The client-supplied filename is discarded entirely (no
 * > path traversal surface).
 *
 * ── "No path traversal surface" is a claim about inputs, not about escaping ─
 * There is a version of this module that accepts the client's filename and
 * carefully sanitises it — strip `..`, strip separators, normalise unicode,
 * reject control characters — and that version is wrong. Not because any single
 * rule is wrong, but because it puts an attacker-controlled string into a path
 * and then has to be right forever, against `..%2f`, against `....//`, against
 * NTFS alternate data streams, against whatever normalisation the next Node
 * version changes.
 *
 * This module never sees the client's filename. `allocate()` takes a kind and a
 * user id and *invents* a name from the CSPRNG. `../../../etc/passwd.png`
 * cannot traverse anything because it is not an input to any path operation —
 * it is discarded at the route boundary and never reaches here. That is why
 * `upload-traversal.test.ts` can assert something stronger than "the name was
 * cleaned": it asserts the stored name has no relationship to the submitted
 * one at all.
 *
 * The user id IS interpolated into the path, so it is the one segment that gets
 * checked — see `assertSafeSegment`. It comes from the session, not the
 * request, so it is not attacker-controlled either; the check is there because
 * "not attacker-controlled" is a property of code somewhere else that could
 * change without this file's author noticing.
 *
 * ── On the 24-character name ───────────────────────────────────────────────
 * SPEC-006's oracle pins the stored filename to `[a-z0-9]{24}` — cuid2's own
 * default length. SPEC-004 pins *database ids* to 26 characters, and
 * `lib/db/ids.ts` implements that. Both are right and they are about different
 * things: a row id and a filename. This module therefore generates its own
 * 24-character name rather than reusing `createId()`, which would produce 26
 * and fail the oracle. The generator below is the same construction — rejection
 * sampling over the platform CSPRNG, no modulo bias — at the length this spec
 * asks for.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UPLOAD_KINDS, UploadRejected, type UploadKind } from './validate';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** SPEC-006's storage table, as a map. `kind` → directory segment. */
export const KIND_DIRECTORY = {
  avatar: 'avatars',
  cover: 'covers',
  inline: 'inline',
} as const satisfies Record<UploadKind, string>;

/** The directory of tracked fixture images that GC must never touch. */
export const SEED_DIRECTORY = 'seed';

/** Stored files are always WebP (SPEC-006's Resize row). */
export const STORED_EXTENSION = '.webp';

/** The length SPEC-006's oracle pins the generated name to. */
export const MEDIA_ID_LENGTH = 24;

/**
 * The public URL prefix. Files live under `public/`, which Next serves at the
 * root, so the on-disk `public/uploads/...` is the served `/uploads/...`.
 */
export const PUBLIC_PREFIX = '/uploads';

/**
 * The shape SPEC-006's oracle matches against, built from the constants above
 * rather than written out, so changing a directory name cannot leave the
 * pattern behind still asserting the old one.
 */
export const STORED_PATH_PATTERN = new RegExp(
  `^${PUBLIC_PREFIX}/(${Object.values(KIND_DIRECTORY).join('|')})/[A-Za-z0-9_-]+/[a-z0-9]{${MEDIA_ID_LENGTH}}\\${STORED_EXTENSION}$`,
);

/**
 * The interface `approach.md` publishes to Profiles and Editor & Content:
 * `StoredImage: { path: '/uploads/<kind>/<userId>/<cuid2>.webp', width, height }`.
 *
 * `path` is the SERVED path, not a filesystem path. Consumers put it straight
 * into `src`, and it is what lands in `User.avatarPath` / `Article.coverPath` /
 * a ProseMirror image node — which is the same string the garbage collector
 * later matches against, so the two halves of this module agree by sharing one
 * definition instead of by convention.
 */
export interface StoredImage {
  path: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/**
 * The uploads root.
 *
 * `TITAN_UPLOADS_ROOT` exists for tests and only for tests: a suite that
 * exercised the real `public/uploads` would leave files in the working tree
 * that `git status` then reports and that the GC test would race against. Every
 * function here takes the root as an argument, so this is only the default.
 *
 * Resolved from `process.cwd()` rather than `import.meta.url` because Next
 * bundles server code and the module's own URL is not a reliable anchor to the
 * project root; the dev server, `next start`, vitest and the scripts all run
 * with the repo root as cwd.
 */
export function uploadsRoot(): string {
  const override = process.env.TITAN_UPLOADS_ROOT;
  if (override && override.length > 0) return resolve(override);
  return join(process.cwd(), 'public', 'uploads');
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A 24-character name over `[a-z0-9]`, drawn from the platform CSPRNG.
 *
 * Rejection sampling, not `byte % 36`. 256 is not a multiple of 36, so the
 * modulo shortcut would make the first four symbols ~14% more likely than the
 * rest. Nothing here is a capability — the containing directory is already
 * per-user and the files are public — but a biased name generator is the kind
 * of thing that gets copied into a context where it does matter.
 */
export function createMediaId(): string {
  const LIMIT = 252; // 36 * 7 — the largest multiple of 36 under 256
  let pool = randomBytes(64);
  let cursor = 0;
  const nextSymbol = (): string => {
    for (;;) {
      if (cursor >= pool.length) {
        pool = randomBytes(64);
        cursor = 0;
      }
      const byte = pool[cursor++] ?? 0;
      if (byte < LIMIT) return ALPHABET[byte % ALPHABET.length] ?? '0';
    }
  };

  let out = '';
  for (let i = 0; i < MEDIA_ID_LENGTH; i++) out += nextSymbol();
  return out;
}

/** True for a name this module would have produced. */
export function isMediaFilename(name: string): boolean {
  return new RegExp(`^[a-z0-9]{${MEDIA_ID_LENGTH}}\\${STORED_EXTENSION}$`).test(name);
}

// ---------------------------------------------------------------------------
// Path allocation
// ---------------------------------------------------------------------------

/**
 * Refuse anything that could mean more than one directory.
 *
 * The allowed shape is deliberately narrower than "no `..`": a segment must be
 * a run of URL-safe characters with no separators, no dots, no NUL, no
 * percent-encoding. A user id from `lib/db/ids.ts` is 26 base-36 characters and
 * passes trivially; the fixtures in the auth tests use `user-1`, which is why
 * `-` and `_` are allowed. Anything else is a bug upstream, and a loud one is
 * better than a file in an unexpected directory.
 */
export function assertSafeSegment(segment: string, label = 'userId'): string {
  if (typeof segment !== 'string' || segment.length === 0 || segment.length > 64) {
    throw new UploadRejected(400, 'bad_owner', `Invalid ${label}.`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new UploadRejected(400, 'bad_owner', `Invalid ${label}.`);
  }
  return segment;
}

export interface Allocation {
  /** The served path — what goes in the database and the JSON response. */
  publicPath: string;
  /** The absolute filesystem path to write. */
  absolutePath: string;
  /** The generated name, without directories. */
  filename: string;
  kind: UploadKind;
  userId: string;
}

/**
 * Choose a destination for one upload.
 *
 * Pure apart from the CSPRNG draw — it creates no directory and writes no file,
 * so a caller that fails validation after allocating has left nothing behind.
 * The containment assertion at the end is belt-and-braces against the segment
 * checks above: if the resolved absolute path is not inside the root, something
 * upstream is wrong in a way that must not be allowed to reach the disk.
 */
export function allocate(
  kind: UploadKind,
  userId: string,
  root: string = uploadsRoot(),
): Allocation {
  if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) {
    throw new UploadRejected(400, 'bad_kind', 'Unknown upload kind.');
  }
  const owner = assertSafeSegment(userId);
  const directory = KIND_DIRECTORY[kind];
  const filename = `${createMediaId()}${STORED_EXTENSION}`;

  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, directory, owner, filename);
  assertInside(absoluteRoot, absolutePath);

  return {
    publicPath: `${PUBLIC_PREFIX}/${directory}/${owner}/${filename}`,
    absolutePath,
    filename,
    kind,
    userId: owner,
  };
}

/** Throw unless `candidate` is inside `root`. The last line of defence. */
export function assertInside(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UploadRejected(400, 'outside_root', 'Refusing to write outside the uploads root.');
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write the processed bytes and return the interface other slices consume.
 *
 * The directory is created on demand rather than at boot: users are created at
 * runtime, so there is no moment at which the full set of per-user directories
 * is known, and a missing directory must not be an error the uploader has to
 * recover from.
 */
export async function storeImage(input: {
  kind: UploadKind;
  userId: string;
  data: Uint8Array;
  width: number;
  height: number;
  root?: string;
}): Promise<StoredImage & { absolutePath: string }> {
  const allocation = allocate(input.kind, input.userId, input.root ?? uploadsRoot());
  await mkdir(join(allocation.absolutePath, '..'), { recursive: true });
  await writeFile(allocation.absolutePath, input.data);
  return {
    path: allocation.publicPath,
    width: input.width,
    height: input.height,
    absolutePath: allocation.absolutePath,
  };
}

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

/**
 * Every file under the uploads root, as served paths, excluding `seed/`.
 *
 * Returning served paths rather than filesystem paths is what lets the caller
 * compare against database columns directly — `User.avatarPath` holds
 * `/uploads/avatars/<id>/<name>.webp`, and no normalisation step stands between
 * the two sides of the comparison where a bug could hide.
 */
export async function listStoredFiles(root: string = uploadsRoot()): Promise<
  Array<{ publicPath: string; absolutePath: string }>
> {
  const absoluteRoot = resolve(root);
  const out: Array<{ publicPath: string; absolutePath: string }> = [];

  const walk = async (directory: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(directory, { encoding: 'utf8' });
    } catch {
      return; // nothing uploaded yet — an empty root is not an error
    }
    for (const entry of entries) {
      const child = join(directory, entry);
      const info = await stat(child).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        await walk(child);
        continue;
      }
      const rel = relative(absoluteRoot, child).split(sep).join('/');
      // SPEC-006: GC deletes files "excluding `seed/`". Tracked fixtures are
      // referenced by nothing in the database by design, so without this line
      // the very first GC run would delete assets that are committed to git.
      if (rel === SEED_DIRECTORY || rel.startsWith(`${SEED_DIRECTORY}/`)) continue;
      out.push({ publicPath: `${PUBLIC_PREFIX}/${rel}`, absolutePath: child });
    }
  };

  await walk(absoluteRoot);
  out.sort((a, b) => (a.publicPath < b.publicPath ? -1 : a.publicPath > b.publicPath ? 1 : 0));
  return out;
}

/**
 * Pull every image reference out of a ProseMirror document.
 *
 * SPEC-006 names "any `image` node in any `Article.bodyJson`" as a reference
 * root, and DEC-002 makes `bodyJson` the canonical body — so this walk is the
 * only thing standing between an author's inline images and the collector.
 * It is deliberately permissive about the document's shape (unknown node types,
 * missing `content`, attrs that are not objects) because a parse failure here
 * would read as "no references found", and "no references found" means *delete*.
 * Anything it cannot understand contributes nothing rather than throwing.
 */
export function collectImageReferences(node: unknown, into: Set<string> = new Set()): Set<string> {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;

    if (record.type === 'image' && record.attrs && typeof record.attrs === 'object') {
      const src = (record.attrs as Record<string, unknown>).src;
      if (typeof src === 'string' && src.length > 0) into.add(normalizeReference(src));
    }
    // Walk children regardless of node type: an image can be nested inside a
    // figure, a blockquote, or a node type this slice has never heard of.
    if (record.content !== undefined) visit(record.content);
    for (const key of ['marks', 'children']) {
      if (record[key] !== undefined) visit(record[key]);
    }
  };
  visit(node);
  return into;
}

/**
 * Reduce a stored reference to the served path this module compares on.
 *
 * A reference may legitimately have arrived as `/uploads/...` (what this module
 * returns), as `public/uploads/...` (what someone typed by hand), or with a
 * query string appended by a cache-buster. All three name the same file, and
 * treating them as different names is the failure mode that matters: an
 * unrecognised reference is an *undercount* of what is in use, and the GC
 * deletes whatever it fails to recognise.
 */
export function normalizeReference(reference: string): string {
  let value = reference.trim().replace(/\\/g, '/');
  const cut = value.search(/[?#]/);
  if (cut !== -1) value = value.slice(0, cut);
  const at = value.indexOf(`${PUBLIC_PREFIX}/`);
  if (at !== -1) return value.slice(at);
  return value;
}

export interface GarbageCollectionResult {
  scanned: number;
  deleted: string[];
  kept: string[];
}

/**
 * Delete every stored file that nothing references.
 *
 * The direction is important and it is the reason `referenced` is a required
 * argument rather than something this function goes and fetches: a collector
 * that computes its own reference set can be wrong in two directions, and only
 * one of them is recoverable. Deleting a referenced file destroys a user's
 * upload permanently; keeping an unreferenced one wastes a few kilobytes until
 * the next run. So the caller assembles the reference set explicitly, and if it
 * cannot — a failed query, a database that will not open — it must not call
 * this at all rather than call it with an empty set.
 */
export async function garbageCollect(input: {
  referenced: Iterable<string>;
  root?: string;
  dryRun?: boolean;
}): Promise<GarbageCollectionResult> {
  const root = input.root ?? uploadsRoot();
  const referenced = new Set<string>();
  for (const reference of input.referenced) {
    if (typeof reference === 'string' && reference.length > 0) {
      referenced.add(normalizeReference(reference));
    }
  }

  const files = await listStoredFiles(root);
  const deleted: string[] = [];
  const kept: string[] = [];

  for (const file of files) {
    if (referenced.has(file.publicPath)) {
      kept.push(file.publicPath);
      continue;
    }
    if (!input.dryRun) await rm(file.absolutePath, { force: true });
    deleted.push(file.publicPath);
  }

  return { scanned: files.length, deleted, kept };
}
