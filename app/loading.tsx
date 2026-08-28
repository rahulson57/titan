/**
 * The route-level loading fallback (SPEC-011).
 *
 * > "`app/loading.tsx` per route group renders the `Skeleton` primitive; no
 * >  route shows a blank white frame for more than 200 ms after navigation."
 *
 * ── How this actually satisfies "never a blank frame" ─────────────────────
 * Next wraps every segment below this file in a `<Suspense>` whose fallback is
 * this component. The moment a navigation starts, this renders — synchronously,
 * from markup already in the client bundle — while the server component tree
 * for the destination is still streaming. There is no data fetch, no effect
 * and no client JavaScript in the path, which is what makes the 200 ms budget
 * reachable rather than merely hoped for.
 *
 * It lives at `app/` root on purpose. A `loading.tsx` covers its own segment
 * and everything nested under it, so one file here gives every route in the
 * product a non-blank first frame. Routes with a distinctive shape — the
 * article page, the editor — are free to add their own closer to the leaf and
 * it will win for that subtree; this is the floor, not a ceiling, and the
 * floor is what the criterion is about.
 *
 * ── Why the shape is what it is ───────────────────────────────────────────
 * The skeleton deliberately mirrors a list of article cards rather than being
 * a generic spinner. Most navigations in this product land on a list — the
 * feed, a tag, search, a profile, `/bookmarks` — and a placeholder with
 * roughly the right geometry means the real content replaces it without the
 * page jumping. A centred spinner would reserve no space at all and guarantee
 * a layout shift on arrival.
 *
 * `Skeleton` itself carries `role="status"` and `aria-busy`, and labels the
 * whole block "Loading" once instead of announcing a list of empty boxes — so
 * a screen-reader user is told the page is working, exactly once.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the layout reads design tokens through `style` props. The
 * shimmer, radius and colours are all the `Skeleton` primitive's own.
 */

import type { CSSProperties } from 'react';

import { Skeleton } from '../components/ui/Skeleton';

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
