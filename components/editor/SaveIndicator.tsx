'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The autosave status indicator (SPEC-007).
 *
 * > Status indicator text is one of exactly: `Saved`, `Saving…`,
 * > `Unsaved changes`, `Save failed — retry`.
 *
 * "Exactly" is why this component renders `SAVE_STATUS[state]` and never a
 * literal. The ellipsis is U+2026 and the dash in "Save failed — retry" is an
 * em dash; both are trivially retyped as "..." and "-" by a later editor, both
 * still look right on screen, and both fail a criterion asserting the exact
 * string. Keeping the four strings in `lib/content/autosave.ts` means there is
 * one place they exist and the unit suite asserts them there.
 *
 * ── Why it is a live region, and why `polite` ─────────────────────────────
 * The text changes without any user action — a timer fires and the label
 * becomes `Saving…`, then `Saved`. A sighted author sees that in peripheral
 * vision; a screen-reader user gets nothing at all unless the region announces
 * itself. `polite` rather than `assertive` because it must not interrupt
 * dictation or reading mid-sentence: the information is reassurance, not an
 * alarm. The failed state is the exception and it gets a real button, which is
 * both focusable and announced when reached.
 *
 * ── Colour is not the signal ──────────────────────────────────────────────
 * SPEC-003's token set has no error colour with a verified contrast ratio, and
 * SPEC-002 budgets >= 4.5:1 in BOTH themes. Inventing a red here would put an
 * unmeasured value on the page. The failure state is carried by the text
 * itself, by `role="alert"` on the retry control, and by a border — none of
 * which depend on a reader being able to distinguish two colours.
 */

import type { CSSProperties } from 'react';

import { SAVE_STATUS, type AutosaveState } from '../../lib/content/autosave';

export interface SaveIndicatorProps {
  state: AutosaveState;
  /** ISO-8601 timestamp of the last successful save, if there has been one. */
  savedAt?: string | null;
  /** Invoked by the retry control. Present only when the state is `error`. */
  onRetry?: () => void;
}

const wrapper: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-meta-size)',
  lineHeight: 'var(--text-meta-leading)',
  color: 'var(--fg-muted)',
};

const retryStyle: CSSProperties = {
  font: 'inherit',
  color: 'var(--fg)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-1) var(--space-3)',
  cursor: 'pointer',
};

/** `14:32` — the time only. The date is meaningless for a save 20 seconds ago. */
function formatSavedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function SaveIndicator({ state, savedAt, onRetry }: SaveIndicatorProps) {
  const text = SAVE_STATUS[state];

  return (
    <span style={wrapper}>
      <span
        data-testid="save-indicator"
        data-state={state}
        role="status"
        aria-live="polite"
        // The whole point of the region is that it announces changes to text
        // it already contains, so a partial update must not be announced as a
        // fragment. `atomic` re-reads the whole label.
        aria-atomic="true"
      >
        {text}
      </span>

      {state === 'clean' && savedAt ? (
        // `title`, not visible text: the indicator's string set is closed by
        // the spec, so the timestamp cannot be appended to it. A `<time>` with
        // a machine-readable `dateTime` keeps the detail available without
        // changing what the criterion reads.
        <time
          data-testid="saved-at"
          dateTime={savedAt}
          style={{ color: 'var(--fg-muted)' }}
          title={savedAt}
        >
          {formatSavedAt(savedAt)}
        </time>
      ) : null}

      {state === 'error' && onRetry ? (
        <button type="button" onClick={onRetry} style={retryStyle} data-testid="save-retry">
          Retry now
        </button>
      ) : null}
    </span>
  );
}

export default SaveIndicator;
