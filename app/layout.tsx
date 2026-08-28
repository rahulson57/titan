import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, Source_Serif_4 } from 'next/font/google';
import Script from 'next/script';

import './globals.css';
import { TopNav } from '../components/nav/TopNav';
import { THEME_INIT_SCRIPT, THEME_INIT_SCRIPT_ID } from '../lib/theme';

/**
 * Root layout — the design system's entry point (SPEC-003).
 *
 * This replaces TASK-001's placeholder wholesale, per DEC-007. Nothing from it
 * is preserved except `lang="en"`, which is load-bearing for the a11y gate.
 *
 * This file provides the fonts, the tokens, and the pre-paint theme class —
 * the substrate every surface composes on top of.
 *
 * ── The app shell mounts here (SPEC-011, DEC-029) ─────────────────────────
 * TASK-002 wrote, correctly for its moment: *"Deliberately NOT here:
 * navigation, wordmark, user menu, and the mounted ThemeToggle. SPEC-011 owns
 * the app shell and places the toggle in the top nav; putting chrome in the
 * layout would be building another slice's work."* That slice has now landed,
 * and this is the seat it was holding open.
 *
 * SPEC-011's deliverable is "the persistent chrome around **every page**", and
 * the root layout is the only place in an App Router tree that is genuinely
 * every page. Its "Files owned" list omitted this file — an omission in a
 * derived list rather than an intent, adjudicated as such in DEC-029, which
 * widened TASK-008's scope by this file alone.
 *
 * Everything TASK-002 put here is untouched: the two font families and their
 * CSS variables, `metadata`, `viewport`, `lang="en"` (load-bearing for the
 * a11y gate), and `THEME_INIT_SCRIPT` in its original position in `<head>`.
 * The only change is `<TopNav />` above `{children}`.
 *
 * `RootLayout` stays SYNCHRONOUS. `TopNav` is the async component — it is the
 * one that reads the session — so the dynamic dependency is confined to the
 * subtree that needs it and the pre-paint script path is unchanged.
 *
 * ── The theme script is now rendered twice (TASK-019) ─────────────────────
 * The blocking `<script>` below is still in its original position and still
 * does all the work on every document the server renders. A second copy went
 * in beside it because there is one document the server does NOT render — the
 * stand-in Next sends when `notFound()` is thrown from inside a page — and on
 * that one the blocking tag is reproduced into the DOM but never executed. The
 * measurements, the alternatives rejected, and what is still not fixed are all
 * written out at the call site.
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

        {/*
          ── The same script again, and why that is not belt-and-braces ─────
          TASK-019. The tag above is the only theme code that runs on a
          document the SERVER produced. There is one document this app serves
          that the server does not produce, and on it the tag above never
          executes at all.

          When `notFound()` is thrown from INSIDE a page — `/article/<unknown
          slug>`, `/editor/<unknown id>` — Next 15.5 does not server-render the
          not-found tree the way it does for an unmatched path. It abandons the
          shell and sends a stand-in document of its own:

              <html id="__next_error__"><head>…no stylesheet, no theme
              script…</head><body>…flight payload…</body></html>

          …then renders the whole real tree, root layout included, on the
          CLIENT out of that payload. Measured on this repo at 15.5.24, in
          `next dev` and in `next build && next start` alike:

            | path                         | status | served <html>          |
            |------------------------------|--------|------------------------|
            | /article/<real slug>         | 200    | lang+class (ours)      |
            | /no-such-page  (router 404)  | 404    | lang+class (ours)      |
            | /article/<unknown slug>      | 404    | id="__next_error__"    |
            | /editor/<unknown id>         | 404    | id="__next_error__"    |

          React reproduces this `<script>` element into that document's head —
          it is visible in the DOM afterwards — but it does not RUN it. A
          script element React creates and inserts never executes its inline
          text; only the HTML parser starts a parser-inserted script. So the
          class was never applied, `style.colorScheme` stayed empty, and a
          dark-mode reader got a permanently white 404. Not a flash that
          settles: it never settled.

          `next/script` is the fix because its client path does the one thing
          React's renderer deliberately will not — `document.createElement`,
          set the text, append — which executes. `afterInteractive` places that
          in an effect, and this tag sits in `<head>`, so the effect runs ahead
          of every effect inside `<body>`; `ThemeToggle` therefore still reads
          a document that already carries the right class and cannot mount
          showing the wrong label.

          Three things deliberately NOT done, each measured before it was
          rejected:

          - Replacing the tag above with `strategy="beforeInteractive"`. Next
            then emits it as a deferred external script instead of a blocking
            inline one, and EVERY page — `/` included — went white-then-dark on
            first paint. That is SPEC-003's no-flash criterion, broken
            everywhere, to fix one page.
          - Making `app/not-found.tsx` a client component and applying the
            theme in a layout effect. It works, and it is ~13 ms faster on the
            in-page-404 path, but it costs that file its `metadata` export and
            its no-JavaScript posture — a real regression on the router-404
            path, which renders correctly today, bought for 13 ms of a ~200 ms
            window this file cannot close (see below).
          - Nothing at all on the grounds that "the flash is Next's". The
            residual IS Next's, but the missing class was ours to apply.

          What this does NOT fix, stated plainly so nobody reads the green as
          more than it is: Next's stand-in document carries no stylesheet
          either, so its first paint is an unstyled white frame ~200 ms wide in
          dev, and no code in this repo runs before it. The reader still sees
          white on an in-page 404; they now see it for the width of that frame
          instead of forever. Closing it means stopping Next from taking the
          stand-in path at all, which is not reachable from these three files.
        */}
        <Script
          id={THEME_INIT_SCRIPT_ID}
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>
        {/* SPEC-011's persistent chrome. Above `{children}` so it is the first
            landmark in the document, which is where a screen-reader user and a
            keyboard user both expect the navigation to be. */}
        <TopNav />
        {children}
      </body>
    </html>
  );
}
