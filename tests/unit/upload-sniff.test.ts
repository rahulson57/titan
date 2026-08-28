/**
 * The client's word is never taken for anything (SPEC-006).
 *
 * > Accepted types | `image/jpeg`, `image/png`, `image/webp`, `image/avif` —
 * > determined by **magic bytes**, not the `Content-Type` header or file
 * > extension
 * > Rejected | SVG (script vector), GIF, anything failing magic-byte sniff → 415
 *
 * Oracles:
 *  - "A file whose bytes are a PDF but whose `Content-Type` header says
 *    `image/png` is rejected with HTTP 415 and no file is written."
 *  - "An SVG upload is rejected with HTTP 415."
 *
 * ── The PDF case is a test of precedence, not of PDF detection ─────────────
 * Three signals describe an upload's type: the bytes, the `Content-Type` on the
 * multipart part, and the filename extension. Two of them are strings the
 * client typed. The fixture below makes all three disagree deliberately — PDF
 * bytes, `image/png` header, `.png` name — so a handler that consults either of
 * the attacker-controlled signals accepts it and this suite fails. Detecting
 * that the bytes are a PDF is incidental; what is being pinned is which of the
 * three signals wins.
 *
 * ── Why SVG gets its own case ─────────────────────────────────────────────
 * SVG has no magic number — it is XML — so it is the one rejected format that
 * cannot be caught by a signature table, and therefore the one most likely to
 * slip through a refactor of the sniffer. It also has the worst consequence if
 * it does: files are served from `public/` on our own origin, so a stored SVG
 * carrying `<script>` is a stored same-origin XSS, and sharp *can* rasterise
 * SVG when built against librsvg — meaning a missing SVG rule fails open, not
 * closed. The variants below (BOM, XML prolog, DOCTYPE, leading comment) are
 * the shapes a real file takes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { handleUpload } from '../../app/api/upload/route';
import { looksLikeSvg, sniffImageType } from '../../lib/media/validate';
import type { SessionUser } from '../../lib/auth/session';

const USER: SessionUser = { id: 'u2np8v5k1q7wxr4mtcdhz3jb', handle: 'ada', name: 'Ada', avatarPath: null };

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'titan-upload-sniff-'));
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

function upload(bytes: Buffer | string, name: string, type: string, kind = 'inline'): Request {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buffer)], name, { type }));
  form.set('kind', kind);
  return new Request('http://localhost:3000/api/upload', { method: 'POST', body: form });
}

async function noiseImage(
  format: 'jpeg' | 'png' | 'webp',
  width = 64,
  height = 64,
): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x1a2b3c4;
  for (let i = 0; i < pixels.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = (state >>> 24) & 0xff;
  }
  const pipeline = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (format === 'jpeg') return pipeline.jpeg().toBuffer();
  if (format === 'png') return pipeline.png().toBuffer();
  return pipeline.webp().toBuffer();
}

/** A minimal but genuinely well-formed PDF. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <rect width="64" height="64" fill="#1a8917"/>
  <script>fetch('/api/upload')</script>
</svg>`;

describe('SPEC-006 — a PDF wearing a PNG label is refused', () => {
  let before: string[];
  beforeEach(() => {
    before = census(root);
  });

  it('answers 415 and writes nothing, despite the header and the extension', async () => {
    const response = await handleUpload(upload(PDF, 'avatar.png', 'image/png'), USER);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'unsupported_type' });
    expect(census(root)).toEqual(before);
  });

  it('says so in a way that names the real type, not the claimed one', async () => {
    const response = await handleUpload(upload(PDF, 'avatar.png', 'image/png'), USER);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('application/pdf');
  });

  it('the same trick with a JPEG label fails identically', async () => {
    const response = await handleUpload(upload(PDF, 'photo.jpg', 'image/jpeg'), USER);
    expect(response.status).toBe(415);
    expect(census(root)).toEqual(before);
  });

  it('and an honest PNG whose header LIES the other way is still accepted', async () => {
    // The mirror image of the attack: real PNG bytes, a nonsense declared type.
    // The header is not consulted in either direction — an upload is judged
    // only on what it is.
    const png = await noiseImage('png');
    const response = await handleUpload(upload(png, 'x.bin', 'application/octet-stream'), USER);
    expect(response.status).toBe(201);
  });
});

describe('SPEC-006 — SVG is refused outright', () => {
  let before: string[];
  beforeEach(() => {
    before = census(root);
  });

  it('answers 415 and writes nothing', async () => {
    const response = await handleUpload(upload(SVG, 'logo.svg', 'image/svg+xml'), USER);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'unsupported_type' });
    expect(census(root)).toEqual(before);
  });

  it('is refused however it is dressed up', async () => {
    const disguises: Array<[string, string, string]> = [
      ['logo.png', 'image/png', SVG],
      ['logo.jpg', 'image/jpeg', SVG],
      ['logo.svg', 'image/svg+xml', `﻿${SVG}`],
      ['logo.svg', 'image/svg+xml', `<?xml version="1.0"?>\n${SVG}`],
      ['logo.svg', 'image/svg+xml', `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n${SVG}`],
      ['logo.svg', 'image/svg+xml', `<!-- a comment -->\n${SVG}`],
      ['logo.svg', 'image/svg+xml', `\n\n   ${SVG}`],
    ];
    for (const [name, type, body] of disguises) {
      const response = await handleUpload(upload(body, name, type), USER);
      expect(response.status, `${name} / ${type}`).toBe(415);
    }
    expect(census(root)).toEqual(before);
  });

  it('recognises each of those shapes at the sniffer level too', () => {
    const svg = (text: string) => Buffer.from(text, 'utf8');
    expect(looksLikeSvg(svg(SVG))).toBe(true);
    expect(looksLikeSvg(svg(`﻿${SVG}`))).toBe(true);
    expect(looksLikeSvg(svg(`<?xml version="1.0"?>${SVG}`))).toBe(true);
    expect(looksLikeSvg(svg('<!DOCTYPE svg><svg/>'))).toBe(true);
    expect(looksLikeSvg(svg('<!-- hi --><svg/>'))).toBe(true);
    // Not everything with angle brackets is an SVG.
    expect(looksLikeSvg(svg('<html><body>hello</body></html>'))).toBe(false);
    expect(looksLikeSvg(svg('plain text'))).toBe(false);
  });
});

describe('SPEC-006 — GIF and other unlisted formats are refused', () => {
  it('rejects a GIF with 415', async () => {
    // GIF89a header + minimal logical screen descriptor.
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
    ]);
    const response = await handleUpload(upload(gif, 'anim.gif', 'image/gif'), USER);
    expect(response.status).toBe(415);
  });

  it('rejects bytes that are no format at all', async () => {
    const response = await handleUpload(
      upload(Buffer.from('not an image, just words'), 'x.png', 'image/png'),
      USER,
    );
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not an image/i);
  });
});

describe('SPEC-006 — bytes that pass the sniff but will not decode', () => {
  it('answers 415, not 500, for a truncated image', async () => {
    // The gap between "these bytes start like a JPEG" and "these bytes are a
    // JPEG" is real: a signature check is eight bytes and a decoder reads the
    // whole file. A truncated upload therefore gets past the sniffer and dies
    // inside sharp. From the caller's side that is still "your file is not
    // usable", so it is a 415 — a 500 would read as "our fault" and would page
    // someone at 3am for a partial upload.
    const whole = await noiseImage('jpeg', 200, 200);
    const truncated = whole.subarray(0, Math.floor(whole.length / 3));
    expect(sniffImageType(truncated)).toBe('image/jpeg');

    const response = await handleUpload(upload(truncated, 'half.jpg', 'image/jpeg'), USER);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'undecodable' });
  });

  it('answers 415 for a PNG header glued to nothing', async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0),
    ]);
    expect(sniffImageType(fake)).toBe('image/png');
    const response = await handleUpload(upload(fake, 'x.png', 'image/png'), USER);
    expect(response.status).toBe(415);
  });
});

describe('SPEC-006 — the sniffer names each format from its bytes', () => {
  it('recognises the four accepted formats', async () => {
    expect(sniffImageType(await noiseImage('jpeg'))).toBe('image/jpeg');
    expect(sniffImageType(await noiseImage('png'))).toBe('image/png');
    expect(sniffImageType(await noiseImage('webp'))).toBe('image/webp');
    // AVIF by its ISO-BMFF brand. Encoding a real AVIF costs seconds of CPU
    // and depends on the libheif in this sharp build, so the container header
    // is constructed directly — it is exactly what the sniffer reads.
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from('ftypavif', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('avifmif1miaf', 'latin1'),
    ]);
    expect(sniffImageType(avif)).toBe('image/avif');
  });

  it('recognises an AVIF declared only in its compatible brands', () => {
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from('ftypmif1', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mif1avif', 'latin1'),
    ]);
    expect(sniffImageType(avif)).toBe('image/avif');
  });

  it('does not mistake other ISO-BMFF files for AVIF', () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('isomiso2', 'latin1'),
    ]);
    expect(sniffImageType(mp4)).toBeNull();
  });

  it('does not mistake a RIFF container that is not WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0, 0, 0]),
      Buffer.from('WAVEfmt ', 'latin1'),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it('names the rejected formats rather than shrugging at them', () => {
    expect(sniffImageType(Buffer.from('GIF87a'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toBe('image/bmp');
    expect(sniffImageType(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('image/tiff');
    expect(sniffImageType(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe('image/tiff');
    expect(sniffImageType(PDF)).toBe('application/pdf');
  });

  it('returns null rather than guessing on short or empty input', () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff]))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});
