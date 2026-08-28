import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * SPEC-003 contrast budget, computed from the tokens themselves.
 *
 * The criterion is specific about the method: "computing WCAG ratios from the
 * token values in app/globals.css". So this suite reads the stylesheet off
 * disk and parses it, rather than importing a duplicate table of hex values
 * from TypeScript. A second copy of the palette would pass this suite happily
 * while the real one drifted — the point is to check the file the browser
 * actually loads.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GLOBALS_CSS = join(REPO_ROOT, 'app', 'globals.css');

/**
 * Custom properties from one top-level rule.
 *
 * Deliberately anchored to column 0 so it matches the base `:root` block and
 * not the `:root` override nested inside the sub-640px media query — that one
 * is indented, and it re-declares `--text-body-size`, not a colour. Taking the
 * first regex hit anywhere in the file would silently read the wrong block the
 * day someone adds a media query above this one.
 */
function readTokenBlock(css: string, selector: string): Record<string, string> {
  const lines = css.split('\n');
  const openIndex = lines.findIndex((line) => line === `${selector} {`);
  if (openIndex === -1) {
    throw new Error(`app/globals.css has no top-level "${selector} {" block`);
  }

  const tokens: Record<string, string> = {};
  for (let i = openIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line === '}') return tokens;
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (match?.[1] && match[2]) tokens[match[1]] = match[2].trim();
  }
  throw new Error(`app/globals.css: "${selector}" block is never closed at column 0`);
}

/** #rgb / #rrggbb → 0-255 channels. */
export function parseHex(value: string): [number, number, number] {
  const hex = value.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new Error(`not a hex colour: "${value}"`);
  }
  const int = Number.parseInt(full, 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio. Order-independent, 1.0 - 21.0. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

const css = readFileSync(GLOBALS_CSS, 'utf8');
const THEMES = {
  light: readTokenBlock(css, ':root'),
  dark: readTokenBlock(css, '.dark'),
} as const;

type ThemeName = keyof typeof THEMES;
const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/** The palette exactly as SPEC-003's colour table states it. */
const SPEC_003_PALETTE: Record<ThemeName, Record<string, string>> = {
  light: {
    '--bg': '#ffffff',
    '--fg': '#242424',
    '--fg-muted': '#6b6b6b',
    '--accent': '#1a8917',
    '--border': '#e6e6e6',
  },
  dark: {
    '--bg': '#0f0f0f',
    '--fg': '#e8e8e8',
    '--fg-muted': '#a3a3a3',
    '--accent': '#4ade80',
    '--border': '#2a2a2a',
  },
};

describe('WCAG contrast ratios (SPEC-003)', () => {
  describe('the parser reads the stylesheet, not a copy of it', () => {
    it('finds both top-level token blocks', () => {
      expect(Object.keys(THEMES.light).length).toBeGreaterThan(5);
      expect(Object.keys(THEMES.dark).length).toBeGreaterThan(4);
    });

    it('reads the base :root block, not the sub-640px media-query override', () => {
      // The override sets --text-body-size: 19px. If the parser had latched
      // onto it, the base block's 21px would be missing or wrong.
      expect(THEMES.light['--text-body-size']).toBe('21px');
    });

    it.each(['#fff', '#ffffff', '#FFFFFF'])('parses %s as white', (value) => {
      expect(parseHex(value)).toEqual([255, 255, 255]);
    });

    it('rejects a value that is not a hex colour', () => {
      expect(() => parseHex('var(--bg)')).toThrow(/not a hex colour/);
    });

    it('agrees with the WCAG reference points', () => {
      // Black on white is the definition of 21:1; a colour against itself is 1:1.
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
      expect(contrastRatio('#767676', '#767676')).toBeCloseTo(1, 5);
      // A well-known boundary case: #767676 on white is the classic 4.54:1
      // "smallest passing grey".
      expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.6);
    });

    it('is symmetric in its arguments', () => {
      expect(contrastRatio('#1a8917', '#ffffff')).toBeCloseTo(
        contrastRatio('#ffffff', '#1a8917'),
        10,
      );
    });
  });

  describe.each(THEME_NAMES)('%s theme', (themeName) => {
    const tokens = THEMES[themeName];
    const bg = tokens['--bg'] as string;

    it('declares every colour token SPEC-003 names, at the value SPEC-003 names', () => {
      for (const [token, expected] of Object.entries(SPEC_003_PALETTE[themeName])) {
        expect(tokens[token], `${themeName} ${token}`).toBe(expected);
      }
    });

    // SPEC-002/SPEC-003: body text >= 4.5:1 against --bg.
    it.each(['--fg', '--fg-muted'])('body text %s meets 4.5:1 against --bg', (token) => {
      const ratio = contrastRatio(tokens[token] as string, bg);
      expect(ratio, `${themeName} ${token} on --bg = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    // Large text (the 42px --text-h1 title, and the 22px card/empty-state
    // headings) only needs 3:1. Asserted separately from the 4.5 rule above so
    // a future palette change that drops a token below 4.5 but above 3 fails
    // with the right diagnosis rather than one bare number.
    it.each(['--fg', '--fg-muted'])('large text %s meets 3:1 against --bg', (token) => {
      expect(contrastRatio(tokens[token] as string, bg)).toBeGreaterThanOrEqual(3);
    });

    it('--accent meets 4.5:1 against --bg, so it can carry text and underlines', () => {
      // .prose a underlines in --accent and .btn--ghost hovers toward it, so
      // the accent is a text colour here and takes the body-text bar, not the
      // 3:1 non-text one.
      const ratio = contrastRatio(tokens['--accent'] as string, bg);
      expect(ratio, `${themeName} --accent on --bg = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    it('--accent-contrast meets 4.5:1 on --accent, so a primary button label is legible', () => {
      const ratio = contrastRatio(tokens['--accent-contrast'] as string, tokens['--accent'] as string);
      expect(
        ratio,
        `${themeName} --accent-contrast on --accent = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });

    it('--fg-muted stays legible on --bg-subtle, the code and chip surface', () => {
      // .tag and .prose code sit on --bg-subtle rather than --bg, so checking
      // only against --bg would leave the surface people actually read on
      // unmeasured.
      const ratio = contrastRatio(tokens['--fg-muted'] as string, tokens['--bg-subtle'] as string);
      expect(ratio, `${themeName} --fg-muted on --bg-subtle`).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('the two themes are genuinely different palettes', () => {
    // Guards against a copy-paste that leaves .dark identical to :root, which
    // would pass every ratio above while shipping one theme.
    expect(THEMES.dark['--bg']).not.toBe(THEMES.light['--bg']);
    expect(THEMES.dark['--fg']).not.toBe(THEMES.light['--fg']);
  });

  it('dark really is darker than light', () => {
    const lightBg = relativeLuminance(parseHex(THEMES.light['--bg'] as string));
    const darkBg = relativeLuminance(parseHex(THEMES.dark['--bg'] as string));
    expect(darkBg).toBeLessThan(lightBg);
  });
});
