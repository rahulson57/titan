/**
 * Social-link normalization and rendering (SPEC-010).
 *
 * > Social inputs `@name`, `name`, and `https://x.com/name` all normalize to
 * > the stored handle `name`; a `javascript:alert(1)` website value is
 * > rejected with no write.
 *
 * The criterion has two halves and they fail differently, so both are asserted
 * here rather than only the convenient one:
 *
 *   - **Normalization** is a correctness property. Three inputs collapsing to
 *     one stored value is what lets the profile page render a link from a
 *     template instead of parsing whatever a user pasted.
 *   - **Rejection** is a security property. `javascript:` in `User.socials`
 *     becomes an `href` on a public page, which is stored XSS. "No write" is
 *     asserted in `profile-validation.test.ts` against a real row; what is
 *     asserted here is that the value never gets that far.
 *
 * The render half is tested too, because SPEC-010's `rel`/`target` criterion is
 * checked in a browser (`profile-page.spec.ts`) and a browser test can only
 * check the links that happen to be on the page. `hrefFor` refusing a value
 * this module would not have written is the property that has to hold for
 * links nobody thought to seed.
 */

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_SCHEMES,
  GITHUB_HANDLE_PATTERN,
  REL,
  SOCIAL_KEYS,
  TARGET,
  TWITTER_HANDLE_PATTERN,
  WEBSITE_MAX,
  hrefFor,
  labelFor,
  normalizeGithub,
  normalizeSocials,
  normalizeTwitter,
  normalizeWebsite,
  renderableSocials,
} from '../../lib/profile/socials';

// ---------------------------------------------------------------------------
// The criterion, verbatim
// ---------------------------------------------------------------------------

describe('SPEC-010 — @name, name and https://x.com/name all store `name`', () => {
  it.each(['@name', 'name', 'https://x.com/name'])('%s -> name', (input) => {
    expect(normalizeTwitter(input)).toEqual({ ok: true, value: 'name' });
  });

  it('accepts the twitter.com spelling of the same profile', () => {
    // SPEC-010's table names both hosts. A user who has not updated a link
    // since the rename is describing the same account.
    expect(normalizeTwitter('https://twitter.com/name')).toEqual({ ok: true, value: 'name' });
    expect(normalizeTwitter('https://www.twitter.com/name')).toEqual({ ok: true, value: 'name' });
  });

  it('ignores a trailing slash, a query and a fragment', () => {
    expect(normalizeTwitter('https://x.com/name/')).toEqual({ ok: true, value: 'name' });
    expect(normalizeTwitter('https://x.com/name?ref=1')).toEqual({ ok: true, value: 'name' });
    expect(normalizeTwitter('https://x.com/@name')).toEqual({ ok: true, value: 'name' });
  });

  it('stores the same value however many @ the user typed', () => {
    expect(normalizeTwitter('@@name')).toEqual({ ok: true, value: 'name' });
    expect(normalizeTwitter('  @name  ')).toEqual({ ok: true, value: 'name' });
  });
});

describe('SPEC-010 — a javascript: website is rejected', () => {
  it('rejects javascript:alert(1)', () => {
    const result = normalizeWebsite('javascript:alert(1)');
    expect(result.ok).toBe(false);
    // The message must not be the rejected value echoed back — see the note in
    // `normalizeWebsite`. React would escape it safely, but it reads as though
    // the input was understood.
    if (!result.ok) expect(result.message).not.toContain('alert');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/x',
  ])('rejects %s', (input) => {
    expect(normalizeWebsite(input).ok).toBe(false);
  });

  it('never lets a rejected scheme through as a twitter or github value either', () => {
    // The handle fields parse URLs too, so the same hole would exist twice.
    expect(normalizeTwitter('javascript:alert(1)').ok).toBe(false);
    expect(normalizeGithub('javascript:alert(1)').ok).toBe(false);
  });

  it('allows exactly http and https, and nothing else', () => {
    expect([...ALLOWED_SCHEMES]).toEqual(['http:', 'https:']);
    expect(normalizeWebsite('https://ada.example/').ok).toBe(true);
    expect(normalizeWebsite('http://ada.example/').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The stored shapes
// ---------------------------------------------------------------------------

describe('SPEC-010 — stored values match the patterns the spec pins', () => {
  it('uses the spec\'s own patterns', () => {
    expect(TWITTER_HANDLE_PATTERN.source).toBe('^[A-Za-z0-9_]{1,15}$');
    expect(GITHUB_HANDLE_PATTERN.source).toBe('^[A-Za-z0-9-]{1,39}$');
  });

  it('rejects a twitter handle over 15 characters', () => {
    expect(normalizeTwitter('a'.repeat(15))).toEqual({ ok: true, value: 'a'.repeat(15) });
    expect(normalizeTwitter('a'.repeat(16)).ok).toBe(false);
  });

  it('rejects a github handle over 39 characters', () => {
    expect(normalizeGithub('a'.repeat(39))).toEqual({ ok: true, value: 'a'.repeat(39) });
    expect(normalizeGithub('a'.repeat(40)).ok).toBe(false);
  });

  it('keeps the platforms\' character sets apart', () => {
    // A hyphen is legal on GitHub and not on X; an underscore is the reverse.
    // Sharing one pattern would quietly accept a handle that 404s on the
    // platform it links to.
    expect(normalizeGithub('ada-lovelace')).toEqual({ ok: true, value: 'ada-lovelace' });
    expect(normalizeTwitter('ada-lovelace').ok).toBe(false);
    expect(normalizeTwitter('ada_lovelace')).toEqual({ ok: true, value: 'ada_lovelace' });
  });

  it('does not read a handle out of a URL on the wrong host', () => {
    // `https://evil.example/name` must not become `@name` linking to x.com.
    expect(normalizeTwitter('https://evil.example/name').ok).toBe(false);
    expect(normalizeGithub('https://gitlab.com/name').ok).toBe(false);
  });

  it('rejects a platform URL that names no profile', () => {
    expect(normalizeTwitter('https://x.com').ok).toBe(false);
    expect(normalizeTwitter('https://x.com/').ok).toBe(false);
  });

  it('stores the parser\'s canonical form of a website', () => {
    expect(normalizeWebsite('HTTPS://Ada.Example/Path')).toEqual({
      ok: true,
      value: 'https://ada.example/Path',
    });
  });

  it('requires an absolute URL rather than inferring a scheme', () => {
    // SPEC-010's accepted input is "absolute URL". Prefixing `https://` onto a
    // bare host would be this module inventing acceptance the table does not
    // grant — and would turn a typo into a link to a host of that name.
    expect(normalizeWebsite('ada.example').ok).toBe(false);
  });

  it('refuses a website longer than the repository will store', () => {
    // `isValidSocial` in lib/db/users.ts drops anything over 200 characters. A
    // value accepted here and dropped there is a save that reports success and
    // stores nothing.
    const long = `https://ada.example/${'a'.repeat(WEBSITE_MAX)}`;
    expect(normalizeWebsite(long).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty means "clear it", not "invalid"
// ---------------------------------------------------------------------------

describe('SPEC-010 — an empty field clears the link', () => {
  it.each(SOCIAL_KEYS)('%s: empty is a valid save that stores nothing', (key) => {
    const result = normalizeSocials({ [key]: '   ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });

  it('omits absent keys rather than storing empty strings', () => {
    const result = normalizeSocials({ twitter: 'ada' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ twitter: 'ada' });
  });
});

describe('normalizeSocials collects every failure at once', () => {
  it('reports all three rather than only the first', () => {
    const result = normalizeSocials({
      twitter: 'way-too-long-for-x-and-hyphenated',
      github: 'https://gitlab.com/ada',
      website: 'javascript:alert(1)',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field)).toEqual(['twitter', 'github', 'website']);
    }
  });

  it('writes nothing for the good fields when another one fails', () => {
    // The caller must not be able to half-apply a submission: SPEC-010's
    // criterion is "rejected with no write".
    const result = normalizeSocials({ twitter: 'ada', website: 'javascript:alert(1)' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering — the second half of the defence
// ---------------------------------------------------------------------------

describe('SPEC-010 — rendering re-derives the URL from the stored value', () => {
  it('renders the documented URL for each key', () => {
    expect(hrefFor('twitter', 'ada')).toBe('https://x.com/ada');
    expect(hrefFor('github', 'ada')).toBe('https://github.com/ada');
    expect(hrefFor('website', 'https://ada.example/')).toBe('https://ada.example/');
  });

  it('renders nothing for a stored value it would not have written', () => {
    // The scenario: a row written by something other than `normalizeSocials` —
    // the seed, an import, a future migration. `User.socials` is free-form
    // TEXT, so this is reachable without any bug in the write path.
    expect(hrefFor('website', 'javascript:alert(1)')).toBeNull();
    expect(hrefFor('website', 'data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(hrefFor('twitter', 'javascript:alert(1)')).toBeNull();
    expect(hrefFor('twitter', 'https://evil.example/ada')).toBeNull();
    expect(hrefFor('github', '../../etc/passwd')).toBeNull();
  });

  it.each([null, undefined, '', '   '])('renders nothing for %p', (stored) => {
    expect(hrefFor('website', stored)).toBeNull();
  });

  it('drops unsafe values from the rendered list without dropping the safe ones', () => {
    const links = renderableSocials({
      twitter: 'ada',
      github: 'javascript:alert(1)',
      website: 'https://ada.example/',
    });
    expect(links.map((l) => l.key)).toEqual(['twitter', 'website']);
    expect(links.every((l) => l.href.startsWith('https://'))).toBe(true);
  });

  it.each([null, undefined, {}])('renders no links for %p', (stored) => {
    expect(renderableSocials(stored)).toEqual([]);
  });

  it('labels a handle with an @ and a website with its host', () => {
    expect(labelFor('twitter', 'ada')).toBe('@ada');
    expect(labelFor('github', 'ada')).toBe('@ada');
    expect(labelFor('website', 'https://www.ada.example/deep/path')).toBe('ada.example');
  });

  it('pins the rel and target SPEC-010 requires', () => {
    // Asserted as a constant because the browser test can only check the links
    // that happen to be rendered on the page it visits.
    expect(REL.split(' ').sort()).toEqual(['nofollow', 'noopener', 'noreferrer']);
    expect(TARGET).toBe('_blank');
  });
});
