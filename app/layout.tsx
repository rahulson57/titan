import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, Source_Serif_4 } from 'next/font/google';

import './globals.css';
import { THEME_INIT_SCRIPT } from '../lib/theme';

/**
 * Root layout — the design system's entry point (SPEC-003).
 *
 * This replaces TASK-001's placeholder wholesale, per DEC-007. Nothing from it
 * is preserved except `lang="en"`, which is load-bearing for the a11y gate.
 *
 * Deliberately NOT here: navigation, wordmark, user menu, and the mounted
 * ThemeToggle. SPEC-011 owns the app shell and places the toggle in the top
 * nav; putting chrome in the layout would be building another slice's work.
 * This file provides the fonts, the tokens, and the pre-paint theme class —
 * the substrate every surface composes on top of.
 */

/**
 * Fonts are self-hosted, not linked (SPEC-003).
 *
 * `next/font/google` downloads both families at BUILD time and serves them
 * from our own origin with a generated `@font-face`. That matters twice over:
 * SPEC-001 forbids an external network dependency at runtime, and SPEC-003's
 * originality guard requires every font to come through `next/font` from an
 * open-licence family. Source Serif 4 and Inter are both SIL Open Font
 * License 1.1 — no proprietary face, and no Medium font licence, enters the
 * repo.
 *
 * `display: 'swap'` renders the fallback immediately rather than holding a
 * blank frame, which keeps the LCP budget reachable; the fallback stacks in
 * globals.css are chosen to be metrically close so the swap does not reflow
 * the measure.
 */
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-source-serif',
});

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: {
    default: 'Titan',
    template: '%s · Titan',
  },
  description: 'A place to read and write long-form writing worth the time.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /* Both palettes are declared so the browser UI (address bar, form controls)
     matches whichever theme is active from the first frame. */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0f0f' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sourceSerif.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        {/*
          The no-flash script (SPEC-003: "an inline blocking script sets the
          class before first paint").

          Three things about it are deliberate:

          - It is inline, not a module import. Anything with a `src` is a
            network round trip, and anything React renders happens after
            hydration; either one shows a frame of the wrong theme, which is
            the exact defect this exists to prevent.
          - It is in `<head>`, before the stylesheet's first use, so the `dark`
            class is on `<html>` when the very first paint resolves `--bg`.
          - Its source lives in lib/theme.ts as `THEME_INIT_SCRIPT` and is
            executed against a fake document by the unit suite, which asserts
            it agrees with `resolveTheme` + `applyTheme` on every input. The
            duplication with the module is unavoidable — it cannot import —
            but it cannot drift unnoticed.

          `suppressHydrationWarning` on <html> is required and not a smell: the
          script mutates `class` and `style` on the very element React is about
          to reconcile, so server and client markup differ by construction.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
