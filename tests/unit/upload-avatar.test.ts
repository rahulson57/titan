/**
 * The happy path, end to end (SPEC-006).
 *
 * Oracle: "Uploading a 2 MB JPEG as `kind=avatar` returns 201 with a path
 * matching `^/uploads/avatars/<userId>/[a-z0-9]{24}\.webp$` and the file exists
 * on disk at 400×400, asserted by tests/unit/upload-avatar.test.ts."
 *
 * ── This suite drives the real route handler ──────────────────────────────
 * `handleUpload` is the function `POST` delegates to, with the session passed
 * in rather than resolved from `next/headers` (see the header comment in
 * `app/api/upload/route.ts` for why). Everything else is real: a real
 * `FormData`, a real multipart `Request`, real sharp, real files on a real
 * temporary directory. Nothing here is mocked, so a regression anywhere in
 * validate → process → store surfaces as a failure here.
 *
 * ── About the 2 MB ────────────────────────────────────────────────────────
 * The oracle says "a 2 MB JPEG", and 2 MB is not incidental — it is comfortably
 * over any buffering threshold and comfortably under the 5 MB limit, so this
 * test proves the pipeline handles a realistically large photo rather than a
 * toy. Getting an EXACT size out of a lossy encoder is not possible by tuning
 * quality, so the fixture is padded to the byte with APP15 segments — an
 * application-specific JPEG marker that every decoder skips. The result is a
 * genuinely valid 2,097,152-byte JPEG rather than an approximation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { handleUpload } from '../../app/api/upload/route';
import { MEDIA_ID_LENGTH } from '../../lib/media/store';
import type { SessionUser } from '../../lib/auth/session';

const TWO_MB = 2 * 1024 * 1024;

const USER: SessionUser = {
  id: 'ux4k2m9v7p1qb3ncd8trwzhy',
  handle: 'ada',
  name: 'Ada',
  avatarPath: null,
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'titan-upload-avatar-'));
  process.env.TITAN_UPLOADS_ROOT = root;
});

afterAll(async () => {
  delete process.env.TITAN_UPLOADS_ROOT;
  await rm(root, { recursive: true, force: true });
});

/**
 * A JPEG of incompressible noise. Noise, not a gradient, because a gradient
 * encodes to a few kilobytes at any dimension and the padding below would then
 * be most of the file — this way the bytes the decoder actually works on are
 * representative of a photograph.
 */
async function noiseJpeg(width: number, height: number, quality = 92): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  // A fixed LCG rather than randomBytes: a deterministic fixture makes a
  // failure reproducible from the file alone.
  let state = 0x2f6e2b1;
  for (let i = 0; i < pixels.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = (state >>> 24) & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality, mozjpeg: false })
    .toBuffer();
}

/**
 * Grow a JPEG to exactly `target` bytes by inserting APP15 segments after SOI.
 *
 * APP15 (0xFFEF) is reserved for application use and carries no meaning to a
 * decoder, so libjpeg skips it — the image decodes identically. Each segment is
 * `FF EF <2-byte length> <payload>`, where the length includes its own two
 * bytes, giving a minimum segment cost of 4 bytes and a maximum of 65,537.
 */
function padJpegTo(jpeg: Buffer, target: number): Buffer {
  const deficit = target - jpeg.length;
  if (deficit < 4) {
    throw new Error(`cannot pad a ${jpeg.length}-byte JPEG up to ${target} bytes`);
  }
  const segments: Buffer[] = [];
  let remaining = deficit;
  while (remaining > 0) {
    // Never leave a remainder smaller than the 4-byte minimum segment.
    const size = remaining > 65537 ? (remaining - 65537 < 4 ? 65533 : 65537) : remaining;
    const length = size - 2; // the length field counts itself
    const segment = Buffer.alloc(size, 0x20);
    segment[0] = 0xff;
    segment[1] = 0xef;
    segment.writeUInt16BE(length, 2);
    segments.push(segment);
    remaining -= size;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

function uploadRequest(file: Buffer, fields: Record<string, string>): Request {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(file)], 'portrait.jpg', { type: 'image/jpeg' }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request('http://localhost:3000/api/upload', { method: 'POST', body: form });
}

describe('SPEC-006 — uploading a 2 MB JPEG as an avatar', () => {
  let body: { path: string; width: number; height: number };
  let status: number;
  let source: Buffer;

  beforeAll(async () => {
    source = padJpegTo(await noiseJpeg(900, 1200), TWO_MB);
    const response = await handleUpload(uploadRequest(source, { kind: 'avatar' }), USER);
    status = response.status;
    body = (await response.json()) as typeof body;
  });

  it('the fixture really is a 2 MB JPEG, so the test is what it claims', () => {
    expect(source.length).toBe(TWO_MB);
    expect(source.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('answers 201', () => {
    expect(status).toBe(201);
  });

  it('returns a path matching the shape SPEC-006 pins', () => {
    const pattern = new RegExp(`^/uploads/avatars/${USER.id}/[a-z0-9]{${MEDIA_ID_LENGTH}}\\.webp$`);
    expect(body.path).toMatch(pattern);
  });

  it('returns the stored dimensions alongside the path', () => {
    // The `StoredImage` interface `approach.md` publishes to Profiles and
    // Editor & Content is `{ path, width, height }` — a consumer that has to
    // fetch the file to learn its size cannot lay out around it without a
    // reflow.
    expect(body).toEqual({ path: body.path, width: 400, height: 400 });
  });

  it('writes the file to disk under the session user’s own directory', async () => {
    const onDisk = join(root, body.path.replace('/uploads/', ''));
    const info = await stat(onDisk);
    expect(info.isFile()).toBe(true);
    expect(info.size).toBeGreaterThan(0);
  });

  it('stores a 400×400 WebP, whatever the source aspect ratio was', async () => {
    // The source is 900x1200 — portrait. SPEC-006 says avatars are a
    // cover-crop, so the stored file must be square, not letterboxed and not
    // squashed.
    const onDisk = join(root, body.path.replace('/uploads/', ''));
    const metadata = await sharp(await readFile(onDisk)).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(400);
  });

  it('stores far fewer bytes than it received', async () => {
    // Not a performance assertion — a proof that the stored file is a NEW
    // encoding rather than the upload passed through. A 2 MB input that lands
    // as a 2 MB file would mean the re-encode did not happen, and with it the
    // EXIF-stripping guarantee would be gone too.
    const onDisk = join(root, body.path.replace('/uploads/', ''));
    const info = await stat(onDisk);
    expect(info.size).toBeLessThan(source.length / 4);
  });

  it('enlarges a small source rather than storing it undersized', async () => {
    // SPEC-006's oracle says the stored avatar is 400x400 with no qualifier, so
    // a 120x120 upload must still come out 400x400 — a smaller file in a
    // 400x400 slot is a broken layout, and "max 400" is what the COVER and
    // INLINE kinds say, not this one.
    const small = await noiseJpeg(120, 120);
    const response = await handleUpload(uploadRequest(small, { kind: 'avatar' }), USER);
    expect(response.status).toBe(201);
    const result = (await response.json()) as { path: string; width: number; height: number };
    expect([result.width, result.height]).toEqual([400, 400]);
  });

  it('gives two uploads two different names', async () => {
    // The name is drawn from the CSPRNG per upload, so re-uploading an avatar
    // cannot silently overwrite the previous one — which matters because the
    // old path may still be sitting in a rendered page or a database row until
    // the profile write lands.
    const again = await handleUpload(
      uploadRequest(await noiseJpeg(500, 500), { kind: 'avatar' }),
      USER,
    );
    const other = (await again.json()) as { path: string };
    expect(other.path).not.toBe(body.path);
  });

  it('rejects an anonymous upload with 401, before reading the body', async () => {
    const response = await handleUpload(uploadRequest(source, { kind: 'avatar' }), null);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects an unknown `kind` with 400', async () => {
    const response = await handleUpload(
      uploadRequest(await noiseJpeg(200, 200), { kind: 'banner' }),
      USER,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'bad_kind' });
  });

  it('rejects a request with no file part with 400', async () => {
    const form = new FormData();
    form.set('kind', 'avatar');
    const response = await handleUpload(
      new Request('http://localhost:3000/api/upload', { method: 'POST', body: form }),
      USER,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'missing_file' });
  });
});

describe('SPEC-006 — cover and inline kinds resize to their own ceilings', () => {
  it('caps a cover at 1600 wide and preserves its aspect ratio', async () => {
    const response = await handleUpload(
      uploadRequest(await noiseJpeg(2400, 1350), { kind: 'cover' }),
      USER,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string; width: number; height: number };
    expect(body.path).toMatch(/^\/uploads\/covers\//);
    expect(body.width).toBe(1600);
    expect(body.height).toBe(900); // 2400x1350 is 16:9; 1600 wide keeps it
  });

  it('caps an inline image at 1400 wide', async () => {
    const response = await handleUpload(
      uploadRequest(await noiseJpeg(2000, 1000), { kind: 'inline' }),
      USER,
    );
    const body = (await response.json()) as { path: string; width: number };
    expect(body.path).toMatch(/^\/uploads\/inline\//);
    expect(body.width).toBe(1400);
  });

  it('leaves a cover smaller than the ceiling alone rather than upscaling it', async () => {
    // "max 1600w" is a maximum, not a target. Upscaling would invent detail and
    // cost bytes on every page load for a worse-looking image.
    const response = await handleUpload(
      uploadRequest(await noiseJpeg(800, 450), { kind: 'cover' }),
      USER,
    );
    const body = (await response.json()) as { width: number; height: number };
    expect(body.width).toBe(800);
    expect(body.height).toBe(450);
  });
});
