/**
 * The image serving posture (SPEC-006).
 *
 * > `next/image` is configured with `unoptimized: false` and local paths only;
 * > no `remotePatterns` entry exists (an empty remote allowlist means no
 * > external image host can ever be referenced).
 *
 * Oracle: "next.config.ts declares zero `images.remotePatterns` entries,
 * asserted by tests/unit/constraints-images.test.ts."
 *
 * ── Why this is asserted on the source text, not on the imported config ────
 * `next.config.ts` is a TypeScript module that vitest could import and inspect
 * as an object, and that would be the tidier test. It would also be the weaker
 * one. The property SPEC-006 is buying is "no external image host can EVER be
 * referenced" — a claim about what the file says, permanently. Reading the
 * evaluated object proves only what the config resolved to under this process's
 * environment; a `remotePatterns: process.env.CI ? [] : [...]` would pass an
 * import-based check on the machine that ran it and ship an open allowlist
 * everywhere else.
 *
 * So the scan is textual and deliberately blunt: the literal must be an empty
 * array, spelled out, with nothing conditional about it. A future change that
 * legitimately needs a remote host has to edit this test as well, which is
 * exactly the review conversation that should happen.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/db';

const CONFIG_PATH = join(REPO_ROOT, 'next.config.ts');
const source = readFileSync(CONFIG_PATH, 'utf8');

/** Strip comments so a `remotePatterns` mentioned in prose is not a match. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const code = withoutComments(source);

describe('SPEC-006 — images come from local disk only', () => {
  it('declares an images config at all, so the assertions below are not vacuous', () => {
    expect(code).toMatch(/images\s*:\s*\{/);
  });

  it('declares zero images.remotePatterns entries', () => {
    // The whole criterion, in one assertion: the key exists (so the empty
    // allowlist is a stated decision rather than an omission Next fills in with
    // its own default) and its literal value is the empty array.
    const match = code.match(/remotePatterns\s*:\s*(\[[^\]]*\])/);
    expect(match, 'next.config.ts does not declare images.remotePatterns').not.toBeNull();
    expect(match?.[1]?.replace(/\s+/g, '')).toBe('[]');
  });

  it('names no external image origin anywhere in the config', () => {
    // A second, independent angle on the same property. `remotePatterns` is the
    // documented door, but `domains` is the deprecated one Next still honours,
    // and either would let a third-party origin in.
    expect(code).not.toMatch(/domains\s*:/);
    expect(code).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it('does not disable the optimizer — SPEC-006 says `unoptimized: false`', () => {
    // Absent is correct: `unoptimized` defaults to false. What must not appear
    // is an explicit `true`, which would serve every upload unresized and undo
    // the point of re-encoding them.
    expect(code).not.toMatch(/unoptimized\s*:\s*true/);
  });

  it('keeps WebP in the served formats, matching what the uploader stores', () => {
    // `lib/media/process.ts` writes WebP and nothing else; a formats list that
    // excluded it would make the optimizer transcode every stored file on every
    // request for no benefit.
    expect(code).toMatch(/formats\s*:\s*\[[^\]]*'image\/webp'/);
  });
});
