/**
 * Playwright global setup — runs `npm run setup` BEFORE the web server boots.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * SPEC-001's boot contract is a *sequence*: clean clone → `npm run setup` →
 * `npm run dev` → HTTP 200. `boot.spec.ts` used to execute the setup step from
 * inside a test, which meant it ran with `next dev` already listening — the
 * reverse of the order the contract describes, and a race.
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
 * Running setup here removes the race by construction: `globalSetup` completes
 * before Playwright starts `webServer`, so nothing is connected to the database
 * when the migration runs. Authorised by the operator (MSG-2261), which also
 * widened TASK-004's file scope to cover this file, `playwright.config.ts` and
 * `boot.spec.ts`.
 *
 * ── Why it runs setup TWICE ────────────────────────────────────────────────
 * SPEC-001 requires setup to be idempotent — specifically that a second run
 * does not rotate `AUTH_SECRET`, because rotating it invalidates every session
 * and turns a routine `npm run setup` into a surprise logout. That property is
 * only observable across two runs, so both happen here and the verdict is
 * handed to `boot.spec.ts`, which still owns the assertion.
 *
 * ── How the result reaches the tests ───────────────────────────────────────
 * Through `process.env`. Playwright runs this in the main process and spawns
 * workers from it, so anything set here is inherited — the documented channel
 * for passing global-setup results to specs, and the reason no temp file is
 * involved (a file under `outputDir` would be swept between runs).
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

export default function globalSetup(): void {
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
