'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The clap control (SPEC-009) — optimistic, coalesced, and rendered twice.
 *
 * > All three controls update optimistically via `useOptimistic` and **roll
 * > back to the server value on failure**; the rendered number after a failed
 * > mutation must equal the server's number, never the optimistic guess. Clap
 * > taps are coalesced client-side into one action call per 400 ms burst.
 *
 * ── Why this module exports a PROVIDER as well as a button ────────────────
 * SPEC-009 puts a clap control in the article footer AND in the sticky bar
 * ("compact title + clap + bookmark"). At the bottom of a long article both
 * are on screen at once. Two independent `useOptimistic` hooks would be two
 * sources of truth for one number, and the reader would watch the footer say
 * 13 while the bar above it says 12 — a defect that only appears on the
 * surface the spec explicitly asks for.
 *
 * So the state lives in `ClapProvider`, which the server page wraps around
 * both, and `ClapButton` is a consumer with no state of its own. A React
 * context rather than a prop chain because the two consumers sit in different
 * subtrees of a SERVER component, which cannot hold the shared state itself.
 *
 * ── How rollback is achieved, precisely ───────────────────────────────────
 * `server` is the only durable state and it is written in exactly one place:
 * after an action that came back `ok`. `useOptimistic` layers taps on top and
 * React discards that layer when the transition settles. So:
 *
 *   success → `setServer(result.value)` runs inside the transition, the base
 *             moves, the layer is dropped, the rendered number IS the server's.
 *   failure → nothing is written, the layer is dropped, the rendered number
 *             falls back to the value the server last confirmed.
 *
 * The rollback is therefore structural. There is no error branch that has to
 * remember to undo anything — the failure path is the path where nothing
 * happens, which is the one that cannot be got wrong.
 *
 * ── The 400 ms burst, and why every tap opens a transition ────────────────
 * The first tap of a burst becomes the LEADER: it opens a window, and when the
 * window closes it issues ONE action carrying every tap counted meanwhile.
 * Followers issue nothing.
 *
 * Every tap still starts its own transition, and each one awaits the burst's
 * completion before returning. That is not ceremony — React drops optimistic
 * state once no transition is pending, so a follower whose transition ended
 * early would take its own `+1` down with it and the number would stutter
 * downward mid-burst. Holding every tap's transition open until the leader has
 * an answer keeps the displayed number monotonic through the burst and makes
 * the single settle point the moment the server value lands.
 *
 * The window is anchored to the FIRST tap rather than reset by each one. A
 * trailing debounce would also satisfy "ten taps in 400 ms issue one call",
 * but a reader who keeps tapping would keep pushing the deadline back and
 * nothing would ever be sent. A fixed window bounds the wait at
 * `CLAP_BURST_MS` no matter how long the tapping goes on.
 */

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { clapAction } from '../../app/article/[slug]/actions';
// TYPE-ONLY, and it has to stay that way. `lib/engage/clap.ts` imports
// `lib/db/articles`, which imports `lib/db/ids`, which imports `node:crypto` —
// so a VALUE import here drags SQLite's id generator into the browser bundle
// and webpack fails the build outright with `UnhandledSchemeError: node:crypto`.
// A type import is erased before webpack sees it. The two constants this
// component needs (`CLAP_BURST_MS`, `MAX_CLAPS_PER_READER`) therefore arrive as
// props from the server page, which may import that module freely — see
// `burstMs` and `maxClaps` below.
import type { ClapState } from '../../lib/engage/clap';
import { articleHref, signInHref } from '../../lib/routes';

interface ClapContextValue extends ClapState {
  /** True once this reader has spent all 50 of their claps on this article. */
  spent: boolean;
  maxClaps: number;
  signedIn: boolean;
  /** Where an anonymous reader is sent instead of being shown an error. */
  signInTarget: string;
  clap: () => void;
}

const ClapContext = createContext<ClapContextValue | null>(null);

export interface ClapProviderProps {
  articleId: string;
  /** The article's own slug — the `?next=` an anonymous reader returns to. */
  slug: string;
  signedIn: boolean;
  initialTotal: number;
  initialMine: number;
  /**
   * `CLAP_BURST_MS`, handed down rather than imported.
   *
   * The rule and its constant live in `lib/engage/clap.ts`; this file cannot
   * import a value from there without pulling the database layer into the
   * browser bundle (see the import block above). Passing it keeps ONE
   * definition of the window — the server page reads it from the module that
   * owns it, and `tests/e2e/engage-coalesce.spec.ts` asserts against the same
   * export, so the component cannot silently disagree with either.
   */
  burstMs: number;
  /** `MAX_CLAPS_PER_READER`, handed down for the same reason. */
  maxClaps: number;
  children: ReactNode;
}

/**
 * One burst in flight.
 *
 * `window` settles when the 400 ms collection window closes; `done` settles
 * when the leader's action has returned and `server` has been updated. Two
 * gates rather than one because followers and the leader wait for different
 * things: the leader waits for the window so it knows how many taps to send,
 * everybody waits for `done` so the optimistic layer survives until there is a
 * server value to land on.
 */
interface Burst {
  window: Promise<void>;
  closeWindow: () => void;
  done: Promise<void>;
  finish: () => void;
}

function openBurst(): Burst {
  let closeWindow = () => {};
  let finish = () => {};
  const win = new Promise<void>((resolve) => {
    closeWindow = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { window: win, closeWindow, done, finish };
}

export function ClapProvider({
  articleId,
  slug,
  signedIn,
  initialTotal,
  initialMine,
  burstMs,
  maxClaps,
  children,
}: ClapProviderProps) {
  const [server, setServer] = useState<ClapState>({ total: initialTotal, mine: initialMine });

  // The reducer refuses to move past the ceiling, so the 51st tap shows the
  // same number the server would return for it. An optimistic guess that the
  // server is guaranteed to contradict is worse than no guess at all.
  const [view, addTap] = useOptimistic(server, (state: ClapState): ClapState =>
    state.mine >= maxClaps ? state : { total: state.total + 1, mine: state.mine + 1 },
  );

  const burstRef = useRef<Burst | null>(null);
  const pendingRef = useRef(0);

  const signInTarget = useMemo(() => signInHref(articleHref(slug)), [slug]);

  const clap = useCallback(() => {
    // The signed-out control is an anchor, not a button — see `ClapButton`.
    // This guard only matters if a caller reaches the provider directly.
    if (!signedIn) return;

    const leader = burstRef.current === null;
    if (leader) {
      const opened = openBurst();
      burstRef.current = opened;
      setTimeout(opened.closeWindow, burstMs);
    }

    const burst = burstRef.current;
    if (!burst) return;
    pendingRef.current += 1;

    startTransition(async () => {
      addTap(null);

      if (!leader) {
        // Contributes a tap to the optimistic layer and keeps its transition
        // pending until the leader lands, so the layer is not torn down early.
        await burst.done;
        return;
      }

      await burst.window;

      // These three statements are synchronous and adjacent on purpose: no tap
      // can interleave between reading the count and closing the burst, so a
      // tap is either in this call or in the next one, never dropped.
      const delta = pendingRef.current;
      pendingRef.current = 0;
      burstRef.current = null;

      try {
        const result = await clapAction(articleId, delta);
        if (result.ok) {
          setServer(result.value);
        } else if (result.status === 401) {
          // The session expired while the tab sat open. Send them to sign in
          // rather than silently swallowing every tap from here on.
          window.location.assign(signInTarget);
        }
        // Any other failure falls through deliberately: `server` is untouched,
        // so the optimistic layer unwinds onto the last confirmed value.
      } catch {
        // A transport failure is a failed mutation, not a page crash. Catching
        // it here is what keeps the rejection off the error boundary AND lets
        // the same unwinding do the rollback.
      } finally {
        burst.finish();
      }
    });
  }, [addTap, articleId, burstMs, signInTarget, signedIn]);

  const value = useMemo<ClapContextValue>(
    () => ({
      total: view.total,
      mine: view.mine,
      spent: view.mine >= maxClaps,
      maxClaps,
      signedIn,
      signInTarget,
      clap,
    }),
    [clap, maxClaps, signInTarget, signedIn, view.mine, view.total],
  );

  return <ClapContext.Provider value={value}>{children}</ClapContext.Provider>;
}

/**
 * Read the shared clap state.
 *
 * Throws rather than returning a default when there is no provider: a control
 * silently rendering `0` claps forever is a bug that looks like data, and this
 * component is only ever mounted by the article page.
 */
export function useClap(): ClapContextValue {
  const value = useContext(ClapContext);
  if (!value) throw new Error('ClapButton must be rendered inside <ClapProvider>');
  return value;
}

/**
 * The mark (SPEC-003: original assets only).
 *
 * Two offset rounded strokes and a spark — drawn here from primitives, not
 * traced from anything. `aria-hidden` because the button carries the label.
 */
function ClapMark({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.5 12.5 6.8 9.6a1.3 1.3 0 0 1 2.2-1.3l1.3 2.1" />
      <path d="M10.8 10.1 9.2 6.4a1.3 1.3 0 0 1 2.4-1l1.5 3.6" />
      <path d="M13.4 9.3 12.6 6a1.3 1.3 0 0 1 2.5-.6l1.2 4.4" />
      <path
        d="M16.6 10.4c.9-.7 2.1-.5 2.5.5.3.8-.1 1.6-.5 2.4l-1.4 2.7a5.4 5.4 0 0 1-9.6-.4L6.2 13"
        fill={filled ? 'currentColor' : 'none'}
        fillOpacity={filled ? 0.15 : 0}
      />
    </svg>
  );
}

export interface ClapButtonProps {
  /** The sticky bar's variant: icon plus number, no padding to spare. */
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
 * The control itself — signed in it is a `<button>`, signed out an `<a>`.
 *
 * That is not styling: SPEC-009 requires the signed-out state to *"route to
 * `/signin?next=<path>` rather than erroring"*, and a real anchor does that
 * with no JavaScript, no click handler and no chance of a rejected action.
 * A screen reader is also told the truth — this one navigates, it does not
 * act — which a `<button>` with a `location.assign` inside would not.
 */
export function ClapButton({ compact = false }: ClapButtonProps) {
  const { total, mine, spent, maxClaps, signedIn, signInTarget, clap } = useClap();

  const style = {
    ...baseStyle,
    padding: compact ? 'var(--space-1) var(--space-3)' : 'var(--space-2) var(--space-4)',
    color: mine > 0 ? 'var(--accent)' : 'var(--fg-muted)',
    borderColor: mine > 0 ? 'var(--accent)' : 'var(--border)',
  };

  const count = (
    <span data-testid="clap-total" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {total}
    </span>
  );

  if (!signedIn) {
    return (
      <a
        href={signInTarget}
        style={style}
        data-testid="clap-button"
        data-signed-in="false"
        aria-label={`Sign in to clap for this story. ${total} claps so far.`}
      >
        <ClapMark filled={false} />
        {count}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={clap}
      style={style}
      data-testid="clap-button"
      data-signed-in="true"
      data-mine={mine}
      // The label carries the number because the number is the point of the
      // control; `aria-live` is deliberately absent — a burst of ten taps
      // would otherwise queue ten announcements.
      aria-label={
        spent
          ? `You have given this story all ${maxClaps} of your claps. ${total} claps so far.`
          : `Clap for this story. ${total} claps so far.`
      }
    >
      <ClapMark filled={mine > 0} />
      {count}
    </button>
  );
}

export default ClapButton;
