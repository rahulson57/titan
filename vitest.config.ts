import { defineConfig } from 'vitest/config';

/**
 * Vitest — the unit/integration/perf half of the single gate (SPEC-002).
 *
 * File-extension convention, and the reason for it: `.test.ts` belongs to
 * Vitest, `.spec.ts` belongs to Playwright. The two runners both default to
 * globbing `tests/**`, and a Playwright spec imported into a Node context
 * fails in a confusing way. Splitting on extension makes ownership decidable
 * from the filename alone, with no per-directory exceptions to remember.
 *
 * `tests/perf/*.test.ts` runs here (in-process query timing); `tests/perf/
 * *.spec.ts` runs under Playwright (browser-observed timing).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],

    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'tests/**/*.spec.ts'],

    // SPEC-002 forbids flaky passes. A retry is how a flaky test hides, so
    // there are none — same posture as `retries: 0` on the Playwright side.
    retry: 0,

    // Parts of this harness are armed against slices that have not landed and
    // skip until they do. The skip ledger in tests/unit/scripts.test.ts prints
    // what is still unverified — but the default reporter buffers console
    // output from *passing* tests and drops it, which would hide exactly the
    // message whose job is to be seen. Writing straight through keeps it on
    // screen for a plain `npm test`.
    disableConsoleIntercept: true,

    // Perf suites time real queries against a real database. Sharing a process
    // with other suites adds GC and scheduler noise straight into the p95, and
    // two suites migrating SQLite files concurrently contend on disk. Forked
    // processes, one file at a time.
    pool: 'forks',
    fileParallelism: false,

    // Perf suites do 100+ timed runs against a 500-article corpus and a cold
    // suite has to migrate a database first.
    testTimeout: 30_000,
    hookTimeout: 120_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',

      // The budget applies to `lib/**` — the product logic other slices ship.
      // Configs, tests and generated output are not the thing being measured.
      include: ['lib/**/*.ts', 'lib/**/*.tsx'],
      exclude: ['lib/**/*.d.ts', 'lib/**/*.test.ts', 'lib/**/*.test.tsx'],

      // Note: an unimported `lib/**` file still counts as 0% rather than
      // dropping out of the denominator — otherwise a module nobody tested
      // would vanish from the measurement and the budget would quietly apply
      // to a smaller population than it claims. Vitest 4 does this by default
      // for everything matched by `include`; it was the `all: true` flag in v2.

      thresholds: {
        statements: 80,
      },
    },
  },
});
