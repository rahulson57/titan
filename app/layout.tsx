import type { ReactNode } from 'react';

/**
 * Root layout — PLACEHOLDER.
 *
 * ⚠️  TASK-002 (Design System, SPEC-003) OWNS THIS FILE AND REPLACES IT WHOLESALE.
 *     Per DEC-007, do not preserve or extend anything below; write the real
 *     layout over it.
 *
 * Why it exists at all: Next.js refuses to start without an App Router entry
 * point — `next dev` and `next lint` both abort with "Couldn't find any `pages`
 * or `app` directory" — so S01 could not verify its own boot contract, which
 * is the headline claim of the slice it belongs to. The operator authorised
 * this minimum (MSG-2138) rather than sign S01 off on an unrun promise.
 *
 * It is deliberately missing everything SPEC-003 specifies, so that none of it
 * has to be unpicked later:
 *   - no `import './globals.css'` — app/globals.css is TASK-002's file and
 *     does not exist; a stock Next template would import it and break the build
 *   - no font loading, no `--font-reading` / `--font-ui`
 *   - no theme class or pre-paint theme script
 *   - no nav, no chrome, no components
 */
export const metadata = {
  title: 'titan',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // `lang` is the one thing carried here rather than left to TASK-002: without
  // it every axe scan reports an html-has-lang violation, which would make the
  // a11y gate fail for a reason that has nothing to do with the design system.
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
