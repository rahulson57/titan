/**
 * The one SQLite connection (SPEC-004).
 *
 * > All other modules read/write through the typed repository functions in
 * > `lib/db/` — no module opens its own SQLite handle.
 *
 * `tests/unit/db-boundary.test.ts` enforces that literally: this directory is
 * the only place `@prisma/client` may be imported from. Everything else calls a
 * repository function.
 *
 * ── Connection pragmas ──────────────────────────────────────────────────────
 * SPEC-004 requires `journal_mode=WAL`, `foreign_keys=ON` and
 * `busy_timeout=5000`. Those three are not set in the same place, because they
 * are not the same kind of setting:
 *
 *  - `journal_mode=WAL` is a property of the FILE and survives every close, so
 *    it is set once by the initial migration. Setting it here as well would be
 *    harmless but misleading: it would suggest a freshly-migrated database that
 *    the app has not yet opened is somehow not in WAL, which is false.
 *  - `foreign_keys` and `busy_timeout` are per-CONNECTION and reset to their
 *    defaults on every open, so they are applied here, on this client.
 *
 * `connection_limit=1` is appended to the datasource URL for the same reason.
 * Prisma pools connections; a pragma applied through `$executeRawUnsafe` lands
 * on whichever pooled connection served that statement, so with a pool of N
 * the app would have N-1 connections silently running with foreign keys off.
 * One connection makes "the app connection" a thing that exists. It costs
 * nothing here — SQLite in WAL mode admits one writer at a time regardless,
 * and this is a single-process localhost app (DEC-001).
 */

import { PrismaClient } from '@prisma/client';

/** Per-connection pragmas, in the order they are applied. */
export const CONNECTION_PRAGMAS = ['foreign_keys = ON', 'busy_timeout = 5000'] as const;

/**
 * The default when nothing sets `DATABASE_URL` (SPEC-001's boot contract).
 *
 * This MUST stay byte-identical to the `DATABASE_URL` in the committed `.env`.
 * `tests/e2e/auth.spec.ts` counts session rows through this fallback while the
 * dev server serves from `.env`, and DEC-013 records what a disagreement looks
 * like: one database migrated, a different one served, and no error to say so.
 * `tests/unit/db-pragmas.test.ts` asserts the two resolve to the same file.
 *
 * The `../` is load-bearing and must not be "tidied" to `./`. A relative sqlite
 * `file:` URL is resolved against the directory holding `schema.prisma` — i.e.
 * `prisma/` — by both the Prisma CLI and the generated client, NOT against the
 * repository root and NOT against the process cwd. `file:./data/titan.db`
 * therefore names `prisma/data/titan.db`, which is where this application's
 * database actually lived until TASK-016 while `./data/` sat empty. SPEC-001
 * puts persistent state at `./data/titan.db`, so the URL has to climb out of
 * `prisma/` to reach it.
 */
export const DEFAULT_DATABASE_URL = 'file:../data/titan.db';

/**
 * The datasource URL, with the single-connection pool pinned on.
 *
 * Read from the environment on every call rather than captured at module load:
 * `tests/helpers/db.ts` hands each suite a throwaway database by rewriting
 * `DATABASE_URL`, and a value frozen at import time would quietly ignore it and
 * point the whole suite at `./data/titan.db`.
 */
export function databaseUrl(): string {
  const base = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  if (base.includes('connection_limit=')) return base;
  return `${base}${base.includes('?') ? '&' : '?'}connection_limit=1`;
}

let client: PrismaClient | undefined;
let clientUrl: string | undefined;

/**
 * The app connection. Memoised per datasource URL, so a test that repoints
 * `DATABASE_URL` gets a client bound to the new database instead of a stale
 * handle on the old one.
 */
export function getDb(): PrismaClient {
  const url = databaseUrl();
  if (client && clientUrl === url) return client;

  const next = new PrismaClient({ datasources: { db: { url } } });
  // Fire-and-forget is safe here and awaiting is not an option: `getDb()` is
  // called from synchronous module scope all over the app. Prisma serialises
  // work on the single pooled connection in call order, so these land before
  // any query issued after this line — including the first one.
  for (const pragma of CONNECTION_PRAGMAS) {
    void next.$executeRawUnsafe(`PRAGMA ${pragma}`).catch(() => {
      /* a pragma that cannot be applied surfaces on the first real query */
    });
  }

  client = next;
  clientUrl = url;
  return next;
}

/**
 * Close the connection and forget it. Tests call this between throwaway
 * databases; nothing in the app does, because the process owns the connection
 * for its whole life.
 */
export async function disconnectDb(): Promise<void> {
  const current = client;
  client = undefined;
  clientUrl = undefined;
  if (current) await current.$disconnect();
}

/**
 * Read one pragma back off the app connection. Used by the pragma guard tests.
 *
 * The result column is NOT reliably named after the pragma — `PRAGMA
 * busy_timeout` answers in a column called `timeout` — so this falls back to
 * the row's first value rather than trusting the name and silently returning
 * `undefined`.
 */
export async function readPragma(name: string): Promise<unknown> {
  const rows = await getDb().$queryRawUnsafe<Array<Record<string, unknown>>>(`PRAGMA ${name}`);
  const row = rows[0];
  if (!row) return undefined;
  return name in row ? row[name] : Object.values(row)[0];
}
