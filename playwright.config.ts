import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

/** The one port this project binds, ever (SPEC-001). */
export const PORT = 3000;
export const BASE_URL = `http://localhost:${PORT}`;

/**
 * Does the tree contain an App Router entry point yet?
 *
 * `next dev` does not start at all without one — it exits with "Couldn't find
 * any `pages` or `app` directory" — so this is the difference between a web
 * server that can bind and one that cannot.
 *
 * S01 (this slice) owns the runtime and the harness. `app/layout.tsx` is owned
 * by SPEC-003 (TASK-002, Design System) and `app/page.tsx` by SPEC-008
 * (TASK-007, Feed & Search). Until at least one of those lands there is no
 * bootable app, and attaching a `webServer` to it would make every e2e run
 * fail on a 60s timeout that says nothing about this slice's correctness.
 *
 * So the browser suites state their real assertions and skip with a named
 * reason while this is false. Nothing here needs editing when it flips.
 */
export function appIsBootable(): boolean {
  return ['app/page.tsx', 'app/page.jsx', 'app/page.js', 'pages/index.tsx'].some((p) =>
    existsSync(join(REPO_ROOT, p)),
  );
}

/**
 * The web server contract, stated once so it can be asserted directly rather
 * than regex-matched out of this file's source.
 *
 * `PW_WEBSERVER` exists for one reason: SPEC-002 fixes the budgets against
 * `next build && next start`, "since dev-mode compilation dominates and is not
 * a product property", while the boot contract is about `next dev`. Both bind
 * port 3000; the LCP suite asks for the production build explicitly.
 *
 * Note that `url` is used rather than `port`: Playwright accepts exactly one
 * of the two and errors if both are given. `url` is the stronger check — it
 * waits for an actual HTTP response at `/` rather than for something to bind
 * the socket, which is what SPEC-001's "serves HTTP 200" criterion means.
 * `PORT` above stays exported so the port itself is still assertable.
 */
export const WEB_SERVER = {
  command: process.env.PW_WEBSERVER ?? 'npm run dev',
  url: BASE_URL,
  reuseExistingServer: !process.env.CI,
  timeout: 60_000, // SPEC-001: HTTP 200 within 60s of a clean boot
} as const;

export default defineConfig({
  testDir: './tests',

  // `.spec.ts` is Playwright's; `.test.ts` is Vitest's. See vitest.config.ts.
  testMatch: '**/*.spec.ts',

  // SPEC-002: "1 worker, retries: 0, fullyParallel: false — a flaky pass is a
  // failure." The perf budgets are also only meaningful on an unloaded
  // machine, which parallel workers would not be.
  workers: 1,
  retries: 0,
  fullyParallel: false,

  // A `test.only` left behind would silently narrow the gate.
  forbidOnly: true,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './test-results',

  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // Chromium only (SPEC-002). One browser, one machine, no matrix.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Attached only when there is an app to serve. See `appIsBootable()`.
  webServer: appIsBootable() ? { ...WEB_SERVER } : undefined,
});
