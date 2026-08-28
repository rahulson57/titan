#!/usr/bin/env node
/**
 * titan — one-command local setup (SPEC-001, "Boot contract").
 *
 *   fresh clone -> npm install && npm run setup && npm run dev -> http://localhost:3000
 *
 * `npm run setup` is defined by SPEC-001 as `prisma migrate deploy` + `db:seed`
 * + `uploads:seed`, plus the prerequisites those three steps assume exist:
 * a Node runtime new enough to run them, a `./data/` directory to put the
 * SQLite file in, and a `.env.local` carrying a locally-generated AUTH_SECRET.
 *
 * Two properties this script is built around:
 *
 *  1. IT NEVER REACHES THE NETWORK FOR PRODUCT STATE. Every secret is generated
 *     locally from the platform CSPRNG; the database is a file; there is no
 *     hosted dependency to provision. The single optional network call is the
 *     Playwright browser download, which is test tooling, not product state,
 *     and is best-effort (see `--no-browsers`).
 *
 *  2. IT IS RE-RUNNABLE AND ORDER-TOLERANT. Steps whose owning slice has not
 *     landed yet are skipped with a named reason rather than failing the boot.
 *     S01 (this slice) owns the runtime and the harness; the Prisma schema,
 *     the seed corpus and the uploads seeder are owned by later slices
 *     (SPEC-004 and SPEC-006). Running setup before those land must still
 *     leave a usable tree, and running it again after they land must pick
 *     them up with no edit to this file.
 *
 *  3. IT NAMES THE DATABASE IT TOUCHED, ABSOLUTELY, AND REFUSES TO TOUCH ONE
 *     OUTSIDE THIS CHECKOUT (DEC-061). `node_modules` is a symlink shared by
 *     every worktree on this machine, so there is exactly ONE generated Prisma
 *     client, and a RELATIVE sqlite `file:` URL is resolved against the schema
 *     directory baked into THAT client — not against this repo, not against the
 *     cwd, not against the `.env` that declares it. Whichever checkout ran
 *     `prisma generate` last therefore owns every other checkout's
 *     `../data/titan.db`. The migrate step (Prisma CLI, resolves against
 *     `./prisma/`) and the seed step (generated client, resolves against the
 *     baked directory) can consequently target DIFFERENT FILES and both exit 0.
 *     That is the whole failure: it is silent, and each step individually
 *     succeeds. So this script prints the ABSOLUTE path each step resolved,
 *     fails if either lands outside the invoking repository root, and — because
 *     a derivation can go stale when Prisma's internals move — also checks
 *     AFTERWARDS that the file it named is the one that actually changed.
 *
 * Usage:
 *   node scripts/setup.mjs [--no-browsers] [--force-env] [--quiet]
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimum runtime, per SPEC-001. `.nvmrc` pins the major line to 20. */
const MIN_NODE = { major: 20, minor: 11 };

/** SPEC-001's database file. Lives in `./data/`, at the repository root. */
const DB_FILENAME = 'titan.db';

/** SQLite keeps its journal and shared-memory files beside the database. */
const DB_SIDECARS = ['', '-wal', '-shm', '-journal'];

/**
 * The DATABASE_URL this repo carried before TASK-016.
 *
 * It reads as "./data/ at the repo root" and is not: Prisma resolves a relative
 * sqlite `file:` URL against the directory holding `schema.prisma`, so it
 * actually named `prisma/data/titan.db`. Kept here so setup can recognise a
 * tree still carrying it — in a generated `.env.local`, or as a real database
 * file in the old location — and move it to where SPEC-001 says it belongs.
 */
const LEGACY_DATABASE_URL = 'file:./data/titan.db';

/**
 * The env files the PRISMA CLI reads, in the order it reads them, highest
 * precedence first.
 *
 * `.env.local` is deliberately absent and that is not an oversight (DEC-013):
 * it is a Next.js convention, and the Prisma CLI has never read it. A real
 * `DATABASE_URL` in the process environment beats both files, because dotenv
 * does not overwrite a variable that is already set.
 */
const PRISMA_CLI_ENV_FILES = ['prisma/.env', '.env'];

/** Where `prisma generate` writes the client every checkout on this box shares. */
const GENERATED_CLIENT_DIR = join(ROOT, 'node_modules', '.prisma', 'client');

const argv = new Set(process.argv.slice(2));
const QUIET = argv.has('--quiet');
const SKIP_BROWSERS = argv.has('--no-browsers');
const FORCE_ENV = argv.has('--force-env');

const say = (...a) => {
  if (!QUIET) console.log(...a);
};
const step = (n, total, msg) => say(`\n[${n}/${total}] ${msg}`);
const ok = (msg) => say(`      ok    ${msg}`);
const skip = (msg) => say(`      skip  ${msg}`);
/**
 * Deliberately NOT routed through `say`. `--quiet` exists so the e2e harness is
 * not spammed by a step it runs twice per gate; it is not a request to hide the
 * one class of finding this script exists to make visible.
 */
const warn = (msg) => console.warn(`      warn  ${msg}`);

/** Run a command, inheriting stdio, failing the whole setup on non-zero exit. */
function run(cmd, args, { optional = false, label = null } = {}) {
  const printable = label ?? `${cmd} ${args.join(' ')}`;
  try {
    execFileSync(cmd, args, {
      cwd: ROOT,
      stdio: QUIET ? 'ignore' : 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    ok(printable);
    return true;
  } catch (err) {
    if (optional) {
      skip(`${printable} — ${err.message.split('\n')[0]}`);
      return false;
    }
    throw new Error(`setup step failed: ${printable}\n${err.message}`);
  }
}

const npx = (args, opts) =>
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, opts);

// ---------------------------------------------------------------------------
// 1. Runtime check
// ---------------------------------------------------------------------------

function checkNode(total) {
  step(1, total, 'Checking Node runtime');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (
    major < MIN_NODE.major ||
    (major === MIN_NODE.major && minor < MIN_NODE.minor)
  ) {
    throw new Error(
      `titan needs Node >= ${MIN_NODE.major}.${MIN_NODE.minor} (see .nvmrc); this is ${process.version}.\n` +
        `Install it with your version manager, e.g. \`nvm use\` in the repo root.`,
    );
  }
  ok(`node ${process.version}`);
}

// ---------------------------------------------------------------------------
// 2. ./data/ — the only place persistent state lives
//
// This directory was decorative until TASK-016: DATABASE_URL said
// `file:./data/titan.db`, Prisma read that relative to `prisma/`, and every
// migration, seed and query went to `prisma/data/titan.db` while setup
// carefully created an empty `./data/` next door. The URL now says
// `file:../data/titan.db`, so this is the real location — and a tree that ran
// the old setup still has its database in the old place, which is what
// `relocateLegacyDatabase` is for.
// ---------------------------------------------------------------------------

function ensureDataDir(total) {
  step(2, total, 'Ensuring ./data/ exists');
  const dir = join(ROOT, 'data');
  if (existsSync(dir)) {
    ok('data/ already present');
  } else {
    mkdirSync(dir, { recursive: true });
    ok('created data/');
  }
  relocateLegacyDatabase(dir);
}

/**
 * Move a database left behind at `prisma/data/titan.db` by the pre-TASK-016
 * URL into `./data/`, sidecars and all.
 *
 * Deliberately conservative: it never overwrites. If both locations hold a
 * database, this says so and touches neither — deciding which of two
 * divergent databases is the real one is a judgement call, and a setup script
 * making it silently is how work gets lost. Stop the dev server before running
 * this: renaming a file another process holds open leaves that process writing
 * to the moved inode.
 */
function relocateLegacyDatabase(dataDir) {
  const legacy = join(ROOT, 'prisma', 'data', DB_FILENAME);
  if (!existsSync(legacy)) return;

  const target = join(dataDir, DB_FILENAME);
  if (existsSync(target)) {
    skip(
      `prisma/data/${DB_FILENAME} also exists — moving nothing. data/${DB_FILENAME} ` +
        'is the one DATABASE_URL now names; delete the other once you have checked it.',
    );
    return;
  }

  for (const suffix of DB_SIDECARS) {
    if (existsSync(`${legacy}${suffix}`)) {
      renameSync(`${legacy}${suffix}`, `${target}${suffix}`);
    }
  }
  ok(
    `moved prisma/data/${DB_FILENAME} -> data/${DB_FILENAME} ` +
      '(pre-TASK-016 trees put it there; SPEC-001 puts it here)',
  );

  // Take the empty directory with it. Left behind, `prisma/data/` is the exact
  // signpost that started this — a plausible-looking database location that
  // holds nothing. `rmdirSync` refuses a non-empty directory, which is the
  // guard: anything unexpected in there survives untouched.
  try {
    rmdirSync(dirname(legacy));
  } catch {
    /* not empty, or already gone — either way there is nothing to tidy */
  }
}

// ---------------------------------------------------------------------------
// 3. .env.local — generated locally, never fetched, never committed
// ---------------------------------------------------------------------------

/**
 * The `DATABASE_URL` value declared in an env file, or null.
 *
 * Quotes are optional because dotenv treats them as optional; a commented-out
 * mention cannot match, since the assignment has to start the line. `.env`
 * carries several `# DATABASE_URL=...` lines of explanation, and reading one of
 * those as the setting would be a very quiet way to check the wrong path.
 */
function readDatabaseUrl(file) {
  if (!existsSync(file)) return null;
  const m = /^[ \t]*DATABASE_URL[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m.exec(
    readFileSync(file, 'utf8'),
  );
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * Correct a `.env.local` still carrying the pre-TASK-016 DATABASE_URL.
 *
 * This matters more than it looks. `.env.local` overrides `.env` FOR THE APP
 * but is invisible to the Prisma CLI (DEC-013), so a tree whose `.env.local`
 * was generated before this fix would migrate `./data/titan.db` and serve
 * `prisma/data/titan.db` — the exact split DEC-013 exists to prevent, with no
 * error to announce it.
 *
 * Only the one known-stale literal is rewritten. A `.env.local` pointing
 * somewhere else entirely is a deliberate local override and is left alone.
 */
function repairStaleEnvLocal(target, example) {
  if (readDatabaseUrl(target) !== LEGACY_DATABASE_URL) return false;

  const corrected = readDatabaseUrl(example);
  if (!corrected || corrected === LEGACY_DATABASE_URL) return false;

  const body = readFileSync(target, 'utf8').replace(
    /^DATABASE_URL=.*$/m,
    `DATABASE_URL="${corrected}"`,
  );
  writeFileSync(target, body, { mode: 0o600 });
  ok(
    `repaired a stale DATABASE_URL in .env.local (${LEGACY_DATABASE_URL} -> ${corrected}); ` +
      'the old value resolved to prisma/data/, so the app and the Prisma CLI ' +
      'would have used different databases',
  );
  return true;
}

function ensureEnvLocal(total) {
  step(3, total, 'Ensuring .env.local');
  const target = join(ROOT, '.env.local');
  const example = join(ROOT, '.env.example');

  if (existsSync(target) && !FORCE_ENV) {
    if (!repairStaleEnvLocal(target, example)) {
      ok('.env.local already present (left untouched; --force-env to regenerate)');
    }
    return;
  }

  if (!existsSync(example)) {
    throw new Error('.env.example is missing — cannot derive .env.local from it.');
  }

  // 32 bytes of local CSPRNG output. Nothing about this value comes from,
  // or is sent to, anything off this machine.
  const secret = randomBytes(32).toString('base64url');

  const body = readFileSync(example, 'utf8')
    .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET="${secret}"`)
    .replace(
      /^# titan — committed example environment\.$/m,
      '# titan — LOCAL environment. Generated by `npm run setup`. Not committed.',
    );

  writeFileSync(target, body, { mode: 0o600 });
  ok(`wrote .env.local with a freshly generated AUTH_SECRET`);
}

// ---------------------------------------------------------------------------
// The DEC-061 guard rail: name the database, then prove it was the one written.
//
// Two independent mechanisms, because they fail in different directions.
//
//   DERIVATION  — resolve the absolute path each step WILL target and refuse
//                 anything outside this checkout. Precise, names the offending
//                 path, and fails BEFORE the step runs; but it reads a private
//                 field out of Prisma's generated client, so a Prisma upgrade
//                 could make it uninformative.
//   MEASUREMENT — after the step, check that the file we named is the one that
//                 actually appeared/changed. Knows nothing about Prisma's
//                 internals and cannot go stale; but it can only speak after
//                 the write has happened.
//
// Neither is redundant: the derivation stops the write, the measurement
// notices a write we failed to predict. A guard that only derived would go
// quietly vacuous the day the field is renamed — which is exactly the shape of
// the bug it is guarding against.
// ---------------------------------------------------------------------------

/** This checkout, symlinks resolved. `node_modules` here is a shared symlink. */
const REAL_ROOT = realpathish(ROOT);

/**
 * `realpathSync` for a path that may not exist yet.
 *
 * Resolves the longest existing prefix and re-appends the rest verbatim. Plain
 * `realpathSync` throws on a database file setup is about to create, and
 * comparing an unresolved path against a resolved root is how a check like this
 * reports a false mismatch: on this machine `/var` is a symlink to
 * `/private/var`, so the same directory has two spellings.
 */
function realpathish(path) {
  let head = resolve(path);
  let tail = '';
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail ? join(real, tail) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail = tail ? join(basename(head), tail) : basename(head);
      head = parent;
    }
  }
}

/** True when `child` is `parent` or lives beneath it. Segment-aware. */
function isUnder(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The `DATABASE_URL` that will actually be in force, and where it came from. */
function effectiveDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, source: 'the process environment' };
  }
  for (const file of PRISMA_CLI_ENV_FILES) {
    const url = readDatabaseUrl(join(ROOT, file));
    if (url) return { url, source: file };
  }
  return { url: null, source: null };
}

/**
 * The absolute file a sqlite `file:` URL names when resolved against `baseDir`.
 *
 * `baseDir` is the whole point: it is `./prisma/` for the Prisma CLI and the
 * generated client's OWN baked directory for anything going through the client.
 * Same URL string, two answers. Returns null for a URL this script has no
 * business second-guessing (a non-`file:` datasource, or an empty path).
 */
function sqliteTarget(url, baseDir) {
  if (!url || !url.startsWith('file:')) return null;
  const spec = url.slice('file:'.length).split('?')[0];
  if (!spec) return null;
  return realpathish(isAbsolute(spec) ? spec : resolve(baseDir, spec));
}

/**
 * The schema directory baked into the generated Prisma client — i.e. the
 * checkout that currently OWNS every relative `file:` URL on this machine.
 *
 * Read out of the generated source rather than by loading the client. Two
 * reasons, and the first is a hard rule: SPEC-004's persistence boundary says
 * only `lib/db/**` may import the generated client, and
 * tests/unit/db-boundary.test.ts enforces that by scanning this file's TEXT —
 * so the specifier must not appear here even in a comment. The second is that
 * loading the client would open a connection to the very database we have not
 * yet decided we are allowed to touch.
 *
 * Returns null when the client has not been generated, or when Prisma has moved
 * the field — an unknown answer, not a safe one. The measurement below is what
 * covers that case.
 */
function generatedClientSchemaDir(clientDir = GENERATED_CLIENT_DIR) {
  const index = join(clientDir, 'index.js');
  if (!existsSync(index)) return null;
  const source = readFileSync(index, 'utf8');

  // `sourceFilePath` is the schema FILE; `relativePath` is its directory,
  // relative to the generated client. Either answers the question.
  const file = /"sourceFilePath"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(source);
  if (file) return realpathish(dirname(JSON.parse(file[1])));
  const dir = /"relativePath"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(source);
  if (dir) return realpathish(resolve(clientDir, JSON.parse(dir[1])));
  return null;
}

/** Where the CLI would migrate, and where the client would seed. */
function databaseTargets({ clientDir = GENERATED_CLIENT_DIR } = {}) {
  const { url, source } = effectiveDatabaseUrl();
  const schemaDir = generatedClientSchemaDir(clientDir);
  return {
    url,
    source,
    schemaDir,
    migrate: sqliteTarget(url, join(ROOT, 'prisma')),
    seed: schemaDir ? sqliteTarget(url, schemaDir) : null,
  };
}

/**
 * Why a target could not be resolved. There are two reasons and they are not
 * interchangeable: one is "there is nothing here to check", the other is "this
 * check just went blind", and printing the first for the second is how a guard
 * rail comes to read as green while checking nothing.
 */
function unresolvedBecause(url, schemaDir) {
  if (!url || !url.startsWith('file:')) {
    return '(not a local sqlite file: URL — nothing for this check to resolve)';
  }
  if (!schemaDir) return '(UNKNOWN — could not read the generated Prisma client)';
  return '(unresolved)';
}

/**
 * One line saying where a target came from, for the refusal message.
 *
 * An ABSOLUTE url has no base directory, and saying it was resolved against one
 * would send the reader to the wrong file to fix it.
 */
function howResolved({ url, source }, base) {
  const from = `DATABASE_URL=${url} (from ${source})`;
  return url && url.startsWith('file:/')
    ? `${from} — an absolute path, so no base directory is involved`
    : `${from}, against ${base}`;
}

/**
 * Print an absolute target and refuse it if it is outside this checkout.
 *
 * SPEC-001 puts persistent state at `./data/titan.db` INSIDE the repository, so
 * "outside the invoking repo root" is never a legitimate answer here, however
 * it was arrived at — which is why there is no override flag. A deliberate
 * cross-checkout write is still a cross-checkout write, and the reason this is
 * worth failing over is that the alternative is exit 0.
 */
function assertTarget(label, path, how, unresolved = '(unresolved)') {
  say(`      db    ${label.padEnd(7)} -> ${path ?? unresolved}`);
  if (!path || isUnder(path, REAL_ROOT)) return;
  throw new Error(
    `the ${label} step would use a database OUTSIDE this checkout — refusing to run it.\n` +
      `  repository root : ${REAL_ROOT}\n` +
      `  ${`${label} target`.padEnd(15)} : ${path}\n` +
      `  resolved        : ${how}\n` +
      'Every worktree on this machine shares one node_modules, so there is one\n' +
      'generated Prisma client, and whichever checkout ran `prisma generate` last\n' +
      'owns every relative DATABASE_URL (DEC-061). Re-point it at this checkout\n' +
      'with `npx prisma generate` — but not while another checkout has a dev\n' +
      'server or a gate running, because generate rewrites a 16.8 MB memory-mapped\n' +
      'query engine underneath it (DEC-062).',
  );
}

/** A change-detector for a SQLite database: the file and its WAL sidecars. */
function fingerprintDatabase(path) {
  if (!path) return null;
  return DB_SIDECARS.map((suffix) => {
    try {
      const stats = statSync(`${path}${suffix}`);
      return `${suffix}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      return `${suffix}:absent`;
    }
  }).join('|');
}

// ---------------------------------------------------------------------------
// 4-6. Steps owned by later slices. Present => run. Absent => say why, move on.
// ---------------------------------------------------------------------------

function migrate(total) {
  step(4, total, 'Applying database migrations');
  const schema = join(ROOT, 'prisma', 'schema.prisma');
  if (!existsSync(schema)) {
    skip('prisma/schema.prisma not present yet — owned by SPEC-004 (Persistence)');
    return null;
  }

  // Checked BEFORE `prisma generate`, not after. The URL alone decides the
  // CLI's target, so nothing is gained by waiting — and generate is the step
  // with a cost that cannot be taken back: it rewrites the query-engine dylib
  // every other checkout on this machine has mapped. A run that is going to be
  // refused should be refused before it damages anybody else's.
  const declared = effectiveDatabaseUrl();
  say(`      db    url     -> ${declared.url ?? '(unset)'}  [from ${declared.source ?? 'nothing — Prisma will fail'}]`);
  const migrateTarget = sqliteTarget(declared.url, join(ROOT, 'prisma'));
  assertTarget(
    'migrate',
    migrateTarget,
    howResolved(declared, './prisma/, which is what the Prisma CLI resolves a relative sqlite URL against'),
    unresolvedBecause(declared.url, join(ROOT, 'prisma')),
  );

  reportClientOwner();
  npx(['prisma', 'generate'], { label: 'prisma generate' });

  // Re-read AFTER generate: that command is what makes the answer this
  // checkout's rather than whoever regenerated last.
  const targets = databaseTargets();
  assertTarget(
    'seed',
    targets.seed,
    howResolved(declared, `${targets.schemaDir}, the schema directory baked into the generated Prisma client`),
    unresolvedBecause(declared.url, targets.schemaDir),
  );
  assertOneDatabase(migrateTarget, targets.seed);
  if (!targets.schemaDir) {
    warn(
      'could not read the schema directory out of the generated Prisma client, so ' +
        'the seed path is UNVERIFIED by derivation. The post-seed check below still ' +
        'holds. If Prisma was just upgraded, this script needs updating (DEC-061).',
    );
  }

  const before = fingerprintDatabase(migrateTarget);
  npx(['prisma', 'migrate', 'deploy'], { label: 'prisma migrate deploy' });

  // The measurement half. `migrate deploy` creates the database if it is
  // absent, so an exit 0 that leaves nothing here means it created it
  // somewhere else — the one outcome the derivation above cannot rule out.
  if (migrateTarget && !existsSync(migrateTarget)) {
    throw new Error(
      `prisma migrate deploy exited 0 but ${migrateTarget} does not exist.\n` +
        'It migrated a different file. Nothing that reads this checkout will see it.',
    );
  }
  if (migrateTarget) {
    const label = fingerprintDatabase(migrateTarget) === before ? 'unchanged (already migrated)' : 'written';
    ok(`migrated ${migrateTarget} — ${label}`);
  }
  return { ...targets, migrate: migrateTarget };
}

function seed(total, targets) {
  step(5, total, 'Seeding the deterministic corpus');
  const seedFile = join(ROOT, 'prisma', 'seed.ts');
  if (!existsSync(seedFile)) {
    skip('prisma/seed.ts not present yet — owned by SPEC-004 (Persistence)');
    return;
  }
  if (!targets) {
    skip('schema was not migrated, so there is nothing to seed into');
    return;
  }

  // Resolved again rather than reused from step 4. Between the two steps
  // another checkout's gate can run `prisma generate` and take ownership of the
  // shared client; that is not hypothetical, it is the exact sequence that put
  // 18.6 MB of this project's seed corpus into a peer's worktree while their
  // gate was mid-run, with both commands reporting success.
  const current = databaseTargets();
  const declared = effectiveDatabaseUrl();
  assertTarget(
    'seed',
    current.seed,
    howResolved(declared, `${current.schemaDir}, the schema directory baked into the generated Prisma client`),
    unresolvedBecause(declared.url, current.schemaDir),
  );
  assertOneDatabase(targets.migrate, current.seed);

  const target = current.seed ?? targets.migrate;
  const before = fingerprintDatabase(target);
  run('npm', ['run', 'db:seed'], { label: 'npm run db:seed' });

  // The seed deletes and rebuilds the whole corpus, so this file — or one of
  // its WAL sidecars — has to have moved. If none of them did, the row counts
  // the seed just printed describe some other database. Never trust the seed's
  // own count line: it counts what it wrote, not where it wrote it.
  if (target && fingerprintDatabase(target) === before) {
    throw new Error(
      `npm run db:seed exited 0 but nothing changed under ${target}.\n` +
        'The corpus went into a different database (DEC-061). Re-point the shared\n' +
        'Prisma client at this checkout with `npx prisma generate` and run setup again.',
    );
  }
  if (target) ok(`seeded ${target}`);
}

/**
 * Say so when the shared client is currently owned by another checkout.
 *
 * Not a failure: `prisma generate`, on the very next line, is the fix. It is
 * reported because of what it says about the PAST — every `npm run db:seed`,
 * `npm run dev` or test run launched from here since that client was generated
 * read and wrote the tree named below, and reported success for doing it.
 */
function reportClientOwner() {
  const owner = generatedClientSchemaDir();
  if (!owner || isUnder(owner, REAL_ROOT)) return;
  warn(
    `the shared Prisma client currently points at ${owner} — not this checkout. ` +
      'Anything run from here since it was generated used THAT tree\'s database ' +
      '(DEC-061). `prisma generate` below takes ownership back; be aware that it ' +
      'takes it away from whoever is using it now.',
  );
}

/** SPEC-001 has one database. Two live targets is DEC-013's split, one level down. */
function assertOneDatabase(migrateTarget, seedTarget) {
  if (!migrateTarget || !seedTarget || migrateTarget === seedTarget) return;
  throw new Error(
    'migrate and seed resolved to DIFFERENT databases — both would exit 0.\n' +
      `  migrate : ${migrateTarget}\n` +
      `  seed    : ${seedTarget}\n` +
      'One database would carry the schema and the other the rows, and nothing\n' +
      'would say so. Run `npx prisma generate` from this checkout.',
  );
}

function seedUploads(total) {
  step(6, total, 'Seeding local upload fixtures');
  const script = join(ROOT, 'scripts', 'uploads-seed.mjs');
  if (!existsSync(script)) {
    skip('scripts/uploads-seed.mjs not present yet — owned by SPEC-006 (Media)');
    return;
  }
  run('npm', ['run', 'uploads:seed'], { label: 'npm run uploads:seed' });
}

// ---------------------------------------------------------------------------
// 7. Browser for the e2e half of the harness. Optional, best-effort.
// ---------------------------------------------------------------------------

function ensureBrowser(total) {
  step(7, total, 'Ensuring the Chromium build Playwright drives');
  if (SKIP_BROWSERS) {
    skip('--no-browsers');
    return;
  }
  if (!existsSync(join(ROOT, 'node_modules', '@playwright', 'test'))) {
    skip('@playwright/test is not installed — run `npm install` first');
    return;
  }
  // Optional: this is the one step that touches the network, and it fetches
  // test tooling rather than product state. Offline? The app still boots and
  // `npm run test:unit` still passes; only `npm run test:e2e` needs this.
  npx(['playwright', 'install', 'chromium'], {
    optional: true,
    label: 'playwright install chromium',
  });
}

// ---------------------------------------------------------------------------

function main() {
  const TOTAL = 7;
  say('titan setup — one process, one machine, no external services.');

  checkNode(TOTAL);
  ensureDataDir(TOTAL);
  ensureEnvLocal(TOTAL);
  const targets = migrate(TOTAL);
  seed(TOTAL, targets);
  seedUploads(TOTAL);
  ensureBrowser(TOTAL);

  say('\nSetup complete. Next:  npm run dev   ->  http://localhost:3000');
}

try {
  main();
} catch (err) {
  console.error(`\nsetup failed: ${err.message}`);
  process.exit(1);
}
