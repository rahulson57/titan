/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { runInNewContext } from 'node:vm';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArticleCard, formatPublishedAt, formatReadingTime } from '../../components/ui/ArticleCard';
import { Avatar, initials } from '../../components/ui/Avatar';
import { Button, buttonClassName } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Prose } from '../../components/ui/Prose';
import { Skeleton } from '../../components/ui/Skeleton';
import { Tag } from '../../components/ui/Tag';
import { ThemeToggle } from '../../components/ui/ThemeToggle';
import {
  DARK_CLASS,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemeDocument,
  type ThemeStorage,
  applyTheme,
  currentTheme,
  isTheme,
  oppositeTheme,
  readStoredTheme,
  resolveTheme,
  setTheme,
  storeTheme,
  systemTheme,
  toggleTheme,
} from '../../lib/theme';

/**
 * Unit contract for the design system (SPEC-003).
 *
 * Rendering is done with `react-dom/server`, not a DOM testing library. That
 * is a constraint, not a preference: this repo has no DOM test environment
 * (neither jsdom nor happy-dom is installed) and no testing-library, and
 * `package.json` belongs to SPEC-001 — "No other section may edit them" — so
 * this slice cannot add one. Static rendering still answers everything the
 * criterion asks: that each component renders in isolation without throwing,
 * and that its markup matches its documented prop contract. What it cannot
 * cover is click behaviour, which is why the theme module underneath the
 * toggle is exercised directly against injected fakes below, and why the
 * browser-observable half lives in tests/e2e/.
 */

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

/* ---------------------------------------------------------------- fakes -- */

/** Minimal `classList` + `style` stand-in for the document under test. */
function fakeDocument(initialClasses: string[] = []): ThemeDocument & { classes: Set<string> } {
  const classes = new Set(initialClasses);
  return {
    classes,
    documentElement: {
      classList: {
        add: (t: string) => void classes.add(t),
        remove: (t: string) => void classes.delete(t),
        contains: (t: string) => classes.has(t),
      },
      style: { colorScheme: '' },
    },
  };
}

function fakeStorage(initial: Record<string, string> = {}): ThemeStorage & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

/** A storage whose every method throws — private-mode Safari, quota exceeded. */
const hostileStorage: ThemeStorage = {
  getItem() {
    throw new Error('storage disabled');
  },
  setItem() {
    throw new Error('storage disabled');
  },
};

/* ====================================================== component contract */

describe('the eight primitives render in isolation', () => {
  // The inventory exactly as SPEC-003 lists it. Kept as data so "all eight"
  // is checked by counting, not by trusting that eight describes were written.
  const INVENTORY = [
    ['Button', () => <Button>Publish</Button>],
    ['Avatar', () => <Avatar name="Ada Lovelace" />],
    ['Tag', () => <Tag href="/tag/design">Design</Tag>],
    ['ThemeToggle', () => <ThemeToggle />],
    [
      'ArticleCard',
      () => (
        <ArticleCard
          title="On measure"
          href="/article/on-measure"
          author={{ name: 'Ada Lovelace', handle: 'ada' }}
          publishedAt="2026-01-01T00:00:00Z"
        />
      ),
    ],
    ['Prose', () => <Prose>Body</Prose>],
    ['EmptyState', () => <EmptyState title="Nothing here yet" />],
    ['Skeleton', () => <Skeleton />],
  ] as const;

  it('is the full inventory SPEC-003 names', () => {
    expect(INVENTORY.map(([name]) => name)).toEqual([
      'Button',
      'Avatar',
      'Tag',
      'ThemeToggle',
      'ArticleCard',
      'Prose',
      'EmptyState',
      'Skeleton',
    ]);
    expect(INVENTORY).toHaveLength(8);
  });

  it.each(INVENTORY)('%s renders without throwing and emits markup', (_name, render) => {
    const markup = html(render());
    expect(markup).not.toBe('');
    expect(markup.startsWith('<')).toBe(true);
  });
});

describe('Button', () => {
  it('defaults to a type="button" primary action', () => {
    const markup = html(<Button>Publish</Button>);
    expect(markup).toContain('<button');
    // Without an explicit type, a button inside a form submits it. Defaulting
    // to "button" means a primitive can never cause a surprise navigation.
    expect(markup).toContain('type="button"');
    expect(markup).toContain('class="btn btn--primary"');
    expect(markup).toContain('Publish');
  });

  it('renders an anchor when given href, and no <button>', () => {
    const markup = html(<Button href="/editor/new">Write</Button>);
    expect(markup).toContain('<a');
    expect(markup).toContain('href="/editor/new"');
    expect(markup).not.toContain('<button');
  });

  it('honours an explicit type', () => {
    expect(html(<Button type="submit">Save</Button>)).toContain('type="submit"');
  });

  it.each(['primary', 'secondary', 'ghost'] as const)('applies the %s variant class', (variant) => {
    expect(html(<Button variant={variant}>x</Button>)).toContain(`btn--${variant}`);
  });

  it('omits a size modifier for the default md, and adds one otherwise', () => {
    expect(buttonClassName({ size: 'md' })).toBe('btn btn--primary');
    expect(buttonClassName({ size: 'sm' })).toBe('btn btn--primary btn--sm');
    expect(buttonClassName({ size: 'lg' })).toBe('btn btn--primary btn--lg');
  });

  it('adds btn--icon only when asked', () => {
    expect(buttonClassName({ iconOnly: true })).toContain('btn--icon');
    expect(buttonClassName({})).not.toContain('btn--icon');
  });

  it('appends a caller class without dropping its own', () => {
    expect(buttonClassName({ className: 'nav__cta' })).toBe('btn btn--primary nav__cta');
  });

  it('passes disabled through', () => {
    expect(html(<Button disabled>x</Button>)).toContain('disabled');
  });

  it('sets no inline outline, so the global focus ring governs', () => {
    // SPEC-003 puts the focus ring in one place. A component that styled its
    // own would be the way that rule quietly stops holding.
    expect(html(<Button>x</Button>)).not.toContain('outline');
  });
});

describe('Avatar', () => {
  it('renders the image when a src is given, with the name as alt', () => {
    const markup = html(<Avatar name="Ada Lovelace" src="/uploads/ada.webp" />);
    expect(markup).toContain('src="/uploads/ada.webp"');
    expect(markup).toContain('alt="Ada Lovelace"');
    expect(markup).toContain('avatar__image');
  });

  it('falls back to initials, labelled once for assistive tech', () => {
    const markup = html(<Avatar name="Ada Lovelace" />);
    expect(markup).toContain('>AL<');
    expect(markup).toContain('aria-label="Ada Lovelace"');
    expect(markup).toContain('role="img"');
    // The letters themselves are hidden so the name is not announced twice.
    expect(markup).toContain('aria-hidden="true"');
  });

  it('treats an empty src as no src', () => {
    expect(html(<Avatar name="Ada" src="" />)).toContain('role="img"');
    expect(html(<Avatar name="Ada" src={null} />)).toContain('role="img"');
  });

  it.each([
    ['Ada Lovelace', 'AL'],
    ['Ada', 'A'],
    ['ada lovelace', 'AL'],
    ['  Ada   Byron   Lovelace  ', 'AL'],
    ['', '?'],
    ['   ', '?'],
  ])('initials(%j) === %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  it('takes one whole glyph from an astral-plane name', () => {
    // 'split("")' would return half a surrogate pair here and render a box.
    expect(initials('𝒜da Lovelace')).toBe('𝒜L');
    expect(Array.from(initials('𝒜da Lovelace'))).toHaveLength(2);
  });

  it.each(['sm', 'md', 'lg'] as const)('applies the %s size class', (size) => {
    expect(html(<Avatar name="Ada" size={size} />)).toContain(`avatar--${size}`);
  });
});

describe('Tag', () => {
  it('is an anchor with href and a span without', () => {
    expect(html(<Tag href="/tag/design">Design</Tag>)).toContain('<a class="tag" href="/tag/design"');
    const noHref = html(<Tag>Design</Tag>);
    expect(noHref).toContain('<span');
    expect(noHref).not.toContain('<a ');
  });

  it('marks the active tag with aria-current, not colour alone', () => {
    const markup = html(
      <Tag href="/tag/design" active>
        Design
      </Tag>,
    );
    expect(markup).toContain('tag--active');
    expect(markup).toContain('aria-current="page"');
  });

  it('omits aria-current when inactive', () => {
    expect(html(<Tag href="/tag/design">Design</Tag>)).not.toContain('aria-current');
  });
});

describe('ThemeToggle', () => {
  it('renders a labelled button with an inline icon', () => {
    const markup = html(<ThemeToggle />);
    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('theme-toggle');
    expect(markup).toContain('<svg');
  });

  it('describes itself neutrally before it knows the theme', () => {
    // On the server the theme is genuinely unknown — the pre-paint script has
    // not run yet — so the control must not claim a direction it might have
    // backwards for a frame.
    expect(html(<ThemeToggle />)).toContain('aria-label="Switch theme"');
  });

  it('accepts an explicit label', () => {
    expect(html(<ThemeToggle label="Appearance" />)).toContain('aria-label="Appearance"');
  });

  it('carries the ghost icon-button styling', () => {
    const markup = html(<ThemeToggle />);
    expect(markup).toContain('btn--ghost');
    expect(markup).toContain('btn--icon');
  });
});

describe('ArticleCard', () => {
  const base = {
    title: 'On measure',
    href: '/article/on-measure',
    author: { name: 'Ada Lovelace', handle: 'ada' },
    publishedAt: '2026-03-12T09:30:00Z',
  };

  it('renders title, link, author and a machine-readable date', () => {
    const markup = html(<ArticleCard {...base} />);
    expect(markup).toContain('href="/article/on-measure"');
    expect(markup).toContain('On measure');
    expect(markup).toContain('href="/@ada"');
    // Matched case-insensitively: React 19 emits the JSX prop name `dateTime`
    // verbatim. HTML attribute names are case-insensitive, so the browser and
    // every parser read it as `datetime` — asserting the exact casing would be
    // pinning a React implementation detail rather than the contract.
    expect(markup).toMatch(/datetime="2026-03-12T09:30:00Z"/i);
    expect(markup).toContain('12 Mar 2026');
  });

  it('links the headline only, never the whole card', () => {
    // A card-wide anchor would nest the author and tag links inside it, which
    // is invalid HTML and announces the card as one huge link.
    const markup = html(<ArticleCard {...base} tags={[{ slug: 'design', name: 'Design' }]} />);
    expect(markup).toContain('article-card__link');
    expect(markup).not.toMatch(/<a[^>]*>\s*<article/);
  });

  it('omits optional regions rather than rendering them empty', () => {
    const markup = html(<ArticleCard {...base} />);
    expect(markup).not.toContain('article-card__excerpt');
    expect(markup).not.toContain('article-card__cover');
    expect(markup).not.toContain('min read');
  });

  it('renders optional regions when given', () => {
    const markup = html(
      <ArticleCard
        {...base}
        excerpt="Why 68 characters."
        readingMinutes={7}
        coverUrl="/uploads/cover.webp"
        tags={[{ slug: 'design', name: 'Design' }]}
      />,
    );
    expect(markup).toContain('Why 68 characters.');
    expect(markup).toContain('7 min read');
    expect(markup).toContain('/uploads/cover.webp');
    expect(markup).toContain('article-card--with-cover');
    expect(markup).toContain('href="/tag/design"');
  });

  it('marks the cover decorative, because the headline names the target', () => {
    const markup = html(<ArticleCard {...base} coverUrl="/uploads/cover.webp" />);
    expect(markup).toContain('alt=""');
  });

  it('renders the author as plain text when there is no handle', () => {
    const markup = html(<ArticleCard {...base} author={{ name: 'Ada Lovelace' }} />);
    expect(markup).toContain('Ada Lovelace');
    expect(markup).not.toContain('href="/@');
  });

  it('accepts an engagement slot owned by another slice', () => {
    const markup = html(<ArticleCard {...base} actions={<span data-testid="claps">42</span>} />);
    expect(markup).toContain('data-testid="claps"');
  });

  describe('formatPublishedAt', () => {
    it('formats in UTC, not the machine timezone', () => {
      // 23:30Z on the 12th is still the 12th here, whatever TZ the runner is
      // in. A local-zone format would make this row read differently on two
      // machines, which is the flaky pass SPEC-002 forbids.
      expect(formatPublishedAt('2026-03-12T23:30:00Z')).toBe('12 Mar 2026');
      expect(formatPublishedAt('2026-01-01T00:00:00Z')).toBe('1 Jan 2026');
    });

    it('degrades to empty rather than printing "Invalid Date"', () => {
      expect(formatPublishedAt('not a date')).toBe('');
      expect(formatPublishedAt('')).toBe('');
    });

    it('drops the date from the byline when it cannot be parsed', () => {
      const markup = html(<ArticleCard {...base} publishedAt="nonsense" />);
      expect(markup.toLowerCase()).not.toContain('<time');
      expect(markup).not.toContain('Invalid');
    });
  });

  describe('formatReadingTime', () => {
    it.each([
      [1, '1 min read'],
      [7, '7 min read'],
      [7.4, '7 min read'],
      [0, '1 min read'],
      [0.2, '1 min read'],
      [-3, '1 min read'],
    ])('formatReadingTime(%s) === %j', (minutes, expected) => {
      expect(formatReadingTime(minutes)).toBe(expected);
    });
  });
});

describe('Prose', () => {
  it('is an <article> carrying the measure class by default', () => {
    const markup = html(<Prose>Body text</Prose>);
    expect(markup).toContain('<article');
    expect(markup).toContain('class="prose"');
    expect(markup).toContain('Body text');
  });

  it('renders as another element on request', () => {
    expect(html(<Prose as="div">x</Prose>)).toContain('<div');
    expect(html(<Prose as="section">x</Prose>)).toContain('<section');
  });

  it('renders pre-sanitised HTML from the editor', () => {
    const markup = html(<Prose sanitizedHtml="<p>Hello <em>there</em></p>" />);
    expect(markup).toContain('<p>Hello <em>there</em></p>');
  });

  it('does not sanitise, and does not claim to', () => {
    // Stated as a test so the contract is explicit: sanitising happens where
    // the HTML is produced and stored (SPEC-007), once, not at every render.
    const markup = html(<Prose sanitizedHtml='<p onclick="x()">hi</p>' />);
    expect(markup).toContain('onclick');
  });

  it('exposes a stable hook for the typography e2e suite', () => {
    expect(html(<Prose>x</Prose>)).toContain('data-testid="prose"');
  });

  it('appends a caller class without losing .prose', () => {
    expect(html(<Prose className="article__body">x</Prose>)).toContain(
      'class="prose article__body"',
    );
  });
});

describe('EmptyState', () => {
  it('renders the title as a real heading', () => {
    const markup = html(<EmptyState title="Nothing saved yet" />);
    expect(markup).toContain('<h2 class="empty-state__title">Nothing saved yet</h2>');
  });

  it('drops to h3 when nested under another section', () => {
    expect(html(<EmptyState title="x" headingLevel={3} />)).toContain('<h3');
  });

  it('omits description and action when not given', () => {
    const markup = html(<EmptyState title="x" />);
    expect(markup).not.toContain('empty-state__description');
    expect(markup).not.toContain('empty-state__action');
  });

  it('renders description and action when given', () => {
    const markup = html(
      <EmptyState
        title="Nothing saved yet"
        description="Articles you bookmark will appear here."
        action={<Button href="/">Browse</Button>}
      />,
    );
    expect(markup).toContain('Articles you bookmark will appear here.');
    expect(markup).toContain('href="/"');
  });
});

describe('Skeleton', () => {
  it('announces the wait once, and hides the bars', () => {
    const markup = html(<Skeleton lines={3} />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="Loading"');
    expect((markup.match(/aria-label="Loading"/g) ?? []).length).toBe(1);
    expect((markup.match(/aria-hidden="true"/g) ?? []).length).toBe(3);
  });

  it('renders exactly the number of lines asked for', () => {
    expect((html(<Skeleton lines={4} />).match(/class="skeleton skeleton--text"/g) ?? []).length)
      .toBe(4);
  });

  it('shortens the last line, as real text ends short', () => {
    expect(html(<Skeleton lines={2} />)).toContain('width:62%');
  });

  it.each([
    [0, 1],
    [1, 1],
    [-5, 1],
    [2.7, 2],
  ])('clamps lines=%s to %s', (given, expected) => {
    const markup = html(<Skeleton lines={given} />);
    const bars = (markup.match(/class="skeleton skeleton--text"/g) ?? []).length;
    expect(bars).toBe(expected);
  });

  it.each(['text', 'rect', 'circle'] as const)('applies the %s variant class', (variant) => {
    expect(html(<Skeleton variant={variant} />)).toContain(`skeleton--${variant}`);
  });

  it('treats a number dimension as px and a string as a CSS length', () => {
    expect(html(<Skeleton variant="rect" width={120} height={8} />)).toContain('width:120px');
    expect(html(<Skeleton variant="rect" width="50%" height="2rem" />)).toContain('width:50%');
    expect(html(<Skeleton variant="rect" width="50%" height="2rem" />)).toContain('height:2rem');
  });

  it('ignores height for text, which is one line tall by definition', () => {
    expect(html(<Skeleton variant="text" height={999} />)).not.toContain('height:999px');
  });
});

/* ======================================================== theme behaviour */

describe('lib/theme', () => {
  describe('pure helpers', () => {
    it.each([
      ['light', true],
      ['dark', true],
      ['Dark', false],
      ['', false],
      [null, false],
      [undefined, false],
      [0, false],
      [{}, false],
    ])('isTheme(%j) === %j', (value, expected) => {
      expect(isTheme(value)).toBe(expected);
    });

    it('oppositeTheme flips, and is its own inverse', () => {
      expect(oppositeTheme('light')).toBe('dark');
      expect(oppositeTheme('dark')).toBe('light');
      expect(oppositeTheme(oppositeTheme('dark'))).toBe('dark');
    });

    it('systemTheme maps prefers-dark to dark and everything else to light', () => {
      expect(systemTheme(true)).toBe('dark');
      expect(systemTheme(false)).toBe('light');
      // `null` means "cannot be determined" — light is the safe default.
      expect(systemTheme(null)).toBe('light');
    });
  });

  describe('storage', () => {
    it('reads a stored theme back', () => {
      expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark');
      expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light');
    });

    it('treats an absent or corrupt value as no choice at all', () => {
      // `null` is not `light`: it means "follow the system", which is what
      // makes a visitor who never touched the toggle track their OS setting.
      expect(readStoredTheme(fakeStorage())).toBeNull();
      expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'purple' }))).toBeNull();
      expect(readStoredTheme(null)).toBeNull();
    });

    it('writes under the key SPEC-003 fixes', () => {
      expect(THEME_STORAGE_KEY).toBe('titan.theme');
      const storage = fakeStorage();
      storeTheme('dark', storage);
      expect(storage.data[THEME_STORAGE_KEY]).toBe('dark');
    });

    it('survives a storage that throws, rather than taking the UI down with it', () => {
      expect(() => storeTheme('dark', hostileStorage)).not.toThrow();
      expect(readStoredTheme(hostileStorage)).toBeNull();
      expect(() => storeTheme('dark', null)).not.toThrow();
    });
  });

  describe('resolveTheme', () => {
    it('prefers an explicit choice over the system preference', () => {
      expect(resolveTheme('light', true)).toBe('light');
      expect(resolveTheme('dark', false)).toBe('dark');
    });

    it('falls back to the system preference when there is no choice', () => {
      expect(resolveTheme(null, true)).toBe('dark');
      expect(resolveTheme(null, false)).toBe('light');
      expect(resolveTheme(null, null)).toBe('light');
    });
  });

  describe('applying to the document', () => {
    it('adds and removes the dark class, and keeps color-scheme in step', () => {
      const doc = fakeDocument();
      applyTheme('dark', doc);
      expect(doc.classes.has(DARK_CLASS)).toBe(true);
      expect(doc.documentElement.style.colorScheme).toBe('dark');

      applyTheme('light', doc);
      expect(doc.classes.has(DARK_CLASS)).toBe(false);
      expect(doc.documentElement.style.colorScheme).toBe('light');
    });

    it('is idempotent', () => {
      const doc = fakeDocument();
      applyTheme('dark', doc);
      applyTheme('dark', doc);
      expect([...doc.classes]).toEqual([DARK_CLASS]);
    });

    it('reads the current theme back off the document', () => {
      expect(currentTheme(fakeDocument([DARK_CLASS]))).toBe('dark');
      expect(currentTheme(fakeDocument())).toBe('light');
      expect(currentTheme(null)).toBe('light');
    });

    it('does nothing at all without a document', () => {
      expect(() => applyTheme('dark', null)).not.toThrow();
    });
  });

  describe('setTheme / toggleTheme', () => {
    it('setTheme applies and persists in one step', () => {
      const doc = fakeDocument();
      const storage = fakeStorage();
      expect(setTheme('dark', doc, storage)).toBe('dark');
      expect(doc.classes.has(DARK_CLASS)).toBe(true);
      expect(storage.data[THEME_STORAGE_KEY]).toBe('dark');
    });

    it('toggleTheme flips whatever the DOCUMENT shows, not local state', () => {
      // The document is the single source of truth, so a second toggle mounted
      // elsewhere — or a change made in another tab — cannot desynchronise it.
      const doc = fakeDocument();
      const storage = fakeStorage();

      expect(toggleTheme(doc, storage)).toBe('dark');
      expect(storage.data[THEME_STORAGE_KEY]).toBe('dark');

      expect(toggleTheme(doc, storage)).toBe('light');
      expect(storage.data[THEME_STORAGE_KEY]).toBe('light');
    });

    it('round-trips back to where it started', () => {
      const doc = fakeDocument([DARK_CLASS]);
      const storage = fakeStorage();
      toggleTheme(doc, storage);
      toggleTheme(doc, storage);
      expect(currentTheme(doc)).toBe('dark');
    });
  });

  /**
   * Every function above takes its document/storage/matchMedia as a parameter,
   * with a browser-global default. Those defaults are the code path that
   * actually runs in production, so they are exercised here rather than left
   * as the one untested corner of the module — first with the globals absent,
   * which is Vitest's `node` environment and also the server render, then with
   * fakes installed on `globalThis` to drive the browser branch.
   */
  describe('browser-global defaults', () => {
    const globals = globalThis as Record<string, unknown>;
    const saved = {
      window: globals.window,
      document: globals.document,
      localStorage: globals.localStorage,
    };

    afterEach(() => {
      for (const key of ['window', 'document', 'localStorage'] as const) {
        if (saved[key] === undefined) delete globals[key];
        else globals[key] = saved[key];
      }
    });

    describe('with no browser globals at all (server render)', () => {
      it('degrades to light and never throws', () => {
        expect(readStoredTheme()).toBeNull();
        expect(() => storeTheme('dark')).not.toThrow();
        expect(() => applyTheme('dark')).not.toThrow();
        expect(currentTheme()).toBe('light');
        expect(systemTheme()).toBe('light');
        expect(resolveTheme()).toBe('light');
        expect(setTheme('dark')).toBe('dark');
        expect(toggleTheme()).toBe('dark');
      });
    });

    describe('with browser globals present', () => {
      it('reads and writes the real storage and document', () => {
        const store: Record<string, string> = {};
        const classes = new Set<string>();
        globals.localStorage = {
          getItem: (k: string) => store[k] ?? null,
          setItem: (k: string, v: string) => {
            store[k] = v;
          },
        };
        globals.document = {
          documentElement: {
            classList: {
              add: (t: string) => void classes.add(t),
              remove: (t: string) => void classes.delete(t),
              contains: (t: string) => classes.has(t),
            },
            style: { colorScheme: '' },
          },
        };
        globals.window = { matchMedia: () => ({ matches: true }) };

        expect(systemTheme()).toBe('dark');
        expect(resolveTheme()).toBe('dark');

        expect(setTheme('dark')).toBe('dark');
        expect(classes.has(DARK_CLASS)).toBe(true);
        expect(store[THEME_STORAGE_KEY]).toBe('dark');
        expect(readStoredTheme()).toBe('dark');
        expect(currentTheme()).toBe('dark');

        expect(toggleTheme()).toBe('light');
        expect(classes.has(DARK_CLASS)).toBe(false);
        expect(store[THEME_STORAGE_KEY]).toBe('light');

        // A stored choice now outranks the dark system preference.
        expect(resolveTheme()).toBe('light');
      });

      it('survives a window without matchMedia, and one whose matchMedia throws', () => {
        globals.window = {};
        expect(systemTheme()).toBe('light');

        globals.window = {
          matchMedia: () => {
            throw new Error('unsupported query');
          },
        };
        expect(systemTheme()).toBe('light');
      });

      it('survives a localStorage that throws on access', () => {
        Object.defineProperty(globals, 'localStorage', {
          configurable: true,
          get() {
            throw new Error('storage disabled');
          },
        });
        expect(readStoredTheme()).toBeNull();
        expect(() => storeTheme('dark')).not.toThrow();
      });
    });
  });

  /**
   * The pre-paint script is a hand-written copy of `resolveTheme` +
   * `applyTheme` — it has to be, because it runs before any module can load.
   * These tests execute the actual string that ships in the layout against a
   * fake window and assert it agrees with the module on every input, so the
   * two copies cannot drift without a red test.
   */
  describe('THEME_INIT_SCRIPT (the no-flash script)', () => {
    interface Sandbox {
      classes: Set<string>;
      colorScheme: () => string;
    }

    function runScript(options: {
      stored?: string | null;
      prefersDark?: boolean;
      storageThrows?: boolean;
      noMatchMedia?: boolean;
      initialClasses?: string[];
    }): Sandbox {
      const classes = new Set<string>(options.initialClasses ?? []);
      const style = { colorScheme: '' };

      const context = {
        window: {
          localStorage: {
            getItem(key: string) {
              if (options.storageThrows) throw new Error('nope');
              return key === THEME_STORAGE_KEY ? (options.stored ?? null) : null;
            },
          },
          ...(options.noMatchMedia
            ? {}
            : { matchMedia: () => ({ matches: options.prefersDark === true }) }),
        },
        document: {
          documentElement: {
            classList: {
              add: (t: string) => void classes.add(t),
              remove: (t: string) => void classes.delete(t),
              contains: (t: string) => classes.has(t),
            },
            style,
          },
        },
      };

      runInNewContext(THEME_INIT_SCRIPT, context);
      return { classes, colorScheme: () => style.colorScheme };
    }

    it.each([
      // stored,   prefersDark, expected
      ['dark', false, 'dark'],
      ['dark', true, 'dark'],
      ['light', true, 'light'],
      ['light', false, 'light'],
      [null, true, 'dark'],
      [null, false, 'light'],
      ['purple', true, 'dark'],
      ['purple', false, 'light'],
    ] as const)(
      'stored=%j prefersDark=%j resolves to %j, exactly as the module does',
      (stored, prefersDark, expected) => {
        const sandbox = runScript({ stored, prefersDark });

        expect(sandbox.classes.has(DARK_CLASS)).toBe(expected === 'dark');
        expect(sandbox.colorScheme()).toBe(expected);

        // ...and the module, given the same inputs, agrees.
        const viaModule = resolveTheme(
          readStoredTheme(fakeStorage(stored === null ? {} : { [THEME_STORAGE_KEY]: stored })),
          prefersDark,
        );
        expect(viaModule).toBe(expected);
      },
    );

    it('clears a stale dark class when the resolved theme is light', () => {
      // Matters on a back/forward navigation that restores markup from cache.
      const sandbox = runScript({ stored: 'light', prefersDark: true, initialClasses: [DARK_CLASS] });
      expect(sandbox.classes.has(DARK_CLASS)).toBe(false);
    });

    it('falls back to light when storage throws', () => {
      const sandbox = runScript({ storageThrows: true, prefersDark: false });
      expect(sandbox.classes.has(DARK_CLASS)).toBe(false);
      expect(sandbox.colorScheme()).toBe('light');
    });

    it('still honours a stored choice when matchMedia is unavailable', () => {
      const sandbox = runScript({ stored: 'dark', noMatchMedia: true });
      expect(sandbox.classes.has(DARK_CLASS)).toBe(true);
    });

    it('never throws, whatever the environment does', () => {
      // It runs before anything else on the page. If it threw, it would take
      // the first paint with it.
      expect(() => runScript({ storageThrows: true, noMatchMedia: true })).not.toThrow();
    });

    it('needs no HTML escaping inside a <script> tag', () => {
      // It is injected with dangerouslySetInnerHTML, so an unescaped "<" would
      // let the parser close the tag early and break the page.
      expect(THEME_INIT_SCRIPT).not.toMatch(/[<>&]/);
    });

    it('reads the key SPEC-003 fixes, not a hard-coded duplicate', () => {
      expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
      expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(DARK_CLASS));
    });
  });
});

/* ================================================= stylesheet integration */

describe('components and stylesheet agree', () => {
  let css: string;

  beforeEach(async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    css = readFileSync(join(root, 'app', 'globals.css'), 'utf8');
  });

  // Every class a component emits must exist in the stylesheet. This is the
  // check that catches a rename on one side of the pair — the failure mode
  // that leaves a component unstyled while every unit test still passes.
  it.each([
    'btn', 'btn--primary', 'btn--secondary', 'btn--ghost', 'btn--sm', 'btn--lg', 'btn--icon',
    'avatar', 'avatar--sm', 'avatar--md', 'avatar--lg', 'avatar__image',
    'tag', 'tag--active',
    'theme-toggle', 'theme-toggle__icon',
    'article-card', 'article-card--with-cover', 'article-card__byline', 'article-card__author',
    'article-card__title', 'article-card__link', 'article-card__excerpt', 'article-card__footer',
    'article-card__cover',
    'prose',
    'empty-state', 'empty-state__title', 'empty-state__description', 'empty-state__action',
    'skeleton', 'skeleton--text', 'skeleton--rect', 'skeleton--circle',
  ])('.%s is declared in app/globals.css', (className) => {
    expect(css).toContain(`.${className}`);
  });
});
