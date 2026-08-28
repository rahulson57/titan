/**
 * Playwright boot setup — runs `npm run setup` once per run, before the web
 * server starts and therefore before any test runs.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * SPEC-001's boot contract is a *sequence*: clean clone → `npm run setup` →
 * `npm run dev` → HTTP 200. `boot.spec.ts` used to execute the setup step from
 * inside a test, which meant it ran not merely with `next dev` listening, but
 * after other specs had already driven the app through it. That is a race.
 *
 * The race is not theoretical. `npm run setup` runs `prisma migrate deploy`,
 * and the migration engine needs a write lock on the SQLite file. Measured on
 * this repo:
 *
 *   | state of the app's Prisma connection      | `prisma migrate deploy` |
 *   |-------------------------------------------|-------------------------|
 *   | open, has only READ                       | succeeds                |
 *   | open, has WRITTEN                         | **"database is locked"** |
 *   | closed                                    | succeeds                |
 *
 * `lib/db/client.ts` deliberately holds one connection for the process's whole
 * life (it is where `foreign_keys=ON` and `busy_timeout` are established), so
 * a running dev server that has served a single sign-up blocks the migration
 * for the rest of the run. The schema engine uses its own connection and does
 * not inherit `busy_timeout=5000`, so it fails instantly rather than waiting.
 *
 * This was latent from the first day and surfaced the moment an e2e suite made
 * the app WRITE — SPEC-005's sign-up was the first. SPEC-006 (uploads),
 * SPEC-007 (autosave), SPEC-009 (claps/bookmarks) and SPEC-010 (profile edits)
 * would each have hit it in turn, and Playwright orders files alphabetically,
 * so `article`, `bookmarks` and `editor` all sort ahead of `boot` too.
 *
 * ── WHERE IT RUNS FROM, AND WHY THAT MOVED (DEC-040) ───────────────────────
 * This used to be wired only as Playwright's `globalSetup`. That was ordered
 * *later* than it looks: DEC-023 established, against the installed runner
 * source rather than the docs, that in Playwright 1.55.1 `globalSetup` runs
 * AFTER `webServer` — `webServer` is registered as a plugin, and
 * `createGlobalSetupTasks` awaits every plugin's `setup()` (which is what
 * boots the dev server and polls its URL) before invoking any `globalSetup`
 * module.
 *
 * For the DATABASE that was still safe, and the reasoning was right as far as
 * it went: the invariant needed is "setup runs before the app's first WRITE",
 * not "before the app starts", and at `globalSetup` time the server has served
 * only its readiness probe. What that reasoning did not cover is that step 4
 * of `scripts/setup.mjs` is `prisma generate`, which rewrites
 * `libquery_engine-darwin-arm64.dylib.node` — 16.8 MB of native code the dev
 * server has already memory-mapped. Replacing a binary under a live mmap is
 * not a database race and no amount of read/write reasoning about SQLite
 * catches it. It surfaces as `SQLITE_CANTOPEN` against a completely healthy
 * database, which is why it read for weeks as flakiness in whichever slice
 * happened to be running.
 *
 * It stayed invisible while `generate` was a no-op (when the generated
 * client's `sourceFilePath` already matches the invoking checkout, it rewrites
 * nothing). Anything that repoints the shared client at another worktree turns
 * that no-op into a real 16.8 MB rewrite on every subsequent run, and the gate
 * starts destroying its own query engine mid-flight.
 *
 * So `runBootSetup()` is now called from `playwright.config.ts` at module
 * load. That is strictly before the web server, and not by convention:
 * Playwright has to read the config to discover there is a `webServer` at all.
 * The `globalSetup` hook below stays wired and calls the same function, which
 * no-ops if it has already run — a fallback, not a second execution.
 *
 * The env-var channel is why this is a function called from the config rather
 * than a command chained onto `webServer.command`. Both orderings would be
 * correct; only this one runs in the runner process, and `boot.spec.ts` reads
 * its verdicts out of `process.env` (see below). A chained shell command is a
 * child and can publish nothing back to its parent.
 *
 * WHAT WOULD BREAK THIS AGAIN: the database invariant is unchanged and still
 * narrower than "setup goes first" implies — it rests on nothing writing
 * between setup and the end of the run's first write. Anything that makes a
 * page load write (a session touch, a visit counter, a warm-up job,
 * middleware that records a request) is fine now that setup precedes the boot,
 * but moving this call back into `globalSetup` reinstates both hazards at
 * once. If you need to move it, move it EARLIER, never later.
 *
 * Authorised by the operator (MSG-2261, which widened TASK-004's file scope to
 * cover this file and `playwright.config.ts`; TASK-017 for the DEC-040
 * ordering repair).
 *
 * ── Why it runs setup TWICE ────────────────────────────────────────────────
 * SPEC-001 requires setup to be idempotent — specifically that a second run
 * does not rotate `AUTH_SECRET`, because rotating it invalidates every session
 * and turns a routine `npm run setup` into a surprise logout. That property is
 * only observable across two runs, so both happen here and the verdict is
 * handed to `boot.spec.ts`, which still owns the assertion.
 *
 * ── How the result reaches the tests ───────────────────────────────────────
 * Through `process.env`. This runs in Playwright's main process and the
 * workers are spawned from it, so anything set here is inherited — the
 * documented channel for passing setup results to specs, and the reason no
 * temp file is involved (a file under `outputDir` would be swept between
 * runs).
 *
 * The failure text is carried across deliberately. The old arrangement used
 * `stdio: 'pipe'` and asserted on the exit code, so a failing gate reported
 * only "Command failed: npx prisma migrate deploy" with the actual SQLite
 * error discarded — the diagnosis above took an hour of instrumenting to
 * recover. Whatever breaks this next should say so on the first read.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_LOCAL = join(REPO_ROOT, '.env.local');

/**
 * The environment keys this module publishes for `boot.spec.ts`.
 *
 * Exported as constants rather than typed as string literals at both ends, so
 * a rename cannot leave the spec silently reading an unset variable — which
 * would read as "setup did not run" and fail for the wrong reason.
 */
export const BOOT_SETUP = {
  /** `'1'` when both setup runs exited 0. */
  ok: 'TITAN_BOOT_SETUP_OK',
  /** Combined stderr/stdout of the run that failed; empty when both passed. */
  error: 'TITAN_BOOT_SETUP_ERROR',
  /** `'1'` when `.env.local` was byte-identical before and after the second run. */
  idempotent: 'TITAN_BOOT_SETUP_IDEMPOTENT',
} as const;

interface RunResult {
  ok: boolean;
  output: string;
}

/**
 * One `npm run setup`, with its output captured rather than discarded.
 *
 * `--no-browsers` because Playwright is the thing invoking this: the Chromium
 * build it drives necessarily already exists, and re-checking it would add
 * seconds to every run for a certainty.
 */
function runSetup(): RunResult {
  try {
    execFileSync('node', ['scripts/setup.mjs', '--quiet', '--no-browsers'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: 120_000,
    });
    return { ok: true, output: '' };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; message?: string };
    const output = [failure.stdout, failure.stderr]
      .map((stream) => (stream ? String(stream) : ''))
      .join('\n')
      .trim();
    return { ok: false, output: output || failure.message || 'setup failed with no output' };
  }
}

/** `.env.local` verbatim, or `''` when setup has not produced one. */
function envLocal(): string {
  return existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, 'utf8') : '';
}

/**
 * Run setup twice and publish the verdicts, at most once per process tree.
 *
 * Called from `playwright.config.ts` at module load — see the DEC-040 section
 * above for why that, and not `globalSetup`, is where the ordering is safe.
 *
 * Idempotent on two levels, because this module is loaded more than once:
 *
 *  - `hasRun` covers a second call within one process (config load, then the
 *    `globalSetup` hook).
 *  - the published env var covers Playwright's WORKER processes, which load
 *    the config again but inherit the runner's environment. Without it, every
 *    worker would re-run migrate/seed — after the server booted, which is
 *    precisely the ordering this change exists to remove.
 */
let hasRun = false;

export function runBootSetup(): void {
  if (hasRun || process.env[BOOT_SETUP.ok] !== undefined) return;
  hasRun = true;

  const first = runSetup();

  // Only meaningful if the first run worked; a second attempt after a failure
  // would report a confusing "not idempotent" on top of the real error.
  const afterFirst = envLocal();
  const second = first.ok ? runSetup() : { ok: false, output: '' };
  const afterSecond = envLocal();

  process.env[BOOT_SETUP.ok] = first.ok && second.ok ? '1' : '0';
  process.env[BOOT_SETUP.error] = first.ok ? second.output : first.output;
  // Compared as whole-file bytes rather than by extracting the secret: any
  // rewrite of this file between identical runs is a non-idempotency worth
  // seeing, not just a rotated AUTH_SECRET.
  process.env[BOOT_SETUP.idempotent] =
    afterFirst.length > 0 && afterFirst === afterSecond ? '1' : '0';
}

/**
 * Playwright's `globalSetup` hook — a fallback, not the primary path.
 *
 * On a normal run `playwright.config.ts` has already called `runBootSetup()`
 * at module load and this no-ops. It stays wired so that any path which
 * reaches the runner without loading that module still gets a setup, and so
 * the hook remains where a reader looks for it.
 */
export default function globalSetup(): void {
  runBootSetup();
}
