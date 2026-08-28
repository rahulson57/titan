/**
 * Theme state for the titan design system (SPEC-003).
 *
 * SPEC-003 fixes three things and this module owns all three:
 *   1. the switch is `class="dark"` on `<html>`
 *   2. the choice persists in `localStorage` under `titan.theme`
 *   3. the default is `prefers-color-scheme`, and there is no flash of the
 *      wrong theme — an inline blocking script applies the class before paint
 *
 * Everything here is written to run in three places: the browser, the inline
 * pre-paint script, and Vitest's `node` environment. That last one is why no
 * function reaches for a global on its own — `document`, `localStorage` and
 * `matchMedia` all arrive as parameters with browser defaults. In Node they
 * are simply absent, so a module that closed over them could only be tested
 * by faking a DOM, and there is no DOM test environment in this repo
 * (jsdom/happy-dom are not dependencies, and `package.json` belongs to
 * SPEC-001, so adding one is not this slice's call). Injection makes the
 * whole module exercisable as plain data.
 */

/** The two themes. There is no `system` value stored — see `resolveTheme`. */
export type Theme = 'light' | 'dark';

/** localStorage key. Fixed by SPEC-003; the e2e suite asserts this literal. */
export const THEME_STORAGE_KEY = 'titan.theme';

/** The class SPEC-003 puts on `<html>` for the dark palette. */
export const DARK_CLASS = 'dark';

export const THEMES: readonly Theme[] = ['light', 'dark'] as const;

/**
 * The minimum of `Storage` this module uses.
 *
 * Typed structurally rather than as `Storage` so a plain object literal can
 * stand in during unit tests without implementing `length`/`key`/`clear`.
 */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The minimum of `Document` this module uses. */
export interface ThemeDocument {
  documentElement: {
    classList: { add(token: string): void; remove(token: string): void; contains(token: string): boolean };
    style: { colorScheme: string };
  };
}

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** The opposite theme. Total over `Theme`, so no fallback branch is needed. */
export function oppositeTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

function defaultStorage(): ThemeStorage | null {
  try {
    // Private-mode Safari throws on property access, not just on setItem.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultDocument(): ThemeDocument | null {
  return typeof document === 'undefined' ? null : (document as unknown as ThemeDocument);
}

/**
 * The persisted choice, or `null` when the visitor has never chosen.
 *
 * `null` is meaningful and distinct from `'light'`: it means "follow the
 * system", which is what `resolveTheme` does with it. A visitor who has never
 * touched the toggle tracks their OS setting forever; one who has chosen does
 * not, even if the OS later disagrees.
 */
export function readStoredTheme(storage: ThemeStorage | null = defaultStorage()): Theme | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    // A storage that throws is a storage that is unavailable.
    return null;
  }
}

/** Persist a choice. Silent on failure: a broken storage must not break the UI. */
export function storeTheme(theme: Theme, storage: ThemeStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* quota exceeded or storage disabled — the class is still applied */
  }
}

/** `prefers-color-scheme`, defaulting to light where it cannot be read. */
export function systemTheme(matches: boolean | null = defaultPrefersDark()): Theme {
  return matches === true ? 'dark' : 'light';
}

function defaultPrefersDark(): boolean | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return null;
  }
}

/** Stored choice wins; otherwise the system preference. SPEC-003's default rule. */
export function resolveTheme(
  stored: Theme | null = readStoredTheme(),
  prefersDark: boolean | null = defaultPrefersDark(),
): Theme {
  return stored ?? systemTheme(prefersDark);
}

/**
 * Apply a theme to the document: the `dark` class, plus `color-scheme` so the
 * UA paints form controls, scrollbars and the canvas to match. Without the
 * second, a dark page keeps a white scrollbar and a white flash between
 * navigations, which is the exact defect SPEC-003's no-flash rule is about.
 */
export function applyTheme(theme: Theme, doc: ThemeDocument | null = defaultDocument()): void {
  if (!doc) return;
  const root = doc.documentElement;
  if (theme === 'dark') root.classList.add(DARK_CLASS);
  else root.classList.remove(DARK_CLASS);
  root.style.colorScheme = theme;
}

/** Read the theme back off the document — the single source of truth in the DOM. */
export function currentTheme(doc: ThemeDocument | null = defaultDocument()): Theme {
  if (!doc) return 'light';
  return doc.documentElement.classList.contains(DARK_CLASS) ? 'dark' : 'light';
}

/** Apply and persist in one step. What the toggle calls. */
export function setTheme(
  theme: Theme,
  doc: ThemeDocument | null = defaultDocument(),
  storage: ThemeStorage | null = defaultStorage(),
): Theme {
  applyTheme(theme, doc);
  storeTheme(theme, storage);
  return theme;
}

/** Flip whatever the document currently shows, and persist the result. */
export function toggleTheme(
  doc: ThemeDocument | null = defaultDocument(),
  storage: ThemeStorage | null = defaultStorage(),
): Theme {
  return setTheme(oppositeTheme(currentTheme(doc)), doc, storage);
}

/**
 * The pre-paint script, as source text for `dangerouslySetInnerHTML` in the
 * root layout.
 *
 * It is duplicated logic on purpose, and the duplication is the point: this
 * has to run *before* React, before hydration and before first paint, so it
 * cannot import anything — a module graph would mean a network round trip and
 * a frame of the wrong theme. It is inlined into `<head>` as a blocking
 * script, which is the only place the class can be set early enough for
 * SPEC-003's "zero light-frame flash".
 *
 * `tests/unit/components.test.tsx` guards the duplication by executing this
 * string against a fake document and asserting it agrees with `resolveTheme`
 * + `applyTheme` on every input, so the two copies cannot drift silently.
 *
 * Kept free of `<`, `>` and `&` so it needs no escaping inside the tag — which
 * is why the media query is read into `m` with a ternary instead of the
 * obvious `&&`. An unescaped character here would let the HTML parser close
 * the `<script>` early and take the page with it. A unit test asserts the
 * absence rather than trusting the next editor to remember.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var s=null;try{s=window.localStorage.getItem(k)}catch(e){}var m=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)").matches:false;var t=s==="dark"||s==="light"?s:(m?"dark":"light");var r=document.documentElement;if(t==="dark"){r.classList.add(${JSON.stringify(
  DARK_CLASS,
)})}else{r.classList.remove(${JSON.stringify(
  DARK_CLASS,
)})}r.style.colorScheme=t}catch(e){}})();`;
