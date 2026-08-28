/**
 * Identifier generation (SPEC-004).
 *
 * > IDs are **cuid2** strings (26 chars), generated app-side so seed output is
 * > deterministic under the fixed PRNG.
 *
 * "Generated app-side" is the whole point. A database-side default (`uuid()`,
 * an autoincrement) would make the seed corpus depend on insertion order and
 * on SQLite's own state, and SPEC-002 requires two seed runs to produce
 * byte-identical `id` columns. So the id generator takes its entropy from an
 * injected source: `crypto` at runtime, a seeded PRNG in `prisma/seed.ts`.
 *
 * The generator is written here rather than pulled from `@paralleldrive/cuid2`
 * because a dependency cannot be added from this slice's file scope — and the
 * property the spec actually names (26 characters, collision-resistant,
 * sortable-safe, generated locally) is a dozen lines. What is NOT reimplemented
 * is cuid2's security posture: this is a local single-process app whose ids are
 * never a capability, and `createId()` draws from `randomBytes` so it inherits
 * the platform CSPRNG.
 */

import { randomBytes } from 'node:crypto';

/** Fixed by SPEC-004: "cuid2 strings (26 chars)". */
export const ID_LENGTH = 26;

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * A uniform random source over [0, 1). `Math.random` satisfies the type but is
 * deliberately never the default — see `createId` and `createSeededRandom`.
 */
export type Random = () => number;

/** Shape check for an id this module would have produced. */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][0-9a-z]{25}$/.test(value);
}

/**
 * Draw one id from an arbitrary random source.
 *
 * The first character is always a letter so an id is a valid identifier in
 * every context that might interpolate one (CSS selector, JS property, URL
 * fragment) — the same constraint cuid2 imposes, and the reason ids are not
 * simply 26 base-36 digits.
 */
export function createIdFrom(random: Random): string {
  let out = LETTERS[Math.floor(random() * LETTERS.length) % LETTERS.length] ?? 'a';
  for (let i = 1; i < ID_LENGTH; i++) {
    out += DIGITS[Math.floor(random() * DIGITS.length) % DIGITS.length] ?? '0';
  }
  return out;
}

/** Runtime id generation. Entropy comes from the platform CSPRNG. */
export function createId(): string {
  // Rejection sampling, not `byte % 36`. 256 is not a multiple of 36, so the
  // modulo shortcut would make the first four symbols of the 36-character
  // alphabet ~14% more likely than the rest — a real, if small, loss of the collision
  // resistance the 26-character length is chosen to buy. Bytes at or above
  // 252 (= 36 x 7) are discarded and redrawn instead.
  const LIMIT = 252;
  let pool = randomBytes(64);
  let cursor = 0;
  const nextByte = (): number => {
    for (;;) {
      if (cursor >= pool.length) {
        pool = randomBytes(64);
        cursor = 0;
      }
      const byte = pool[cursor++] ?? 0;
      if (byte < LIMIT) return byte;
    }
  };
  return createIdFrom(() => nextByte() / LIMIT);
}

/**
 * A deterministic PRNG seeded from a string — `titan-2026` for the seed corpus
 * (SPEC-002). This is xmur3 for seed expansion feeding sfc32 for the stream:
 * both are small, well-distributed, and — the property that matters here —
 * exactly reproducible across machines and Node versions, which
 * `Math.random()` is not.
 */
export function createSeededRandom(seed: string): Random {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const nextSeed = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };

  let a = nextSeed();
  let b = nextSeed();
  let c = nextSeed();
  let d = nextSeed();

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

/** An id generator bound to a seeded stream — the seed corpus's id source. */
export function createSeededIdFactory(seed: string): () => string {
  const random = createSeededRandom(seed);
  return () => createIdFrom(random);
}

/**
 * A 32-byte opaque session id (DEC-005: "opaque 32-byte random id").
 * Sessions are a capability, so this one never accepts an injected source.
 */
export function createSessionId(): string {
  return randomBytes(32).toString('hex');
}
