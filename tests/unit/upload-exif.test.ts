/**
 * The photograph arrives carrying its coordinates; the stored file does not
 * (SPEC-006).
 *
 * > Always re-encoded to WebP q80 - re-encoding strips EXIF including GPS.
 *
 * Oracle: "An uploaded JPEG carrying GPS EXIF produces a stored WebP whose
 * metadata contains no `GPSLatitude` tag, asserted by
 * tests/unit/upload-exif.test.ts."
 *
 * -- Why this is worth a whole suite ----------------------------------------
 * This is the only rule in SPEC-006 whose violation is invisible. An oversized
 * upload that slips through fills a disk; an SVG that slips through eventually
 * fires an alert. A stored GPS tag looks exactly like a correct file, renders
 * identically, and quietly publishes the street a user's avatar was taken on -
 * to anyone who downloads it and runs `exiftool`. Nothing in the product will
 * ever surface it, so a test is the only thing that can.
 *
 * -- The fixture has to be real -------------------------------------------
 * A test that asserts "the output has no GPS" against an input that never had
 * any passes forever while proving nothing, and that is the easy mistake here.
 * So the first assertion below parses the SOURCE JPEG's EXIF and proves that
 * `GPSLatitude` (tag 0x0002 inside the GPS IFD reached through tag 0x8825) is
 * genuinely present. Only then does the absence downstream mean anything.
 *
 * -- Reading EXIF without adding a dependency ------------------------------
 * The tag walker below is about forty lines of TIFF: a byte-order mark, a
 * directory of 12-byte entries, and a pointer to the GPS sub-directory. Writing
 * it here rather than pulling in `exifr` keeps the assertion honest in a
 * specific way - it names the actual tag number the criterion names, instead of
 * trusting a library's mapping from a friendly name to a number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { handleUpload } from '../../app/api/upload/route';
import { describeImage, processImage } from '../../lib/media/process';
import type { SessionUser } from '../../lib/auth/session';

/** EXIF tag numbers, from the TIFF/EXIF specification. */
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE = 0x0004;

const USER: SessionUser = {
  id: 'ue3k9m2q7v4xnpr1tzcwhjd8',
  handle: 'ada',
  name: 'Ada',
  avatarPath: null,
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'titan-upload-exif-'));
  process.env.TITAN_UPLOADS_ROOT = root;
});

afterAll(async () => {
  delete process.env.TITAN_UPLOADS_ROOT;
  await rm(root, { recursive: true, force: true });
});

/**
 * Walk a TIFF/EXIF blob and return the tag numbers present in each directory.
 *
 * Returns an empty result rather than throwing on anything malformed: a
 * successful parse is the interesting outcome for the SOURCE assertion, and for
 * the OUTPUT assertion "there was nothing parseable" is already the answer the
 * criterion wants.
 */
function readExifTags(blob: Uint8Array | undefined): {
  ifd0: number[];
  exif: number[];
  gps: number[];
} {
  const empty = { ifd0: [], exif: [], gps: [] };
  if (!blob || blob.length < 8) return empty;

  const buffer = Buffer.from(blob);
  // sharp hands back the JPEG APP1 payload, which begins with the `Exif\0\0`
  // identifier before the TIFF header. WebP's EXIF chunk has no such prefix.
  const base = buffer.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0;
  if (buffer.length < base + 8) return empty;

  const order = buffer.subarray(base, base + 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return empty;
  const little = order === 'II';
  const u16 = (at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
  const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));

  if (u16(base + 2) !== 42) return empty;

  const directory = (offset: number): Array<{ tag: number; value: number }> => {
    const at = base + offset;
    if (at + 2 > buffer.length) return [];
    const count = u16(at);
    const entries: Array<{ tag: number; value: number }> = [];
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > buffer.length) break;
      entries.push({ tag: u16(entry), value: u32(entry + 8) });
    }
    return entries;
  };

  const ifd0 = directory(u32(base + 4));
  const pointer = (tag: number) => ifd0.find((entry) => entry.tag === tag)?.value;
  const gpsOffset = pointer(TAG_GPS_IFD_POINTER);
  const exifOffset = pointer(TAG_EXIF_IFD_POINTER);

  return {
    ifd0: ifd0.map((entry) => entry.tag),
    exif: exifOffset === undefined ? [] : directory(exifOffset).map((entry) => entry.tag),
    gps: gpsOffset === undefined ? [] : directory(gpsOffset).map((entry) => entry.tag),
  };
}

/**
 * A JPEG carrying GPS coordinates, a camera make/model and an orientation tag.
 *
 * The coordinates are 51 deg 30' N, 0 deg 7' W - the Greenwich meridian, chosen
 * because it is a landmark rather than anyone's house.
 */
async function jpegWithGps(orientation = 1): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(240 * 320 * 3);
  let state = 0x7c1f3a5;
  for (let i = 0; i < pixels.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = (state >>> 24) & 0xff;
  }
  return sharp(pixels, { raw: { width: 240, height: 320, channels: 3 } })
    .withExif({
      IFD0: {
        Make: 'Titan',
        Model: 'Fixture Camera',
        Copyright: 'test fixture',
      },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
        GPSAltitude: '11/1',
      },
    })
    // Orientation cannot be set through `withExif`: sharp normalises the
    // orientation tag it writes and the IFD0 entry comes back as 1. This is the
    // supported way to produce a file that a decoder will actually rotate, and
    // it is what a phone camera really emits.
    .withMetadata({ orientation })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function uploadRequest(bytes: Buffer, kind = 'avatar'): Request {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'holiday.jpg', { type: 'image/jpeg' }));
  form.set('kind', kind);
  return new Request('http://localhost:3000/api/upload', { method: 'POST', body: form });
}

describe('SPEC-006 - GPS EXIF does not survive the upload', () => {
  let source: Buffer;
  let storedBytes: Buffer;
  let storedPath: string;

  beforeAll(async () => {
    source = await jpegWithGps();
    const response = await handleUpload(uploadRequest(source), USER);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string };
    storedPath = body.path;
    storedBytes = await readFile(join(root, storedPath.replace('/uploads/', '')));
  });

  it('the fixture really does carry GPSLatitude, so the absence below means something', async () => {
    const metadata = await sharp(source).metadata();
    expect(metadata.exif, 'the fixture JPEG has no EXIF at all').toBeDefined();

    const tags = readExifTags(metadata.exif);
    expect(tags.ifd0).toContain(TAG_GPS_IFD_POINTER);
    expect(tags.gps).toContain(TAG_GPS_LATITUDE);
    expect(tags.gps).toContain(TAG_GPS_LATITUDE_REF);
    expect(tags.gps).toContain(TAG_GPS_LONGITUDE);
  });

  it('the stored file is a WebP', async () => {
    const metadata = await sharp(storedBytes).metadata();
    expect(metadata.format).toBe('webp');
    expect(storedPath.endsWith('.webp')).toBe(true);
  });

  it('the stored WebP metadata contains no GPSLatitude tag', async () => {
    const metadata = await sharp(storedBytes).metadata();
    const tags = readExifTags(metadata.exif);
    expect(tags.gps).not.toContain(TAG_GPS_LATITUDE);
    expect(tags.gps).toEqual([]);
  });

  it('carries no EXIF block at all - stronger than the criterion asks', async () => {
    // The criterion names GPSLatitude specifically, but the guarantee is
    // categorical: sharp copies metadata only when asked with `keepMetadata()`,
    // and `lib/media/process.ts` never asks. Asserting the whole block is
    // absent means a future change that starts preserving metadata fails here
    // even if it happens to drop the GPS sub-directory.
    const metadata = await sharp(storedBytes).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(readExifTags(metadata.exif)).toEqual({ ifd0: [], exif: [], gps: [] });
  });

  it('carries no EXIF chunk in the container either', () => {
    // A byte-level check that does not go through sharp's reader, in case a
    // future sharp version starts reporting metadata differently. A WebP stores
    // EXIF in a RIFF chunk with the fourcc `EXIF`; XMP uses `XMP `.
    const text = storedBytes.toString('latin1');
    expect(text.includes('EXIF')).toBe(false);
    expect(text.includes('XMP ')).toBe(false);
    // And none of the fixture's identifying strings survive anywhere in it.
    expect(text.includes('Titan')).toBe(false);
    expect(text.includes('Fixture Camera')).toBe(false);
  });

  it('drops the coordinates for every kind, not just avatars', async () => {
    for (const kind of ['avatar', 'cover', 'inline']) {
      const response = await handleUpload(uploadRequest(await jpegWithGps(), kind), USER);
      const body = (await response.json()) as { path: string };
      const bytes = await readFile(join(root, body.path.replace('/uploads/', '')));
      const metadata = await sharp(bytes).metadata();
      expect(readExifTags(metadata.exif).gps, kind).toEqual([]);
    }
  });

  it('strips metadata at the processing layer, not only through the route', async () => {
    // The route is one caller. Anything a later slice builds on `processImage`
    // inherits the same guarantee, so the property is asserted where it lives.
    const processed = await processImage(await jpegWithGps(), 'cover');
    const described = await describeImage(processed.data);
    expect(described.format).toBe('webp');
    expect(described.exif).toBeUndefined();
  });
});

describe('SPEC-006 - orientation is applied before the metadata is discarded', () => {
  it('honours an EXIF rotation rather than storing the photo on its side', async () => {
    // The ordering that makes this work is load -> rotate -> resize -> encode.
    // Orientation lives in EXIF, and this pipeline destroys EXIF - so if the
    // rotate were dropped, or moved after the encode, every portrait photo from
    // a phone would be stored sideways with nothing left to correct it. The
    // fixture is 240x320 (portrait) tagged Orientation=6, which means "rotate
    // 90 degrees clockwise" - so a correct pipeline yields a 320x240 landscape
    // image, and a broken one leaves it 240x320.
    const rotated = await processImage(await jpegWithGps(6), 'cover');
    expect([rotated.width, rotated.height]).toEqual([320, 240]);

    const upright = await processImage(await jpegWithGps(1), 'cover');
    expect([upright.width, upright.height]).toEqual([240, 320]);
  });

  it('still leaves no GPS behind on the rotated path', async () => {
    const rotated = await processImage(await jpegWithGps(6), 'cover');
    expect((await describeImage(rotated.data)).exif).toBeUndefined();
  });
});
