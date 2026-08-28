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

import { afterAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDbClient,
  hasMigratableSchema,
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

describe('SPEC-001 — the database location is a local file either way', () => {
  // Asserts against configuration rather than a connection, so it holds now.
  it('points DATABASE_URL at a file: URL under ./data/', async () => {
    const { readFileSync } = await import('node:fs');
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const match = /^DATABASE_URL="(.+)"$/m.exec(example);
    expect(match?.[1]).toBe('file:./data/titan.db');
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
