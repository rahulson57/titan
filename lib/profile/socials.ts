/**
 * Social-link normalization and rendering (SPEC-010, "Social links").
 *
 * | Key       | Accepted input                                  | Stored                            | Rendered as                    |
 * |-----------|-------------------------------------------------|-----------------------------------|--------------------------------|
 * | `twitter` | `@name`, `name`, or a `twitter.com`/`x.com` URL | bare handle, `^[A-Za-z0-9_]{1,15}$` | `https://x.com/<handle>`     |
 * | `github`  | `name` or a `github.com` URL                    | bare handle, `^[A-Za-z0-9-]{1,39}$` | `https://github.com/<handle>`|
 * | `website` | absolute URL                                    | URL with scheme `https:`/`http:` only | the URL itself             |
 *
 * Pure functions over strings — no database, no `next/*`, no React. The same
 * verdict is therefore reachable from the server action, from the unit suite,
 * and from the component that renders the result, which is what stops the
 * three from disagreeing about what a valid link is.
 *
 * ── Why normalization is a WRITE-time concern ─────────────────────────────
 * SPEC-010 puts it plainly: "Each value is normalized and validated at write
 * time" and "Any URL whose scheme is not `http`/`https` … is rejected at write
 * time — it never reaches the DB." Storing the bare handle rather than
 * whatever the user pasted means the render is a template, not a parse: three
 * inputs (`@ada`, `ada`, `https://x.com/ada`) collapse to one stored value, so
 * the profile page cannot be handed a string it has to decide about.
 *
 * ── The two-sided defence, and why the render side is not redundant ───────
 * `hrefFor` re-derives the URL from the stored value and returns `null` when
 * that value is not one this module would have written. That looks like belt
 * and braces over `normalizeSocials`, and it is deliberate:
 *
 *   - `User.socials` is a TEXT column of free-form JSON. Rows exist that this
 *     module never wrote — the seed corpus writes it directly, and any future
 *     import or migration could too.
 *   - The failure mode is stored XSS. A `javascript:` string that reached the
 *     column would become an `href` a reader clicks, and by then it is just a
 *     string that came out of the database with no memory of how it got there.
 *
 * A validator at the write boundary alone is one edit away from being bypassed.
 * A renderer that refuses to emit anything it cannot re-derive cannot be.
 *
 * ── `rel` and `target` are not styling ────────────────────────────────────
 * `REL` is exported as one constant because SPEC-010 requires all three tokens
 * on every outbound link, and its oracle checks for all three. Spelled per call
 * site, the fourth link is the one that gets two of them.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The three keys `User.socials` may carry (SPEC-004 / SPEC-010). */
export const SOCIAL_KEYS = ['twitter', 'github', 'website'] as const;

export type SocialKey = (typeof SOCIAL_KEYS)[number];

/** The stored shape, mirroring `SocialLinks` in `lib/db/users.ts`. */
export type StoredSocials = Partial<Record<SocialKey, string>>;

/**
 * The outcome of normalizing ONE field.
 *
 * `ok: true` with `value: null` is the third case and it is not an error: an
 * empty input means "I have no Twitter", which is a legitimate save that
 * clears the key. Collapsing it into a rejection would make a profile with a
 * link impossible to turn back into a profile without one.
 */
export type NormalizeResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// The stored shapes, verbatim from SPEC-010
// ---------------------------------------------------------------------------

export const TWITTER_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
export const GITHUB_HANDLE_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

/**
 * The only two schemes any stored value may carry.
 *
 * This is the load-bearing line of the module. Everything else here is about
 * tidiness; this is about not shipping a stored-XSS vector on a public page.
 */
export const ALLOWED_SCHEMES: readonly string[] = Object.freeze(['http:', 'https:']);

/** SPEC-010: every outbound social link carries all three tokens. */
export const REL = 'nofollow noopener noreferrer';

/** SPEC-010: and opens in a new tab. */
export const TARGET = '_blank';

/**
 * A cap on the stored website URL.
 *
 * `lib/db/users.ts`'s `isValidSocial` refuses anything over 200 characters, and
 * a value this module accepts that the repository then silently drops would be
 * a save that reports success and stores nothing. The two bounds are the same
 * number on purpose.
 */
export const WEBSITE_MAX = 200;

/**
 * Hosts recognised as "a `twitter.com`/`x.com` URL" and "a `github.com` URL".
 *
 * `www.` is included because `https://www.github.com/ada` is the same link a
 * user copied from their browser; nothing else is, because everything else
 * would be this module inventing acceptance the spec's table does not grant.
 */
const TWITTER_HOSTS: ReadonlySet<string> = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse `value` as an absolute URL, or return `null`.
 *
 * `new URL` throws on a relative reference, which is the whole point: a bare
 * `ada` is not a URL and must fall through to the handle branch rather than
 * being resolved against some base this module would have had to invent.
 */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Is this URL one whose scheme SPEC-010 permits to be stored and rendered? */
export function hasAllowedScheme(url: URL): boolean {
  return ALLOWED_SCHEMES.includes(url.protocol);
}

/**
 * The first path segment of a profile URL — `ada` in `https://x.com/ada/`.
 *
 * Returns `null` for a URL with no path (`https://x.com`), which names the
 * platform rather than a person and has no handle to extract.
 */
function firstPathSegment(url: URL): string | null {
  const [segment] = url.pathname.split('/').filter((part) => part.length > 0);
  return segment ?? null;
}

/** Strip any number of leading `@`, so `@@ada` and `@ada` agree. */
function stripAt(value: string): string {
  return value.replace(/^@+/, '');
}

// ---------------------------------------------------------------------------
// Per-key normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a platform handle that may arrive bare, `@`-prefixed, or as a URL.
 *
 * The order of the branches matters. The bare-handle test runs FIRST, so a
 * value that is already a handle is never handed to `new URL` — which would
 * happily parse `mailto:ada` or `x:ada` as a URL with a scheme and send it
 * down the wrong path. Only a value that cannot be a handle is treated as a
 * URL, and only a URL on the platform's own host yields a handle.
 */
function normalizeHandleField(
  raw: string,
  input: {
    hosts: ReadonlySet<string>;
    pattern: RegExp;
    /** What to tell the user, naming the shapes the spec's table accepts. */
    message: string;
  },
): NormalizeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  const bare = stripAt(trimmed);
  if (input.pattern.test(bare)) return { ok: true, value: bare };

  const url = parseUrl(trimmed);
  if (url && hasAllowedScheme(url) && input.hosts.has(url.hostname.toLowerCase())) {
    const segment = firstPathSegment(url);
    if (segment !== null) {
      // Decode `%40ada` and friends before matching, so a browser-copied URL
      // is judged on the handle it names rather than on its encoding.
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        /* malformed escape: judge the raw segment, which will fail the pattern */
      }
      const handle = stripAt(decoded);
      if (input.pattern.test(handle)) return { ok: true, value: handle };
    }
  }

  return { ok: false, message: input.message };
}

/** SPEC-010: `@name`, `name`, or a `twitter.com`/`x.com` URL → bare handle. */
export function normalizeTwitter(raw: string): NormalizeResult {
  return normalizeHandleField(raw, {
    hosts: TWITTER_HOSTS,
    pattern: TWITTER_HANDLE_PATTERN,
    message:
      'Enter an X handle like @name, or the full link to your profile. ' +
      'Handles are up to 15 letters, numbers or underscores.',
  });
}

/** SPEC-010: `name` or a `github.com` URL → bare handle. */
export function normalizeGithub(raw: string): NormalizeResult {
  return normalizeHandleField(raw, {
    hosts: GITHUB_HOSTS,
    pattern: GITHUB_HANDLE_PATTERN,
    message:
      'Enter a GitHub username, or the full link to your profile. ' +
      'Usernames are up to 39 letters, numbers or hyphens.',
  });
}

/**
 * SPEC-010: an absolute URL, stored with an `https:`/`http:` scheme only.
 *
 * A scheme is REQUIRED rather than inferred. `example.com` is not an absolute
 * URL, and prefixing `https://` onto whatever the user typed would be this
 * module deciding something the spec's table does not say — it would also
 * silently turn a typo'd `javascript:alert(1) ` into a link to a host called
 * `javascript:alert(1)`. Saying "start it with https://" is one sentence and
 * cannot be wrong.
 *
 * `url.href` is stored rather than the raw input, so the value is the parser's
 * own canonical form: the scheme and host are lowercased and the syntax is
 * whatever a browser will actually resolve. A stored string that differs from
 * what the parser makes of it is a string two readers can disagree about.
 */
export function normalizeWebsite(raw: string): NormalizeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  const url = parseUrl(trimmed);
  if (!url) {
    return { ok: false, message: 'Enter a full web address, starting with https://' };
  }
  if (!hasAllowedScheme(url)) {
    // The message names the rule rather than the rejected scheme. Echoing
    // `javascript:` back into the page is safe (React escapes it) but it reads
    // as though the value was understood, and it is not information the person
    // typing a normal URL ever needs.
    return { ok: false, message: 'Links must start with https:// or http://' };
  }
  if (url.href.length > WEBSITE_MAX) {
    return { ok: false, message: `Use at most ${WEBSITE_MAX} characters.` };
  }
  return { ok: true, value: url.href };
}

/** The normalizer for each key, so callers iterate rather than branch. */
const NORMALIZERS: Record<SocialKey, (raw: string) => NormalizeResult> = {
  twitter: normalizeTwitter,
  github: normalizeGithub,
  website: normalizeWebsite,
};

export function normalizeSocial(key: SocialKey, raw: string): NormalizeResult {
  return NORMALIZERS[key](raw);
}

// ---------------------------------------------------------------------------
// The whole group
// ---------------------------------------------------------------------------

export interface SocialFieldError {
  field: SocialKey;
  message: string;
}

export type SocialsResult =
  | { ok: true; value: StoredSocials }
  | { ok: false; errors: SocialFieldError[] };

/**
 * Normalize all three fields, collecting EVERY failure.
 *
 * Not first-failure-wins: a form that reports one bad field, gets it fixed and
 * then reports the next is a form the user submits three times.
 *
 * A key that normalizes to `null` is omitted from the result rather than
 * stored as an empty string, so `{}` is the canonical "no links" value — the
 * same convention `serializeSocials` in `lib/db/users.ts` already keeps.
 */
export function normalizeSocials(input: Partial<Record<SocialKey, string>>): SocialsResult {
  const value: StoredSocials = {};
  const errors: SocialFieldError[] = [];

  for (const key of SOCIAL_KEYS) {
    const result = normalizeSocial(key, input[key] ?? '');
    if (!result.ok) {
      errors.push({ field: key, message: result.message });
      continue;
    }
    if (result.value !== null) value[key] = result.value;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The outbound URL for a stored value, or `null` if it is not renderable.
 *
 * Every stored value is re-validated here. See the module header: this is the
 * half that holds when a row was written by something other than
 * `normalizeSocials`, and it is what makes a `javascript:` value in the column
 * a link that does not render rather than a link that fires.
 */
export function hrefFor(key: SocialKey, stored: string | null | undefined): string | null {
  if (typeof stored !== 'string') return null;
  const value = stored.trim();
  if (value.length === 0) return null;

  if (key === 'website') {
    const url = parseUrl(value);
    return url && hasAllowedScheme(url) && url.href.length <= WEBSITE_MAX ? url.href : null;
  }

  // A handle key must hold a bare handle. Anything else — including a full URL
  // that an older write may have stored — is refused rather than guessed at,
  // because guessing is how a URL-shaped value gets concatenated onto
  // `https://x.com/` and produces a link to somewhere else entirely.
  if (key === 'twitter') {
    return TWITTER_HANDLE_PATTERN.test(value) ? `https://x.com/${value}` : null;
  }
  return GITHUB_HANDLE_PATTERN.test(value) ? `https://github.com/${value}` : null;
}

/** What the link says: `@ada` for a handle, the host for a website. */
export function labelFor(key: SocialKey, stored: string): string {
  if (key === 'website') {
    const url = parseUrl(stored);
    // The host alone, without `www.`: a profile listing a 90-character URL
    // reads as a paste accident, and the href still carries the whole thing.
    return url ? url.hostname.replace(/^www\./, '') : stored;
  }
  return `@${stored}`;
}

/** The human name of the platform, for the link's accessible name. */
export const SOCIAL_TITLES: Record<SocialKey, string> = {
  twitter: 'X',
  github: 'GitHub',
  website: 'Website',
};

export interface RenderableSocial {
  key: SocialKey;
  href: string;
  label: string;
  title: string;
}

/**
 * The links a profile should render, in SPEC-010's key order, skipping every
 * value that does not survive `hrefFor`.
 *
 * One function so the page has no branching to get wrong, and so "an unsafe
 * stored value renders nothing at all" is a property of a unit-testable
 * function rather than of JSX.
 */
export function renderableSocials(stored: StoredSocials | null | undefined): RenderableSocial[] {
  if (!stored) return [];
  const out: RenderableSocial[] = [];
  for (const key of SOCIAL_KEYS) {
    const href = hrefFor(key, stored[key]);
    if (href === null) continue;
    const raw = stored[key];
    if (raw === undefined) continue;
    out.push({ key, href, label: labelFor(key, raw.trim()), title: SOCIAL_TITLES[key] });
  }
  return out;
}
