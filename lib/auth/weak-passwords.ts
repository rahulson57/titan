/**
 * The common-password denylist (SPEC-005).
 *
 * > Password: 8–200 chars, checked against a 200-entry common-password
 * > denylist (`lib/auth/weak-passwords.ts`). No composition rules (NIST
 * > 800-63B).
 *
 * The absence of composition rules is the point, not an omission. NIST 800-63B
 * §5.1.1.2 dropped "must contain an uppercase letter and a symbol" because
 * those rules push users toward `Passw0rd!` — a password that satisfies every
 * rule and is in every cracking dictionary. What replaces them is a check
 * against passwords that are actually known to be common, which is this list.
 *
 * ── Why the list is a literal, and why it is exactly 200 ────────────────────
 * SPEC-005 fixes the size at 200, so the count is an assertable property
 * rather than "roughly the top few hundred" — `auth-validation.test.ts` counts
 * it. It is a source literal rather than a downloaded corpus because SPEC-001
 * forbids an external network dependency and the tests block outbound fetch
 * outright; a list that has to be fetched is a list that cannot be checked on
 * a clean clone.
 *
 * ── Matching is case-insensitive, and that is deliberate ────────────────────
 * `PASSWORD` and `Password` are the same guess to an attacker — capitalising
 * the first letter is the single most common mutation in every cracking
 * ruleset. Storing the list lowercased and lowercasing the candidate means one
 * entry covers the whole family, which is what makes 200 entries worth more
 * than 200 exact strings.
 *
 * What this is NOT: a breach-corpus check. 200 entries deters the top of the
 * guess distribution and nothing more. A deployment facing real credential
 * stuffing needs a k-anonymity range query against a breach service — which is
 * exactly the external dependency this app does not have (DEC-005 accepts this
 * trade-off in writing).
 *
 * Note the seeded demo password `titan1234` is deliberately absent: it is a
 * local fixture credential (SPEC-005, "Seeded demo accounts") and denylisting
 * it would make the seed corpus unreproducible through the sign-up path.
 */

/**
 * 200 of the most commonly chosen passwords, lowercased.
 *
 * Sourced from the recurring head of published breach-frequency lists (the
 * `rockyou`-derived top-N that every annual "worst passwords" roundup
 * re-reports). Entries shorter than 8 characters are kept even though the
 * length rule already rejects them — the two rules are independent, and a
 * later change to the minimum length must not silently un-ban `123456`.
 */
export const WEAK_PASSWORDS: readonly string[] = Object.freeze([
  '123456', 'password', '123456789', '12345678', '12345', '111111', '1234567',
  'sunshine', 'qwerty', 'iloveyou', 'princess', 'admin', 'welcome', '666666', 'abc123',
  'football', '123123', 'monkey', '654321', '!@#$%^&*', 'charlie', 'aa123456',
  'donald', 'password1', 'qwerty123', '1234', '1q2w3e4r', 'qwertyuiop', '123321',
  'password123', '1q2w3e', 'zxcvbnm', '121212', 'bailey', 'freedom', 'shadow',
  'passw0rd', 'master', 'baseball', 'buster', 'daniel', 'hannah', 'thomas', 'summer',
  'george', 'harley', 'letmein', 'dragon', 'jessica', 'michael', 'superman',
  'trustno1', 'hunter', 'ranger', 'jordan', 'michelle', 'loveme', 'ferrari', 'cookie',
  'computer', 'corvette', 'mercedes', 'flower', 'hello', 'chelsea', 'biteme',
  'matthew', 'access', 'yankees', '987654321', 'dallas', 'austin', 'thunder', 'taylor',
  'matrix', 'mustang', 'starwars', '112233', 'asshole', 'fuckyou', 'dolphin', 'maggie',
  'pepper', '1111', 'nicole', 'chicken', 'soccer', 'hockey', 'killer', 'andrew',
  'tigger', 'jennifer', 'joshua', 'love', 'robert', 'amanda', 'anthony', 'liverpool',
  'batman', 'ashley', 'arsenal', 'nathan', 'jasper', 'samantha', 'ginger', 'cheese',
  'internet', 'service', 'canada', 'hello123', 'whatever', 'diamond', 'phoenix',
  'silver', 'richard', 'fuckme', 'orange', 'merlin', 'bigdog', 'cheyenne', 'chester',
  'porsche', 'jackson', 'jasmine', 'martin', 'heather', 'william', 'junior', 'hawaii',
  'nirvana', 'test', 'testing', 'testtest', 'temp', 'temporary', 'guest', 'default',
  'changeme', 'secret', 'secret123', 'letmein123', 'welcome1', 'welcome123',
  'admin123', 'administrator', 'root', 'toor', 'adminadmin', 'pass1234', 'pass123',
  'abcd1234', 'abcdefgh', 'a1b2c3d4', 'qazwsx', 'qazwsxedc', 'zaq12wsx', '1qaz2wsx',
  'asdfghjkl', 'asdfasdf', 'qwerty1', 'qwerty12', 'poiuytrewq', 'lkjhgfdsa',
  '1234qwer', 'qwer1234', '11111111', '00000000', '12341234', '123456a', '123456789a',
  '1234567890', '0987654321', '55555555', '77777777', '88888888', '99999999',
  '87654321', '147258369', '159753', '741852963', 'iloveyou1', 'blink182', 'metallica',
  'slipknot', 'nintendo', 'pokemon', 'minecraft', 'starcraft', 'warcraft', 'fortnite',
  'pikachu', 'sonic', 'spiderman', 'cocacola', 'chocolate', 'butterfly', 'purple',
  'rainbow', 'january', 'december',
]);

/** Fixed by SPEC-005: "a 200-entry common-password denylist". */
export const WEAK_PASSWORD_COUNT = 200;

/**
 * Membership as a Set, built once. The lookup runs on the sign-up and
 * password-change paths, so an O(n) `includes` over 200 entries would be
 * cheap — but this also makes duplicate entries impossible to hide: a list
 * with a repeat yields a smaller Set, which `assertDenylistIntegrity` catches.
 */
const DENYLIST = new Set(WEAK_PASSWORDS);

/**
 * Is this password on the denylist?
 *
 * Trimmed and lowercased before lookup, for the reason in the module note:
 * `Password`, `PASSWORD ` and `password` are one guess, not three.
 */
export function isWeakPassword(password: string): boolean {
  return DENYLIST.has(password.trim().toLowerCase());
}

/**
 * Structural check on the list itself, exposed so a test can state it rather
 * than re-deriving it. Returns the properties SPEC-005 fixes: the entry count,
 * the deduplicated count, and any entry that is not already normalised.
 *
 * A denylist that quietly shrank to 180 entries, or that contained `Password`
 * (which `isWeakPassword` could never match, because it lowercases the
 * candidate), would still pass every behavioural test — the list would just
 * silently stop covering what it claims to. This makes that visible.
 */
export function denylistIntegrity(): {
  count: number;
  unique: number;
  unnormalized: string[];
} {
  return {
    count: WEAK_PASSWORDS.length,
    unique: DENYLIST.size,
    unnormalized: WEAK_PASSWORDS.filter((entry) => entry !== entry.trim().toLowerCase()),
  };
}
