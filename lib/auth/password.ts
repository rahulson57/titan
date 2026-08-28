/**
 * Password hashing (SPEC-005 / DEC-005).
 *
 * > Password hash: **argon2id** via `@node-rs/argon2` — `m=19456 KiB, t=2,
 * > p=1` (OWASP 2024 baseline)
 *
 * Those three numbers are the whole security posture, so they live in one
 * exported constant rather than at the call site: a hash written with the
 * wrong cost is indistinguishable from a correct one until someone tries to
 * crack it, and `auth-hash.test.ts` asserts the parameters back out of the
 * encoded string rather than trusting that this file was read.
 *
 * argon2id rather than bcrypt because it is memory-hard: bcrypt's cost is CPU
 * time, which a GPU parallelises cheaply, whereas argon2id at m=19456 KiB
 * forces each guess to hold ~19 MiB, which is what actually limits an attacker
 * with a graphics card. `id` rather than `i` or `d` because it is the hybrid
 * OWASP recommends — side-channel resistance from argon2i on the first pass,
 * GPU resistance from argon2d after.
 *
 * ── The dummy verification, which is load-bearing ──────────────────────────
 * SPEC-005 forbids user enumeration, and the oracle measures it as timing:
 * "sign-in with a wrong password and sign-in with a non-existent email ...
 * both within 50 ms of each other's mean over 20 runs".
 *
 * A naive sign-in returns early when no user is found, so the missing-account
 * path skips the ~40 ms argon2 verification the wrong-password path pays. The
 * two outcomes then have identical *messages* and obviously different
 * *durations* — the message is the control, and the clock defeats it. Anyone
 * with a stopwatch can enumerate the user table.
 *
 * `verifyAgainstDummy` closes that: the missing-account path runs a real
 * argon2 verification against a real hash that simply cannot match. Same
 * memory, same passes, same time. It is deliberately NOT `sleep(40)` — a fixed
 * sleep is a guess at a duration that changes with the machine, and it adds
 * latency to the honest path for no defensive gain.
 */

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id` and `Version.V0x13`, written as the numbers they are.
 *
 * `@node-rs/argon2` declares both as ambient `const enum`s, and this repo
 * compiles under `isolatedModules: true` — which makes reading them a hard
 * TypeScript error (TS2748), because a const enum member is erased at compile
 * time and there is nothing left to import per-file. Inlining the values is
 * the supported way out; the alternative, `preserveConstEnums` +
 * `importsNotUsedAsValues`, would change the whole project's compiler posture
 * to accommodate one dependency.
 *
 * The numbers are pinned by the argon2 format itself, not by this library's
 * enum ordering: `2` is argon2id in the reference implementation's type field
 * and `1` is encoding version 0x13. `auth-hash.test.ts` reads both back out of
 * a real hash (`$argon2id$v=19$...`) rather than trusting these constants, so
 * a wrong number fails a test instead of silently downgrading every password
 * in the database to argon2i.
 */
const ALGORITHM_ARGON2ID = 2;
const VERSION_0X13 = 1;

/**
 * OWASP's 2024 argon2id baseline, as named by SPEC-005.
 *
 * `outputLen` and `version` are pinned alongside the three cost parameters so
 * the encoded hash is fully determined by this object — an upgrade to any of
 * them is then a visible change here rather than a silent drift in a library
 * default.
 */
export const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  version: VERSION_0X13,
  /** m = 19456 KiB (19 MiB). */
  memoryCost: 19456,
  /** t = 2 passes. */
  timeCost: 2,
  /** p = 1 lane. */
  parallelism: 1,
  /** 32-byte tag — the argon2 reference default, and what OWASP assumes. */
  outputLen: 32,
} as const;

/** The prefix every hash this module writes must carry (asserted by the oracle). */
export const ARGON2ID_PREFIX = '$argon2id$';

/**
 * Hash a password for storage.
 *
 * No salt is passed: `@node-rs/argon2` generates a fresh 16-byte random salt
 * per call and encodes it into the returned string. That is why two calls with
 * the same password return different hashes — a property `auth-hash.test.ts`
 * asserts, because a deterministic hash would make the stored column a rainbow
 * table lookup and would leak which users share a password.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

/**
 * Check a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed or unparseable hash. A
 * corrupt `passwordHash` column is a data problem, not a reason to answer a
 * sign-in attempt with a stack trace: the caller's only correct behaviour
 * either way is the same generic failure, and letting the exception escape
 * would distinguish "this account's row is damaged" from "wrong password" —
 * which is an enumeration signal.
 *
 * The verification itself is constant-time with respect to the tag comparison;
 * that is argon2's job, not this function's.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * A real argon2id hash of a value no password can be, computed once on first
 * use and reused.
 *
 * Lazily built rather than computed at module load: this module is imported by
 * server components that never sign anyone in, and paying ~40 ms of memory-hard
 * work at import time would tax every cold start for a code path most requests
 * never reach.
 *
 * The plaintext is a fixed sentinel rather than a random string because the
 * value is irrelevant — it is never compared against anything a user supplies,
 * and the only property required is that verification against it always fails.
 */
let dummyHashPromise: Promise<string> | undefined;

export function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(
    'titan/no-such-account/2f7c1d9b4e6a8035c1f2e3d4b5a69788',
  );
  return dummyHashPromise;
}

/**
 * Burn the same work a real verification costs, and always fail.
 *
 * Call this on the "no user with that email" branch of sign-in so the two
 * failure paths are indistinguishable on the clock as well as in the message.
 * The return type is `Promise<false>`, not `Promise<boolean>`: the type states
 * that a caller who treats a `true` from here as a successful sign-in has
 * written something impossible.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  await verifyPassword(await dummyHash(), password);
  return false;
}

/**
 * Warm the dummy hash without checking anything.
 *
 * The FIRST missing-account sign-in of a process pays for computing the dummy
 * hash on top of verifying against it — roughly double, which is exactly the
 * timing tell this whole mechanism exists to erase. Anything that wants the
 * guarantee from the first request rather than the second calls this at
 * startup; `auth-enumeration.test.ts` calls it before it starts timing.
 */
export async function warmDummyHash(): Promise<void> {
  await dummyHash();
}

/** The parts of an encoded argon2 string, as parsed back out of it. */
export interface ParsedHash {
  algorithm: string;
  version: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Parse `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`.
 *
 * Exists so the cost parameters can be asserted from a STORED hash rather than
 * from `ARGON2_OPTIONS` — a test that reads the constant it is checking proves
 * only that the constant equals itself. Returns `null` on anything that is not
 * a well-formed argon2 encoding.
 */
export function parseHash(encoded: string): ParsedHash | null {
  const match =
    /^\$(argon2(?:id|i|d))\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(encoded);
  if (!match) return null;
  const [, algorithm, version, memoryCost, timeCost, parallelism] = match;
  return {
    algorithm: algorithm as string,
    version: Number(version),
    memoryCost: Number(memoryCost),
    timeCost: Number(timeCost),
    parallelism: Number(parallelism),
  };
}
