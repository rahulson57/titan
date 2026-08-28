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

  // Always boot a server this run owns, and never adopt one that was already
  // listening. Two reasons, both learned from a gate run that hung:
  //
  //  1. Correctness. The criterion is that a *clean boot* answers on 3000.
  //     Adopting a server someone else started proves nothing about this
  //     tree's boot, and would happily go green against a stale build of a
  //     different commit.
  //  2. Teardown. Playwright only kills a web server it started itself. Under
  //     `reuseExistingServer` an adopted `next dev` outlives the run still
  //     holding the stdio pipes it inherited, and the parent `npm test` blocks
  //     forever waiting on a pipe that never closes — the suite reports every
  //     test passed and then simply never exits.
  //
  // The failure mode this replaces is a silent multi-minute hang. The failure
  // mode it introduces is Playwright refusing to start with "port 3000 is
  // already used", which names the problem in one line.
  reuseExistingServer: false,

  // Ask the server tree to stop before killing it. `npm run dev` is three
  // processes deep (npm -> next -> next-server); a bare SIGKILL to the group
  // can leave the grandchild orphaned on port 3000, which is precisely what
  // makes the *next* run fail to bind.
  gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },

  // Own the server's output explicitly rather than letting it inherit this
  // process's stdio. An inherited pipe held open by a surviving child is the
  // other half of the hang described above; piping also keeps the dev server's
  // log attributable when a boot failure needs reading.
  stdout: 'pipe',
  stderr: 'pipe',

  timeout: 60_000, // SPEC-001: HTTP 200 within 60s of a clean boot
} as const;

export default defineConfig({
  testDir: './tests',

  /**
   * `npm run setup` runs HERE, once per run, rather than from inside a test.
   *
   * This is a correctness fix, not tidying. Setup runs `prisma migrate deploy`,
   * and the migration engine cannot get its write lock while a Prisma
   * connection that has WRITTEN is still open — which is exactly what a running
   * dev server is once anyone has signed up. Measured: connection open and
   * read-only, migrate succeeds; open and has written, "database is locked";
   * closed, succeeds.
   *
   * Be precise about why that helps, because the invariant is narrower than it
   * looks (DEC-023): `globalSetup` runs AFTER `webServer` boots, not before.
   * What makes it safe is that no TEST has run yet, so the server has read but
   * not written. The rule to preserve is "setup runs before the app's first
   * WRITE" — anything that writes on boot breaks it. Full reasoning in
   * tests/e2e/global.setup.ts.
   *
   * Authorised by the operator (MSG-2261) as part of TASK-004, which is where
   * the latent defect first surfaced.
   */
  globalSetup: './tests/e2e/global.setup.ts',

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

  // A ceiling on the entire run, teardown included.
  //
  // Per-test timeouts do not bound the run: a suite can pass every test and
  // then hang in teardown, which is exactly how this harness once burned nine
  // minutes of a gate and reported nothing at all. Whatever kills the run
  // should be Playwright, because Playwright says why; an outer harness
  // timeout just truncates the log mid-sentence.
  //
  // The whole suite is seconds today and is bounded by 60s x test count even
  // once every slice has landed, so this is slack, not a budget.
  globalTimeout: Number(process.env.PW_GLOBAL_TIMEOUT ?? 8 * 60_000),

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
