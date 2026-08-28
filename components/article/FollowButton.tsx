'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The follow toggle (SPEC-009).
 *
 * Rendered twice on this page — once in the header's author row, once in the
 * footer author card — so it takes the same provider-plus-consumer shape as
 * the clap and bookmark controls. Two independent hooks would let the header
 * say "Following" while the card below it still offers "Follow", and both
 * would carry their own follower count. See `ClapButton.tsx` for the argument
 * in full.
 *
 * ── Self-follow ──────────────────────────────────────────────────────────
 * SPEC-009 makes it a 400 `SelfFollowError`. The control is not rendered at
 * all when the viewer is the author — `isSelf` short-circuits to `null` — so
 * the error is unreachable through the UI. The server rule still exists and is
 * still tested, because a Server Action is an addressable endpoint and "the
 * button is not on the page" is not an authorization control.
 *
 * ── Rollback ─────────────────────────────────────────────────────────────
 * Structural, as with the other two: `server` is written only on `ok`, and the
 * optimistic layer React drops on settle carries both the flag AND the count,
 * so a failed follow puts the follower number back as well as the label. A
 * control that rolled the label back but left the count one higher would be a
 * more confusing lie than not rolling back at all.
 */

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useMemo,
  useOptimistic,
  useState,
  type ReactNode,
} from 'react';

import { followAction } from '../../app/article/[slug]/actions';
import type { FollowState } from '../../lib/engage/follow';
import { articleHref, signInHref } from '../../lib/routes';

interface FollowContextValue extends FollowState {
  signedIn: boolean;
  /** True when the viewer IS the author: the control is suppressed entirely. */
  isSelf: boolean;
  authorName: string;
  signInTarget: string;
  toggle: () => void;
}

const FollowContext = createContext<FollowContextValue | null>(null);

export interface FollowProviderProps {
  /** The author being followed — never the viewer; the actor comes from the cookie. */
  authorId: string;
  authorName: string;
  slug: string;
  signedIn: boolean;
  isSelf: boolean;
  initialFollowing: boolean;
  initialFollowerCount: number;
  children: ReactNode;
}

export function FollowProvider({
  authorId,
  authorName,
  slug,
  signedIn,
  isSelf,
  initialFollowing,
  initialFollowerCount,
  children,
}: FollowProviderProps) {
  const [server, setServer] = useState<FollowState>({
    following: initialFollowing,
    followerCount: initialFollowerCount,
  });

  const [view, flip] = useOptimistic(server, (state: FollowState): FollowState => ({
    following: !state.following,
    // The count moves with the flag. `Math.max(0, …)` guards the unfollow
    // direction against a stale zero rendering as -1 for a frame.
    followerCount: state.following
      ? Math.max(0, state.followerCount - 1)
      : state.followerCount + 1,
  }));

  const signInTarget = useMemo(() => signInHref(articleHref(slug)), [slug]);

  const toggle = useCallback(() => {
    if (!signedIn || isSelf) return;

    startTransition(async () => {
      flip(null);
      try {
        const result = await followAction(authorId);
        if (result.ok) {
          setServer(result.value);
        } else if (result.status === 401) {
          window.location.assign(signInTarget);
        }
        // 400 (self) and 404 (gone) both fall through: nothing is written, so
        // the optimistic layer unwinds onto the last confirmed value.
      } catch {
        // A transport failure is a failed mutation, not a page crash.
      }
    });
  }, [authorId, flip, isSelf, signInTarget, signedIn]);

  const value = useMemo<FollowContextValue>(
    () => ({
      following: view.following,
      followerCount: view.followerCount,
      signedIn,
      isSelf,
      authorName,
      signInTarget,
      toggle,
    }),
    [
      authorName,
      isSelf,
      signInTarget,
      signedIn,
      toggle,
      view.followerCount,
      view.following,
    ],
  );

  return <FollowContext.Provider value={value}>{children}</FollowContext.Provider>;
}

export function useFollow(): FollowContextValue {
  const value = useContext(FollowContext);
  if (!value) throw new Error('FollowButton must be rendered inside <FollowProvider>');
  return value;
}

export interface FollowButtonProps {
  /** The header's author row wants a smaller target than the footer card. */
  compact?: boolean;
}

const baseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-meta-size)',
  lineHeight: 'var(--text-meta-leading)',
  fontWeight: 600,
  borderRadius: 'var(--radius-pill)',
  cursor: 'pointer',
  textDecoration: 'none',
  border: '1px solid var(--accent)',
} as const;

/**
 * Signed in it is a `<button aria-pressed>`; signed out an `<a>` to
 * `/signin?next=<article>`; viewing your own article it is nothing at all.
 */
export function FollowButton({ compact = false }: FollowButtonProps) {
  const { following, isSelf, signedIn, signInTarget, authorName, toggle } = useFollow();

  // Nobody follows themselves, and an inert "Follow" beside your own byline
  // reads as a bug. The 400 the server would answer with stays unreachable.
  if (isSelf) return null;

  const style = {
    ...baseStyle,
    padding: compact ? 'var(--space-1) var(--space-4)' : 'var(--space-2) var(--space-5)',
    background: following ? 'transparent' : 'var(--accent)',
    color: following ? 'var(--accent)' : 'var(--accent-contrast)',
  };

  if (!signedIn) {
    return (
      <a
        href={signInTarget}
        style={style}
        data-testid="follow-button"
        data-signed-in="false"
        aria-label={`Sign in to follow ${authorName}`}
      >
        Follow
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      style={style}
      data-testid="follow-button"
      data-signed-in="true"
      data-following={following}
      aria-pressed={following}
      aria-label={following ? `Unfollow ${authorName}` : `Follow ${authorName}`}
    >
      {following ? 'Following' : 'Follow'}
    </button>
  );
}

/** The author card's "1,204 followers" line, kept in step with the button. */
export function FollowerCount() {
  const { followerCount } = useFollow();
  return (
    <span data-testid="follower-count" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {followerCount.toLocaleString('en-US')}
      {followerCount === 1 ? ' follower' : ' followers'}
    </span>
  );
}

export default FollowButton;
