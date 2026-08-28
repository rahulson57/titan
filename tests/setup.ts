/**
 * Vitest global setup (SPEC-002).
 *
 * Loaded before every unit and perf suite. Its whole job is to make the two
 * determinism rules structurally true rather than a thing each test has to
 * remember:
 *
 *   - no test may reach the network;
 *   - no test may touch `./data/titan.db`.
 *
 * Both are enforced as failures at the point of misuse, so a violation names
 * the test that caused it instead of surfacing later as a flake.
 */

import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(REPO_ROOT, 'data');

// ---------------------------------------------------------------------------
// Deterministic environment
// ---------------------------------------------------------------------------

// Fixed timezone: a fixture whose `createdAt` renders differently in BST than
// in UTC is not deterministic, and the machine's local zone is not a product
// property. (NODE_ENV is already 'test' — Vitest sets it, and the type surface
// treats it as read-only.)
process.env.TZ = 'UTC';

// A test that reads DATABASE_URL must get a throwaway file, never the dev
// database. `tests/helpers/db.ts` overrides this per suite; this is the floor.
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('titan.db')) {
  process.env.DATABASE_URL = `file:${join(DATA_DIR, `test-${process.pid}.db`)}`;
}

// Deterministic secret so auth-adjacent suites do not depend on setup having run.
process.env.AUTH_SECRET ??= 'test-secret-not-used-outside-vitest';

// ---------------------------------------------------------------------------
// No network
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    // Loopback is the app under test, not an external service.
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) {
      return realFetch(input as RequestInfo);
    }
    throw new Error(
      `Blocked network call to ${url}.\n` +
        'titan has no external service dependency (SPEC-001). A unit test that ' +
        'needs a remote response is testing the wrong thing — stub it instead.',
    );
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Leak check: throwaway databases must not survive their suite
// ---------------------------------------------------------------------------

afterAll(() => {
  if (!existsSync(DATA_DIR)) return;
  for (const entry of readdirSync(DATA_DIR)) {
    if (entry.startsWith(`test-${process.pid}`)) {
      rmSync(join(DATA_DIR, entry), { force: true });
    }
  }
});

afterEach(() => {
  expect(process.env.DATABASE_URL ?? '').not.toContain('data/titan.db');
});
