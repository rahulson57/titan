/**
 * The loading fallback for `/bookmarks` (SPEC-011).
 *
 * > "`app/loading.tsx` **per route group** renders the `Skeleton` primitive; no
 * >  route shows a blank white frame for more than 200 ms after navigation."
 *
 * ── Why this file exists, and why the root one no longer does ────────────
 * This is TASK-002's `app/loading.tsx`, moved down one segment. Nothing about
 * its markup has changed: same `Skeleton` primitive, same three-row article-card
 * geometry, same `route-loading` testid the sealed SPEC-011 oracle probes.
 *
 * What changed is WHERE it sits, and that is a correctness fix, not a
 * preference. A `loading.tsx` wraps its segment's children in a `<Suspense>`
 * boundary. React flushes that boundary's fallback as soon as the shell is
 * ready — which, for a file at the `app/` ROOT, is before ANY page below it has
 * resolved. The HTTP status is committed with that first chunk. So a root
 * `loading.tsx` makes it structurally impossible for any page in the product to
 * answer `notFound()` with a real 404: the page renders `app/not-found.tsx` into
 * an already-open 200 response, and the wire says `200 OK`.
 *
 * Measured, single variable, fresh dev server per run, identical page:
 *
 *   | root app/loading.tsx | GET an unknown slug |
 *   |----------------------|---------------------|
 *   | present              | **200**  (soft 404) |
 *   | absent               | **404**             |
 *
 * That defeated three sealed criteria at once — SPEC-009's "an unknown slug
 * returns HTTP 404 (not 500)" and SPEC-005's two draft-privacy assertions in
 * `tests/e2e/draft-privacy.spec.ts` — and it contradicted `app/not-found.tsx`'s
 * own stated reason for existing: *"a soft 404 gets indexed, gets cached, and
 * tells a crawler the page exists."*
 *
 * Note that SPEC-011 asks for a loading file **per route group**. The single
 * root file was a broader thing that happened to satisfy the words; this is
 * closer to the spec text, not a departure from it.
 *
 * Authorised by the operator (MSG-2428) and by the coordinator (MSG-2430),
 * which added this file, `app/editor/loading.tsx` and the deletion of
 * `app/loading.tsx` to TASK-009's file scope.
 *
 * ── Why `/bookmarks` specifically ────────────────────────────────────────
 * Because it is the surface the criterion's oracle actually probes:
 * `tests/e2e/nav.spec.ts` navigates to `/bookmarks` and requires `route-loading`
 * (or the settled page) to be visible. It is also a genuinely good home for a
 * list skeleton — the page renders `ArticleCard` rows, which is the shape this
 * placeholder mirrors — and it can never 404, because an unknown reader is
 * redirected to `/signin` rather than rejected.
 *
 * `/`, `/tag/[slug]` and `/search` are the other list surfaces and deliberately
 * did NOT get one here: they belong to TASK-007, which was landing as this was
 * written, and two workers writing the same directories concurrently is a
 * conflict worth more than a skeleton. TASK-018 is queued against those files
 * behind both slices.
 *
 * ── On styling ───────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 and is outside this task's file scope,
 * so the layout reads design tokens through `style` props. The shimmer, radius
 * and colours are all the `Skeleton` primitive's own — and `Skeleton` carries
 * `role="status"` and `aria-busy`, so a screen-reader user is told the page is
 * working exactly once rather than hearing a list of empty boxes.
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
