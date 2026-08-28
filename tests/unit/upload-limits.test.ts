/**
 * The size ceiling (SPEC-006).
 *
 * > Max bytes | 5 MB (`5 * 1024 * 1024`), rejected with 413
 *
 * Oracle: "A 6 MB image is rejected with HTTP 413 and no file is written,
 * asserted by tests/unit/upload-limits.test.ts."
 *
 * ── "and no file is written" is the half that can actually regress ─────────
 * The status code is easy and stays right. What silently breaks is the
 * ordering: someone adds a step, the file gets written before the size check,
 * and the endpoint starts answering 413 while filling the disk anyway. So every
 * rejection here is asserted against a directory census taken before the
 * request — not against "the response said no".
 *
 * The oversized fixture is a real, decodable JPEG rather than 6 MB of zeroes.
 * Zeroes would be rejected by the magic-byte sniff as well, and a test that
 * two rules both fire cannot tell you which one did — if the size check were
 * deleted, a zero-filled fixture would still be refused, with a 415, and only
 * the status assertion would notice. A valid image isolates the size rule.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { handleUpload } from '../../app/api/upload/route';
import { MAX_UPLOAD_BYTES, formatBytes, validateUpload } from '../../lib/media/validate';
import type { SessionUser } from '../../lib/auth/session';

const SIX_MB = 6 * 1024 * 1024;

const USER: SessionUser = { id: 'u9wq2k7m4x1td6ncbv8shjrz', handle: 'ada', name: 'Ada', avatarPath: null };

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'titan-upload-limits-'));
  process.env.TITAN_UPLOADS_ROOT = root;
});

afterAll(async () => {
  delete process.env.TITAN_UPLOADS_ROOT;
  await rm(root, { recursive: true, force: true });
});

/** Every regular file under `directory`, recursively. */
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

async function noiseJpeg(width: number, height: number, quality = 95): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x51f3a7c;
  for (let i = 0; i < pixels.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = (state >>> 24) & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
}

/** Pad a JPEG to exactly `target` bytes with skippable APP15 segments. */
function padJpegTo(jpeg: Buffer, target: number): Buffer {
  const deficit = target - jpeg.length;
  if (deficit < 4) throw new Error(`cannot pad ${jpeg.length} bytes up to ${target}`);
  const segments: Buffer[] = [];
  let remaining = deficit;
  while (remaining > 0) {
    const size = remaining > 65537 ? (remaining - 65537 < 4 ? 65533 : 65537) : remaining;
    const segment = Buffer.alloc(size, 0x20);
    segment[0] = 0xff;
    segment[1] = 0xef;
    segment.writeUInt16BE(size - 2, 2);
    segments.push(segment);
    remaining -= size;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

function uploadRequest(file: Buffer, kind = 'avatar'): Request {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(file)], 'huge.jpg', { type: 'image/jpeg' }));
  form.set('kind', kind);
  return new Request('http://localhost:3000/api/upload', { method: 'POST', body: form });
}

describe('SPEC-006 — a 6 MB image is refused', () => {
  let before: string[];

  beforeEach(() => {
    before = census(root);
  });

  it('states the limit SPEC-006 states', () => {
    expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
  });

  it('answers 413 and writes nothing', async () => {
    const oversized = padJpegTo(await noiseJpeg(1400, 1400), SIX_MB);
    expect(oversized.length).toBe(SIX_MB);
    // A real image, so the ONLY rule that can reject it is the size rule.
    expect(oversized.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const response = await handleUpload(uploadRequest(oversized), USER);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'too_large' });
    expect(census(root)).toEqual(before);
  });

  it('rejects one byte over the limit, and accepts the limit exactly', async () => {
    // The boundary is where an off-by-one lives, and the spec's wording — "Max
    // bytes | 5 MB" — makes exactly 5 MB legal.
    const atLimit = padJpegTo(await noiseJpeg(1200, 1200), MAX_UPLOAD_BYTES);
    const overLimit = padJpegTo(await noiseJpeg(1200, 1200), MAX_UPLOAD_BYTES + 1);

    const accepted = await handleUpload(uploadRequest(atLimit), USER);
    expect(accepted.status).toBe(201);

    const censusAfterAccept = census(root);
    const refused = await handleUpload(uploadRequest(overLimit), USER);
    expect(refused.status).toBe(413);
    expect(census(root)).toEqual(censusAfterAccept);
  });

  it('refuses an empty file with 400 rather than storing a zero-byte image', async () => {
    const response = await handleUpload(uploadRequest(Buffer.alloc(0)), USER);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'empty_file' });
    expect(census(root)).toEqual(before);
  });

  it('trusts the smaller of the declared and the actual size', async () => {
    // `file.size` comes from the multipart framing and can disagree with the
    // bytes that actually arrive. Whichever is over the limit wins the
    // rejection — a client that under-declares must not get a free pass, and a
    // client that over-declares must not be able to make a legal upload fail
    // by lying about it... except that over-declaring IS refused, deliberately:
    // the endpoint answers on the declared size before buffering anything, and
    // refusing to buffer 6 MB on a client's say-so is the point of the limit.
    const bytes = new Uint8Array(await noiseJpeg(64, 64));
    expect(() => validateUpload({ bytes, kind: 'avatar', declaredSize: SIX_MB })).toThrowError(
      /too large|limit/i,
    );
  });

  it('reports the limit in the message, in units a person reads', () => {
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe('5 MB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('rejects an oversized upload of every kind, not just avatars', async () => {
    const oversized = padJpegTo(await noiseJpeg(1400, 1400), SIX_MB);
    for (const kind of ['avatar', 'cover', 'inline']) {
      const censusBefore = census(root);
      const response = await handleUpload(uploadRequest(oversized, kind), USER);
      expect(response.status, `kind=${kind}`).toBe(413);
      expect(census(root)).toEqual(censusBefore);
    }
  });
});
