/**
 * Sign-up validation rules (SPEC-005, "Validation rules").
 *
 * Two sealed criteria land here:
 *
 *   - "Passwords shorter than 8 chars or present in the denylist are rejected
 *      at signup with a field-level error."
 *   - "Reserved handles (`admin`, `api`, `me`, `settings`, `new`, `search`,
 *      `tag`) and handles failing `^[a-z0-9_]{3,24}$` are rejected at signup."
 *
 * Both are asserted through `validateSignUp` — the function the Server Action
 * actually calls — rather than by re-implementing the regex here. A test that
 * re-states the rule it is checking passes whatever the rule becomes.
 */

import { describe, expect, it } from 'vitest';

import {
  HANDLE_PATTERN,
  PASSWORD_MAX,
  PASSWORD_MIN,
  RESERVED_HANDLES,
  isReservedHandle,
  normalizeEmail,
  normalizeHandle,
  validateHandle,
  validatePassword,
  validateSignInShape,
  validateSignUp,
} from '../../lib/auth/validation';
import {
  WEAK_PASSWORDS,
  WEAK_PASSWORD_COUNT,
  denylistIntegrity,
  isWeakPassword,
} from '../../lib/auth/weak-passwords';

const VALID = {
  email: 'Ada@Example.COM',
  password: 'a reasonably long passphrase',
  name: 'Ada Lovelace',
  handle: 'ada_l',
};

/** Every error field reported for an input, for compact assertions. */
function fieldsRejected(input: Partial<typeof VALID>): string[] {
  const result = validateSignUp({ ...VALID, ...input });
  return result.ok ? [] : result.errors.map((e) => e.field);
}

describe('SPEC-005 — a valid sign-up', () => {
  it('accepts and normalises', () => {
    const result = validateSignUp(VALID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBe('ada@example.com');
    expect(result.value.handle).toBe('ada_l');
    expect(result.value.name).toBe('Ada Lovelace');
    // The password is passed through untouched — see auth-hash.test.ts for why.
    expect(result.value.password).toBe(VALID.password);
  });

  it('reports EVERY field-level problem at once, not just the first', () => {
    // A form that surfaces one error per submission is a form the user submits
    // four times. This is the behavioural reason validation returns a list.
    const fields = fieldsRejected({
      email: 'nope',
      password: 'short',
      name: '   ',
      handle: 'ADMIN',
    });

    expect(new Set(fields)).toEqual(new Set(['email', 'password', 'name', 'handle']));
  });
});

describe('SPEC-005 — password rules', () => {
  it(`rejects anything shorter than ${PASSWORD_MIN} characters`, () => {
    for (const password of ['', 'a', '1234567']) {
      expect(fieldsRejected({ password })).toContain('password');
    }
    // The boundary itself, both sides.
    expect(fieldsRejected({ password: 'x'.repeat(PASSWORD_MIN - 1) })).toContain('password');
    expect(fieldsRejected({ password: 'x'.repeat(PASSWORD_MIN) })).not.toContain('password');
  });

  it(`rejects anything longer than ${PASSWORD_MAX} characters`, () => {
    // An upper bound is not pedantry: argon2 hashes whatever it is given, so an
    // unbounded field lets one request burn arbitrary memory-hard work.
    expect(fieldsRejected({ password: 'x'.repeat(PASSWORD_MAX) })).not.toContain('password');
    expect(fieldsRejected({ password: 'x'.repeat(PASSWORD_MAX + 1) })).toContain('password');
  });

  it('rejects every entry on the denylist', () => {
    // Length and denylist are independent rules. Entries shorter than the
    // minimum are checked through `isWeakPassword` directly so a future change
    // to PASSWORD_MIN cannot silently un-ban `123456`.
    for (const weak of WEAK_PASSWORDS) {
      expect(isWeakPassword(weak), `${weak} should be denied`).toBe(true);
      if (weak.length >= PASSWORD_MIN) {
        expect(fieldsRejected({ password: weak }), `${weak} at signup`).toContain('password');
      }
    }
  });

  it('matches the denylist case-insensitively', () => {
    // `Password` is the single most common mutation in every cracking ruleset;
    // one entry has to cover the family or 200 entries are worth far less.
    expect(isWeakPassword('PASSWORD')).toBe(true);
    expect(isWeakPassword('Password123')).toBe(true);
    expect(isWeakPassword('  qwerty123  ')).toBe(true);
  });

  it('holds exactly 200 unique, already-normalised entries', () => {
    // SPEC-005 fixes the size, so it is assertable rather than approximate.
    const integrity = denylistIntegrity();
    expect(integrity.count).toBe(WEAK_PASSWORD_COUNT);
    expect(integrity.unique).toBe(WEAK_PASSWORD_COUNT);
    // An entry like `Password` could never match, because the candidate is
    // lowercased before lookup — it would be a silent hole in the list.
    expect(integrity.unnormalized).toEqual([]);
  });

  it('does not deny the seeded demo password', () => {
    // SPEC-005 seeds `demo@titan.local` / `titan1234`. Denylisting it would
    // make the seed corpus unreproducible through the sign-up path.
    expect(isWeakPassword('titan1234')).toBe(false);
    expect(validatePassword('titan1234')).toBeNull();
  });

  it('imposes no composition rules (NIST 800-63B)', () => {
    // A long all-lowercase passphrase is strong and must be accepted; the
    // rejected classic satisfies every legacy composition rule and is on the
    // list precisely because it is guessed constantly.
    expect(validatePassword('correct horse battery staple')).toBeNull();
    expect(validatePassword('passw0rd')).not.toBeNull();
  });
});

describe('SPEC-005 — handle rules', () => {
  it('rejects all seven reserved handles', () => {
    expect([...RESERVED_HANDLES].sort()).toEqual(
      ['admin', 'api', 'me', 'new', 'search', 'settings', 'tag'].sort(),
    );

    for (const handle of RESERVED_HANDLES) {
      expect(isReservedHandle(handle), handle).toBe(true);
      expect(fieldsRejected({ handle }), handle).toContain('handle');
      // And through the casing and `@` forms a pasted URL produces.
      expect(fieldsRejected({ handle: handle.toUpperCase() })).toContain('handle');
      expect(fieldsRejected({ handle: `@${handle}` })).toContain('handle');
    }
  });

  it('rejects handles failing ^[a-z0-9_]{3,24}$', () => {
    const bad = [
      'ab', // too short
      'a'.repeat(25), // too long
      'has space',
      'has-hyphen',
      'has.dot',
      'has$ymbol',
      'émile', // non-ASCII
      '', // empty
    ];

    for (const handle of bad) {
      expect(HANDLE_PATTERN.test(handle), `${handle} vs pattern`).toBe(false);
      expect(fieldsRejected({ handle }), handle).toContain('handle');
    }
  });

  it('accepts the boundary lengths', () => {
    expect(validateHandle('abc')).toBeNull();
    expect(validateHandle('a'.repeat(24))).toBeNull();
    expect(validateHandle('a'.repeat(25))).not.toBeNull();
  });

  it('normalises casing and a leading @ before deciding', () => {
    // `/@Ada` and `ada` must resolve to one identity, or the unique index is
    // decided on a form the app does not consistently produce.
    expect(normalizeHandle('  @ADA_L ')).toBe('ada_l');
    expect(validateHandle('@ADA_L')).toBeNull();
  });

  it('reports the malformation, not the reservation, when a handle is both', () => {
    // `ADMIN` normalises to a reserved name; `ad min` is malformed. The more
    // actionable message is the one the user can act on.
    expect(validateHandle('ADMIN')?.message).toMatch(/reserved/i);
    expect(validateHandle('ad min')?.message).toMatch(/3–24|characters/i);
  });
});

describe('SPEC-005 — email rules', () => {
  it('normalises to lowercase and trims before uniqueness is decided', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('rejects obvious junk', () => {
    for (const email of ['', 'nope', 'a@b', 'a b@c.com', '@example.com', 'a@.com']) {
      expect(fieldsRejected({ email }), email).toContain('email');
    }
  });

  it('accepts ordinary addresses', () => {
    for (const email of ['a@b.co', 'ada.lovelace+titan@example.co.uk']) {
      expect(fieldsRejected({ email }), email).not.toContain('email');
    }
  });
});

describe('SPEC-005 — sign-in checks only that both boxes are filled', () => {
  it('does not apply the sign-up password rules', () => {
    // Applying them would split the single generic failure into per-field
    // messages, which is an enumeration signal: "that password is too common"
    // on a stored account says the account exists.
    expect(validateSignInShape('ada@example.com', '123')).toBe(true);
    expect(validateSignInShape('ada@example.com', 'password')).toBe(true);
  });

  it('rejects an empty email or password', () => {
    expect(validateSignInShape('', 'anything')).toBe(false);
    expect(validateSignInShape('  ', 'anything')).toBe(false);
    expect(validateSignInShape('ada@example.com', '')).toBe(false);
  });
});
