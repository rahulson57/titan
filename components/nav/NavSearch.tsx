/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx. */
import type { CSSProperties } from 'react';

import { SEARCH } from '../../lib/routes';

export interface NavSearchProps {
  /** Pre-fills the box — `/search?q=` echoes the query back into the chrome. */
  defaultQuery?: string;
  className?: string;
}

/**
 * The nav's search entry (SPEC-011: "command-free search entry").
 *
 * ── Why this is a plain GET form and not a client component ───────────────
 * It is one input and one destination. A client component would need state, a
 * router import, a submit handler and hydration, and would buy nothing: the
 * browser already knows how to serialise `<input name="q">` into `?q=` and
 * navigate. What the plain form buys instead is real:
 *
 *   - **It works before hydration, and without JavaScript.** The nav is on
 *     every page, so it is the first interactive thing a reader meets; a
 *     search box that is dead for the first few hundred milliseconds after
 *     load is a search box that gets clicked twice.
 *   - **It costs nothing on the LCP budget.** SPEC-002 caps article LCP at
 *     1500 ms. Chrome is on every route, so every kilobyte of client component
 *     here is paid on every route.
 *   - **The URL is the state.** `/search?q=x` is shareable and back-buttonable
 *     for free, which is what SPEC-011's `?q=` note describes.
 *
 * `method="get"` is not the default for a `<form>` in spirit only — it is the
 * HTML default, but it is stated explicitly because getting it wrong makes the
 * box POST to `/search`, which App Router answers with a 405 and no clue why.
 *
 * `role="search"` names the landmark so a screen-reader user can jump to it;
 * the input carries a visually-hidden `<label>` rather than a `placeholder`,
 * because a placeholder is not an accessible name and vanishes the moment
 * anyone types.
 */
const formStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

const inputStyle: CSSProperties = {
  // Reads as a field without a heavy border: the chrome should recede.
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-pill)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-meta-size)',
  padding: 'var(--space-2) var(--space-4)',
  // Wide enough for a two-word query, narrow enough not to crowd the actions.
  inlineSize: '13rem',
  maxInlineSize: '40vw',
};

export function NavSearch({ defaultQuery, className }: NavSearchProps) {
  return (
    <form
      className={className}
      style={formStyle}
      action={SEARCH}
      method="get"
      role="search"
      data-testid="nav-search"
    >
      {/*
        `.visually-hidden` is SPEC-003's utility from globals.css — the label
        is present for assistive tech and absent from the visual design, which
        is what the spec's compact nav asks for. Hiding it with `display: none`
        instead would remove it from the accessibility tree too, leaving the
        input nameless.
      */}
      <label className="visually-hidden" htmlFor="nav-search-q">
        Search stories
      </label>
      <input
        id="nav-search-q"
        // `q` is not arbitrary: SPEC-011's route table specifies `/search?q=`.
        name="q"
        type="search"
        defaultValue={defaultQuery}
        autoComplete="off"
        style={inputStyle}
        placeholder="Search"
        data-testid="nav-search-input"
      />
    </form>
  );
}

export default NavSearch;
