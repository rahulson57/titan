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
 * Usage:
 *   node scripts/setup.mjs [--no-browsers] [--force-env] [--quiet]
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimum runtime, per SPEC-001. `.nvmrc` pins the major line to 20. */
const MIN_NODE = { major: 20, minor: 11 };

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
}

// ---------------------------------------------------------------------------
// 3. .env.local — generated locally, never fetched, never committed
// ---------------------------------------------------------------------------

function ensureEnvLocal(total) {
  step(3, total, 'Ensuring .env.local');
  const target = join(ROOT, '.env.local');
  const example = join(ROOT, '.env.example');

  if (existsSync(target) && !FORCE_ENV) {
    ok('.env.local already present (left untouched; --force-env to regenerate)');
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
// 4-6. Steps owned by later slices. Present => run. Absent => say why, move on.
// ---------------------------------------------------------------------------

function migrate(total) {
  step(4, total, 'Applying database migrations');
  const schema = join(ROOT, 'prisma', 'schema.prisma');
  if (!existsSync(schema)) {
    skip('prisma/schema.prisma not present yet — owned by SPEC-004 (Persistence)');
    return false;
  }
  npx(['prisma', 'generate'], { label: 'prisma generate' });
  npx(['prisma', 'migrate', 'deploy'], { label: 'prisma migrate deploy' });
  return true;
}

function seed(total, migrated) {
  step(5, total, 'Seeding the deterministic corpus');
  const seedFile = join(ROOT, 'prisma', 'seed.ts');
  if (!existsSync(seedFile)) {
    skip('prisma/seed.ts not present yet — owned by SPEC-004 (Persistence)');
    return;
  }
  if (!migrated) {
    skip('schema was not migrated, so there is nothing to seed into');
    return;
  }
  run('npm', ['run', 'db:seed'], { label: 'npm run db:seed' });
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
  const migrated = migrate(TOTAL);
  seed(TOTAL, migrated);
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
