/**
 * The SQLite connection-mode guard (SPEC-001).
 *
 * > Database | Local SQLite file at `./data/titan.db` (WAL mode)
 *
 * WAL is not cosmetic here. Without it, SQLite takes a whole-database write
 * lock, so a single in-flight autosave from the editor blocks every reader —
 * which on a single-process server means the feed stops rendering. The
 * criterion is therefore stated as an invariant of the *app connection*, not
 * of the file: "every `PRAGMA journal_mode` on the app connection returns
 * `wal`". WAL is persistent once set, but a connection opened with different
 * pragmas would still be wrong, so both are checked.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * The app connection lives in `lib/db/client.ts`, owned by SPEC-004
 * (TASK-003, Persistence). Until that lands there is no connection to
 * interrogate. The assertions below are complete and arm themselves the
 * moment it does; they need no edit to start running.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDbClient,
  hasMigratableSchema,
  REPO_ROOT,
  type TestDatabase,
} from '../helpers/db';

const READY = hasMigratableSchema();
const REASON = 'waiting on TASK-003 (Persistence): prisma/schema.prisma + migrations do not exist yet';

let db: TestDatabase | undefined;

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(!READY)(`SPEC-001 — the app connection runs in WAL mode${READY ? '' : ` [${REASON}]`}`, () => {
  it('reports journal_mode = wal', async () => {
    db ??= await createTestDatabase();
    const rows = await db.client.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      'PRAGMA journal_mode',
    );
    expect(rows[0]?.journal_mode?.toLowerCase()).toBe('wal');
  });

  it('still reports wal on a second, independently opened connection', async () => {
    // WAL is a persistent property of the database file, so a fresh connection
    // must inherit it. If this passes while the first test fails, the pragma
    // is being set per-connection and something opened it wrong.
    db ??= await createTestDatabase();
    const second = await createTestDatabase();
    try {
      const rows = await second.client.$queryRawUnsafe<Array<{ journal_mode: string }>>(
        'PRAGMA journal_mode',
      );
      expect(rows[0]?.journal_mode?.toLowerCase()).toBe('wal');
    } finally {
      await second.drop();
    }
  });

  it('enforces foreign keys', async () => {
    // SQLite defaults foreign_keys OFF per connection. SPEC-004 relies on
    // cascade behaviour, which silently does nothing without this.
    db ??= await createTestDatabase();
    // DEC-012: the Prisma SQLite driver maps INTEGER to BigInt over
    // $queryRawUnsafe, so this pragma answers `1n`, not `1`. The generic is
    // widened as well as the value coerced — a type that says `number` while
    // the driver returns `bigint` is the latent lie that produced the original
    // failure. Do not "simplify" the Number() away. It cannot weaken the gate:
    // Number(undefined) is NaN, Number(null) and Number(0n) are 0, and all
    // three still fail this assertion.
    const rows = await db.client.$queryRawUnsafe<Array<{ foreign_keys: number | bigint }>>(
      'PRAGMA foreign_keys',
    );
    expect(Number(rows[0]?.foreign_keys)).toBe(1);
  });

  it('is a plain local file, not an attached or remote source', async () => {
    db ??= await createTestDatabase();
    const rows = await db.client.$queryRawUnsafe<Array<{ file: string; name: string }>>(
      'PRAGMA database_list',
    );
    const main = rows.find((r) => r.name === 'main');
    expect(main?.file).toContain('data/');
    expect(main?.file).toMatch(/\.db$/);
  });
});

/** The `DATABASE_URL="..."` value declared in a repo-root env file, or undefined. */
function declaredDatabaseUrl(file: string): string | undefined {
  return /^DATABASE_URL="(.+)"$/m.exec(readFileSync(join(REPO_ROOT, file), 'utf8'))?.[1];
}

/** Delete a sqlite file and its sidecars, wherever it turned out to land. */
function removeDatabase(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

describe('SPEC-001 — the database location is a local file either way', () => {
  /**
   * Where the configured DATABASE_URL actually puts the database.
   *
   * This test used to read `.env.example` and assert the string was
   * `file:./data/titan.db`. It was green for four slices while the database sat
   * in `prisma/data/` (TASK-016), because a relative sqlite `file:` URL is
   * resolved against the directory holding `schema.prisma` — so the string that
   * reads as "the repo root" means `prisma/`. Its own comment said the quiet
   * part out loud: "asserts against configuration rather than a connection, so
   * it holds now."
   *
   * Swapping in a corrected literal would repeat exactly that defect, so this
   * asserts the RESOLVED location instead: run the real migration through the
   * real Prisma CLI at the configured path, then look at where the file landed.
   * `tests/unit/constraints.test.ts` proves the same claim statically from the
   * other end; this one is the empirical half and would catch a change in how
   * Prisma resolves, which no amount of string-matching can.
   *
   * Only the FILENAME is substituted — the directory prefix under test is the
   * committed one, character for character. Migrating `titan.db` itself is
   * forbidden by SPEC-002 and would defeat the purpose anyway.
   */
  it.skipIf(!READY)(
    `migrates to a file under ./data/, not prisma/data/${READY ? '' : ` [${REASON}]`}`,
    () => {
      const configured = declaredDatabaseUrl('.env');
      expect(
        configured,
        '.env must declare DATABASE_URL — it is the file the Prisma CLI reads (DEC-013)',
      ).toBeTruthy();

      // e.g. `file:../data/titan.db` -> prefix `file:../data/`, which is the
      // part this test is actually interrogating.
      const prefix = (configured as string).replace(/[^/]+$/, '');
      const name = `test-${process.pid}-resolve.db`;

      // Belt and braces against SPEC-002's "never against ./data/titan.db":
      // the substitution above cannot produce titan.db, and this proves it.
      expect(`${prefix}${name}`).not.toContain('titan.db');

      const landed = join(REPO_ROOT, 'data', name);
      const legacy = join(REPO_ROOT, 'prisma', 'data', name);
      removeDatabase(landed);
      removeDatabase(legacy);

      try {
        execFileSync(
          process.platform === 'win32' ? 'npx.cmd' : 'npx',
          ['prisma', 'migrate', 'deploy'],
          {
            cwd: REPO_ROOT,
            stdio: 'ignore',
            env: { ...process.env, DATABASE_URL: `${prefix}${name}` },
            shell: process.platform === 'win32',
          },
        );

        expect(
          existsSync(landed),
          `DATABASE_URL="${configured}" did not migrate to ./data/. A relative ` +
            'sqlite path is resolved against prisma/, not the repository root, ' +
            'so it needs to climb out: file:../data/titan.db.',
        ).toBe(true);
        expect(
          existsSync(legacy),
          'the database landed in prisma/data/ — this is the TASK-016 defect, ' +
            'not a new one. SPEC-001 puts persistent state at ./data/.',
        ).toBe(false);
      } finally {
        removeDatabase(landed);
        removeDatabase(legacy);
      }
    },
  );

  it('serves the same database the CLI migrates', async () => {
    // DEC-013: the app's fallback and the CLI's `.env` must name ONE file.
    // If they drift, one database gets migrated and a different one served,
    // with no error to announce it — and `tests/e2e/auth.spec.ts` counts
    // session rows through the fallback while the dev server uses `.env`.
    // Compared as resolved paths rather than strings, because equal strings
    // are not what this needs to be true.
    const { DEFAULT_DATABASE_URL } = await import('../../lib/db/client');
    const schemaDir = join(REPO_ROOT, 'prisma');
    const resolveUrl = (url: string) => resolve(schemaDir, url.replace(/^file:/, ''));

    for (const file of ['.env', '.env.example']) {
      expect(
        resolveUrl(declaredDatabaseUrl(file) ?? ''),
        `${file} and lib/db/client.ts DEFAULT_DATABASE_URL name different databases`,
      ).toBe(resolveUrl(DEFAULT_DATABASE_URL));
    }
    expect(resolveUrl(DEFAULT_DATABASE_URL)).toBe(join(REPO_ROOT, 'data', 'titan.db'));
  });

  it('never lets a test bind the development database', () => {
    // tests/setup.ts rewrites DATABASE_URL to a throwaway path. If this ever
    // fails, an integration suite is one mistake away from wiping dev data.
    expect(process.env.DATABASE_URL).not.toContain('titan.db');
    expect(process.env.DATABASE_URL).toContain(`test-${process.pid}`);
  });

  it(`records why the connection-level assertions are dormant`, () => {
    // A visible, asserted statement of the dependency — so "0 failures" here
    // is never mistaken for "WAL is verified" while Persistence is unbuilt.
    if (!READY) {
      expect(hasDbClient(), 'lib/db/client.ts is owned by TASK-003').toBe(false);
    }
  });
});
