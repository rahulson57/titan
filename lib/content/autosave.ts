/**
 * Autosave — the scheduler and the conflict rule (SPEC-007, "Autosave state
 * machine").
 *
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
 * Two halves live here, and they are separated on purpose:
 *
 *  1. `createAutosaveScheduler` — WHEN to save. Pure, with the clock and the
 *     timer injected, so the 2s debounce and the 30s ceiling are unit-testable
 *     without waiting 35 real seconds or watching a browser.
 *  2. `saveDraftContent` — WHAT a save does, including the optimistic
 *     concurrency check. Server-side; the Server Action in
 *     `app/editor/actions.ts` is a thin authenticated wrapper over it.
 *
 * ── Why the conflict check is here and not in `lib/db/articles.ts` ─────────
 * `updateArticle` bumps `version` unconditionally and compares nothing — by
 * design: it is the repository's job to make the counter advance on every
 * write, and every write path wants that. The COMPARISON is a policy about
 * what an editor is allowed to overwrite, and it belongs with the editor.
 *
 * The important half of SPEC-007's rule is the negative one — "it never
 * silently overwrites a newer server doc" — so the check runs BEFORE any write
 * and returns without touching the row. `tests/unit/editor-conflict.test.ts`
 * proves the stored `bodyJson` is byte-identical after a rejected save, which
 * is the only assertion that distinguishes this from a check that runs after
 * the update and reports a conflict it already caused.
 */

import {
  type ArticleRecord,
  DerivedBodyMismatchError,
  EmptyTitleError,
  createArticle,
  getArticleById,
  normalizeTitle,
  updateArticle,
} from '../db/articles';
import { MAX_TAGS_PER_ARTICLE, TooManyTagsError, setArticleTags } from '../db/tags';
import { deriveContent } from './render';
import { toProseMirrorNode } from './schema';

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
// The save itself
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

/**
 * Apply one autosave.
 *
 * Ordering is the whole contract, and it is: read, compare, reject-or-write.
 * Nothing before the version comparison writes anything, so a stale save leaves
 * the row byte-identical — including `updatedAt` and `version`, which a
 * "write then detect" implementation would have moved.
 *
 * Authorization is NOT checked here. It is checked by the Server Action through
 * `guardArticleMutation`, which makes the write unreachable unless the caller
 * owns the article. Doing it in both places would mean two rules to keep in
 * step; doing it in the combinator means the check cannot be skipped.
 */
export async function saveDraftContent(
  articleId: string,
  input: DraftInput,
  now: Date = new Date(),
): Promise<SaveDraftResult> {
  const existing = await getArticleById(articleId);
  if (!existing) {
    return { ok: false, status: 404, message: 'That draft no longer exists.' };
  }

  if (!Number.isInteger(input.version) || input.version !== existing.version) {
    return {
      ok: false,
      status: 409,
      serverVersion: existing.version,
      message: CONFLICT_MESSAGE,
    };
  }

  // Validated before the write for the same reason as the version check: a
  // draft whose title was cleared must not be half-saved. `normalizeTitle`
  // throws on empty, and an untitled draft is a legitimate state to be IN — it
  // is only publishing that requires a title — so an empty title keeps the
  // stored one rather than failing the save. An author who selects-all-deletes
  // their title mid-edit should not see "Save failed".
  let title: string;
  try {
    title = normalizeTitle(input.title);
  } catch (error) {
    if (!(error instanceof EmptyTitleError)) throw error;
    title = existing.title;
  }

  if (input.tags && input.tags.length > MAX_TAGS_PER_ARTICLE) {
    return {
      ok: false,
      status: 400,
      field: 'tags',
      message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
    };
  }

  // The sanitised document is what gets stored — never `input.bodyJson`. That
  // is the line that makes the security boundary server-side: a client posting
  // a hand-written document with a `<script>` node has it removed here, not in
  // the component that happened to render it.
  const derived = deriveContent(input.bodyJson);

  const updated: ArticleRecord = await updateArticle(articleId, {
    title,
    subtitle: input.subtitle ?? null,
    coverPath: input.coverPath ?? null,
    bodyJson: toProseMirrorNode(derived.doc),
    bodyHtml: derived.bodyHtml,
    now,
  });

  if (input.tags) {
    try {
      await setArticleTags(articleId, input.tags);
    } catch (error) {
      // The ceiling is re-checked by the repository against the DEDUPLICATED
      // set, so a list of six that collapses to five is legal and only this
      // path knows it was not. The content is already saved; reporting the tag
      // problem without losing the prose is the right trade.
      if (!(error instanceof TooManyTagsError)) throw error;
      return {
        ok: false,
        status: 400,
        field: 'tags',
        message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
      };
    }
  }

  return {
    ok: true,
    status: 200,
    savedAt: updated.updatedAt.toISOString(),
    version: updated.version,
    slug: updated.slug,
    readingMinutes: updated.readingMinutes,
  };
}

/** The title a draft carries until its author gives it one. */
export const UNTITLED_DRAFT = 'Untitled';

/**
 * The first save of a document written at `/editor/new`.
 *
 * `/editor/new` deliberately does NOT create a row when it renders. A page that
 * mints an article on GET leaves a trail of empty drafts behind every visit,
 * every refresh and every back-button — and `/editor` is behind the session
 * check, so those rows all belong to a real author and all show up in their
 * profile's draft count. The row appears on the first autosave instead, which
 * is the first moment there is anything to store.
 *
 * `createArticle` refuses an empty title (SPEC-004: "title, 1-120 chars"), so
 * an untouched title field becomes `Untitled` here. That is a real,
 * publishable-looking name in the slug — but only until the author types one,
 * because `updateArticle` recomputes the slug from the title on every save
 * while `publishedAt` is null. The placeholder therefore cannot survive into a
 * published URL unless the author genuinely publishes something untitled, which
 * `validatePublish` refuses.
 */
export async function createDraftContent(
  authorId: string,
  input: Omit<DraftInput, 'version'>,
  now: Date = new Date(),
): Promise<SaveDraftResult> {
  if (input.tags && input.tags.length > MAX_TAGS_PER_ARTICLE) {
    return {
      ok: false,
      status: 400,
      field: 'tags',
      message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
    };
  }

  const derived = deriveContent(input.bodyJson);
  const title = input.title.trim().length > 0 ? input.title : UNTITLED_DRAFT;

  const created = await createArticle({
    authorId,
    title,
    subtitle: input.subtitle ?? null,
    bodyJson: toProseMirrorNode(derived.doc),
    bodyHtml: derived.bodyHtml,
    coverPath: input.coverPath ?? null,
    now,
  });

  if (input.tags && input.tags.length > 0) {
    try {
      await setArticleTags(created.id, input.tags);
    } catch (error) {
      if (!(error instanceof TooManyTagsError)) throw error;
      return {
        ok: false,
        status: 400,
        field: 'tags',
        message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
      };
    }
  }

  return {
    ok: true,
    status: 200,
    savedAt: created.updatedAt.toISOString(),
    version: created.version,
    slug: created.slug,
    readingMinutes: created.readingMinutes,
    articleId: created.id,
  };
}

/** Re-exported so a caller catching a repository error does not import two modules. */
export { DerivedBodyMismatchError };
