'use client';

/**
 * The global error boundary (SPEC-011).
 *
 * > "`app/error.tsx` — client error boundary, renders a retry button; never
 * >  leaks a stack trace to the DOM in `NODE_ENV=production`."
 *
 * ── Why `'use client'` is mandatory, not a choice ─────────────────────────
 * Next requires every `error.tsx` to be a Client Component. An error boundary
 * is a React class-component feature that catches exceptions thrown *during
 * render on the client*, and there is no server equivalent — a server-only
 * module could not receive `reset` or re-render the subtree. This is the one
 * file in the shell where the runtime dictates the choice.
 *
 * ── The stack-trace rule, and how it is actually kept ─────────────────────
 * The criterion is machine-checked: *"A thrown render error shows the error
 * boundary with a retry button and the DOM contains no stack-trace text when
 * `NODE_ENV=production`."*
 *
 * Next already redacts the message of a *server*-side error in production,
 * replacing it with a generic string plus a `digest`. It does NOT redact an
 * error thrown during client render — that message reaches this component
 * verbatim, in production, because it was produced in the browser and never
 * crossed the server boundary. So relying on the framework's redaction would
 * satisfy the criterion for one class of error and silently fail it for the
 * other, which is the worse outcome because it would look correct in testing.
 *
 * This file therefore makes the decision itself and inverts the default:
 * **nothing derived from the error is rendered unless the build is explicitly
 * non-production.** `error.message` and `error.stack` are read in exactly one
 * branch, guarded by an environment check, and that branch is dead code in a
 * production bundle — `process.env.NODE_ENV` is statically replaced at build
 * time, so the string never even ships.
 *
 * `digest` is the exception and it is safe: it is a hash Next generates so a
 * user-reported failure can be matched to a server log line. It carries no
 * source text, no paths and no user data — it is the only thing worth showing,
 * and the reason a production error page can still be diagnosed.
 *
 * ── What this boundary does NOT catch, measured rather than assumed ───────
 * It catches errors thrown **below** the root layout — pages, and everything
 * they render. It does **not** catch an error thrown by the root layout
 * itself, which includes `TopNav`, `UserMenu` and `ThemeToggle`, because they
 * are mounted in `app/layout.tsx`. Those escape to Next's built-in
 * `global-error` fallback, which renders the bare "Application error: a
 * client-side exception has occurred" page with none of the recovery below.
 *
 * This was established by experiment while building
 * `tests/e2e/error-boundary.spec.ts`, not read off the documentation, and it
 * is worth knowing for two reasons. First, a fault injected into the chrome to
 * test this file will never reach it — the test would fail while the boundary
 * worked perfectly. Second, and more importantly: **if the chrome ever
 * acquires a way to throw, the product has no recovery surface for it.** The
 * fix at that point is `app/global-error.tsx`, which SPEC-011 does not
 * currently call for. Flagged here rather than built, since nothing in the
 * chrome can throw today and speculative surfaces are how a shell grows a
 * layer nobody maintains.
 *
 * ── Why `reset` and not `location.reload()` ───────────────────────────────
 * `reset()` re-renders the failed subtree in place, so a transient failure —
 * a lost connection, a race on first paint — recovers without discarding the
 * rest of the page or the reader's scroll position. A full reload would work
 * and would be worse. The link home is the second exit, for the case where
 * retrying will never help.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the wrapper reads design tokens through a `style` prop; the
 * content is the design system's `EmptyState` and `Button` primitives.
 */

import { useEffect } from 'react';
import type { CSSProperties } from 'react';

import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { HOME } from '../lib/routes';

export interface GlobalErrorProps {
  /** Next augments the Error with a `digest` for server-produced failures. */
  error: Error & { digest?: string };
  /** Re-renders the failed segment in place. */
  reset: () => void;
}

const columnStyle: CSSProperties = {
  maxWidth: 'var(--measure)',
  margin: '0 auto',
  padding: 'var(--space-8) var(--space-5)',
  fontFamily: 'var(--font-ui)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--space-5)',
};

const detailStyle: CSSProperties = {
  maxInlineSize: '100%',
  overflowX: 'auto',
  padding: 'var(--space-3)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--fg)',
  fontSize: 'var(--text-meta-size)',
  whiteSpace: 'pre-wrap',
};

const digestStyle: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  // The failure still has to be *recorded* somewhere, or it is invisible to
  // everyone but the reader who hit it. The console is the only sink this
  // project has (SPEC-001 admits no external service), and it is a browser
  // console — not the DOM — so it does not touch the no-stack-trace rule.
  useEffect(() => {
    console.error('Unhandled render error', error);
  }, [error]);

  // Statically replaced at build time, so the whole development branch below
  // is eliminated from a production bundle rather than merely skipped.
  const isDevelopment = process.env.NODE_ENV !== 'production';

  return (
    <main style={columnStyle} data-testid="error-boundary">
      <h1 className="visually-hidden">Something went wrong</h1>

      <EmptyState
        title="Something went wrong"
        description="The page failed to load. Trying again often fixes it."
        action={
          <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center' }}>
            {/*
              A real `<button>`, because it acts rather than navigates — and it
              is the control the sealed criterion looks for by its accessible
              name ("a retry button").
            */}
            <Button type="button" onClick={reset} data-testid="error-retry">
              Try again
            </Button>
            <Button href={HOME} variant="secondary" data-testid="error-home">
              Back to reading
            </Button>
          </div>
        }
      />

      {/*
        The digest, and only the digest, in every environment. It is a hash
        with no source text in it, and it is what turns "it broke" into a
        report someone can act on.
      */}
      {error.digest ? (
        <p style={digestStyle} data-testid="error-digest">
          Reference: <code>{error.digest}</code>
        </p>
      ) : null}

      {/*
        Development only. `isDevelopment` is a build-time constant, so this
        entire subtree — and the `error.message`/`error.stack` reads inside it
        — is removed from a production build. That is what makes the criterion
        structurally true rather than a thing this file has to remember.
      */}
      {isDevelopment ? (
        <pre style={detailStyle} data-testid="error-detail">
          {error.stack ?? error.message}
        </pre>
      ) : null}
    </main>
  );
}
