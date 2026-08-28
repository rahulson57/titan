import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * SPEC-003's originality guard.
 *
 * "Medium-*inspired*, never Medium-*copied*. No Medium trademark, wordmark,
 * logo, font licence, or lifted CSS/asset may enter the repo."
 *
 * The forbidden strings are assembled from fragments at run time rather than
 * written out. If they appeared as literals here, this file would itself be a
 * file in the repo containing them — which is the thing SPEC-003 forbids, and
 * a plain `grep -rn` by a reviewer would report a hit in the very test whose
 * job is to prove there are none.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Exactly the paths named by the SPEC-003 criterion, in that order. */
const SCANNED_DIRS = ['app', 'components', 'public'] as const;

/** Directories the criterion's `--exclude-dir` excludes, plus build output. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', 'test-results']);

const FORBIDDEN = [
  { name: 'the Medium domain', pattern: new RegExp(['medi', 'um', '\\.com'].join(''), 'i') },
  {
    name: 'the Medium corporate name',
    pattern: new RegExp(['Medi', 'um', ' ', 'Corporation'].join(''), 'i'),
  },
] as const;

/** Binary extensions: read as bytes, never string-scanned. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.pdf', '.zip',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const scannedRoots = SCANNED_DIRS.map((d) => join(REPO_ROOT, d));
const allFiles = scannedRoots.flatMap(walk);
const textFiles = allFiles.filter((f) => !BINARY_EXT.has(extname(f).toLowerCase()));

describe('originality guard (SPEC-003)', () => {
  it('scans a non-empty set of files, so a green result means something', () => {
    // Without this, deleting app/ and components/ would make every assertion
    // below pass vacuously — the exact failure mode of a grep over a path that
    // does not exist.
    expect(textFiles.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN.map((f) => [f.name, f.pattern] as const))(
    'no file under app/, components/ or public/ contains %s',
    (_name, pattern) => {
      const hits = textFiles
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => relative(REPO_ROOT, file));
      expect(hits).toEqual([]);
    },
  );

  it('the scanner would actually catch a violation', () => {
    // A negative test that never fails is indistinguishable from one that
    // cannot fail. This proves the patterns match what they claim to.
    const sample = `see https://${['medi', 'um', '.com'].join('')}/@someone for the original`;
    expect(FORBIDDEN.some((f) => f.pattern.test(sample))).toBe(true);
    expect(FORBIDDEN.some((f) => f.pattern.test('an ordinary sentence about design'))).toBe(false);
  });

  describe('fonts', () => {
    const layout = readFileSync(join(REPO_ROOT, 'app', 'layout.tsx'), 'utf8');

    /**
     * SPEC-003: "every font is loaded via `next/font` from an open-licence
     * family." Both families here ship under the SIL Open Font License 1.1.
     */
    const OPEN_LICENCE_FAMILIES = ['Source_Serif_4', 'Inter'] as const;

    it('loads every family through next/font', () => {
      expect(layout).toMatch(/from 'next\/font\/google'/);
      for (const family of OPEN_LICENCE_FAMILIES) {
        expect(layout).toContain(family);
      }
    });

    it('pulls no font over the network at runtime', () => {
      // next/font downloads at build time and self-hosts. A stylesheet <link>
      // or CSS @import to a font CDN would reintroduce the runtime dependency
      // SPEC-001 forbids, and would sidestep the licence check above.
      const fontCdn = /fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.cdnfonts/i;
      const offenders = textFiles
        .filter((file) => fontCdn.test(readFileSync(file, 'utf8')))
        .map((file) => relative(REPO_ROOT, file));
      expect(offenders).toEqual([]);
    });

    it('ships no font binary of its own', () => {
      // A committed .woff2 is how a licensed face sneaks in. Everything must
      // come through next/font, whose output lives in .next/, not in the repo.
      const fontFiles = allFiles
        .filter((f) => ['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(extname(f).toLowerCase()))
        .map((file) => relative(REPO_ROOT, file));
      expect(fontFiles).toEqual([]);
    });
  });

  describe('assets', () => {
    it('carries no third-party logo asset', () => {
      // SPEC-011's wordmark is the text "Titan" set in the reading face, so
      // there is no legitimate reason for a logo file to exist at all. Named
      // by extension and filename rather than by hash: an asset-hash denylist
      // can only recognise the exact file it was built from, whereas "there
      // are no logo files" is checkable and true today.
      const publicDir = join(REPO_ROOT, 'public');
      const logoish = walk(publicDir)
        .map((file) => relative(REPO_ROOT, file))
        .filter((file) => /logo|wordmark|brand|trademark/i.test(file));
      expect(logoish).toEqual([]);
    });

    it('draws its icons inline rather than importing them', () => {
      // The two ThemeToggle glyphs are hand-drawn paths in the component. This
      // asserts the property that matters — no icon package, no icon asset —
      // rather than the specific drawing.
      const themeToggle = readFileSync(
        join(REPO_ROOT, 'components', 'ui', 'ThemeToggle.tsx'),
        'utf8',
      );
      expect(themeToggle).toContain('<svg');
      expect(themeToggle).not.toMatch(/from '(@heroicons|lucide-react|react-icons|@fortawesome)/);
    });
  });

  describe('stylesheet', () => {
    const css = readFileSync(join(REPO_ROOT, 'app', 'globals.css'), 'utf8');
    /** Comments explain the rules and quote them; only declarations are checked. */
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

    it('imports no third-party stylesheet', () => {
      // SPEC-003 forbids lifted CSS. Nothing is imported, so nothing can be
      // lifted without it showing up as a diff in this file.
      expect(declarations).not.toMatch(/@import\s/);
    });

    it('never removes a focus ring without replacing it', () => {
      // SPEC-003: "never `outline: none` without a replacement". Enforced as a
      // property of the stylesheet rather than trusted to review.
      expect(declarations).not.toMatch(/outline\s*:\s*(none|0)\b/);
      // ...and the replacement it promises is actually declared.
      expect(declarations).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\)/);
    });
  });
});
