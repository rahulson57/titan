/**
 * The harness-shape guard (SPEC-002).
 *
 * SPEC-002 makes two claims that are properties of configuration rather than
 * of any running code: that `npm test` is a single gate composed of both
 * runners, and that Playwright is configured so a flaky pass cannot happen.
 * Neither shows up as a test failure when it regresses — the suite just gets
 * quietly weaker. So they are asserted directly.
 *
 * The Playwright assertions import `playwright.config.ts` and inspect the
 * resolved object rather than grepping its source, so a value moved behind a
 * variable or a spread still gets checked.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import playwrightConfig, { PORT, WEB_SERVER, appIsBootable } from '../../playwright.config';
import vitestConfig from '../../vitest.config';
import { hasDbClient, hasMigratableSchema, hasSeedScript } from '../helpers/db';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('SPEC-002 — the single gate', () => {
  it('runs vitest then playwright under one command', () => {
    // The ordering matters: unit failures are cheaper to read than browser
    // failures, and `&&` means a red unit suite never pays for a browser boot.
    expect(pkg.scripts.test).toBe('vitest run && playwright test');
  });

  it('exposes each half separately for local iteration', () => {
    expect(pkg.scripts['test:unit']).toBe('vitest run');
    expect(pkg.scripts['test:e2e']).toBe('playwright test');
  });

  it('lints types and code in one command', () => {
    expect(pkg.scripts.lint).toBe('next lint && tsc --noEmit');
  });

  it('seeds through tsx, as the determinism rules assume', () => {
    expect(pkg.scripts['db:seed']).toBe('tsx prisma/seed.ts');
    expect(pkg.scripts['db:migrate']).toBe('prisma migrate deploy');
  });

  it('runs `vitest run`, not `vitest`, so the gate cannot hang in watch mode', () => {
    for (const script of ['test', 'test:unit']) {
      expect(pkg.scripts[script]).not.toMatch(/\bvitest\b(?!\s+run)/);
    }
  });
});

describe('SPEC-002 — Playwright is configured against flakiness', () => {
  it('uses exactly one worker', () => {
    expect(playwrightConfig.workers).toBe(1);
  });

  it('never retries — "a flaky pass is a failure"', () => {
    expect(playwrightConfig.retries).toBe(0);
  });

  it('does not run tests in parallel', () => {
    expect(playwrightConfig.fullyParallel).toBe(false);
  });

  it('fails rather than silently narrowing the gate on a stray test.only', () => {
    expect(playwrightConfig.forbidOnly).toBe(true);
  });

  it('drives Chromium only', () => {
    const names = (playwrightConfig.projects ?? []).map((p) => p.name);
    expect(names).toEqual(['chromium']);
  });
});

describe('SPEC-002 — the web server is bound to port 3000', () => {
  it('states the contract on port 3000 at the canonical URL', () => {
    expect(PORT).toBe(3000);
    expect(WEB_SERVER.url).toBe('http://localhost:3000');
    expect(WEB_SERVER.url).toContain(`:${PORT}`);
  });

  it('waits for an HTTP response, not merely for the socket to bind', () => {
    // Playwright takes `url` or `port`, not both. `url` is the one that
    // matches the criterion: SPEC-001 asks for HTTP 200 at `/`, and a bound
    // port that answers nothing would satisfy `port` while failing the spec.
    expect(WEB_SERVER).toHaveProperty('url');
    expect(WEB_SERVER).not.toHaveProperty('port');
  });

  it('boots the app through the project scripts, not an ad-hoc command', () => {
    expect(WEB_SERVER.command).toMatch(/^npm run (dev|build && npm run start|start)$/);
  });

  it('allows the boot contract its full 60 seconds', () => {
    // SPEC-001: HTTP 200 at http://localhost:3000/ within 60s of a clean boot.
    expect(WEB_SERVER.timeout).toBe(60_000);
  });

  it('attaches the web server exactly when there is an app to serve', () => {
    // `next dev` exits immediately without an App Router entry point, so a
    // webServer attached to an app-less tree would fail every e2e run on a
    // timeout that says nothing about the harness. The contract above is
    // asserted unconditionally; the attachment follows the tree.
    //
    // This flips to `true` — with no edit here — once TASK-002 lands
    // app/layout.tsx and TASK-007 lands app/page.tsx.
    if (appIsBootable()) {
      expect(playwrightConfig.webServer).toBeDefined();
      expect(playwrightConfig.webServer).toMatchObject({ url: 'http://localhost:3000' });
    } else {
      expect(playwrightConfig.webServer).toBeUndefined();
    }
  });

  it('routes browser tests at the same origin the server binds', () => {
    expect(playwrightConfig.use?.baseURL).toBe('http://localhost:3000');
  });
});

describe('SPEC-002 — runner ownership is decidable from the filename', () => {
  it('gives *.spec.ts to Playwright', () => {
    expect(playwrightConfig.testMatch).toBe('**/*.spec.ts');
    expect(playwrightConfig.testDir).toBe('./tests');
  });

  it('gives *.test.ts to Vitest and keeps *.spec.ts out of it', () => {
    const include = vitestConfig.test?.include ?? [];
    const exclude = vitestConfig.test?.exclude ?? [];
    expect(include).toContain('tests/**/*.test.ts');
    expect(exclude).toContain('tests/**/*.spec.ts');
  });

  it('never retries on the Vitest side either', () => {
    expect(vitestConfig.test?.retry).toBe(0);
  });
});

/**
 * The backstop.
 *
 * Several suites in this harness are written against slices that have not
 * landed, and guard themselves on whether the artifact they need exists yet.
 * That buys real assertions today at one specific risk: a guard whose
 * predicate is wrong — a renamed file, a moved directory, a typo in a path —
 * never arms. The suite then stays green forever while asserting nothing, and
 * nobody finds out until something it was supposed to catch ships broken.
 *
 * A skip is only acceptable while its dependency is genuinely absent. So each
 * guard is checked here against the thing it claims to be waiting for: if the
 * artifact is present, the guard MUST be armed. This is the test that fails
 * loudly when a predicate goes stale.
 */
describe('SPEC-002 — no guard can hide once its dependency lands', () => {
  const REPO = REPO_ROOT;
  const at = (p: string) => existsSync(join(REPO, p));

  /**
   * Every capability predicate used to guard a suite, paired with the
   * artifacts it is predicated on. `armed` must equal `dependenciesPresent` —
   * in both directions.
   */
  const GUARDS = [
    {
      name: 'hasMigratableSchema (db-pragmas, seed-determinism, perf suites)',
      owner: 'TASK-003 (Persistence)',
      armed: () => hasMigratableSchema(),
      dependenciesPresent: () =>
        at('prisma/schema.prisma') &&
        at('prisma/migrations') &&
        readdirSync(join(REPO, 'prisma', 'migrations')).some((e) => !e.endsWith('.toml')),
    },
    {
      name: 'hasSeedScript (seed-determinism, perf suites)',
      owner: 'TASK-003 (Persistence)',
      armed: () => hasSeedScript(),
      dependenciesPresent: () => at('prisma/seed.ts'),
    },
    {
      name: 'hasDbClient (db-pragmas)',
      owner: 'TASK-003 (Persistence)',
      armed: () => hasDbClient(),
      dependenciesPresent: () => at('lib/db/client.ts'),
    },
    {
      name: 'appIsBootable (boot, a11y, lcp, editor-input)',
      owner: 'TASK-002 (Design System) + TASK-007 (Feed & Search)',
      armed: () => appIsBootable(),
      dependenciesPresent: () => at('app/page.tsx'),
    },
    {
      name: 'hasThemeSystem (a11y, dark-theme half)',
      owner: 'TASK-002 (Design System)',
      armed: () => at('lib/theme.ts'),
      dependenciesPresent: () => at('lib/theme.ts'),
    },
  ] as const;

  it.each(GUARDS.map((g) => [g.name, g] as const))(
    '%s arms exactly when its dependency is present',
    (_name, guard) => {
      expect(
        guard.armed(),
        guard.dependenciesPresent()
          ? `${guard.name} is STILL SKIPPING even though its dependency has landed ` +
            `(${guard.owner}). The predicate has gone stale — the suite it guards ` +
            'is silently asserting nothing. Fix the predicate, do not delete this test.'
          : `${guard.name} claims to be armed but its dependency is absent; the ` +
            'suite it guards will fail for the wrong reason.',
      ).toBe(guard.dependenciesPresent());
    },
  );

  it('reports what is not yet being checked, so a skip is never invisible', () => {
    // Not an assertion so much as a visible ledger: `npm test` prints this,
    // and a reviewer can see at a glance which slices are still unverified.
    const waiting = GUARDS.filter((g) => !g.armed());
    if (waiting.length > 0) {
      console.warn(
        '\n[harness] suites armed but not yet running, and what each waits on:\n' +
          waiting.map((g) => `  - ${g.name} -> ${g.owner}`).join('\n') +
          '\n',
      );
    }
    // The ledger must stay complete: every guard used in the harness is listed
    // above. If a new guarded suite is added without registering it here, this
    // count is the thing that should be updated deliberately.
    expect(GUARDS).toHaveLength(5);
  });
});

/**
 * The runner-version guard.
 *
 * `vitest` is a core package plus a separately-published coverage provider,
 * and the two are only compatible at matching versions — mix them and the run
 * dies during startup with `Cannot read properties of undefined (reading
 * 'reportsDirectory')`, before a single test is collected. That is not a test
 * failure; it is the gate failing to exist.
 *
 * This is not hypothetical here. The acceptance oracle runs a bare
 * `vitest run --coverage`, not `npm run test:coverage`, so which core actually
 * executes depends on how the runner's PATH resolves `vitest` — and a hoisted
 * `node_modules/.bin` above this repo won this project's checkout once already.
 * The core is therefore not fully under this package.json's control; the
 * provider is. Pinning both to the same exact version is what keeps the two
 * halves in step regardless of which copy of the core gets invoked.
 *
 * Exact versions, not ranges: `^3.2.4` on both sides still permits an install
 * that resolves the two packages to different minors.
 */
describe('SPEC-002 — the runner cannot be assembled from mismatched halves', () => {
  const core = pkg.devDependencies.vitest;
  const provider = pkg.devDependencies['@vitest/coverage-v8'];

  it('declares both halves of the coverage runner', () => {
    expect(core, 'vitest is not a devDependency').toBeTruthy();
    expect(provider, '@vitest/coverage-v8 is not a devDependency').toBeTruthy();
  });

  it('pins them to the same exact version', () => {
    expect(
      provider,
      `@vitest/coverage-v8 (${provider}) must match vitest (${core}) exactly — a ` +
        'mismatched provider crashes `vitest run --coverage` during startup, which ' +
        'reads as a broken gate rather than as a failing test.',
    ).toBe(core);
  });

  it('uses exact versions, so an install cannot drift them apart', () => {
    for (const [name, version] of [
      ['vitest', core],
      ['@vitest/coverage-v8', provider],
    ] as const) {
      expect(
        /^\d+\.\d+\.\d+$/.test(version ?? ''),
        `${name} is declared as "${version}"; a range lets npm resolve the two ` +
          'halves to different versions. Pin it exactly.',
      ).toBe(true);
    }
  });
});

describe('SPEC-002 — coverage budget', () => {
  it('enforces >= 80% statements', () => {
    // Read through a narrowed shape: `coverage` is a union over providers and
    // the custom-provider member carries no `thresholds`, so reaching for the
    // property on the union does not type-check.
    const coverage = vitestConfig.test?.coverage as
      | { thresholds?: { statements?: number } }
      | undefined;
    expect(coverage?.thresholds?.statements).toBe(80);
  });

  it('measures lib/** — the product logic — and nothing else', () => {
    const coverage = vitestConfig.test?.coverage as { include?: string[]; exclude?: string[] };
    expect(coverage.include).toEqual(expect.arrayContaining(['lib/**/*.ts', 'lib/**/*.tsx']));

    // Scoping matters in both directions: a config that also counted tests/ or
    // app/ would dilute the lib figure until the threshold stopped biting.
    for (const pattern of coverage.include ?? []) {
      expect(pattern.startsWith('lib/'), `coverage include escapes lib/: ${pattern}`).toBe(true);
    }
  });
});
