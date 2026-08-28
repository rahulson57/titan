/**
 * Re-encoding (SPEC-006).
 *
 * > Resize | `sharp`: avatar → 400×400 cover-crop; cover → max 1600w; inline →
 * > max 1400w. Always re-encoded to WebP q80 — re-encoding strips EXIF
 * > including GPS.
 *
 * ── The stored file is never the uploaded file ─────────────────────────────
 * That sentence is the security design, not a performance note. Nothing a user
 * sends is ever written to disk: sharp decodes the bytes to a raster, and this
 * module encodes a *new* WebP from that raster. Every byte of the output is
 * one this process produced.
 *
 * Three problems disappear at once because of it:
 *
 *  - **EXIF, including GPS.** A phone photo carries the coordinates it was
 *    taken at. Publishing an avatar should not publish someone's home address.
 *    sharp copies metadata only when explicitly asked (`keepMetadata()`), and
 *    this module never asks — so the GPS tags are gone by construction rather
 *    than by a strip-list someone has to keep current. `upload-exif.test.ts`
 *    proves it on a file that really does carry GPSLatitude.
 *  - **Polyglots.** A file that is a valid JPEG *and* a valid HTML document, or
 *    a JPEG with a PHP payload in a comment segment, does not survive being
 *    decoded to pixels and re-encoded. The trailing garbage is simply not part
 *    of the raster.
 *  - **Format drift.** Everything on disk is WebP, so the serving layer has one
 *    content type to think about and `next/image` has one decoder path.
 *
 * The one thing re-encoding costs is fidelity: a user who uploads a pristine
 * PNG gets back a lossy WebP. q80 is SPEC-006's number and it is the right
 * trade for a reading site — the alternative, passing the original through, is
 * what makes all three problems above the operator's problem forever.
 *
 * ── Why `.rotate()` is called with no arguments ────────────────────────────
 * It is not a rotation. Called argument-less, sharp reads the EXIF orientation
 * tag and bakes it into the pixels. It has to happen here, before the metadata
 * is dropped, or every photo taken in portrait on a phone would be stored on
 * its side — the orientation tag is EXIF, and this pipeline destroys EXIF. The
 * ordering is load → rotate → resize → encode, and each arrow matters: rotating
 * after the resize would crop an avatar against the wrong axis.
 */

import sharp from 'sharp';
import { UploadRejected, type UploadKind } from './validate';

/** SPEC-006: "WebP q80". */
export const WEBP_QUALITY = 80;

/** What each placement is resized to. Verbatim from SPEC-006's Resize row. */
export const PROCESSING_TARGETS = {
  /** A square crop — the only kind with a fixed height, because it is a face. */
  avatar: { width: 400, height: 400, fit: 'cover' as const },
  cover: { width: 1600, height: null, fit: 'inside' as const },
  inline: { width: 1400, height: null, fit: 'inside' as const },
} satisfies Record<UploadKind, { width: number; height: number | null; fit: 'cover' | 'inside' }>;

/**
 * A ceiling on decoded pixels, independent of the 5 MB byte ceiling.
 *
 * These are different attacks and the byte limit does not cover the second one.
 * A ~4 KB PNG can legally declare 40000×40000, and decoding it asks for ~6 GB
 * of RAM — the file passes every size and magic-byte check on the way in. 50 MP
 * is roughly an 8000×6000 photo, comfortably above anything a person uploads to
 * a blog and far below anything that threatens a dev machine. sharp enforces it
 * during decode and raises, which this module turns into a 415.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

export interface ProcessedImage {
  /** WebP bytes, freshly encoded. Never a slice of the input. */
  data: Buffer;
  width: number;
  height: number;
  format: 'webp';
}

/**
 * Decode, orient, resize, re-encode.
 *
 * `withoutEnlargement` differs by kind, and the difference is deliberate:
 *
 *  - **avatar** may enlarge. SPEC-006's oracle says the stored avatar "exists
 *    on disk at 400×400" — no qualifier — so a 120×120 source must still come
 *    out 400×400. A face rendered slightly soft is the correct outcome; a
 *    120×120 file in a 400×400 slot is a broken layout.
 *  - **cover** and **inline** are "max 1600w" / "max 1400w". A maximum is not a
 *    target. Upscaling a 900px image to 1400px would invent detail, cost bytes
 *    on every page load, and look worse than the original at the same display
 *    size — so smaller images are left alone.
 */
export async function processImage(
  input: Uint8Array,
  kind: UploadKind,
): Promise<ProcessedImage> {
  const target = PROCESSING_TARGETS[kind];

  try {
    const pipeline = sharp(Buffer.from(input), {
      limitInputPixels: MAX_INPUT_PIXELS,
      // Read the first frame only. An animated GIF/WebP cannot reach here (the
      // sniffer rejects GIF, and an animated WebP would still be flattened),
      // but saying so explicitly keeps a future accepted-format change from
      // silently producing a one-frame file that claims to be an animation.
      animated: false,
      sequentialRead: true,
    })
      // EXIF orientation, applied to pixels while the EXIF still exists.
      .rotate()
      .resize({
        width: target.width,
        ...(target.height === null ? {} : { height: target.height }),
        fit: target.fit,
        position: 'centre',
        withoutEnlargement: kind !== 'avatar',
      })
      // No keepMetadata()/withMetadata(): every EXIF, XMP and ICC block on the
      // input is dropped here. That is the GPS guarantee.
      .webp({ quality: WEBP_QUALITY });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, format: 'webp' };
  } catch (cause) {
    // The bytes passed the magic-byte sniff but the decoder could not make an
    // image of them — truncated, corrupt, or a declared size this build refuses
    // to allocate. That is the same class of answer as "wrong format" from the
    // caller's point of view, so it gets the same status rather than a 500 that
    // would read as "our fault".
    throw new UploadRejected(
      415,
      'undecodable',
      'That image could not be decoded. It may be corrupt or truncated.',
      { cause },
    );
  }
}

/**
 * Read back the dimensions and metadata of an already-encoded image.
 *
 * Exists for the tests and the GC's fixtures rather than the request path — the
 * upload path already knows its output dimensions from `toBuffer`, and asking
 * sharp again would decode the file a second time for no new information.
 */
export async function describeImage(bytes: Uint8Array): Promise<{
  format: string | undefined;
  width: number | undefined;
  height: number | undefined;
  exif: Buffer | undefined;
}> {
  const metadata = await sharp(Buffer.from(bytes)).metadata();
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    exif: metadata.exif,
  };
}
