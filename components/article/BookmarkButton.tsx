'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The bookmark toggle (SPEC-009).
 *
 * Same provider-plus-consumer shape as `ClapButton`, and for the same reason:
 * the control appears in the article footer and again in the sticky bar, and
 * two `useOptimistic` hooks would let one say "saved" while the other says
 * "save". See that file's header for the argument in full.
 *
 * ── What is different from the clap control ──────────────────────────────
 * No coalescing. A burst of clap taps ACCUMULATES — ten taps mean ten claps,
 * so they can be summed and sent once. A burst of bookmark taps ALTERNATES —
 * two taps mean "save, then unsave", and the answer to the pair is the state
 * they end on, which only the server can settle. Debouncing a toggle would
 * make the last tap authoritative and the intermediate ones invisible; that
 * happens to give the same answer here, but only because the toggle is
 * idempotent, and building on that coincidence would be fragile. So each tap
 * is one call and `toggleBookmark` — which returns the state it LEFT rather
 * than the one it found — resolves the order.
 *
 * ── Rollback ─────────────────────────────────────────────────────────────
 * Identical and structural: `server` is written only on `ok`, the optimistic
 * flip is a layer React drops when the transition settles, so a failure leaves
 * the control showing exactly what the server last confirmed. Nothing has to
 * remember to undo anything.
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

import { bookmarkAction } from '../../app/article/[slug]/actions';
import type { BookmarkState } from '../../lib/engage/bookmark';
import { articleHref, signInHref } from '../../lib/routes';

interface BookmarkContextValue extends BookmarkState {
  signedIn: boolean;
  signInTarget: string;
  toggle: () => void;
}

const BookmarkContext = createContext<BookmarkContextValue | null>(null);

export interface BookmarkProviderProps {
  articleId: string;
  slug: string;
  signedIn: boolean;
  initialBookmarked: boolean;
  children: ReactNode;
}

export function BookmarkProvider({
  articleId,
  slug,
  signedIn,
  initialBookmarked,
  children,
}: BookmarkProviderProps) {
  const [server, setServer] = useState<BookmarkState>({ bookmarked: initialBookmarked });

  const [view, flip] = useOptimistic(server, (state: BookmarkState): BookmarkState => ({
    bookmarked: !state.bookmarked,
  }));

  const signInTarget = useMemo(() => signInHref(articleHref(slug)), [slug]);

  const toggle = useCallback(() => {
    if (!signedIn) return;

    startTransition(async () => {
      flip(null);
      try {
        const result = await bookmarkAction(articleId);
        if (result.ok) {
          setServer(result.value);
        } else if (result.status === 401) {
          window.location.assign(signInTarget);
        }
        // Anything else: leave `server` alone and let the layer unwind.
      } catch {
        // A transport failure is a failed mutation, not a page crash.
      }
    });
  }, [articleId, flip, signInTarget, signedIn]);

  const value = useMemo<BookmarkContextValue>(
    () => ({ bookmarked: view.bookmarked, signedIn, signInTarget, toggle }),
    [signInTarget, signedIn, toggle, view.bookmarked],
  );

  return <BookmarkContext.Provider value={value}>{children}</BookmarkContext.Provider>;
}

export function useBookmark(): BookmarkContextValue {
  const value = useContext(BookmarkContext);
  if (!value) throw new Error('BookmarkButton must be rendered inside <BookmarkProvider>');
  return value;
}

/**
 * The mark (SPEC-003: original assets only) — a plain ribbon, filled when
 * saved. Drawn from primitives; `aria-hidden`, the control carries the label.
 */
function BookmarkMark({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.5 4.5h11a1 1 0 0 1 1 1v14l-6.5-4.2L5.5 19.5v-14a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

export interface BookmarkButtonProps {
  compact?: boolean;
}

const baseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-meta-size)',
  lineHeight: 'var(--text-meta-leading)',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-pill)',
  cursor: 'pointer',
  textDecoration: 'none',
} as const;

/**
 * Signed in it is a `<button aria-pressed>`; signed out it is an `<a>` to
 * `/signin?next=<article>`.
 *
 * `aria-pressed` rather than a changing label: this IS a two-state toggle, and
 * the attribute is how assistive tech is told which state it is in without the
 * name changing under the user mid-interaction.
 */
export function BookmarkButton({ compact = false }: BookmarkButtonProps) {
  const { bookmarked, signedIn, signInTarget, toggle } = useBookmark();

  const style = {
    ...baseStyle,
    padding: compact ? 'var(--space-1) var(--space-3)' : 'var(--space-2) var(--space-4)',
    color: bookmarked ? 'var(--accent)' : 'var(--fg-muted)',
    borderColor: bookmarked ? 'var(--accent)' : 'var(--border)',
  };

  if (!signedIn) {
    return (
      <a
        href={signInTarget}
        style={style}
        data-testid="bookmark-button"
        data-signed-in="false"
        aria-label="Sign in to save this story"
      >
        <BookmarkMark filled={false} />
        {!compact && <span>Save</span>}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      style={style}
      data-testid="bookmark-button"
      data-signed-in="true"
      data-bookmarked={bookmarked}
      aria-pressed={bookmarked}
      aria-label={bookmarked ? 'Remove this story from your bookmarks' : 'Save this story'}
    >
      <BookmarkMark filled={bookmarked} />
      {!compact && <span>{bookmarked ? 'Saved' : 'Save'}</span>}
    </button>
  );
}

export default BookmarkButton;
