/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them. */
import type { CSSProperties } from 'react';

import { SEARCH } from '../../lib/routes';

/**
 * The search page's own query field (SPEC-008, `/search?q=`).
 *
 * A plain GET form, for the reasons `components/nav/NavSearch.tsx` sets out at
 * length: it works before hydration and without JavaScript, it costs nothing
 * on the LCP budget, and `?q=` in the URL makes every result page shareable
 * and back-buttonable for free. This is the same idea at page scale — bigger,
 * and carrying a submit button, because on `/search` the field IS the page's
 * primary control rather than a corner of the chrome.
 *
 * ── Why this is not just `NavSearch` with a size prop ─────────────────────
 * `NavSearch` is SPEC-011's App Shell component and lives in every page's
 * header — including this one. Both are on screen at the same time, so they
 * are not one component used twice; they are two controls that must not
 * collide. Concretely, `NavSearch` hard-codes `id="nav-search-q"`, and two
 * elements sharing an `id` is a duplicate-id violation that
 * `tests/e2e/a11y.spec.ts` fails on — and, worse, makes the `<label for=...>`
 * point at whichever field the browser found first, so clicking one label
 * focuses the other field.
 *
 * ── The label is real, not a placeholder ──────────────────────────────────
 * A `placeholder` is not an accessible name and it disappears the moment
 * anyone types. The visible label is the search page's own heading context, so
 * the field's label is visually hidden and present for assistive technology —
 * the same trade `NavSearch` makes, and SPEC-003's `.visually-hidden` utility
 * is what makes it available without a style of this component's own.
 */

export interface SearchBoxProps {
  /** Pre-fills the field, so `/search?q=x` echoes the query back. */
  defaultQuery?: string;
  className?: string;
}

const formStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  marginBlockEnd: 'var(--space-7)',
};

const inputStyle: CSSProperties = {
  flex: '1 1 auto',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-pill)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-ui-size)',
  padding: 'var(--space-3) var(--space-5)',
  minInlineSize: 0,
};

export function SearchBox({ defaultQuery, className }: SearchBoxProps) {
  return (
    <form
      className={className}
      style={formStyle}
      action={SEARCH}
      // Stated rather than left to the HTML default: getting it wrong makes
      // the box POST to /search, which App Router answers with a 405 and no
      // clue why.
      method="get"
      role="search"
      data-testid="search-box"
    >
      <label className="visually-hidden" htmlFor="search-page-q">
        Search stories
      </label>
      <input
        // Distinct from NavSearch's `nav-search-q`. See the header: both
        // fields are on this page at once.
        id="search-page-q"
        // `q` is not arbitrary — SPEC-011's route table specifies `/search?q=`.
        name="q"
        type="search"
        defaultValue={defaultQuery}
        autoComplete="off"
        style={inputStyle}
        placeholder="Search stories"
        data-testid="search-input"
      />
      <button type="submit" className="btn btn--primary" data-testid="search-submit">
        Search
      </button>
    </form>
  );
}

export default SearchBox;
