/**
 * The editor's CLIENT-SAFE half (SPEC-007).
 *
 * ── Read this before adding an import ─────────────────────────────────────
 * `components/editor/Editor.tsx`, `SaveIndicator.tsx` and `TagInput.tsx` are
 * client components and they import this module. Nothing here may import
 * `lib/db/**`, directly or transitively.
 *
 * That is not style. `lib/db/articles.ts` imports `lib/db/ids.ts`, which
 * imports `node:crypto`, which the browser build cannot resolve — the failure
 * is `UnhandledSchemeError: Reading from "node:crypto" is not handled by
 * plugins`, and it takes the whole route down at compile time rather than
 * degrading. It is also the wrong shape regardless of whether it built: a
 * client bundle that contains the repository layer contains the SQL, and
 * SPEC-004's boundary rule ("no module opens its own SQLite handle") means
 * nothing if the query text ships to the browser.
 *
 * So `lib/content/` is split along CLIENT/SERVER, not along autosave/publish:
 *
 *  - **this file** — everything the browser needs: the autosave state machine,
 *    the four indicator strings, the shape of a save request and its reply, and
 *    the pure guards the form runs for immediate feedback.
 *  - **`lib/content/publish.ts`** — everything that writes: `saveDraftContent`,
 *    `createDraftContent`, and the publish transitions. Imports the repository,
 *    and is reached only from `app/editor/actions.ts` and the unit suites.
 *
 * The guards live on this side deliberately. `validatePublish` is a pure
 * function of three values, the form runs it to show every problem at once
 * without a round trip, and `publishDraft` runs the SAME function server-side
 * before it writes anything — so the client's copy is an optimisation and the
 * server's is the authority, rather than two rules that can disagree.
 *
 * ── The autosave state machine (SPEC-007) ─────────────────────────────────
 * ```
 * [*] --> Clean
 * Clean  --> Dirty:  keystroke
 * Dirty  --> Saving: 2s idle debounce OR 30s max interval
 * Saving --> Clean:  200 OK
 * Saving --> Error:  non-2xx / network
 * Error  --> Saving: manual retry or next debounce
 * Dirty  --> Saving: Cmd/Ctrl+S
 * ```
 *
 * The scheduler takes its clock and timers as a parameter, so
 * `tests/unit/editor-conflict.test.ts` can drive 35 seconds of continuous
 * typing — the case SPEC-007's ceiling criterion is about — in under a
 * millisecond, and can assert "exactly one save" as a counter rather than as a
 * network observation.
 *
 * ── Why the conflict rule is not in `lib/db/articles.ts` ──────────────────
 * `updateArticle` bumps `version` unconditionally and compares nothing, by
 * design: it is the repository's job to make the counter advance on every
 * write, and every write path wants that. The COMPARISON is a policy about what
 * an editor may overwrite, so it belongs with the editor — in `publish.ts`,
 * next to the write it guards. `CONFLICT_MESSAGE` and the result types are here
 * because the client renders them.
 */
/*
 * No imports from `lib/db/**`, and that is a load-bearing property rather than
 * a coincidence — see the header. The only import here is a type.
 */
import type { ContentNode } from './schema';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** SPEC-007: "Debounce 2s after last keystroke". */
export const AUTOSAVE_DEBOUNCE_MS = 2_000;

/**
 * SPEC-007: "hard ceiling 30s since last successful save while typing
 * continuously".
 *
 * Measured from the last SUCCESSFUL save, not from the last attempt: a failing
 * server would otherwise reset the ceiling on every rejection and an author
 * typing through an outage would never see a save attempted again.
 */
export const AUTOSAVE_MAX_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * SPEC-007: "Status indicator text is one of exactly: `Saved`, `Saving…`,
 * `Unsaved changes`, `Save failed — retry`."
 *
 * "Exactly" is why these are constants and not string literals in the JSX. The
 * ellipsis is U+2026 and the dash in "Save failed — retry" is an em dash; both
 * are trivially retyped as "..." and "-", which would still look right and
 * would still fail a criterion asserting the exact text.
 */
export const SAVE_STATUS = {
  clean: 'Saved',
  saving: 'Saving…',
  dirty: 'Unsaved changes',
  error: 'Save failed — retry',
} as const;

export type AutosaveState = keyof typeof SAVE_STATUS;
export type SaveStatusText = (typeof SAVE_STATUS)[AutosaveState];

/** The four strings, for a test that wants to assert the set is closed. */
export const SAVE_STATUS_TEXTS: readonly string[] = Object.freeze(Object.values(SAVE_STATUS));

export function statusText(state: AutosaveState): SaveStatusText {
  return SAVE_STATUS[state];
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * The parts of the environment the scheduler touches.
 *
 * Injected rather than closed over so a test can drive 35 seconds of continuous
 * typing in under a millisecond. Everything else in this module is already
 * deterministic; this is the only source of time.
 */
export interface AutosaveTimers {
  now(): number;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** The real environment. `setTimeout` in a browser returns a number. */
export const REAL_TIMERS: AutosaveTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

export interface AutosaveOptions<T> {
  /** Performs the save. Resolving means success; rejecting or `false` means failure. */
  save(payload: T): Promise<boolean | void>;
  /** Called on every state transition, so a component can re-render. */
  onStateChange?(state: AutosaveState): void;
  timers?: AutosaveTimers;
  debounceMs?: number;
  maxIntervalMs?: number;
}

export interface AutosaveScheduler<T> {
  /** Current state. */
  readonly state: AutosaveState;
  /** `SAVE_STATUS[state]` — the exact indicator text. */
  readonly statusText: SaveStatusText;
  /** A keystroke happened. Arms the debounce and, if due, the ceiling. */
  change(payload: T): void;
  /** Cmd/Ctrl+S, or a retry after an error. Saves immediately if there is anything to save. */
  flush(): Promise<void>;
  /** Cancel any armed timer. Called on unmount. */
  dispose(): void;
  /** Number of saves started. Exposed so "exactly one save" is assertable. */
  readonly saveCount: number;
}

/**
 * The debounce/ceiling scheduler.
 *
 * The one subtlety worth stating: the timer is armed for
 * `min(debounce, timeUntilCeiling)`, recomputed on every keystroke. A plain
 * debounce that is merely re-armed each time never fires while the author keeps
 * typing — which is exactly the case SPEC-007's second criterion is about
 * ("typing continuously for 35s issues at least one save"). Taking the minimum
 * is what makes the ceiling reachable rather than decorative.
 */
export function createAutosaveScheduler<T>(options: AutosaveOptions<T>): AutosaveScheduler<T> {
  const timers = options.timers ?? REAL_TIMERS;
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const maxIntervalMs = options.maxIntervalMs ?? AUTOSAVE_MAX_INTERVAL_MS;

  let state: AutosaveState = 'clean';
  let handle: number | null = null;
  let pending: { payload: T } | null = null;
  let inFlight = false;
  let saveCount = 0;
  /** When the ceiling is measured from: the last success, or the first edit since one. */
  let ceilingFrom = timers.now();
  let disposed = false;

  const setState = (next: AutosaveState) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const cancelTimer = () => {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
  };

  const arm = () => {
    cancelTimer();
    if (disposed || !pending) return;
    const untilCeiling = Math.max(0, ceilingFrom + maxIntervalMs - timers.now());
    handle = timers.setTimeout(() => {
      handle = null;
      void run();
    }, Math.min(debounceMs, untilCeiling));
  };

  const run = async (): Promise<void> => {
    if (disposed || inFlight || !pending) return;

    const payload = pending.payload;
    // Cleared BEFORE the await, so a keystroke landing mid-flight is recorded as
    // new pending work rather than being swallowed by the save it raced.
    pending = null;
    inFlight = true;
    saveCount += 1;
    setState('saving');

    try {
      const result = await options.save(payload);
      inFlight = false;
      if (disposed) return;
      if (result === false) {
        setState('error');
        return;
      }
      ceilingFrom = timers.now();
      // A keystroke during the save leaves the document dirty even though this
      // save succeeded. Reporting `Saved` there would be a lie the author can
      // see: the indicator would read Saved while their last word was not.
      setState(pending ? 'dirty' : 'clean');
      if (pending) arm();
    } catch {
      inFlight = false;
      if (disposed) return;
      setState('error');
    }
  };

  return {
    get state() {
      return state;
    },
    get statusText() {
      return SAVE_STATUS[state];
    },
    get saveCount() {
      return saveCount;
    },

    change(payload: T) {
      if (disposed) return;
      // The ceiling runs from the first edit after a clean state, so an author
      // who starts typing on a freshly-loaded document still gets a save within
      // 30s rather than within 30s of page load.
      if (!pending && state !== 'saving') ceilingFrom = Math.min(ceilingFrom, timers.now());
      pending = { payload };
      if (state !== 'saving') setState('dirty');
      arm();
    },

    async flush() {
      cancelTimer();
      await run();
    },

    dispose() {
      disposed = true;
      cancelTimer();
      pending = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/** SPEC-007: "`bodyText` >= 50 chars". */
export const MIN_BODY_TEXT_CHARS = 50;

/**
 * SPEC-007: "1-5 tags".
 *
 * `MAX_TAGS` is a literal rather than a re-export of `MAX_TAGS_PER_ARTICLE`
 * from `lib/db/tags.ts`, and that is forced rather than chosen: this module is
 * imported by `components/editor/TagInput.tsx`, a client component, and
 * `lib/db/tags.ts` imports the generated Prisma client. Re-exporting the
 * constant would drag the whole repository layer — and `node:crypto` under it —
 * into the browser bundle.
 *
 * A duplicated number is a real risk, so it is not left to inspection: the
 * publish-guard suite asserts `MAX_TAGS === MAX_TAGS_PER_ARTICLE` directly. A
 * test file is bundled by nobody, so it can import both sides and hold them
 * together.
 */
export const MIN_TAGS = 1;
export const MAX_TAGS = 5;

export type PublishField = 'title' | 'body' | 'tags';

export interface PublishFieldError {
  field: PublishField;
  message: string;
}

export interface PublishCandidate {
  title: string;
  bodyText: string;
  tags: readonly string[];
}

/**
 * Every reason this article cannot be published, at once.
 *
 * All of them, not the first: SPEC-007's oracle asks for "a field-level error",
 * and a form that reveals its next problem only after you fix the current one
 * is a form the author submits four times. Same reasoning as
 * `validateSignUp` in `lib/auth/validation.ts`, and deliberately the same
 * shape, so the editor's error rendering looks like the sign-up form's.
 */
export function validatePublish(candidate: PublishCandidate): PublishFieldError[] {
  const errors: PublishFieldError[] = [];

  if (candidate.title.trim().length === 0) {
    errors.push({ field: 'title', message: 'Give the article a title before publishing.' });
  }

  // Measured on `bodyText` — the canonical plaintext projection from
  // `lib/derive/reading.ts` — and not on the raw JSON or the HTML. Counting
  // characters of `bodyJson` would let an article of markup and no words past
  // the guard; counting HTML would make the threshold depend on how many tags
  // the author happened to use.
  const length = candidate.bodyText.trim().length;
  if (length < MIN_BODY_TEXT_CHARS) {
    errors.push({
      field: 'body',
      message: `Write at least ${MIN_BODY_TEXT_CHARS} characters — this draft has ${length}.`,
    });
  }

  const tags = normalizeTagList(candidate.tags);
  if (tags.length < MIN_TAGS) {
    errors.push({ field: 'tags', message: 'Add at least one tag so readers can find this.' });
  } else if (tags.length > MAX_TAGS) {
    errors.push({
      field: 'tags',
      message: `Use at most ${MAX_TAGS} tags — this draft has ${tags.length}.`,
    });
  }

  return errors;
}

/**
 * Drop blanks and exact duplicates, preserving order.
 *
 * Counting is done on this list rather than on the raw input so that a trailing
 * empty chip left behind by the tag input does not read as a tag, and so
 * `['a', 'a']` is one tag — which is what `setArticleTags` will store, and the
 * guard must agree with the write or an article can pass validation and then
 * fail to persist what was validated.
 */
export function normalizeTagList(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** True when nothing blocks publication. */
export function canPublish(candidate: PublishCandidate): boolean {
  return validatePublish(candidate).length === 0;
}

// ---------------------------------------------------------------------------
// The save request, and what comes back
// ---------------------------------------------------------------------------

/** The payload SPEC-007 names: `saveDraft(id, { title, subtitle, bodyJson, coverPath, tags })`. */
export interface DraftInput {
  title: string;
  subtitle?: string | null;
  bodyJson: unknown;
  coverPath?: string | null;
  tags?: string[];
  /** The client's last-known `version`. A mismatch is a 409. */
  version: number;
}

export interface SaveDraftOk {
  ok: true;
  status: 200;
  /** ISO-8601. SPEC-007: `saveDraft` returns `{ savedAt, version }`. */
  savedAt: string;
  version: number;
  slug: string;
  readingMinutes: number;
  /**
   * Set only by `createDraftContent`, which is the one save that mints an id.
   * The editor at `/editor/new` reads it to swap its URL to `/editor/<id>`
   * without a navigation, so a refresh after the first autosave lands on the
   * draft rather than on a blank new document.
   */
  articleId?: string;
}

export interface SaveDraftConflict {
  ok: false;
  status: 409;
  /** The version the row actually carries, so the editor can offer a reload. */
  serverVersion: number;
  message: string;
}

export interface SaveDraftRejected {
  ok: false;
  status: 400 | 404;
  message: string;
  field?: 'title' | 'tags';
}

export type SaveDraftResult = SaveDraftOk | SaveDraftConflict | SaveDraftRejected;

export const CONFLICT_MESSAGE =
  'This draft was changed somewhere else. Reload to get the newer version — nothing you typed here has been saved over it.';
