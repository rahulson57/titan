/**
 * Failed-sign-in rate limiting (SPEC-005).
 *
 * Sealed criterion: "A 6th failed sign-in for the same email within 15 minutes
 * returns HTTP 429."
 *
 * Note the shape of the requirement — five failures are permitted, the sixth
 * is refused. That off-by-one is the entire criterion, so it is asserted
 * attempt by attempt rather than by checking that "the limiter eventually
 * fires".
 *
 * Every call passes an explicit `now`. The limiter's window is 15 real
 * minutes; a suite that used the wall clock could assert the threshold but
 * never the expiry, and "does the window actually reopen?" is the half where
 * a bug would go unnoticed for the longest.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_FAILURES,
  RATE_LIMITED_STATUS,
  WINDOW_MS,
  check,
  clear,
  isRateLimited,
  recordFailure,
  reset,
  size,
  sweep,
} from '../../lib/auth/rate-limit';

const EMAIL = 'ada@example.com';
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

beforeEach(() => {
  // Module-level state is the spec's chosen design ("in-process Map"), so it
  // must be reset between tests or the first suite's failures leak into the
  // next one's counts.
  reset();
});

describe('SPEC-005 — 5 failed logins per email per 15 min', () => {
  it('matches the spec constants', () => {
    expect(MAX_FAILURES).toBe(5);
    expect(WINDOW_MS).toBe(15 * 60 * 1000);
    expect(RATE_LIMITED_STATUS).toBe(429);
  });

  it('permits five failures and refuses the sixth', () => {
    for (let attempt = 1; attempt <= MAX_FAILURES; attempt++) {
      // Checked BEFORE recording, which is the order sign-in uses: the point
      // is to refuse before paying for an argon2 verification.
      expect(check(EMAIL, T0).limited, `attempt ${attempt} should be allowed`).toBe(false);
      recordFailure(EMAIL, T0);
    }

    const sixth = check(EMAIL, T0);
    expect(sixth.limited).toBe(true);
    expect(sixth.failures).toBe(MAX_FAILURES);
    expect(sixth.remaining).toBe(0);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts down `remaining` as failures accumulate', () => {
    expect(check(EMAIL, T0).remaining).toBe(5);
    recordFailure(EMAIL, T0);
    expect(check(EMAIL, T0).remaining).toBe(4);
    recordFailure(EMAIL, T0);
    expect(check(EMAIL, T0).remaining).toBe(3);
  });

  it('keys per email — one locked account does not lock another', () => {
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(EMAIL, T0);

    expect(isRateLimited(EMAIL, T0)).toBe(true);
    expect(isRateLimited('grace@example.com', T0)).toBe(false);
  });

  it('normalises the email, so casing cannot be used to reset the counter', () => {
    // Without this an attacker gets five free guesses per casing permutation,
    // which for a ten-character address is thousands of attempts.
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure('ADA@Example.com  ', T0);

    expect(isRateLimited('ada@example.com', T0)).toBe(true);
  });
});

describe('SPEC-005 — the window is fixed and reopens', () => {
  it('stays limited for the whole 15 minutes', () => {
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(EMAIL, T0);

    expect(isRateLimited(EMAIL, T0 + 1)).toBe(true);
    expect(isRateLimited(EMAIL, T0 + WINDOW_MS / 2)).toBe(true);
    expect(isRateLimited(EMAIL, T0 + WINDOW_MS - 1)).toBe(true);
  });

  it('reopens exactly at the boundary', () => {
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(EMAIL, T0);

    expect(isRateLimited(EMAIL, T0 + WINDOW_MS)).toBe(false);
    expect(check(EMAIL, T0 + WINDOW_MS).remaining).toBe(MAX_FAILURES);
  });

  it('does not extend the window on further failures inside it', () => {
    // This is what makes it FIXED rather than sliding. Failures at the end of
    // a window must not push the reset further out, or a persistent attacker
    // could keep a victim locked out indefinitely.
    recordFailure(EMAIL, T0);
    const firstReset = check(EMAIL, T0).resetAt;

    recordFailure(EMAIL, T0 + 60_000);
    recordFailure(EMAIL, T0 + 120_000);

    expect(check(EMAIL, T0 + 120_000).resetAt).toBe(firstReset);
  });

  it('reports a retry-after that shrinks as the window drains', () => {
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(EMAIL, T0);

    const early = check(EMAIL, T0 + 1_000).retryAfterSeconds;
    const late = check(EMAIL, T0 + WINDOW_MS - 10_000).retryAfterSeconds;

    expect(early).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
  });
});

describe('SPEC-005 — successful sign-in clears the counter', () => {
  it('forgets the failures so a legitimate user is not left one slip from lockout', () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) recordFailure(EMAIL, T0);
    expect(check(EMAIL, T0).failures).toBe(4);

    clear(EMAIL);

    expect(check(EMAIL, T0).failures).toBe(0);
    expect(check(EMAIL, T0).remaining).toBe(MAX_FAILURES);
  });

  it('clears through the normalised key too', () => {
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(EMAIL, T0);
    clear('  ADA@EXAMPLE.COM ');
    expect(isRateLimited(EMAIL, T0)).toBe(false);
  });
});

describe('the map does not grow without bound', () => {
  it('evicts an expired window on the next read', () => {
    recordFailure(EMAIL, T0);
    expect(size()).toBe(1);

    check(EMAIL, T0 + WINDOW_MS);
    expect(size()).toBe(0);
  });

  it('sweep() collects windows nothing ever reads again', () => {
    // Lazy eviction handles any address that is retried. This handles the one
    // that is not: five failures against a victim, then silence, leaves an
    // entry with nothing to trigger its removal.
    recordFailure('one@example.com', T0);
    recordFailure('two@example.com', T0);
    recordFailure('three@example.com', T0 + WINDOW_MS);
    expect(size()).toBe(3);

    expect(sweep(T0 + WINDOW_MS)).toBe(2);
    expect(size()).toBe(1);
  });
});
