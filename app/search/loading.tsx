/**
 * The loading fallback for `/search` (SPEC-011, TASK-018).
 *
 * > "`app/loading.tsx` **per route group** renders the `Skeleton` primitive; no
 * >  route shows a blank white frame for more than 200 ms after navigation."
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * TASK-009 deleted the root `app/loading.tsx` (DEC-047), which had been both
 * the loading UI for `/` and the inherited floor for every route below it. The
 * deletion was correct — a Suspense boundary at the app root flushes a shell
 * and commits HTTP 200 before any page can call `notFound()`, which made a
 * hard 404 structurally impossible — but it left the list surfaces without a
 * non-blank first frame. This puts the floor back on the segment that needs
 * it. SPEC-011:44 asks for a loading file "per route group"; this is that.
 *
 * ── Why this segment can safely have one ─────────────────────────────────
 * `app/search/page.tsx` never calls `notFound()`: every `?q=` is answerable,
 * and a query with no matches is an EMPTY RESULT SET, not a missing page —
 * the page renders SPEC-008's "No results for X" state with the popular tags.
 * A missing `?q=` is the other empty state, not an error either. So there is
 * no status for this boundary to pre-empt, and nothing routable sits beneath
 * `/search` for it to cover.
 *
 * ── Why the shape differs slightly from the other three ──────────────────
 * The search box is the first thing on this page and the reason the reader is
 * here, so the placeholder reserves its full-width field above the results.
 * Getting that geometry right is the difference between the field appearing
 * where the eye already is and the whole list shifting down when it arrives.
 * Below it the geometry is the shared article-card shape, because `/search`
 * renders the same `FeedList` rows as `/`, `/tag/[slug]` and `/bookmarks`.
 *
 * The duplication across those surfaces is deliberate and noted in the
 * proposal: a shared placeholder would live under `components/ui/`, which is
 * SPEC-003's territory and outside this task's file scope.
 *
 * ── On styling ───────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 and is outside this task's file scope,
 * so the layout reads design tokens through `style` props. The shimmer, radius
 * and colours are the `Skeleton` primitive's own, and `Skeleton` carries
 * `role="status"` and `aria-busy`, so the wait is announced once.
 */

import type { CSSProperties } from 'react';

import { Skeleton } from '../../components/ui/Skeleton';

const columnStyle: CSSProperties = {
  maxWidth: 'var(--measure)',
  margin: '0 auto',
  padding: 'var(--space-7) var(--space-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-7)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const bylineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

/** Three rows: enough to fill the fold, few enough to stay cheap. */
const PLACEHOLDER_ROWS = [0, 1, 2];

export default function Loading() {
  return (
    <div style={columnStyle} data-testid="route-loading">
      {/* The "Search" heading and the field itself, which lead this page. */}
      <div style={rowStyle}>
        <Skeleton variant="rect" width="9rem" height={32} />
        <Skeleton variant="rect" width="100%" height={44} />
      </div>

      {PLACEHOLDER_ROWS.map((row) => (
        <div key={row} style={rowStyle}>
          <div style={bylineStyle}>
            <Skeleton variant="circle" width={24} height={24} />
            <Skeleton variant="text" width="9rem" />
          </div>
          {/* Headline-sized bar, then two lines of dek — the article-card shape. */}
          <Skeleton variant="rect" width="80%" height={28} />
          <Skeleton variant="text" lines={2} />
        </div>
      ))}
    </div>
  );
}
