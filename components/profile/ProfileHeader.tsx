/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every component file here
   carries them. They pin esbuild's JSX runtime for the Vitest transform and
   leave Next's own build untouched. */

/**
 * The top of a public profile (SPEC-010, `/@[handle]`).
 *
 * | Region   | Contents                                                              |
 * |----------|-----------------------------------------------------------------------|
 * | Cover    | `coverPath` if set (3:1 crop box), else a token-derived gradient       |
 * | Identity | Avatar (128px, circular), display name, `@handle`, bio, social links  |
 * | Stats    | follower count, articles published                                    |
 * | Action   | Follow / Following toggle — own profile shows **Edit profile** instead |
 *
 * Presentational and synchronous. Every count and every row is resolved by the
 * page; this file renders what it is handed, which is what lets it be reasoned
 * about — and rendered — without a database.
 *
 * ── The cover placeholder is an element, not a fallback image ─────────────
 * SPEC-010: "else a token-derived gradient placeholder — **never a broken
 * image**", and its oracle is "renders the gradient placeholder element and
 * issues zero failed image requests". So the no-cover branch emits no `<img>`
 * and no `background-image: url(...)` at all — not a placeholder file, not an
 * empty `src`. `<img src="">` is the specific trap: browsers resolve it
 * against the current document and re-request the page itself, which is a
 * failed image request that no visual inspection reveals.
 *
 * The gradient is built from `--accent` and `--bg-subtle` so it re-themes with
 * everything else rather than being two hex values that look wrong in dark
 * mode. It is `aria-hidden`: it carries no information, and announcing
 * "image" to a screen reader for a decorative band is noise.
 *
 * ── Why the avatar is not `components/ui/Avatar` ──────────────────────────
 * SPEC-010 fixes the profile avatar at 128px. `Avatar`'s scale is 24/40/64,
 * and its size is set by `--avatar-size` declared ON `.avatar` itself, so an
 * ancestor cannot override it — a wrapper setting the variable loses to the
 * component's own declaration. Adding an `.avatar--xl` rule would be the right
 * fix, but `app/globals.css` is SPEC-003's file and outside this slice's
 * scope, and a 128px avatar is not this task's licence to edit the design
 * system. So the element is rendered here at the size the spec names, reusing
 * `initials()` — the part that actually holds a rule — from the design system
 * rather than reimplementing it. Worth folding back into `Avatar` as an `xl`
 * size when SPEC-003 next opens.
 *
 * ── The action slot, and why Follow is not built here ─────────────────────
 * SPEC-009 owns "the clap/bookmark/follow mutations" and TASK-009 is in
 * flight. Building a second follow action here would duplicate work that is
 * coming and leave two mutations to keep in agreement. So `action` is a slot,
 * exactly as `ArticleCard.actions` is a slot "for engagement controls owned by
 * SPEC-009", and the page fills it. The one thing this component DOES enforce
 * is the half of the rule that is Profiles' own: `isOwner` renders **Edit
 * profile** and never a follow control, so a self-follow button cannot appear
 * however the slot is filled.
 */

import type { CSSProperties, ReactNode } from 'react';

import { SocialLinks } from './SocialLinks';
import { initials } from '../ui/Avatar';
import type { StoredSocials } from '../../lib/profile/socials';
import { SETTINGS_PROFILE } from '../../lib/routes';

export interface ProfileHeaderProps {
  name: string;
  handle: string;
  bio: string | null;
  avatarPath: string | null;
  coverPath: string | null;
  socials: StoredSocials | null | undefined;
  /** Live `COUNT(*)` of followers (SPEC-010's Stats row). */
  followerCount: number;
  /** `COUNT(*) WHERE status='PUBLISHED'` for this author. */
  publishedCount: number;
  /** Is the viewer this profile's owner? Decides Edit profile vs the slot. */
  isOwner: boolean;
  /** The Follow / Following control, supplied by the page. Ignored when owner. */
  action?: ReactNode;
}

/** SPEC-010: the cover sits in a 3:1 crop box. */
const COVER_ASPECT = '3 / 1';

const wrapperStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)',
};

const coverBoxStyle: CSSProperties = {
  aspectRatio: COVER_ASPECT,
  inlineSize: '100%',
  overflow: 'hidden',
  borderRadius: 'var(--radius-md)',
  backgroundColor: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
};

const coverImageStyle: CSSProperties = {
  inlineSize: '100%',
  blockSize: '100%',
  objectFit: 'cover',
  display: 'block',
};

const coverPlaceholderStyle: CSSProperties = {
  ...coverBoxStyle,
  // Token-derived, so it re-themes. `color-mix` keeps the band quiet rather
  // than painting a saturated accent stripe across the top of every profile.
  backgroundImage:
    'linear-gradient(120deg, color-mix(in srgb, var(--accent) 22%, var(--bg-subtle)), var(--bg-subtle) 65%, color-mix(in srgb, var(--accent) 10%, var(--bg-subtle)))',
};

const identityStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--space-5)',
  marginBlockStart: 'calc(-1 * var(--space-7))',
  padding: '0 var(--space-5)',
  flexWrap: 'wrap',
};

/** SPEC-010: "Avatar (128px, circular)". */
const AVATAR_SIZE = '128px';

const avatarStyle: CSSProperties = {
  inlineSize: AVATAR_SIZE,
  blockSize: AVATAR_SIZE,
  flex: '0 0 auto',
  borderRadius: 'var(--radius-pill)',
  overflow: 'hidden',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'var(--bg-subtle)',
  // A ring in the page background, so the circle reads as lifted off the cover
  // rather than punched through it.
  border: '4px solid var(--bg)',
  color: 'var(--fg-muted)',
  fontWeight: 600,
  fontSize: '44px',
};

const avatarImageStyle: CSSProperties = {
  inlineSize: '100%',
  blockSize: '100%',
  objectFit: 'cover',
};

const detailsStyle: CSSProperties = {
  flex: '1 1 20rem',
  minInlineSize: 0,
  paddingBlockStart: 'var(--space-7)',
};

const nameStyle: CSSProperties = {
  // SPEC-010: display name at `--text-h1` 32px. The token is 42px at desktop
  // and 32px below 1024px, so the size is pinned here rather than taken from
  // the token: a profile name is not an article title.
  fontSize: '32px',
  lineHeight: 'var(--text-h1-leading)',
  fontWeight: 'var(--text-h1-weight)' as CSSProperties['fontWeight'],
  fontFamily: 'var(--font-reading)',
  color: 'var(--fg)',
  margin: 0,
};

const handleStyle: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
  margin: 'var(--space-1) 0 0',
};

const bioStyle: CSSProperties = {
  color: 'var(--fg)',
  fontSize: 'var(--text-ui-size)',
  lineHeight: 'var(--text-ui-leading)',
  margin: 'var(--space-4) 0 0',
  // A bio is plain text (SPEC-010) and may contain newlines the author typed.
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

const statsStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--space-5)',
  margin: 'var(--space-4) 0 0',
  padding: 0,
  listStyle: 'none',
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
};

const actionStyle: CSSProperties = {
  marginBlockStart: 'var(--space-5)',
  display: 'flex',
  gap: 'var(--space-3)',
};

/** "1 follower" / "2 followers" — a count is a sentence, not a number. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function ProfileHeader({
  name,
  handle,
  bio,
  avatarPath,
  coverPath,
  socials,
  followerCount,
  publishedCount,
  isOwner,
  action,
}: ProfileHeaderProps) {
  return (
    <header style={wrapperStyle} data-testid="profile-header" data-owner={isOwner ? 'true' : 'false'}>
      {coverPath ? (
        <div style={coverBoxStyle} data-testid="profile-cover">
          {/* Plain <img> for the same reason `Avatar` gives: covers are local
              files under `public/uploads` (SPEC-006), `next.config.ts` sets
              `remotePatterns: []`, and next/image needs a loader the static
              render suite cannot provide. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverPath}
            // Decorative: the profile it belongs to is named in the heading
            // directly below, so a described cover would be announced twice.
            alt=""
            style={coverImageStyle}
          />
        </div>
      ) : (
        <div
          style={coverPlaceholderStyle}
          data-testid="profile-cover-placeholder"
          aria-hidden="true"
        />
      )}

      <div style={identityStyle}>
        <span style={avatarStyle} data-testid="profile-avatar">
          {avatarPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarPath} alt={name} style={avatarImageStyle} />
          ) : (
            // `role="img"` + `aria-label` on the wrapper, initials hidden: a
            // screen reader hears the name once, not the name and two letters.
            <span role="img" aria-label={name}>
              <span aria-hidden="true">{initials(name)}</span>
            </span>
          )}
        </span>

        <div style={detailsStyle}>
          <h1 style={nameStyle} data-testid="profile-name">
            {name}
          </h1>
          <p style={handleStyle} data-testid="profile-handle">
            @{handle}
          </p>

          {bio ? (
            <p style={bioStyle} data-testid="profile-bio">
              {/* Rendered as a text child. React escapes it, which is what
                  "plain text only (no markup rendered)" means in practice —
                  and why nothing here reaches for dangerouslySetInnerHTML. */}
              {bio}
            </p>
          ) : null}

          <ul style={statsStyle} data-testid="profile-stats">
            <li data-testid="profile-follower-count" data-count={followerCount}>
              {plural(followerCount, 'follower', 'followers')}
            </li>
            <li data-testid="profile-published-count" data-count={publishedCount}>
              {plural(publishedCount, 'story', 'stories')}
            </li>
          </ul>

          <div style={{ marginBlockStart: 'var(--space-4)' }}>
            <SocialLinks socials={socials} />
          </div>

          <div style={actionStyle}>
            {isOwner ? (
              // SPEC-010: "own profile shows Edit profile instead — never a
              // self-follow button". The slot is not consulted at all in this
              // branch, so no caller can reintroduce one by accident.
              <a
                className="btn btn--secondary"
                href={SETTINGS_PROFILE}
                data-testid="profile-edit-link"
              >
                Edit profile
              </a>
            ) : (
              action ?? null
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
