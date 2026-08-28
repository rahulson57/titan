/**
 * Throwaway-database lifecycle for integration tests (SPEC-002, "Determinism rules").
 *
 * > Integration tests run against a throwaway SQLite file per suite
 * > (`./data/test-<pid>.db`), migrated then dropped. Never against
 * > `./data/titan.db`.
 *
 * That rule is enforced here rather than trusted to each caller:
 * `createTestDatabase()` is the only sanctioned way to get a connection in a
 * test, it refuses to hand back a path that could collide with the development
 * database, and it registers its own teardown.
 *
 * ── On the capability probes ────────────────────────────────────────────────
 * S01 owns the harness; SPEC-004 (Persistence) owns `prisma/schema.prisma`,
 * the migrations and the seed corpus. Until that slice lands there is no
 * schema to migrate and no client to generate, so the database-bound suites
 * have nothing to assert against.
 *
 * The probes below let those suites state their real assertions *now* and arm
 * themselves automatically the moment Persistence lands — no edit to any test
 * file required. A suite guarded by `hasMigratableSchema()` is not a suite
 * that was skipped; it is a suite that is waiting, and it reports which task
 * it is waiting on.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

/** The development database. Tests must never open this. */
export const DEV_DB_PATH = join(DATA_DIR, 'titan.db');

// ---------------------------------------------------------------------------
// Capability probes
// ---------------------------------------------------------------------------

/** True once SPEC-004 has landed a Prisma schema. */
export function hasPrismaSchema(): boolean {
  return existsSync(join(REPO_ROOT, 'prisma', 'schema.prisma'));
}

/** True once SPEC-004 has landed at least one migration to deploy. */
export function hasMigrations(): boolean {
  const dir = join(REPO_ROOT, 'prisma', 'migrations');
  if (!existsSync(dir)) return false;
  // A migrations directory with only `migration_lock.toml` is not deployable.
  return readdirSync(dir).some((entry) => !entry.endsWith('.toml'));
}

/** True once there is a schema *and* migrations — i.e. a database can be built. */
export function hasMigratableSchema(): boolean {
  return hasPrismaSchema() && hasMigrations();
}

/** True once SPEC-004 has landed the deterministic seed script. */
export function hasSeedScript(): boolean {
  return existsSync(join(REPO_ROOT, 'prisma', 'seed.ts'));
}

/** True once SPEC-004 has landed the repository layer that owns the app connection. */
export function hasDbClient(): boolean {
  return existsSync(join(REPO_ROOT, 'lib', 'db', 'client.ts'));
}

/**
 * A human-readable reason for a waiting suite, so a skip in the report names
 * the task that unblocks it instead of reading as an unexplained gap.
 */
export function waitingOn(what: string, task: string): string {
  return `waiting on ${task}: ${what} does not exist yet`;
}

// ---------------------------------------------------------------------------
// Throwaway databases
// ---------------------------------------------------------------------------

let sequence = 0;

/**
 * Allocate a unique throwaway database path for this process.
 * Shape is `./data/test-<pid>.db` per SPEC-002; a monotonic suffix is appended
 * when one process needs more than one, so concurrent suites in the same
 * worker cannot share a file by accident.
 */
export function allocateTestDbPath(): string {
  const n = sequence++;
  const name = n === 0 ? `test-${process.pid}.db` : `test-${process.pid}-${n}.db`;
  const path = join(DATA_DIR, name);
  if (path === DEV_DB_PATH) {
    throw new Error('refusing to hand out the development database as a test database');
  }
  return path;
}

/** `file:` URL Prisma expects, relative paths resolved against the repo root. */
export function toDatabaseUrl(dbPath: string): string {
  return `file:${dbPath}`;
}

/** Remove a SQLite database and its WAL sidecars. Safe to call twice. */
export function dropTestDatabase(dbPath: string): void {
  if (dbPath === DEV_DB_PATH) {
    throw new Error('refusing to drop the development database');
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Minimal structural view of a Prisma client — avoids depending on generated types. */
export interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
}

export interface TestDatabase {
  /** Absolute path to the throwaway `.db` file. */
  path: string;
  /** `file:`-prefixed URL, suitable for `DATABASE_URL`. */
  url: string;
  /** A connected client. */
  client: RawClient;
  /** Disconnect and delete the file plus its sidecars. */
  drop(): Promise<void>;
}

/**
 * Build a migrated, empty database and connect to it.
 *
 * Throws if the schema is not available — callers are expected to guard with
 * `hasMigratableSchema()` so the failure is a clear skip rather than a crash.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!hasMigratableSchema()) {
    throw new Error(
      waitingOn('prisma/schema.prisma with migrations', 'TASK-003 (Persistence)'),
    );
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const path = allocateTestDbPath();
  const url = toDatabaseUrl(path);
  dropTestDatabase(path); // start from nothing, even if a prior run died hard

  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'migrate', 'deploy'],
    {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: { ...process.env, DATABASE_URL: url },
      shell: process.platform === 'win32',
    },
  );

  // Deliberately a non-literal specifier: the generated client does not exist
  // as a *type* until `prisma generate` has run, so a static import here would
  // make `tsc --noEmit` fail on a tree where Persistence has not landed yet.
  // The structural `RawClient` view above is all this helper needs.
  const specifier: string = '@prisma/client';
  const mod = (await import(specifier)) as {
    PrismaClient: new (opts: { datasources: { db: { url: string } } }) => RawClient;
  };
  const client = new mod.PrismaClient({ datasources: { db: { url } } });

  return {
    path,
    url,
    client,
    async drop() {
      await client.$disconnect();
      dropTestDatabase(path);
    },
  };
}
