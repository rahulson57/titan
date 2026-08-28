/**
 * Optimistic concurrency on the autosave path (SPEC-007).
 *
 * Sealed criterion:
 *
 * > A `saveDraft` carrying a stale `version` returns HTTP 409 with
 * > `serverVersion` and does NOT modify the stored `bodyJson`.
 *
 * ── The second clause is the whole test ────────────────────────────────────
 * Returning 409 is easy and, on its own, worthless: an implementation that
 * writes the document and then notices the version moved returns a perfectly
 * correct 409 for a conflict it has already lost. SPEC-007 says what it is
 * actually for — "it never silently overwrites a newer server doc" — so every
 * rejection test below reads the row back and asserts `bodyJson` is
 * byte-identical, and asserts `version` and `updatedAt` did not move either. A
 * bumped `version` would be almost as bad as a lost document: the author's next
 * save would collide with a save nobody made, and the editor would show a
 * conflict banner for a change that does not exist.
 *
 * ── Why the scheduler is in this file ──────────────────────────────────────
 * `lib/content/autosave.ts` holds two things: WHEN a save happens (the 2s
 * debounce and the 30s ceiling) and WHAT it does (the version check above).
 * SPEC-007 asserts the timing criteria through `tests/e2e/editor-autosave.spec.ts`,
 * and this task's file scope has no `tests/unit/editor-autosave.test.ts` — so
 * the state machine's unit tests live here, in the one unit file that owns that
 * module. They are worth having at this level regardless of scope: the ceiling
 * criterion is "typing continuously for 35 seconds", and a browser test of it
 * costs 35 real seconds of gate time to establish one bit, while the injected
 * clock below establishes it — and a dozen neighbouring cases the e2e cannot
 * reach at all — in under a millisecond.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle, getArticleById } from '../../lib/db/articles';
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  type AutosaveTimers,
  CONFLICT_MESSAGE,
  SAVE_STATUS,
  SAVE_STATUS_TEXTS,
  createAutosaveScheduler,
  statusText,
} from '../../lib/content/autosave';
// The write path lives in `publish.ts` — the server half of `lib/content/`.
// The split is by side of the wire, not by subject: `autosave.ts` is imported
// by client components and so may not reach `lib/db/**`. See either header.
import { createDraftContent, saveDraftContent } from '../../lib/content/publish';
import { deriveContent } from '../../lib/content/render';

const AT = new Date('2026-05-01T10:00:00.000Z');

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

let db: TestDatabase;
let authorId = '';
let articleId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

beforeEach(async () => {
  await db.client.$executeRawUnsafe('DELETE FROM "ArticleTag"');
  await db.client.$executeRawUnsafe('DELETE FROM "Tag"');
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  const author = await createUser({
    email: 'author@titan.local',
    passwordHash: 'x',
    handle: 'author',
    name: 'The Author',
    createdAt: AT,
  });
  authorId = author.id;

  const article = await createArticle({
    authorId,
    title: 'A draft in progress',
    bodyJson: doc('the original document'),
    bodyHtml: '<p>the original document</p>',
    now: AT,
  });
  articleId = article.id;
});

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

describe('SPEC-007 — a stale version is refused, and refused without writing', () => {
  it('returns 409 carrying the server’s version', async () => {
    const before = await getArticleById(articleId);
    expect(before?.version).toBe(1);

    const result = await saveDraftContent(articleId, {
      title: 'A draft in progress',
      bodyJson: doc('an overwrite from a stale tab'),
      version: 0, // the client's last-known value, one behind
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    if (result.status === 409) {
      expect(result.serverVersion).toBe(1);
      expect(result.message).toBe(CONFLICT_MESSAGE);
    }
  });

  it('leaves bodyJson byte-identical after the rejection', async () => {
    const before = await getArticleById(articleId);
    const beforeJson = JSON.stringify(before?.bodyJson);

    await saveDraftContent(articleId, {
      title: 'Retitled by the stale tab',
      bodyJson: doc('an overwrite from a stale tab'),
      version: 0,
    });

    const after = await getArticleById(articleId);
    expect(JSON.stringify(after?.bodyJson)).toBe(beforeJson);
    expect(after?.bodyHtml).toBe(before?.bodyHtml);
    expect(after?.bodyText).toBe(before?.bodyText);
    // The title came in on the same call and must not have landed either. A
    // partial write is the failure mode a "write then check" implementation
    // produces, and it is invisible if the test only inspects `bodyJson`.
    expect(after?.title).toBe('A draft in progress');
  });

  it('does not move version or updatedAt on a rejected save', async () => {
    const before = await getArticleById(articleId);

    await saveDraftContent(articleId, {
      title: 'x',
      bodyJson: doc('nope'),
      version: 0,
    });

    const after = await getArticleById(articleId);
    expect(after?.version).toBe(before?.version);
    expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString());
  });

  it('refuses a version from the FUTURE as well as a stale one', async () => {
    // Not pedantry. A client that has somehow got ahead of the server — a
    // replayed response, a restored tab, a bug in the version plumbing — is
    // exactly as unsafe to trust as one that is behind, and `!==` says so.
    // A `<` comparison would let it through and overwrite silently.
    const result = await saveDraftContent(articleId, {
      title: 'x',
      bodyJson: doc('from the future'),
      version: 99,
    });

    expect(result.status).toBe(409);
    if (result.status === 409) expect(result.serverVersion).toBe(1);
    expect((await getArticleById(articleId))?.bodyText).toBe('the original document');
  });

  it.each([
    ['a non-integer', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s version rather than coercing it', async (_label, version) => {
    const result = await saveDraftContent(articleId, {
      title: 'x',
      bodyJson: doc('garbage version'),
      version: version as number,
    });

    expect(result.status).toBe(409);
    expect((await getArticleById(articleId))?.bodyText).toBe('the original document');
  });

  it('404s for an article that no longer exists, without throwing', async () => {
    const result = await saveDraftContent('a00000000000000000000000x', {
      title: 'x',
      bodyJson: doc('orphan'),
      version: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });
});

describe('SPEC-007 — the matching version is accepted', () => {
  it('saves, bumps the version by exactly one, and returns savedAt', async () => {
    // The control. Without it, "reject everything" would satisfy every
    // assertion above.
    const result = await saveDraftContent(
      articleId,
      { title: 'A draft in progress', bodyJson: doc('a real edit'), version: 1 },
      new Date('2026-05-01T10:05:00.000Z'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(2);
    expect(result.savedAt).toBe('2026-05-01T10:05:00.000Z');

    const after = await getArticleById(articleId);
    expect(after?.bodyText).toBe('a real edit');
    expect(after?.version).toBe(2);
  });

  it('lets the client resume with the version the 409 handed back', async () => {
    // The recovery loop the conflict banner drives, end to end: a stale save is
    // refused, the editor adopts `serverVersion`, and the retry lands. Without
    // this the 409 would be a dead end rather than a recoverable state.
    const conflict = await saveDraftContent(articleId, {
      title: 'A draft in progress',
      bodyJson: doc('stale'),
      version: 0,
    });
    expect(conflict.status).toBe(409);
    const resumeAt = conflict.status === 409 ? conflict.serverVersion : -1;

    const retry = await saveDraftContent(articleId, {
      title: 'A draft in progress',
      bodyJson: doc('resumed'),
      version: resumeAt,
    });

    expect(retry.ok).toBe(true);
    expect((await getArticleById(articleId))?.bodyText).toBe('resumed');
  });

  it('two saves in sequence need the version from the first', async () => {
    const first = await saveDraftContent(articleId, {
      title: 'A draft in progress',
      bodyJson: doc('one'),
      version: 1,
    });
    expect(first.ok).toBe(true);

    // Replaying the FIRST save's version — what a tab that missed the response
    // would do — must not overwrite the newer document.
    const replay = await saveDraftContent(articleId, {
      title: 'A draft in progress',
      bodyJson: doc('replayed'),
      version: 1,
    });
    expect(replay.status).toBe(409);
    expect((await getArticleById(articleId))?.bodyText).toBe('one');
  });

  it('stores the SANITISED document, not what the client posted', async () => {
    // The save path is where the security boundary actually is: a client can
    // skip the editor entirely and post a hand-written document straight to the
    // Server Action. `tests/unit/content-sanitize.test.ts` proves the sanitiser;
    // this proves the save path is wired through it.
    await saveDraftContent(articleId, {
      title: 'A draft in progress',
      version: 1,
      bodyJson: {
        type: 'doc',
        content: [
          { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'kept',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
    });

    const after = await getArticleById(articleId);
    const stored = JSON.stringify(after?.bodyJson);
    expect(stored).not.toContain('script');
    expect(stored).not.toContain('javascript:');
    expect(after?.bodyHtml).not.toMatch(/<script|on[a-z]+=|javascript:/i);
    expect(after?.bodyText).toBe('kept');
  });

  it('keeps the stored title when the author clears the field mid-edit', async () => {
    // `normalizeTitle` throws on empty (SPEC-004: "title, 1-120 chars"), and an
    // untitled DRAFT is not a state the schema can hold. Failing the save would
    // put "Save failed — retry" on screen for the ordinary act of
    // select-all-deleting a title before typing a new one, so the previous
    // title is retained instead. Publishing still refuses an empty title —
    // `validatePublish` sees the FORM's value, not the stored one.
    const result = await saveDraftContent(articleId, {
      title: '   ',
      bodyJson: doc('body kept moving'),
      version: 1,
    });

    expect(result.ok).toBe(true);
    const after = await getArticleById(articleId);
    expect(after?.title).toBe('A draft in progress');
    expect(after?.bodyText).toBe('body kept moving');
  });

  it('refuses more than five tags without writing a sixth', async () => {
    const result = await saveDraftContent(articleId, {
      title: 'A draft in progress',
      bodyJson: doc('tagged'),
      version: 1,
      tags: ['one', 'two', 'three', 'four', 'five', 'six'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.status === 400) expect(result.field).toBe('tags');
  });
});

describe('SPEC-007 — the first save of a document written at /editor/new', () => {
  it('mints the row and returns its id, so the editor can adopt the URL', async () => {
    const result = await createDraftContent(
      authorId,
      { title: 'A brand new piece', bodyJson: doc('first words'), tags: ['craft'] },
      AT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleId).toBeDefined();
    expect(result.version).toBe(1);

    const created = await getArticleById(result.articleId ?? '');
    expect(created?.authorId).toBe(authorId);
    expect(created?.status).toBe('DRAFT');
    expect(created?.bodyText).toBe('first words');
  });

  it('names an untouched draft rather than failing on the empty title', async () => {
    const result = await createDraftContent(authorId, { title: '', bodyJson: doc('x') }, AT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const created = await getArticleById(result.articleId ?? '');
    expect(created?.title).toBe('Untitled');
    // The placeholder cannot survive into a published URL: the slug is
    // recomputed from the title on every save while `publishedAt` is null.
    expect(created?.slug.startsWith('untitled-')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The derived columns, on the save path
// ---------------------------------------------------------------------------

describe('SPEC-007 — a save cannot leave the derived columns disagreeing', () => {
  it('writes bodyHtml, bodyText and readingMinutes from the same document', async () => {
    const body = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A section' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Some words '.repeat(60).trim() }],
        },
      ],
    };

    await saveDraftContent(articleId, { title: 'A draft in progress', bodyJson: body, version: 1 });

    const after = await getArticleById(articleId);
    const recomputed = deriveContent(after?.bodyJson);

    expect(after?.bodyHtml).toBe(recomputed.bodyHtml);
    expect(after?.bodyText).toBe(recomputed.bodyText);
    expect(after?.readingMinutes).toBe(recomputed.readingMinutes);
  });
});

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * A controllable clock and timer queue.
 *
 * Not `vi.useFakeTimers()`, deliberately: the scheduler takes its timers as a
 * parameter, and driving it through the injected seam tests the object the
 * component actually constructs rather than a global the module happens to
 * close over. It also makes the test independent of which timer API the
 * implementation reaches for.
 */
function fakeTimers() {
  let now = 0;
  let nextHandle = 1;
  const queue = new Map<number, { at: number; run: () => void }>();

  const timers: AutosaveTimers = {
    now: () => now,
    setTimeout: (handler, ms) => {
      const handle = nextHandle++;
      queue.set(handle, { at: now + ms, run: handler });
      return handle;
    },
    clearTimeout: (handle) => {
      queue.delete(handle);
    },
  };

  /** Advance the clock, firing every timer whose deadline is reached. */
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...queue.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [handle, timer] = due;
      queue.delete(handle);
      now = timer.at;
      timer.run();
      // Let the save's promise chain settle before the clock moves again.
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };

  return { timers, advance, pending: () => queue.size };
}

describe('SPEC-007 — the autosave state machine', () => {
  it('exposes exactly the four indicator strings the spec names', () => {
    // "Status indicator text is one of exactly: Saved, Saving…, Unsaved
    // changes, Save failed — retry." Asserted against literals so a retyped
    // ellipsis (`...` for `…`) or hyphen (`-` for `—`) is caught here rather
    // than by a browser test whose failure message is a diff of two strings
    // that look identical.
    expect(SAVE_STATUS.clean).toBe('Saved');
    expect(SAVE_STATUS.saving).toBe('Saving…');
    expect(SAVE_STATUS.dirty).toBe('Unsaved changes');
    expect(SAVE_STATUS.error).toBe('Save failed — retry');
    expect(SAVE_STATUS_TEXTS).toHaveLength(4);
    expect(statusText('clean')).toBe('Saved');
  });

  it('uses the timings the spec fixes', () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(2_000);
    expect(AUTOSAVE_MAX_INTERVAL_MS).toBe(30_000);
  });

  it('starts Clean and goes Dirty on the first keystroke', async () => {
    const { timers } = fakeTimers();
    const save = vi.fn(async () => true);
    const scheduler = createAutosaveScheduler({ save, timers });

    expect(scheduler.statusText).toBe('Saved');
    scheduler.change('a');
    expect(scheduler.state).toBe('dirty');
    expect(scheduler.statusText).toBe('Unsaved changes');
    expect(save).not.toHaveBeenCalled();
  });

  it('saves exactly once after 2s of idle, however many keystrokes preceded it', async () => {
    // The first sealed autosave criterion, at the unit level: "typing then
    // idling 2s issues EXACTLY ONE saveDraft call and the indicator reads
    // Saved." The e2e asserts it through the browser; this asserts it against
    // the state machine, where "exactly one" is a counter rather than a
    // network observation.
    const { timers, advance } = fakeTimers();
    const save = vi.fn(async () => true);
    const scheduler = createAutosaveScheduler({ save, timers });

    for (let i = 0; i < 10; i++) {
      scheduler.change(`keystroke ${i}`);
      await advance(100); // 100ms apart: well inside the debounce
    }
    expect(save).not.toHaveBeenCalled();

    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    // The LAST payload, not the first — a debounce that saved the keystroke
    // that armed it would store a document nine edits out of date.
    expect(save).toHaveBeenCalledWith('keystroke 9');
    expect(scheduler.statusText).toBe('Saved');
  });

  it('breaks the debounce at the 30s ceiling while typing continuously', async () => {
    // The second sealed criterion: "typing continuously for 35s issues at least
    // one save before the 30s ceiling elapses." A debounce that is merely
    // re-armed on every keystroke never fires here — the author types for an
    // hour and nothing is ever stored. The scheduler arms for
    // `min(debounce, timeUntilCeiling)` precisely to make the ceiling reachable.
    const { timers, advance } = fakeTimers();
    const save = vi.fn(async () => true);
    const scheduler = createAutosaveScheduler({ save, timers });

    for (let elapsed = 0; elapsed < 35_000; elapsed += 500) {
      scheduler.change(`t=${elapsed}`);
      await advance(500);
      if (elapsed < AUTOSAVE_MAX_INTERVAL_MS - 500) {
        expect(save.mock.calls.length).toBeLessThanOrEqual(1);
      }
    }

    expect(save.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(timers.now()).toBeGreaterThanOrEqual(AUTOSAVE_MAX_INTERVAL_MS);
  });

  it('measures the ceiling from the last SUCCESSFUL save', async () => {
    const { timers, advance } = fakeTimers();
    const save = vi.fn(async () => true);
    const scheduler = createAutosaveScheduler({ save, timers });

    scheduler.change('first');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);

    // Type continuously again. The ceiling restarted at the save above, so the
    // next forced save is ~30s after THAT, not 30s after the page loaded.
    for (let elapsed = 0; elapsed < 31_000; elapsed += 500) {
      scheduler.change(`again ${elapsed}`);
      await advance(500);
    }
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('saves immediately on flush — Cmd/Ctrl+S', async () => {
    const { timers, advance } = fakeTimers();
    const save = vi.fn(async () => true);
    const scheduler = createAutosaveScheduler({ save, timers });

    scheduler.change('typed');
    await scheduler.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(scheduler.statusText).toBe('Saved');

    // The armed debounce was cancelled, not merely pre-empted: without the
    // cancel the same payload would be written a second time 2s later.
    await advance(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flushing a clean document does nothing', async () => {
    const { timers } = fakeTimers();
    const save = vi.fn(async () => true);
    const scheduler = createAutosaveScheduler({ save, timers });

    await scheduler.flush();
    expect(save).not.toHaveBeenCalled();
    expect(scheduler.statusText).toBe('Saved');
  });

  it('reports a rejected save as Save failed — retry, and retries on flush', async () => {
    const { timers, advance } = fakeTimers();
    const save = vi
      .fn<(payload: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const scheduler = createAutosaveScheduler({ save, timers });

    scheduler.change('doomed');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(scheduler.statusText).toBe('Save failed — retry');

    scheduler.change('second attempt');
    await scheduler.flush();
    expect(scheduler.statusText).toBe('Saved');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown save the same as a rejected one', async () => {
    // A network failure arrives as a rejected promise, not a `false`. An
    // unhandled rejection here would leave the indicator stuck on `Saving…`
    // forever, which reads to the author as "still working" rather than "your
    // work is not saved" — the worst possible lie for this particular widget.
    const { timers, advance } = fakeTimers();
    const save = vi.fn(async () => {
      throw new Error('network down');
    });
    const scheduler = createAutosaveScheduler({ save, timers });

    scheduler.change('x');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(scheduler.statusText).toBe('Save failed — retry');
  });

  it('does not report Saved when a keystroke landed mid-save', async () => {
    // The indicator would otherwise be a lie the author can see: it reads
    // `Saved` while the word they just typed is not.
    const { timers, advance } = fakeTimers();
    // Typed through a holder rather than a bare `let`: TypeScript narrows a
    // `let` assigned only inside a callback to `null` at every later use, so
    // `release?.()` below becomes a call on `never`. The object defeats the
    // narrowing without an `any` or a non-null assertion.
    const gate: { release: (() => void) | null } = { release: null };
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          gate.release = () => resolve(true);
        }),
    );
    const scheduler = createAutosaveScheduler({ save, timers });

    scheduler.change('first');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(scheduler.statusText).toBe('Saving…');

    scheduler.change('typed while saving');
    gate.release?.();
    await advance(0);
    expect(scheduler.statusText).toBe('Unsaved changes');

    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('typed while saving');
  });

  it('never runs two saves concurrently', async () => {
    const { timers, advance } = fakeTimers();
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          releases.push(() => {
            inFlight -= 1;
            resolve(true);
          });
        }),
    );
    const scheduler = createAutosaveScheduler({ save, timers });

    scheduler.change('a');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    scheduler.change('b');
    await advance(AUTOSAVE_DEBOUNCE_MS);
    void scheduler.flush();
    await advance(0);

    expect(peak).toBe(1);
    for (const release of releases) release();
  });

  it('stops scheduling after dispose', async () => {
    // The unmount path. A timer that survives the component fires against a
    // dead editor and, worse, can post a stale document over a newer one after
    // the author has navigated away.
    const { timers, advance, pending } = fakeTimers();
    const save = vi.fn(async () => true);
    const scheduler = createAutosaveScheduler({ save, timers });

    scheduler.change('x');
    scheduler.dispose();
    expect(pending()).toBe(0);

    await advance(AUTOSAVE_MAX_INTERVAL_MS * 2);
    expect(save).not.toHaveBeenCalled();

    scheduler.change('y');
    await advance(AUTOSAVE_MAX_INTERVAL_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });

  it('announces every transition so the indicator can re-render', async () => {
    const { timers, advance } = fakeTimers();
    const states: string[] = [];
    const scheduler = createAutosaveScheduler({
      save: async () => true,
      timers,
      onStateChange: (state) => states.push(state),
    });

    scheduler.change('x');
    await advance(AUTOSAVE_DEBOUNCE_MS);

    expect(states).toEqual(['dirty', 'saving', 'clean']);
  });
});
