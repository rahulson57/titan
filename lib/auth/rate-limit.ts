/**
 * Failed-sign-in rate limiting (SPEC-005).
 *
 * > In-process fixed-window counter in `lib/auth/rate-limit.ts`: 5 failed
 * > logins per email per 15 min, then 429. In-memory Map — no Redis; process
 * > restart clears it, acceptable for localhost.
 *
 * DEC-005 states the trade-off in full: one Node process has one memory space,
 * so a network hop to a second daemon would buy nothing but an install step
 * and a container SPEC-001 forbids. What that costs is honest and bounded —
 * the limiter resets on restart and does not survive a `next dev` recompile,
 * so it deters casual brute force and nothing more.
 *
 * ── Fixed window, not sliding ──────────────────────────────────────────────
 * The spec says fixed, and fixed is what this is: the window opens on the
 * first failure and runs a flat 15 minutes regardless of what happens inside
 * it. The known weakness is the boundary — an attacker who spends 5 attempts
 * at the end of one window and 5 at the start of the next gets 10 in quick
 * succession. A sliding window would close that. It is not worth the extra
 * state here, and pretending otherwise would be the more dishonest choice.
 *
 * ── Only FAILURES count, and success clears ────────────────────────────────
 * `recordFailure` is called only on a rejected sign-in, and `clear` is called
 * on a successful one. If successes counted, a user with several devices could
 * lock themselves out by signing in normally — a self-inflicted denial of
 * service dressed as a security control.
 *
 * ── Keyed by email, which is a deliberate choice with a cost ───────────────
 * SPEC-005 says "per email". That protects a targeted account, and it means an
 * attacker who knows an address can lock its owner out for 15 minutes — a real
 * denial-of-service primitive. On localhost, with one user, that is noise. In
 * a deployment the key would need to be (email, source IP) so one attacker
 * cannot deny service to a stranger. Stated rather than silently inherited.
 */

/** SPEC-005: 5 failed logins per email per 15 min. */
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;

/** The status code a blocked attempt answers with (SPEC-005: "then 429"). */
export const RATE_LIMITED_STATUS = 429;

interface Window {
  /** Failures recorded since `openedAt`. */
  count: number;
  /** When this window started, in epoch ms. */
  openedAt: number;
}

/**
 * The counter table. Module-level state, which is exactly the "in-process Map"
 * the spec asks for — and the reason every function below takes `now` as a
 * parameter: a limiter whose only clock is `Date.now()` can be tested for its
 * threshold but never for its expiry without sleeping 15 real minutes.
 */
const windows = new Map<string, Window>();

/** Emails are compared in the same normalised form the rest of auth uses. */
function keyFor(email: string): string {
  return email.trim().toLowerCase();
}

/** Drop a window that has aged out, so `windows` cannot grow without bound. */
function activeWindow(key: string, now: number): Window | undefined {
  const window = windows.get(key);
  if (!window) return undefined;
  if (now - window.openedAt >= WINDOW_MS) {
    windows.delete(key);
    return undefined;
  }
  return window;
}

export interface RateLimitState {
  /** True when the next attempt must be refused with 429. */
  limited: boolean;
  /** Failures recorded in the current window. */
  failures: number;
  /** Attempts still permitted before the limit bites. */
  remaining: number;
  /** Epoch ms at which the window expires; `null` when no window is open. */
  resetAt: number | null;
  /** Whole seconds until reset, for a `Retry-After` header. 0 when not limited. */
  retryAfterSeconds: number;
}

function stateOf(window: Window | undefined, now: number): RateLimitState {
  if (!window) {
    return {
      limited: false,
      failures: 0,
      remaining: MAX_FAILURES,
      resetAt: null,
      retryAfterSeconds: 0,
    };
  }
  const resetAt = window.openedAt + WINDOW_MS;
  const limited = window.count >= MAX_FAILURES;
  return {
    limited,
    failures: window.count,
    remaining: Math.max(0, MAX_FAILURES - window.count),
    resetAt,
    retryAfterSeconds: limited ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 0,
  };
}

/**
 * Inspect without recording. Call this BEFORE verifying a password: the point
 * of the limiter is to stop the expensive argon2 verification from running at
 * all, not merely to reject afterwards.
 */
export function check(email: string, now: number = Date.now()): RateLimitState {
  return stateOf(activeWindow(keyFor(email), now), now);
}

/** `check(...).limited`, for call sites that want the predicate only. */
export function isRateLimited(email: string, now: number = Date.now()): boolean {
  return check(email, now).limited;
}

/**
 * Record one failed attempt and return the resulting state.
 *
 * The window opens on the FIRST failure rather than on first sight of the
 * email, so an account nobody has failed against holds no entry at all — the
 * map is a record of suspicion, not a roster of every address ever typed.
 */
export function recordFailure(email: string, now: number = Date.now()): RateLimitState {
  const key = keyFor(email);
  const existing = activeWindow(key, now);
  const window: Window = existing
    ? { count: existing.count + 1, openedAt: existing.openedAt }
    : { count: 1, openedAt: now };
  windows.set(key, window);
  return stateOf(window, now);
}

/** Forget an email's window. Called on a successful sign-in. */
export function clear(email: string): void {
  windows.delete(keyFor(email));
}

/** Forget everything. Test-only; nothing in the app calls it. */
export function reset(): void {
  windows.clear();
}

/**
 * Drop every window that has aged out.
 *
 * `activeWindow` already evicts lazily on read, which is enough to bound
 * memory against any address that is retried. This exists for the address that
 * is not: five failures against `victim@example.com` and then silence leaves
 * one entry alive with nothing to trigger its eviction. Exposed rather than
 * scheduled — a `setInterval` in a module that server components import would
 * pin the process awake for a few dozen bytes.
 */
export function sweep(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, window] of windows) {
    if (now - window.openedAt >= WINDOW_MS) {
      windows.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Number of windows currently held. Used by the tests to prove eviction. */
export function size(): number {
  return windows.size;
}
