/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { buttonClassName } from './Button';
import { type Theme, currentTheme, toggleTheme } from '../../lib/theme';

export interface ThemeToggleProps {
  className?: string;
  /** Accessible name. Defaults to a label naming the theme it switches TO. */
  label?: string;
}

/**
 * Light/dark switch (SPEC-003).
 *
 * SPEC-011 mounts this in the top navigation; the design system owns the
 * control, the app shell owns where it sits. It is not placed in the root
 * layout for that reason.
 *
 * Two details worth stating, because both are easy to get subtly wrong:
 *
 * 1. The initial render is deliberately theme-agnostic. The pre-paint script
 *    in the root layout has already set `class="dark"` on `<html>` by the time
 *    React hydrates, so the server's HTML and the live DOM disagree about the
 *    theme by design. Rendering the icon from state that starts as `null` and
 *    is filled in by an effect keeps hydration from tripping over the
 *    difference, and costs nothing visible — the effect runs in the same frame.
 * 2. The document, not this component, is the source of truth. The handler
 *    reads the class back off `<html>` rather than trusting local state, so a
 *    second toggle mounted elsewhere, or a change made in another tab, cannot
 *    put the two out of step.
 */
export function ThemeToggle({ className, label }: ThemeToggleProps) {
  const [theme, setThemeState] = useState<Theme | null>(null);

  useEffect(() => {
    setThemeState(currentTheme());
  }, []);

  const onClick = useCallback(() => {
    setThemeState(toggleTheme());
  }, []);

  // Before the effect runs the theme is unknown, so the control is described
  // neutrally rather than being labelled with a guess that may be wrong for a
  // frame — a screen reader that reached it early would otherwise announce the
  // opposite of what the button does.
  const next: Theme | null = theme === null ? null : theme === 'dark' ? 'light' : 'dark';
  const accessibleName = label ?? (next === null ? 'Switch theme' : `Switch to ${next} theme`);

  return (
    <button
      type="button"
      className={buttonClassName({ variant: 'ghost', iconOnly: true, className: ['theme-toggle', className].filter(Boolean).join(' ') })}
      onClick={onClick}
      aria-label={accessibleName}
      data-theme={theme ?? undefined}
      data-testid="theme-toggle"
    >
      <span className="theme-toggle__icon" aria-hidden="true">
        {/* Original marks, drawn here rather than imported: SPEC-003 forbids a
            third-party icon asset, and two paths do not justify a dependency. */}
        {theme === 'dark' ? (
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="10" cy="10" r="3.6" />
            <path d="M10 1.4v2.2M10 16.4v2.2M18.6 10h-2.2M3.6 10H1.4M16.08 3.92l-1.56 1.56M5.48 14.52l-1.56 1.56M16.08 16.08l-1.56-1.56M5.48 5.48L3.92 3.92" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9z" />
          </svg>
        )}
      </span>
    </button>
  );
}

export default ThemeToggle;
