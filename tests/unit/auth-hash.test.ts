/**
 * Password hashing (SPEC-005).
 *
 * Sealed criterion: "A stored password hash starts with `$argon2id$` and never
 * equals the plaintext, asserted by tests/unit/auth-hash.test.ts."
 *
 * That is the floor, and this suite goes past it deliberately. `$argon2id$` as
 * a prefix proves the algorithm and nothing about the cost — a hash written at
 * `m=8, t=1, p=1` carries exactly the same prefix and is crackable on a
 * laptop. So the cost parameters are parsed back out of a REAL hash, not read
 * off `ARGON2_OPTIONS`: a test that asserts a constant against itself proves
 * only that the file was not deleted.
 */

import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_PREFIX,
  ARGON2_OPTIONS,
  dummyHash,
  hashPassword,
  parseHash,
  verifyAgainstDummy,
  verifyPassword,
} from '../../lib/auth/password';

const PASSWORD = 'a reasonably long passphrase';

describe('SPEC-005 — argon2id password hashing', () => {
  it('produces a hash that starts with $argon2id$ and is not the plaintext', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash.startsWith(ARGON2ID_PREFIX)).toBe(true);
    expect(hash).not.toBe(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
  });

  it('encodes OWASP 2024 costs — m=19456, t=2, p=1 — in the hash itself', async () => {
    const parsed = parseHash(await hashPassword(PASSWORD));

    expect(parsed).not.toBeNull();
    expect(parsed?.algorithm).toBe('argon2id');
    // v=19 is 0x13. Asserted as the decimal the encoding actually carries.
    expect(parsed?.version).toBe(19);
    expect(parsed?.memoryCost).toBe(19456);
    expect(parsed?.timeCost).toBe(2);
    expect(parsed?.parallelism).toBe(1);
  });

  it('keeps ARGON2_OPTIONS and the encoded hash in agreement', async () => {
    // The pair of assertions that catches a drift between the constant and
    // reality: the previous test proves the hash is right, this proves the
    // constant other code reads describes the same thing.
    const parsed = parseHash(await hashPassword(PASSWORD));
    expect(parsed?.memoryCost).toBe(ARGON2_OPTIONS.memoryCost);
    expect(parsed?.timeCost).toBe(ARGON2_OPTIONS.timeCost);
    expect(parsed?.parallelism).toBe(ARGON2_OPTIONS.parallelism);
  });

  it('salts every hash — the same password twice gives different strings', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    // A deterministic hash would make the stored column a rainbow-table lookup
    // and would leak which accounts share a password just by comparing rows.
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, PASSWORD)).toBe(true);
    expect(await verifyPassword(b, PASSWORD)).toBe(true);
  });

  it('verifies the right password and rejects near misses', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, `${PASSWORD} `)).toBe(false);
    expect(await verifyPassword(hash, PASSWORD.toUpperCase())).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('preserves leading and trailing whitespace in a password', async () => {
    // The bug this guards: trimming at sign-up but not at sign-in (or the
    // reverse) makes a password that worked once stop working, with no error
    // anyone can act on. Spaces are legitimate passphrase characters.
    const padded = '  spaces matter  ';
    const hash = await hashPassword(padded);

    expect(await verifyPassword(hash, padded)).toBe(true);
    expect(await verifyPassword(hash, padded.trim())).toBe(false);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    // A damaged `passwordHash` column must produce the ordinary sign-in
    // failure. Letting the exception escape would distinguish "this row is
    // broken" from "wrong password" — an enumeration signal, and a 500 shown
    // to a user who did nothing wrong.
    for (const corrupt of ['', 'not-a-hash', '$argon2id$', '$argon2id$v=19$m=1$x$y']) {
      expect(await verifyPassword(corrupt, PASSWORD)).toBe(false);
    }
  });

  it('parseHash rejects anything that is not a well-formed argon2 encoding', () => {
    expect(parseHash('')).toBeNull();
    expect(parseHash('$2b$12$abcdefghijklmnopqrstuv')).toBeNull(); // bcrypt
    expect(parseHash('$argon2id$v=19$m=19456,t=2$salt$tag')).toBeNull(); // no p=
  });

  it('the dummy hash is a real argon2id hash that nothing verifies against', async () => {
    // This is the enumeration defence's raw material. If it were a constant
    // string rather than a real hash, verification against it would fail
    // instantly and the timing equalisation would do nothing.
    const dummy = await dummyHash();

    expect(dummy.startsWith(ARGON2ID_PREFIX)).toBe(true);
    expect(parseHash(dummy)?.memoryCost).toBe(ARGON2_OPTIONS.memoryCost);
    expect(await verifyPassword(dummy, PASSWORD)).toBe(false);
    expect(await verifyAgainstDummy(PASSWORD)).toBe(false);
  });

  it('memoises the dummy hash so the cost is paid once per process', async () => {
    // Not an optimisation for its own sake: a freshly computed dummy on every
    // miss costs a hash PLUS a verify, i.e. roughly double the wrong-password
    // path — which would reintroduce the exact timing tell it exists to erase.
    expect(await dummyHash()).toBe(await dummyHash());
  });
});
