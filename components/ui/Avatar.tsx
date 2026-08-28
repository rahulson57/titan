/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
import type { ImgHTMLAttributes } from 'react';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  /** The person's display name. Required — it is the alt text and the fallback. */
  name: string;
  /** Local upload path. Absent or empty renders the initials fallback. */
  src?: string | null;
  /** 24 / 40 / 64px. Defaults to `md`. */
  size?: AvatarSize;
  className?: string;
}

/**
 * First letters of the first and last word, upper-cased — at most two.
 *
 * `Array.from` rather than `split('')` so an astral-plane first character
 * (an emoji, or anything outside the BMP) is taken as one glyph instead of
 * half a surrogate pair, which would render as a replacement box.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  const letters = [first, last]
    .filter(Boolean)
    .map((word) => Array.from(word)[0] ?? '')
    .join('');
  return letters.toUpperCase();
}

/**
 * Circular author image with a typographic fallback (SPEC-003).
 *
 * The fallback is deliberately not a generic silhouette: an initial identifies
 * the author in a feed of many, a grey person icon identifies nothing. It is
 * `aria-hidden` with the name carried on the wrapper's `title`/`aria-label` by
 * the consumer, so a screen reader hears the name once rather than the name
 * and then two stray letters.
 */
export function Avatar({ name, src, size = 'md', className, ...rest }: AvatarProps) {
  const classes = ['avatar', `avatar--${size}`, className].filter(Boolean).join(' ');

  if (src) {
    return (
      <span className={classes} data-testid="avatar">
        {/* Plain <img>, not next/image, and the rule is disabled deliberately
            rather than worked around. Avatars are 24-64px local files served
            from our own disk (SPEC-006): there is no remote origin to optimise
            against — `next.config.ts` sets `remotePatterns: []` on purpose —
            and at this size the optimiser round trip costs more than the bytes
            it saves. next/image also needs a loader at render time, which the
            static-render unit suite has no way to provide. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="avatar__image" src={src} alt={name} {...rest} />
      </span>
    );
  }

  return (
    <span className={classes} data-testid="avatar" role="img" aria-label={name}>
      <span aria-hidden="true">{initials(name)}</span>
    </span>
  );
}

export default Avatar;
