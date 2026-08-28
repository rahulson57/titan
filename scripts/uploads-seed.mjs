#!/usr/bin/env node
/**
 * `npm run uploads:seed` — materialise the tracked fixture images
 * (SPEC-006, SPEC-003).
 *
 * > `public/uploads/seed/**` | seed fixture images shipped with the repo |
 * > **tracked**
 *
 * `scripts/setup.mjs` runs this as the third step of `npm run setup`, so it is
 * part of the fresh-clone-to-running contract in SPEC-001. It has no database
 * dependency and no network dependency: it draws its own pixels and encodes
 * them with the same sharp/WebP settings the upload pipeline uses.
 *
 * ── Why the images are generated rather than committed as source art ───────
 * SPEC-003 requires original assets — "no Medium logos, no scraped imagery".
 * The strongest possible form of that claim is an asset with no provenance
 * question at all: these images are a documented function of a fixed seed, so
 * "where did this picture come from" is answered by reading forty lines of
 * arithmetic rather than by trusting a licence file. They are abstract
 * gradient/vignette fields — placeholders that read as deliberate design rather
 * than as missing images, in the palette from `app/globals.css`.
 *
 * ── Determinism is a hard requirement, not a nicety ────────────────────────
 * These files are TRACKED. If the same seed produced different bytes on a
 * second run, every `npm run setup` would leave the working tree dirty and
 * every clone would produce a spurious diff. So:
 *
 *   - the pixel source is a seeded PRNG (xmur3 → sfc32, the same construction
 *     `lib/db/ids.ts` uses for the seed corpus), never `Math.random`
 *   - nothing derives from the clock, the hostname, the filesystem or the
 *     locale
 *   - encoder settings are pinned, and `effort` is pinned too — libwebp's
 *     default search effort is stable across patch releases, but pinning it
 *     removes the question
 *   - a file whose bytes already match what this run would write is left
 *     untouched, so mtimes do not churn either
 *
 * The one thing outside this script's control is the libwebp version inside
 * whatever `sharp` build is installed. A major libwebp bump can change encoded
 * bytes for identical input; that would show up as a one-time diff on these
 * fixtures, which is visible and reviewable rather than silent.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = process.env.TITAN_UPLOADS_SEED_DIR
  ? process.env.TITAN_UPLOADS_SEED_DIR
  : join(ROOT, 'public', 'uploads', 'seed');

const QUIET = process.argv.includes('--quiet') || process.argv.includes('-q');
const say = (message) => {
  if (!QUIET) process.stdout.write(`${message}\n`);
};

/** Pinned encoder settings — the same quality the upload pipeline stores at. */
const WEBP = { quality: 80, effort: 4 };

/**
 * The palette, lifted from `app/globals.css` so the fixtures sit inside the
 * design system rather than beside it. Values are the light-theme tokens:
 * `--accent`, `--fg`, `--fg-muted`, `--bg-subtle`, `--border`.
 */
const PALETTE = {
  accent: [0x1a, 0x89, 0x17],
  ink: [0x24, 0x24, 0x24],
  muted: [0x6b, 0x6b, 0x6b],
  subtle: [0xfa, 0xfa, 0xfa],
  border: [0xe6, 0xe6, 0xe6],
};

/**
 * xmur3 seed expansion feeding sfc32 — identical in construction to
 * `createSeededRandom` in `lib/db/ids.ts`. Reimplemented rather than imported
 * because this is a plain `.mjs` script with no TypeScript loader, and the
 * thirty lines are cheaper than making the script load one.
 */
function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const next = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
  let a = next();
  let b = next();
  let c = next();
  let d = next();
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

const mix = (from, to, t) => Math.round(from + (to - from) * Math.max(0, Math.min(1, t)));

/**
 * Draw one fixture as a raw RGB buffer.
 *
 * The field is a diagonal two-colour ramp with a soft radial vignette and a
 * low-amplitude ordered dither. The dither is not decoration: a smooth 1600px
 * gradient encoded to lossy WebP bands visibly, and a couple of levels of noise
 * costs a few hundred bytes and removes the banding entirely.
 */
function render({ width, height, seed, from, to }) {
  const random = seededRandom(seed);
  const angle = random() * Math.PI * 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const cx = 0.35 + random() * 0.3;
  const cy = 0.35 + random() * 0.3;

  // A fixed 8x8 dither matrix drawn once from the seeded stream, so the noise
  // is reproducible rather than per-pixel-random (per-pixel would also be
  // reproducible, but 64 draws instead of width*height keeps this fast on the
  // 1600px covers).
  const dither = Array.from({ length: 64 }, () => Math.round((random() - 0.5) * 6));

  const buffer = Buffer.allocUnsafe(width * height * 3);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1 || 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1 || 1);

      // Diagonal ramp, normalised so t spans [0, 1] whatever the angle.
      const t = (u * dx + v * dy + 1) / 2;

      // Radial falloff towards the edges — the vignette that keeps a flat ramp
      // from looking like a broken image.
      const r = Math.hypot(u - cx, v - cy);
      const vignette = 1 - 0.22 * Math.min(1, r * 1.35);

      const noise = dither[((y & 7) << 3) | (x & 7)] ?? 0;
      buffer[cursor++] = clamp(mix(from[0], to[0], t) * vignette + noise);
      buffer[cursor++] = clamp(mix(from[1], to[1], t) * vignette + noise);
      buffer[cursor++] = clamp(mix(from[2], to[2], t) * vignette + noise);
    }
  }
  return buffer;
}

const clamp = (value) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));

/**
 * The fixture manifest.
 *
 * Dimensions mirror `PROCESSING_TARGETS` in `lib/media/process.ts` — avatars
 * are the 400x400 the uploader produces, covers are 1600 wide, inline images
 * are 1400 wide — so a fixture standing in for a real upload has the real
 * upload's geometry and any layout built against it is honest.
 */
const FIXTURES = [
  ...['a', 'b', 'c', 'd'].map((suffix, index) => ({
    name: `avatar-${suffix}.webp`,
    width: 400,
    height: 400,
    seed: `titan-avatar-${suffix}`,
    from: index % 2 === 0 ? PALETTE.accent : PALETTE.ink,
    to: index % 2 === 0 ? PALETTE.subtle : PALETTE.muted,
  })),
  ...['a', 'b', 'c'].map((suffix, index) => ({
    name: `cover-${suffix}.webp`,
    width: 1600,
    height: 900,
    seed: `titan-cover-${suffix}`,
    from: index === 1 ? PALETTE.ink : PALETTE.accent,
    to: index === 1 ? PALETTE.border : PALETTE.subtle,
  })),
  ...['a', 'b'].map((suffix) => ({
    name: `inline-${suffix}.webp`,
    width: 1400,
    height: 788,
    seed: `titan-inline-${suffix}`,
    from: PALETTE.muted,
    to: PALETTE.subtle,
  })),
  // A small, plain fixture for tests and docs that just need "an image that is
  // definitely tracked". SPEC-006's gitignore oracle names this path.
  {
    name: 'demo.webp',
    width: 320,
    height: 320,
    seed: 'titan-demo',
    from: PALETTE.accent,
    to: PALETTE.ink,
  },
];

async function encode(fixture) {
  const raw = render(fixture);
  return sharp(raw, {
    raw: { width: fixture.width, height: fixture.height, channels: 3 },
  })
    .webp(WEBP)
    .toBuffer();
}

async function main() {
  await mkdir(SEED_DIR, { recursive: true });

  let written = 0;
  let unchanged = 0;

  for (const fixture of FIXTURES) {
    const target = join(SEED_DIR, fixture.name);
    const bytes = await encode(fixture);

    // Idempotence: identical bytes are not rewritten, so `npm run setup` on a
    // clean clone does not touch a single mtime and `git status` stays clean.
    const existing = await readFile(target).catch(() => null);
    if (existing && existing.equals(bytes)) {
      unchanged++;
      continue;
    }
    await writeFile(target, bytes);
    written++;
    say(`  + ${fixture.name} (${fixture.width}x${fixture.height}, ${bytes.length} B)`);
  }

  const digest = createHash('sha256');
  for (const fixture of FIXTURES) digest.update(fixture.name);
  say(
    `uploads:seed — ${FIXTURES.length} fixture(s) in ${SEED_DIR}: ` +
      `${written} written, ${unchanged} already current ` +
      `[manifest ${digest.digest('hex').slice(0, 12)}]`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `uploads:seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
