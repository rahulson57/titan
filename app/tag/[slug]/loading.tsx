/**
 * The loading fallback for `/tag/[slug]` (SPEC-011, TASK-018).
 *
 * > "`app/loading.tsx` **per route group** renders the `Skeleton` primitive; no
 * >  route shows a blank white frame for more than 200 ms after navigation."
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * TASK-009 deleted the root `app/loading.tsx` (DEC-047). That file was doing
 * two jobs at once: it was the loading UI for `/`, and — because a
 * `loading.tsx` covers its own segment AND everything nested beneath it — it
 * was also the inherited floor for every other route. Deleting it was
 * necessary (a Suspense boundary at the app root flushes a shell and commits
 * HTTP 200 before any page below can call `notFound()`, so a hard 404 became
 * structurally impossible), but it took the floor with it.
 *
 * This restores the floor where it belongs: on the segment, not above the
 * whole product. SPEC-011:44 asks for a loading file "per route group", so
 * per-segment boundaries are the spec-conformant shape rather than a
 * workaround for the deletion.
 *
 * ── Why this segment can safely have one ─────────────────────────────────
 * The soft-404 hazard only bites routes that call `notFound()`. `/tag/[slug]`
 * deliberately does not — `app/tag/[slug]/page.tsx` says so in its header and
 * does not import it: an unknown tag is an EMPTY tag page, not a missing one,
 * because a tag is a label rather than a resource. So a boundary here cannot
 * mask a status this route never sets. It also encloses nothing else:
 * `/article/[slug]`, the route whose 404 is sealed, is not below it.
 *
 * ── Why the markup matches `app/bookmarks/loading.tsx` ───────────────────
 * Same `Skeleton` primitive, same three-row article-card geometry, same
 * `route-loading` testid the sealed SPEC-011 oracle probes. A tag page renders
 * `ArticleCard` rows through `FeedList`, exactly as `/bookmarks` does, so the
 * same placeholder geometry is the one that lets real content replace it
 * without the page jumping. A centred spinner would reserve no space and
 * guarantee a layout shift on arrival.
 *
 * The duplication across the four list surfaces is deliberate and noted in the
 * proposal: a shared placeholder component would live under `components/ui/`,
 * which is SPEC-003's territory and outside this task's file scope. Three
 * copies of a leaf-level presentational placeholder is the cheaper mistake.
 *
 * ── On styling ───────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 and is outside this task's file scope,
 * so the layout reads design tokens through `style` props. The shimmer, radius
 * and colours are all the `Skeleton` primitive's own — and `Skeleton` carries
 * `role="status"` and `aria-busy`, so a screen-reader user is told the page is
 * working exactly once rather than hearing a list of empty boxes.
 */

import type { CSSProperties } from 'react';

import { Skeleton } from '../../../components/ui/Skeleton';

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
      {/* The tag title and its story count, which sit above the list. */}
      <div style={rowStyle}>
        <Skeleton variant="rect" width="14rem" height={32} />
        <Skeleton variant="text" width="7rem" />
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
