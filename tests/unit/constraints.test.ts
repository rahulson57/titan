/**
 * The runtime guard (SPEC-001).
 *
 * SPEC-001 says: "a guard test walks the repo and fails on any container
 * artifact or any occurrence of port 5173 in a script/config." This is that
 * test. Every assertion here is a constraint that is cheap to violate by
 * accident and expensive to discover late — a stray `-p 5173` copied from a
 * Vite project, a `Dockerfile` added by a well-meaning tool, an `.nvmrc` that
 * drifts below what Next 15 needs.
 *
 * These constraints bind every slice, not just S01, so the guard walks the
 * whole repo rather than a fixed list of files: a container artifact added by
 * a later task must fail here too.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Directories that are never product source: generated, vendored, or transient. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'coverage',
  'data',
  'playwright-report',
  'test-results',
  'public',
]);

/** Every tracked file under the repo root, excluding generated/vendored trees. */
function walk(dir = REPO_ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (IGNORED_DIRS.has(entry)) continue;
      walk(abs, acc);
    } else {
      acc.push(relative(REPO_ROOT, abs));
    }
  }
  return acc;
}

const ALL_FILES = walk();

/** The files the 5173 constraint names explicitly, plus everything in scripts/. */
const SCRIPT_AND_CONFIG_FILES = [
  'package.json',
  'next.config.ts',
  'playwright.config.ts',
  'vitest.config.ts',
  'tsconfig.json',
  ...ALL_FILES.filter((f) => f.startsWith('scripts/')),
].filter((f) => existsSync(join(REPO_ROOT, f)));

describe('SPEC-001 — no containers', () => {
  // The literal artifacts the criterion names:
  //   test -f Dockerfile -o -f docker-compose.yml -o -d .devcontainer  => exits 1
  it.each([
    ['Dockerfile', 'file'],
    ['Dockerfile.dev', 'file'],
    ['docker-compose.yml', 'file'],
    ['docker-compose.yaml', 'file'],
    ['compose.yml', 'file'],
    ['compose.yaml', 'file'],
    ['.dockerignore', 'file'],
    ['.devcontainer', 'directory'],
  ])('has no %s in the repository root', (artifact) => {
    expect(
      existsSync(join(REPO_ROOT, artifact)),
      `SPEC-001 forbids container artifacts; found ${artifact}. ` +
        'titan runs as one Node process on one machine.',
    ).toBe(false);
  });

  it('has no container artifact anywhere in the tree, not just the root', () => {
    const offenders = ALL_FILES.filter((f) =>
      /(^|\/)(Dockerfile[^/]*|\.dockerignore|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f) ||
      f.split('/').includes('.devcontainer'),
    );
    expect(offenders, `container artifacts found: ${offenders.join(', ')}`).toEqual([]);
  });

  it('invokes no container runtime from package.json or any script', () => {
    // Mirrors: grep -rniE '\b(docker|podman|devcontainer)\b' package.json scripts/
    const pattern = /\b(docker|podman|devcontainer)\b/i;
    const offenders: string[] = [];

    for (const file of SCRIPT_AND_CONFIG_FILES) {
      if (file !== 'package.json' && !file.startsWith('scripts/')) continue;
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (pattern.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }

    expect(
      offenders,
      `SPEC-001 forbids container tooling in scripts:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('SPEC-001 — port discipline', () => {
  it('binds port 3000 explicitly in the dev script', () => {
    // The criterion is exact-match, not "contains 3000": the port must be
    // stated at the call site, never inherited from the environment.
    expect(pkg.scripts.dev).toBe('next dev -p 3000');
  });

  it('never mentions the forbidden port in any script or config', () => {
    // Mirrors the 5173 grep across package.json, scripts/, next.config.ts,
    // playwright.config.ts — widened to vitest.config.ts and tsconfig.json,
    // which are equally capable of binding it.
    //
    // Computed rather than written literally so that widening the scanned set
    // to the whole tree later cannot make this guard flag its own source.
    const forbidden = String(5000 + 173);
    const offenders: string[] = [];

    for (const file of SCRIPT_AND_CONFIG_FILES) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (line.includes(forbidden)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }

    expect(
      offenders,
      `SPEC-001 forbids port ${forbidden} (Vite's default):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('serves the production build on the same port as dev', () => {
    expect(pkg.scripts.start).toBe('next start -p 3000');
  });
});

describe('SPEC-001 — runtime version', () => {
  it('runs on Node >= 20.11', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    expect(major, `Next 15 App Router needs Node >= 20.11; this is ${process.version}`).toBeGreaterThanOrEqual(20);
    if (major === 20) expect(minor).toBeGreaterThanOrEqual(11);
  });

  it('pins the major line to 20 in .nvmrc', () => {
    expect(read('.nvmrc').trim()).toBe('20');
  });

  it('declares the same floor in package.json engines', () => {
    expect(pkg.engines?.node).toBe('>=20.11');
  });
});

describe('SPEC-001 — no external services', () => {
  it('depends on no hosted database, cache, queue, object store, mailer or search provider', () => {
    // "$0 run cost" is a dependency-graph property, so it is asserted against
    // the manifest rather than left to review. Each entry below is a service
    // client whose presence would mean something outside this machine is on
    // the critical path.
    const banned = [
      '@aws-sdk/client-s3', 'aws-sdk', '@google-cloud/storage', '@azure/storage-blob',
      'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose',
      'redis', 'ioredis', '@upstash/redis', '@vercel/kv',
      'bullmq', 'amqplib', 'kafkajs',
      'nodemailer', 'resend', '@sendgrid/mail', 'postmark',
      'algoliasearch', 'meilisearch', '@elastic/elasticsearch', 'typesense',
      '@supabase/supabase-js', 'firebase', 'firebase-admin', '@planetscale/database',
      '@neondatabase/serverless', 'stripe', 'cloudinary',
    ];
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    const offenders = banned.filter((name) => name in installed);

    expect(
      offenders,
      `SPEC-001 allows no external service at runtime; found: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the database as a local file under ./data/', () => {
    expect(read('.env.example')).toMatch(/DATABASE_URL="file:\.\/data\/titan\.db"/);
  });

  it('commits .env.example and git-ignores .env.local', () => {
    expect(existsSync(join(REPO_ROOT, '.env.example'))).toBe(true);

    // `git check-ignore` exits 0 when the path is ignored, 1 when it is not.
    // A committed .env.local is how a locally generated secret escapes the
    // machine, so this is asserted rather than assumed.
    let ignored: boolean;
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', '.env.local'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
      ignored = true;
    } catch {
      ignored = false;
    }

    expect(ignored, '.env.local must be git-ignored — it holds a real AUTH_SECRET').toBe(true);
  });
});

describe('SPEC-001 — boot contract', () => {
  it('exposes every script the boot contract names', () => {
    // fresh clone -> npm install && npm run setup && npm run dev
    for (const script of ['setup', 'dev', 'build', 'start', 'lint', 'test']) {
      expect(pkg.scripts[script], `package.json is missing the "${script}" script`).toBeTruthy();
    }
  });

  it('defines setup as migrate + seed + uploads:seed', () => {
    // SPEC-001: "npm run setup = prisma migrate deploy + db:seed + uploads:seed"
    expect(pkg.scripts.setup).toBe('node scripts/setup.mjs');
    expect(existsSync(join(REPO_ROOT, 'scripts', 'setup.mjs'))).toBe(true);

    const setup = read('scripts/setup.mjs');
    expect(setup).toContain('prisma');
    expect(setup).toContain('migrate');
    expect(setup).toContain('db:seed');
    expect(setup).toContain('uploads:seed');
  });

  it('generates AUTH_SECRET locally rather than requiring one from a third party', () => {
    const setup = read('scripts/setup.mjs');
    expect(setup).toContain('randomBytes');
    expect(setup).toContain('AUTH_SECRET');
  });

  it('declares only AUTH_SECRET and DATABASE_URL in .env.example', () => {
    const keys = read('.env.example')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split('=')[0]);
    expect(keys.sort()).toEqual(['AUTH_SECRET', 'DATABASE_URL']);
  });
});
