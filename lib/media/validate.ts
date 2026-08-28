/**
 * What is allowed through the door (SPEC-006).
 *
 * Everything in this file is a pure function of bytes. No filesystem, no
 * sharp, no request object — which is the point: the rules that decide whether
 * a stranger's bytes get to touch the disk are the ones most worth testing
 * exhaustively, and a rule that needs a running server to exercise is a rule
 * that gets tested once, happily, and never again.
 *
 * ── Why the Content-Type header is never consulted ─────────────────────────
 * SPEC-006 is explicit: accepted types are "determined by **magic bytes**, not
 * the `Content-Type` header or file extension". Both of the other two signals
 * are attacker-chosen. A multipart part's `Content-Type` is whatever the client
 * typed into it, and the filename extension is worse — it is attacker-chosen
 * *and* it is a string the server may later be tempted to put in a path.
 *
 * So this module reads the only part of an upload the attacker cannot lie about
 * without changing what the file actually is: the first few bytes. If those
 * bytes are a PDF, it is a PDF, and it is rejected — no matter that the header
 * said `image/png` and the name said `.png`.
 *
 * ── Why SVG is rejected rather than sanitized ──────────────────────────────
 * SVG is not an image format in the sense the rest of this pipeline means it.
 * It is an XML document that can carry `<script>`, `on*` handlers, external
 * entity references and `<foreignObject>` HTML — and it is served from our own
 * origin out of `public/`, so a stored SVG is a stored same-origin XSS. There
 * is a sanitizer-shaped answer to that and it is a permanent maintenance
 * liability (every bypass is a new CVE to chase). Refusing the format outright
 * is one line and has no bypasses. Same reasoning, milder stakes, for GIF: the
 * pipeline re-encodes to a single still WebP frame, so accepting an animation
 * would silently destroy the only reason someone uploaded one.
 */

// ---------------------------------------------------------------------------
// Limits and vocabulary
// ---------------------------------------------------------------------------

/** SPEC-006: "Max bytes | 5 MB (`5 * 1024 * 1024`), rejected with 413". */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The three placements an upload can have (SPEC-006's `kind` parameter). */
export const UPLOAD_KINDS = ['avatar', 'cover', 'inline'] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number];

export function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === 'string' && (UPLOAD_KINDS as readonly string[]).includes(value);
}

/**
 * SPEC-006: "Accepted types | `image/jpeg`, `image/png`, `image/webp`,
 * `image/avif`".
 */
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

/**
 * Formats the sniffer can name but the pipeline refuses. Being able to *name*
 * them is what lets a rejection say "SVG is not accepted" instead of the much
 * less useful "unrecognised bytes" — the difference between a user fixing
 * their upload and a user filing a bug.
 */
export type RejectedImageType = 'image/gif' | 'image/svg+xml' | 'image/bmp' | 'image/tiff';

export type SniffedType = AcceptedImageType | RejectedImageType | 'application/pdf' | null;

export function isAcceptedImageType(value: SniffedType): value is AcceptedImageType {
  return value !== null && (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * A rejection that already knows its HTTP status.
 *
 * The status lives with the rule rather than at the call site because there is
 * more than one caller — the route, the seeder, and anything a later slice
 * builds on this — and "which code does an oversized file get?" must not be
 * re-decided (or re-guessed) by each of them.
 */
export class UploadRejected extends Error {
  readonly status: 400 | 403 | 413 | 415;
  readonly code: string;

  constructor(
    status: 400 | 403 | 413 | 415,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UploadRejected';
    this.status = status;
    this.code = code;
  }
}

export function tooLarge(size: number): UploadRejected {
  return new UploadRejected(
    413,
    'too_large',
    `That image is ${formatBytes(size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
  );
}

export function unsupportedType(sniffed: SniffedType): UploadRejected {
  const named = sniffed ? `Files of type ${sniffed} are not accepted.` : 'That file is not an image.';
  return new UploadRejected(
    415,
    'unsupported_type',
    `${named} Upload a JPEG, PNG, WebP or AVIF.`,
  );
}

export function badRequest(code: string, message: string): UploadRejected {
  return new UploadRejected(400, code, message);
}

/** Human-facing byte sizes. Kept here so the 413 message and tests agree. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

// ---------------------------------------------------------------------------
// Magic-byte sniffing
// ---------------------------------------------------------------------------

const ascii = (bytes: Uint8Array, start: number, length: number): string => {
  let out = '';
  for (let i = start; i < start + length; i++) {
    const byte = bytes[i];
    if (byte === undefined) return out;
    out += String.fromCharCode(byte);
  }
  return out;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => {
  if (bytes.length < signature.length) return false;
  return signature.every((expected, index) => bytes[index] === expected);
};

/**
 * ISO base media file format brands that mean "this is an AVIF still".
 *
 * `avis` is the image-sequence brand; sharp decodes its primary item, and the
 * pipeline is producing a single still WebP anyway, so accepting it loses
 * nothing a user would notice. HEIC brands (`heic`, `mif1`) are deliberately
 * NOT here — SPEC-006's accepted list does not include them, and sharp's HEIF
 * support depends on a libheif build that may not be present.
 */
const AVIF_BRANDS = new Set(['avif', 'avis']);

/**
 * Name the format from the leading bytes, or return `null` for "no idea".
 *
 * Signature lengths are deliberately generous — a PNG is matched on all eight
 * bytes of its signature, not the four that would be enough — because the cost
 * of a longer comparison is nothing and the cost of a false positive is a file
 * sharp then fails to decode, turning a clean 415 into a 500.
 */
export function sniffImageType(input: Uint8Array): SniffedType {
  const bytes = input;

  // JPEG — SOI marker followed by any marker byte.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG — the full 8-byte signature, including the CRLF/EOF trap bytes.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // RIFF container: WEBP is the form type at offset 8.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';

  // ISO-BMFF: `ftyp` box at offset 4, major brand at offset 8.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const major = ascii(bytes, 8, 4);
    if (AVIF_BRANDS.has(major)) return 'image/avif';
    // Compatible brands follow the 4-byte minor version, in 4-byte slots.
    for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
      if (AVIF_BRANDS.has(ascii(bytes, offset, 4))) return 'image/avif';
    }
  }

  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'; // GIF8(7|9)a
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])) return 'image/tiff';
  if (startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'; // %PDF

  if (looksLikeSvg(bytes)) return 'image/svg+xml';

  return null;
}

/**
 * SVG has no magic number — it is XML — so it is detected structurally.
 *
 * The window is deliberately wide (1 KB) and tolerant of a BOM, leading
 * whitespace, an XML declaration, a DOCTYPE and comments, because an SVG that
 * this function fails to recognise does not become "rejected as unknown" by
 * accident — it becomes whatever sharp makes of it, and sharp *can* rasterise
 * SVG when built with librsvg. Recognising it here is what guarantees the 415.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 1024);
  let text = '';
  for (let i = 0; i < window.length; i++) text += String.fromCharCode(window[i] ?? 0);
  const trimmed = text.replace(/^\uFEFF|^\xEF\xBB\xBF/, '').trimStart();

  // `<svg` must be followed by a name-terminating character, so `<svgsomething`
  // is not a match. `/` counts: `<svg/>` is a well-formed empty element.
  const OPENS_SVG = /^<svg[\s/>]/i;
  if (OPENS_SVG.test(trimmed)) return true;

  // A DOCTYPE that names svg is conclusive on its own.
  if (/^<!DOCTYPE\s+svg/i.test(trimmed)) return true;

  // Otherwise skip any run of the three things XML legally allows before the
  // root element — a prolog, comments, a DOCTYPE — and look again.
  const PROLOGUE = /^(?:<\?xml[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|\s+)+/i;
  const afterPrologue = trimmed.replace(PROLOGUE, '');
  return afterPrologue !== trimmed && OPENS_SVG.test(afterPrologue);
}

// ---------------------------------------------------------------------------
// The composed rule
// ---------------------------------------------------------------------------

export interface ValidatedUpload {
  kind: UploadKind;
  /** The type the BYTES claim to be. Never the type the client claimed. */
  type: AcceptedImageType;
  size: number;
}

/**
 * The whole admission decision, in the order SPEC-006 states its statuses.
 *
 * Size is checked before content on purpose. A 6 MB PDF is over the limit *and*
 * the wrong type, and the spec pins the oversize case to 413; answering 415
 * because the sniffer ran first would be defensible and would still fail the
 * oracle. Checking size first also means the expensive test (a content sniff
 * over an attacker-sized buffer) never runs on input we have already decided to
 * throw away.
 */
export function validateUpload(input: {
  bytes: Uint8Array;
  kind: unknown;
  declaredSize?: number;
}): ValidatedUpload {
  if (!isUploadKind(input.kind)) {
    throw badRequest(
      'bad_kind',
      `\`kind\` must be one of ${UPLOAD_KINDS.join(', ')}.`,
    );
  }

  const size = input.declaredSize ?? input.bytes.byteLength;
  if (size > MAX_UPLOAD_BYTES || input.bytes.byteLength > MAX_UPLOAD_BYTES) throw tooLarge(size);
  if (input.bytes.byteLength === 0) throw badRequest('empty_file', 'That file is empty.');

  const sniffed = sniffImageType(input.bytes);
  if (!isAcceptedImageType(sniffed)) throw unsupportedType(sniffed);

  return { kind: input.kind, type: sniffed, size: input.bytes.byteLength };
}
