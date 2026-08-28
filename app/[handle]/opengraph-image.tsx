/**
 * The Open Graph card for `/@[handle]` (SPEC-010's owned files).
 *
 * A profile link pasted into a chat should show who it belongs to. Without
 * this file Next falls back to the app-wide card, so every author's profile
 * previews identically and the link says nothing about whose it is.
 *
 * ── Why this is drawn rather than a stored image ──────────────────────────
 * The obvious alternative is to point the card at `User.coverPath`. It is the
 * wrong answer twice over: most profiles have no cover (SPEC-010 gives them a
 * gradient placeholder precisely because that is the common case), and a
 * user-uploaded image at 1200x630 would be cropped by whatever is scraping it,
 * with the author's name nowhere in the picture. Drawing the card means every
 * profile has one, and the name is always legible.
 *
 * ── Constraints this file is written against ──────────────────────────────
 *   - `next/og` ships with Next and bundles its own font, so this adds no
 *     dependency. SPEC-001 forbids reaching for services the constraints do
 *     not name, and nothing here does.
 *   - Satori (which `ImageResponse` uses) supports a deliberately small subset
 *     of CSS: flexbox only, no `gap`, no CSS custom properties. So the colours
 *     below are literals rather than `var(--bg)` tokens — the tokens genuinely
 *     cannot be resolved in this renderer, and a `var()` here would silently
 *     produce a transparent box rather than an error.
 *   - Every element with more than one child needs an explicit `display`.
 *
 * ── An unknown handle still returns an image ──────────────────────────────
 * `notFound()` is not available in an image route, and answering a scraper
 * with a 404 for the image while the page itself 404s is redundant. A neutral
 * card is returned instead, so a stale link previews as "not found" rather
 * than as a broken image.
 */

import { ImageResponse } from 'next/og';

import { findUserByHandle } from '../../lib/db/users';

/** The size every major scraper crops to. */
export const size = { width: 1200, height: 630 };

export const contentType = 'image/png';

/**
 * Static, because Next requires `alt` to be a module export rather than a
 * value the renderer computes. The author's name is in the image itself.
 */
export const alt = 'Author profile on titan';

/** Literals, not tokens: see the note above on Satori's CSS subset. */
const INK = '#242424';
const MUTED = '#6b6b6b';
const PAPER = '#ffffff';
const ACCENT = '#1a8917';

export default async function ProfileOpenGraphImage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle: raw } = await params;

  // The same segment rule the page applies: no leading `@` is not a profile.
  // Decoding can throw on a malformed escape, which in an image route would be
  // a 500 served to a crawler.
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = '';
  }
  const handle = decoded.startsWith('@') ? decoded.slice(1) : null;
  const user = handle ? await findUserByHandle(handle) : null;

  const name = user?.name ?? 'Profile not found';
  const at = user ? `@${user.handle}` : 'titan';
  // Two lines' worth. A 220-character bio at this size overflows the card and
  // Satori clips it mid-word with no ellipsis, which reads as a rendering bug.
  const bio = user?.bio ? truncate(user.bio, 120) : '';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: PAPER,
          padding: '64px',
          fontFamily: 'sans-serif',
        }}
      >
        {/* The accent band stands in for the profile's cover: it is the one
            element that makes the card recognisable as titan at thumbnail
            size, where the text is unreadable anyway. */}
        <div style={{ display: 'flex', width: '100%', height: '12px', backgroundColor: ACCENT }} />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, color: INK }}>{name}</div>
          <div style={{ display: 'flex', fontSize: 36, color: MUTED, marginTop: '12px' }}>{at}</div>
          {bio ? (
            <div style={{ display: 'flex', fontSize: 30, color: INK, marginTop: '28px' }}>{bio}</div>
          ) : null}
        </div>

        <div style={{ display: 'flex', fontSize: 28, color: MUTED }}>titan</div>
      </div>
    ),
    size,
  );
}

/** Cut on a word boundary; a mid-word cut reads as a defect rather than a limit. */
function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
