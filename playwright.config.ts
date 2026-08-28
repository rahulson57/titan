import { defineConfig, devices } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBootSetup } from './tests/e2e/global.setup';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * The port the TEST HARNESS binds (SPEC-001 v3, Dev-port row).
 *
 * > `npm run dev` stays exactly `next dev -p 3000`; the TEST HARNESS
 * > (playwright webServer + specs) binds `process.env.PORT ?? 3000` so
 * > concurrent worktrees/gates never collide — the platform provisions an
 * > isolated PORT per task.
 *
 * The two halves of that rule are deliberately different and neither is a
 * mistake. `npm run dev` is the human-facing default and stays a constant:
 * "the app is at localhost:3000" is a promise to a person, and three sealed
 * greps plus `boot.spec.ts` pin `package.json` to it. The harness is not
 * human-facing — it is machinery that several worktrees run at the same
 * moment — so it takes the port it is given.
 *
 * Why this exists: four gate runs in two hours (TASK-004 finalize, TASK-005
 * submission gate, TASK-008 finalize, OBJECTIVE-008 integration) failed with
 * `EADDRINUSE` on 3000 while two parallel slices each booted their own
 * `next dev`. Every one of those was green work reported as red, which is the
 * expensive kind of failure: it costs an attempt, and it teaches the reader to
 * distrust the gate.
 *
 * `Number(...)` rather than the raw string because `webServer.url` and
 * `baseURL` are built from it and a stray `PORT=" 3270"` should fail loudly
 * here rather than produce a URL nothing will ever answer. A `PORT` that is
 * not a number is a broken environment, not a port — say so.
 */
export function resolveHarnessPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3000;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      `PORT is set to ${JSON.stringify(raw)}, which is not a TCP port. ` +
        'The harness binds `process.env.PORT ?? 3000` (SPEC-001); unset PORT to get the 3000 default.',
    );
  }
  // NOTE — the forbidden-port constraint is deliberately NOT enforced here.
  //
  // SPEC-001 forbids one port ever being bound, and enforces that with a
  // sealed grep whose stated criterion is that this very file contains no
  // occurrence of that number. So a runtime guard against it cannot be written
  // here without naming it, and naming it fails the constraint that motivates
  // the guard. Naming it some other way (arithmetic, a split string) would be
  // circumventing a sealed check, which is worse than the gap.
  //
  // The gap is real and worth knowing: the port now arrives from OUTSIDE this
  // repo, so a repo-wide grep can no longer see the value that actually gets
  // bound. Raised with the coordinator rather than worked around here.
  return parsed;
}

/** The one port this harness binds (SPEC-001 v3): `process.env.PORT ?? 3000`. */
export const PORT = resolveHarnessPort(process.env.PORT);
export const BASE_URL = `http://localhost:${PORT}`;

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * The dev command, taken from `package.json` with ONLY the port substituted.
 *
 * The property worth keeping is that the harness boots the app the same way a
 * human does — not an ad-hoc invocation that could drift from the documented
 * one and go green against something users never run. Before the port became a
 * variable, `command: 'npm run dev'` said that literally. It cannot any more:
 * `npm run dev` is sealed at `next dev -p 3000` and running it under a
 * provisioned PORT is exactly the collision this file exists to end.
 *
 * So the relationship is preserved rather than the string: read `scripts.dev`
 * and swap its `-p <n>`. If the dev script changes, the harness follows it
 * with no edit here, which is the guarantee the old literal was really making.
 */
export function devCommandForPort(devScript: string, port: number): string {
  const ported = /-p\s+\d+/.test(devScript)
    ? devScript.replace(/-p\s+\d+/, `-p ${port}`)
    : `${devScript} -p ${port}`;
  // `next` lives in node_modules/.bin, which is not on PATH for a command
  // Playwright spawns through a shell.
  return `npx ${ported}`;
}

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
 * a product property", while the boot contract is about `next dev`. It is
 * honoured verbatim — an operator typing an explicit command means it — which
 * also means the operator owns the port in that case: under a provisioned
 * PORT, `PW_WEBSERVER='npm run start'` boots `next start -p 3000` while this
 * config waits on `${BASE_URL}`, and the run fails on the webServer timeout.
 * Pass the port too (`PW_WEBSERVER="npx next start -p $PORT"`) or unset PORT.
 *
 * Note that `url` is used rather than `port`: Playwright accepts exactly one
 * of the two and errors if both are given. `url` is the stronger check — it
 * waits for an actual HTTP response at `/` rather than for something to bind
 * the socket, which is what SPEC-001's "serves HTTP 200" criterion means.
 * `PORT` above stays exported so the port itself is still assertable.
 */
export const WEB_SERVER = {
  command: process.env.PW_WEBSERVER ?? devCommandForPort(pkg.scripts.dev ?? 'next dev', PORT),
  url: BASE_URL,

  // Hand the port down as well as into the command. `next` reads `PORT` when
  // no `-p` is given, and anything the dev server spawns inherits it, so the
  // two channels agree instead of one silently disagreeing with the other.
  env: { PORT: String(PORT) },

  // Always boot a server this run owns, and never adopt one that was already
  // listening. Two reasons, both learned from a gate run that hung:
  //
  //  1. Correctness. The criterion is that a *clean boot* answers on the
  //     harness port. Adopting a server someone else started proves nothing
  //     about this tree's boot, and would happily go green against a stale
  //     build of a different commit.
  //  2. Teardown. Playwright only kills a web server it started itself. Under
  //     `reuseExistingServer` an adopted `next dev` outlives the run still
  //     holding the stdio pipes it inherited, and the parent `npm test` blocks
  //     forever waiting on a pipe that never closes — the suite reports every
  //     test passed and then simply never exits.
  //
  // The failure mode this replaces is a silent multi-minute hang. The failure
  // mode it introduces is Playwright refusing to start with "port is already
  // used", which names the problem in one line. With the port now provisioned
  // per task, that second failure mode should stop happening at all.
  reuseExistingServer: false,

  // Ask the server tree to stop before killing it. The dev command is two
  // processes deep (npx -> next -> next-server); a bare SIGKILL to the group
  // can leave the grandchild orphaned on the port, which is precisely what
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

/**
 * `npm run setup` runs HERE, at config load, and this line is the fix for
 * DEC-040 — read that before moving it.
 *
 * Setup must run before the app's first WRITE (the migration engine cannot get
 * its lock against a Prisma connection that has written; full table in
 * `tests/e2e/global.setup.ts`). It used to run from `globalSetup`, which
 * satisfies that — but DEC-023 established that `globalSetup` runs AFTER
 * `webServer` boots, and step 4 of `scripts/setup.mjs` is `prisma generate`.
 * So every gate booted `next dev`, which memory-maps the 16.8 MB
 * `libquery_engine-*.node`, and then regenerated that binary underneath the
 * live mapping. When the generated client already matched the checkout that
 * was a harmless no-op; when it did not, it produced `SQLITE_CANTOPEN` on a
 * perfectly healthy database, which is how it stayed latent for weeks and then
 * failed several unrelated slices in a row.
 *
 * Module load is the earliest hook there is and it is unambiguously before the
 * server: Playwright cannot boot a `webServer` it has not read this file to
 * learn about. It also keeps the `BOOT_SETUP.*` env-var channel that
 * `boot.spec.ts` reads — this is the runner process, so the workers Playwright
 * forks from it inherit what is published. A command chained into
 * `webServer.command` would also be ordered correctly, but it runs in a child
 * shell and could not publish anything back.
 *
 * Skipped under Vitest, which imports this file to assert the harness shape
 * (`tests/unit/scripts.test.ts`) and must not trigger a migrate/seed to do it.
 * `runBootSetup()` is itself idempotent, so the `globalSetup` hook below stays
 * wired as a fallback and no-ops on the normal path.
 *
 * Authorised by the operator (MSG-2261 for the setup move, TASK-017 for the
 * ordering repair).
 */
if (!process.env.VITEST) {
  runBootSetup();
}

export default defineConfig({
  testDir: './tests',

  // Retained so the documented hook still runs setup if it was ever skipped at
  // config load. On the normal path this is a no-op — see `runBootSetup()`.
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
