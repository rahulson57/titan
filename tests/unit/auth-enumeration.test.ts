/**
 * User enumeration resistance (SPEC-005).
 *
 * Sealed criterion: "Sign-in with a wrong password and sign-in with a
 * non-existent email return byte-identical error messages AND both within
 * 50 ms of each other's mean over 20 runs."
 *
 * The two halves are different defences and only one of them is obvious.
 *
 * The *message* half is easy and is usually where implementations stop. The
 * *timing* half is what makes it real: the natural sign-in returns early when
 * no user matches, skipping the ~50 ms argon2 verification the wrong-password
 * path pays. The messages are then identical and the durations differ by a
 * full hash, so anyone with a stopwatch can enumerate the user table. The
 * message is the control everyone writes; the clock is the leak nobody sees.
 *
 * `lib/auth/password.ts` closes it by verifying against a real dummy hash on
 * the user-not-found path. This suite measures that it worked, against the
 * actual sign-in code rather than a re-creation of it — a hand-rolled timing
 * harness that calls `verifyPassword` directly would prove the primitive and
 * miss the early return in the caller, which is where the bug lives.
 *
 * ── On timing a test at all ────────────────────────────────────────────────
 * A wall-clock assertion is a flake risk, and SPEC-002 is explicit that "a
 * flaky pass is a failure". Three things keep this one honest:
 *   - the budget is 50 ms against an operation that costs tens of ms, so the
 *     margin is large relative to scheduler noise;
 *   - the dummy hash is warmed first, so run 1 does not pay to compute it;
 *   - the two paths alternate rather than running in blocks, so a machine that
 *     slows down partway through slows both arms equally instead of biasing
 *     whichever ran second.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { hashPassword, verifyAgainstDummy, verifyPassword, warmDummyHash } from '../../lib/auth/password';
import { reset as resetRateLimit } from '../../lib/auth/rate-limit';
import { EMPTY_FORM_STATE, GENERIC_SIGNIN_ERROR } from '../../lib/auth/validation';
import { signIn } from '../../app/(auth)/actions';

const AT = new Date('2026-01-01T00:00:00.000Z');
const REAL_EMAIL = 'ada@titan.local';
const REAL_PASSWORD = 'a reasonably long passphrase';
const MISSING_EMAIL = 'nobody@titan.local';

/** SPEC-005's budget: the two means must be within 50 ms of each other. */
const MEAN_DELTA_BUDGET_MS = 50;
const RUNS = 20;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  await createUser({
    email: REAL_EMAIL,
    passwordHash: await hashPassword(REAL_PASSWORD),
    handle: 'ada',
    name: 'Ada',
    createdAt: AT,
  });

  // Pay for the dummy hash once, before anything is timed. Without this the
  // first missing-account attempt costs a hash PLUS a verify and skews the
  // mean upward — the measurement would then fail for a reason that has
  // nothing to do with the property being measured.
  await warmDummyHash();
}, 180_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

function form(email: string, password: string): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  return data;
}

/**
 * One sign-in attempt through the real Server Action.
 *
 * The rate limiter is reset before every attempt: five failures against the
 * same address would otherwise trip it partway through a 20-run measurement,
 * and a rate-limited attempt short-circuits before argon2 — which would
 * collapse the timings toward zero and make this suite pass for the wrong
 * reason.
 */
async function attempt(email: string, password: string) {
  resetRateLimit();
  return signIn(EMPTY_FORM_STATE, form(email, password));
}

describe('SPEC-005 — the two failures are indistinguishable by message', () => {
  it('returns byte-identical strings for wrong password and unknown email', async () => {
    const wrongPassword = await attempt(REAL_EMAIL, 'definitely not the password');
    const noSuchUser = await attempt(MISSING_EMAIL, REAL_PASSWORD);

    expect(wrongPassword.formError).toBe(GENERIC_SIGNIN_ERROR);
    expect(noSuchUser.formError).toBe(GENERIC_SIGNIN_ERROR);
    // "Byte-identical" asserted as such, not merely "both truthy".
    expect(wrongPassword.formError).toBe(noSuchUser.formError);
    expect(Buffer.from(wrongPassword.formError ?? '')).toEqual(
      Buffer.from(noSuchUser.formError ?? ''),
    );
  });

  it('returns the same status and no field-level errors on both paths', async () => {
    // A field error is an enumeration signal too: an error attached to
    // `password` rather than to the form says the email matched something.
    const wrongPassword = await attempt(REAL_EMAIL, 'definitely not the password');
    const noSuchUser = await attempt(MISSING_EMAIL, REAL_PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.errors).toEqual([]);
    expect(noSuchUser.errors).toEqual([]);
  });

  it('says nothing different for a malformed email either', async () => {
    // A third path worth checking: rejecting `not-an-email` with a validation
    // message while rejecting `nobody@titan.local` generically would tell an
    // attacker which of their inputs was even considered.
    const malformed = await attempt('not-an-email', REAL_PASSWORD);
    expect(malformed.formError).toBe(GENERIC_SIGNIN_ERROR);
    expect(malformed.errors).toEqual([]);
  });
});

describe('SPEC-005 — the two failures are indistinguishable on the clock', () => {
  it(`has means within ${MEAN_DELTA_BUDGET_MS} ms over ${RUNS} runs`, async () => {
    const wrongPassword: number[] = [];
    const noSuchUser: number[] = [];

    // Alternating, not blocked. A machine that gets busier partway through
    // then penalises both arms equally instead of whichever ran second.
    for (let i = 0; i < RUNS; i++) {
      let start = performance.now();
      await attempt(REAL_EMAIL, 'definitely not the password');
      wrongPassword.push(performance.now() - start);

      start = performance.now();
      await attempt(MISSING_EMAIL, REAL_PASSWORD);
      noSuchUser.push(performance.now() - start);
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const wrongMean = mean(wrongPassword);
    const missingMean = mean(noSuchUser);
    const delta = Math.abs(wrongMean - missingMean);

    expect(
      delta,
      `wrong-password mean ${wrongMean.toFixed(1)}ms vs unknown-email mean ` +
        `${missingMean.toFixed(1)}ms (delta ${delta.toFixed(1)}ms). A delta of ` +
        'roughly one argon2 verification means the user-not-found path is ' +
        'returning early instead of verifying against the dummy hash.',
    ).toBeLessThan(MEAN_DELTA_BUDGET_MS);
  }, 120_000);

  it('proves the mechanism directly: the dummy path does real argon2 work', async () => {
    // The timing test above can pass for a bad reason — if argon2 were
    // configured so cheaply that BOTH paths were instant, the delta would be
    // tiny and the suite would go green on a broken hash. This pins the
    // absolute cost too, so "fast enough to be indistinguishable" cannot be
    // achieved by making the hashing worthless.
    const hash = await hashPassword(REAL_PASSWORD);

    const realStart = performance.now();
    await verifyPassword(hash, 'wrong');
    const realCost = performance.now() - realStart;

    const dummyStart = performance.now();
    expect(await verifyAgainstDummy('wrong')).toBe(false);
    const dummyCost = performance.now() - dummyStart;

    // Both must be doing memory-hard work, not returning a constant.
    expect(realCost).toBeGreaterThan(1);
    expect(dummyCost).toBeGreaterThan(1);
    expect(Math.abs(realCost - dummyCost)).toBeLessThan(MEAN_DELTA_BUDGET_MS);
  });
});
