#!/usr/bin/env node
/**
 * titan — demo accounts and demo state, built through the REAL product.
 *
 *   npm run setup && npm run dev          # then, against the running app:
 *   node scripts/demo-accounts.mjs
 *
 * ── What this is for ───────────────────────────────────────────────────────
 * The deterministic corpus (`prisma/seed.ts`) gives the app 50 users, 500
 * published articles and a social graph, all sharing SPEC-005's documented
 * password. What it does not give is a *narrated* demo: an author you can sign
 * in as who owns a handful of stories and one unfinished draft, and a reader
 * whose Following tab, bookmark shelf and clap counts are already warm — so
 * that every slice has something to show within one click of signing in.
 *
 * ── The one rule this script is built around ───────────────────────────────
 * EVERY piece of state below is produced by driving the real UI in a real
 * browser. Not one row is written through Prisma. That is deliberate and it is
 * the whole value of the script:
 *
 *   - Accounts are created by submitting `/signup`, so the password hash is
 *     whatever `hashPassword` actually produces and the session cookie is
 *     whatever `startSession` actually sets. A seeded row with a hand-made hash
 *     proves nothing about whether a person can sign in.
 *   - Articles are typed into `/editor/new`, saved by the autosave debounce and
 *     published with the publish button, so their slug, reading time, word
 *     count and FTS index entry are all derived by the code that will derive
 *     them for the human doing the demo.
 *   - Follows, claps and bookmarks are clicks on the article page and the
 *     profile page.
 *
 * So a green run here is a genuine end-to-end smoke test of sign-up, sign-in,
 * the editor, the autosave state machine, publishing, the ranked feed, the
 * Following tab, search, engagement and profiles. If any of those is broken,
 * this script fails rather than quietly writing rows that make it look fine.
 *
 * Verification is deliberately separated from creation: the last phase opens a
 * FRESH browser context (no cookies, nothing carried over) and signs each
 * account in through `/signin`, then checks the state it expects to find. That
 * is the claim the demo actually rests on — "these credentials work" — and it
 * is asserted against the running app, never against the database.
 *
 * ── Re-running ─────────────────────────────────────────────────────────────
 * Idempotent. Existing accounts are signed into rather than recreated;
 * articles are only written if the author is short of them; follows and
 * bookmarks check `aria-pressed` before clicking so a second run does not
 * un-follow and un-bookmark everything the first run did. Note that
 * `npm run setup` REBUILDS the corpus and therefore deletes these accounts, so
 * the order is always: setup first, this script second.
 *
 * ── Options ────────────────────────────────────────────────────────────────
 *   --base-url <url>   default http://localhost:3000
 *   --headed           watch it drive the browser
 *   --json             emit the summary as JSON on the last line
 *   --quiet            only errors and the final summary
 */

import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { baseUrl: 'http://localhost:3000', headed: false, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--headed') opts.headed = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--base-url') opts.baseUrl = argv[++i];
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.slice('--base-url='.length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!opts.baseUrl) throw new Error('--base-url needs a value');
  opts.baseUrl = opts.baseUrl.replace(/\/$/, '');
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));

const say = (...a) => {
  if (!OPTS.quiet) console.log(...a);
};
const step = (msg) => say(`\n▸ ${msg}`);
const ok = (msg) => say(`    ok    ${msg}`);
const info = (msg) => say(`    ·     ${msg}`);

// ---------------------------------------------------------------------------
// The demo identities
//
// Local demo only. These credentials are meant to be written down, pasted into
// a chat and typed by a person who has never seen this app — there is no
// production, no network exposure and nothing of value behind them.
// ---------------------------------------------------------------------------

/**
 * One password for both accounts, so the person driving the demo types it
 * once. 13 characters clears SPEC-005's 8-character floor and it is not in
 * `lib/auth/weak-passwords.ts` — both of which the sign-up form will enforce
 * for real, so a bad choice here fails loudly at account creation rather than
 * silently producing an account nobody can use.
 */
const DEMO_PASSWORD = 'titandemo2026';

const AUTHOR = {
  role: 'author',
  name: 'Dana Ellery',
  handle: 'demo_author',
  email: 'author@titan.demo',
  password: DEMO_PASSWORD,
};

const READER = {
  role: 'reader',
  name: 'Remy Okonkwo',
  handle: 'demo_reader',
  email: 'reader@titan.demo',
  password: DEMO_PASSWORD,
};

/** The seeded author the reader also follows, so Following is not a monoculture. */
const SEEDED_HANDLE = 'demo';

/**
 * The stories the demo author writes.
 *
 * Original text — SPEC-004's "no third-party text is copied into the repo"
 * applies to anything that ends up in the corpus, and this ends up in the
 * corpus. Tags are drawn from the seeded tag vocabulary so that clicking one
 * lands on a tag page that already has neighbours rather than a page of one.
 *
 * Bodies are comfortably over the 50-character publish floor and long enough
 * that the derived reading time is not "1 min" for every single one.
 */
const ARTICLES = [
  {
    title: 'The second draft is where the thinking happens',
    subtitle: 'A first draft is an argument with yourself. The second is the one you let people read.',
    tags: ['writing', 'craft'],
    paragraphs: [
      'A first draft exists to find out what you think. It is allowed to be long, repetitive and wrong, because none of that survives contact with the second pass. The mistake is treating the first draft as a rough version of the finished thing, when it is really a different document with a different job.',
      'The second draft is where you decide what the piece is about, and then delete everything that is about something else. It is slower than writing the first one and it feels less productive, which is exactly why it gets skipped.',
      'What you are looking for on the second pass is the paragraph you wrote to warm yourself up. It is usually the first one. Cut it and the piece starts on its actual sentence.',
    ],
  },
  {
    title: 'Reading time is a design decision, not a measurement',
    subtitle: 'Every number a product shows a reader is a promise about how the next few minutes will feel.',
    tags: ['design', 'reading'],
    paragraphs: [
      'A reading-time estimate looks like a fact and behaves like a promise. Nobody checks it with a stopwatch, but everybody uses it to decide whether to start, which makes it one of the highest-leverage numbers on the page and one of the least examined.',
      'Derive it once, in one place, from the text the reader will actually see. The failure mode is not an estimate that is slightly wrong; it is two estimates that disagree because the feed computed one and the article page computed another.',
      'The honest version of the number is a range, and the useful version is a single figure. Pick the useful one, define it precisely somewhere a future maintainer will find it, and never compute it twice.',
    ],
  },
  {
    title: 'Quiet software, and the cost of being interesting',
    subtitle: 'The interfaces that wear best are the ones that decline to perform.',
    tags: ['design', 'systems'],
    paragraphs: [
      'Software that wants to be noticed is expensive to live with. Every animation that draws the eye, every badge that insists on attention, every panel that slides in unasked is a small withdrawal from a budget the user never agreed to fund.',
      'Quiet software is not featureless software. It is software that has decided, deliberately, which of its capabilities deserve to interrupt you, and has answered that question with a much shorter list than the product team wanted.',
      'The test is what the interface does when nothing is happening. A quiet product looks finished at rest. A loud one looks like it is waiting for you to give it something to do.',
    ],
  },
];

/** The unfinished piece, left as a Draft so the demo can open it in the editor. */
const DRAFT = {
  title: 'Notes towards an argument about typographic rhythm',
  subtitle: 'Unfinished on purpose — this is the draft in the demo.',
  paragraphs: [
    'Vertical rhythm is usually taught as arithmetic: pick a baseline, make every margin a multiple of it, and the page will cohere. That is true and it is not the interesting part.',
    'The interesting part is what happens at the exceptions — the pull quote, the code block, the image that refuses to be a multiple of anything. TODO: find a better example than the one I keep reaching for.',
  ],
};

// ---------------------------------------------------------------------------
// Small waiting helpers
//
// Deliberately hand-rolled rather than borrowed from `@playwright/test`: this
// is a plain node script, not a test file, and importing the runner's `expect`
// into a script that will be run by hand ties a demo tool to the test harness.
// `next dev` compiles a route the first time it is asked for, so every timeout
// here is generous — a 30-second wait on a cold route is normal and is not a
// symptom of anything.
// ---------------------------------------------------------------------------

const NAV_TIMEOUT = 90_000;
const ACT_TIMEOUT = 45_000;

/**
 * `page.goto`, with the long first-compile timeout and — importantly —
 * `networkidle` rather than `domcontentloaded`.
 *
 * Nearly every control this script drives is a client component: the user
 * menu, the clap and bookmark toggles, the follow button, the whole editor.
 * `domcontentloaded` fires when the server HTML is parsed, which is BEFORE
 * React has attached a single handler — so a click in that window is swallowed
 * silently and the script waits 45 seconds for a state change that nothing
 * ever requested. Every e2e suite in this repo navigates with `networkidle`
 * for exactly this reason; it is not caution, it is the difference between
 * driving the app and driving its markup.
 */
async function go(page, path, options = {}) {
  return page.goto(`${OPTS.baseUrl}${path}`, {
    waitUntil: 'networkidle',
    timeout: NAV_TIMEOUT,
    ...options,
  });
}

const testId = (id) => `[data-testid="${id}"]`;

/** Wait for a testid to exist in the DOM. */
async function waitForTestId(page, id, timeout = ACT_TIMEOUT) {
  await page.waitForSelector(testId(id), { timeout, state: 'attached' });
}

/** How many elements carry this testid right now. */
async function countTestId(page, id) {
  return page.locator(testId(id)).count();
}

/**
 * Wait until autosave has landed.
 *
 * Keyed on `data-state="clean"` rather than on the rendered text. The four
 * labels in `lib/content/autosave.ts` contain a U+2026 ellipsis and an em
 * dash, they are a closed set the spec pins, and they are the kind of string a
 * copy edit changes — none of which is true of the state machine's own name
 * for the state. Matching the text would make this script fail on a wording
 * change that broke nothing.
 */
async function waitForSaved(page, timeout = ACT_TIMEOUT) {
  await page.waitForSelector('[data-testid="save-indicator"][data-state="clean"]', {
    timeout,
    state: 'attached',
  });
}

/**
 * Everything the editor is currently saying about itself.
 *
 * Read in ONE `evaluate` so the four values describe the same instant. The
 * autosave indicator and the publish guard's field errors are the two things
 * that can hold this script up, and a timeout that reports only "waitForX
 * exceeded" makes the two indistinguishable — which is the whole reason a
 * first run of this script was hard to diagnose.
 */
async function editorState(page) {
  return page.evaluate(() => {
    const text = (selector) =>
      document.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      url: location.pathname,
      save: text('[data-testid="save-indicator"]'),
      saveState:
        document.querySelector('[data-testid="save-indicator"]')?.getAttribute('data-state') ??
        null,
      status: text('[data-testid="article-status"]'),
      tags: Array.from(document.querySelectorAll('[data-testid="tag-list"] li')).map((n) =>
        n.textContent.trim(),
      ),
      alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((n) =>
        n.textContent.trim(),
      ),
    };
  });
}

/**
 * Run one editor step, and on failure say which step it was and what the
 * editor looked like when it gave up.
 */
async function editorStep(page, label, run) {
  try {
    return await run();
  } catch (error) {
    let snapshot = null;
    try {
      snapshot = await editorState(page);
    } catch {
      /* the page may be gone; the step label is still worth reporting */
    }
    return fail(
      `${label} — ${error.message.split('\n')[0]}` +
        (snapshot ? `\n    editor said: ${JSON.stringify(snapshot)}` : ''),
    );
  }
}

/** Wait until the editor's status chip reads a given word ("Draft"/"Published"). */
async function waitForStatus(page, expected, timeout = ACT_TIMEOUT) {
  await page.waitForFunction(
    (want) =>
      document.querySelector('[data-testid="article-status"]')?.textContent?.trim() === want,
    expected,
    { timeout, polling: 250 },
  );
}

function fail(message) {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Confirm something is actually serving titan at the base URL.
 *
 * Checked by the wordmark rather than by a 200, because "something answered on
 * port 3000" and "titan is running on port 3000" are different claims and a
 * stale server from another checkout satisfies only the first.
 */
async function preflight(page) {
  step(`Checking ${OPTS.baseUrl} is serving titan`);
  let response;
  try {
    response = await go(page, '/');
  } catch (error) {
    fail(
      `could not reach ${OPTS.baseUrl} — start the app first with \`npm run dev\`.\n` +
        `  (${error.message.split('\n')[0]})`,
    );
  }
  if (!response || !response.ok()) {
    fail(`${OPTS.baseUrl}/ answered ${response ? response.status() : 'nothing'}, expected 200.`);
  }
  await waitForTestId(page, 'top-nav');
  await waitForTestId(page, 'home-feed');
  ok(`titan is up (home feed rendered, HTTP ${response.status()})`);
}

// ---------------------------------------------------------------------------
// Accounts — created through /signup, never through Prisma
// ---------------------------------------------------------------------------

/** True when the top nav shows a signed-in user menu. */
async function isSignedIn(page) {
  return (await countTestId(page, 'user-menu-trigger')) > 0;
}

/**
 * Sign in through the real `/signin` form.
 *
 * Waits on the OUTCOME rather than on a URL: a failed sign-in comes back to
 * `/signin?error=...` with `data-auth-error`, so racing "did the URL change"
 * against a timeout would report every wrong password as an infrastructure
 * hang. Waiting for either the user menu or the error element means a bad
 * credential is reported as a bad credential, in the app's own words.
 */
async function signIn(page, account) {
  await go(page, '/signin');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForSelector('[data-testid="user-menu-trigger"], [data-auth-error]', {
    timeout: NAV_TIMEOUT,
    state: 'attached',
  });

  if (!(await isSignedIn(page))) {
    const message = (await page.locator('[data-auth-error]').first().textContent())?.trim();
    fail(`/signin refused ${account.email}: ${message || 'no message rendered'}`);
  }
}

/** Sign out through the user menu, so the next account starts clean. */
async function signOut(page) {
  await go(page, '/');
  if (!(await isSignedIn(page))) return;
  // `aria-expanded` is the menu's own account of whether it opened, so a click
  // that was swallowed is visible as such and simply gets made again, rather
  // than becoming a 45-second wait for a menu nobody opened.
  const trigger = page.locator(testId('user-menu-trigger'));
  const deadline = Date.now() + ACT_TIMEOUT;
  while ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    if (Date.now() > deadline) fail('the user menu never opened');
    await trigger.click();
    await page.waitForTimeout(400);
  }

  await page.waitForSelector(testId('user-menu-signout'), { timeout: ACT_TIMEOUT });
  await page.locator(testId('user-menu-signout')).click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="user-menu-trigger"]'),
    undefined,
    { timeout: ACT_TIMEOUT, polling: 250 },
  );
}

/**
 * Create the account through `/signup`, or sign in if it already exists.
 *
 * The "already exists" branch is recognised by the form's own field error
 * (`data-field-error="email"`), which is the signal a person would see. Asking
 * the database whether the row is there would be both out of this script's
 * self-imposed boundary and a worse test: the row existing does not mean the
 * password matches.
 */
async function ensureAccount(page, account) {
  step(`Account: ${account.email} (${account.role})`);

  await go(page, '/signup');
  await page.fill('#name', account.name);
  await page.fill('#handle', account.handle);
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.getByRole('button', { name: /create account/i }).click();

  // Either the action redirects to `/` with a session, or it re-renders the
  // form with field errors in place. Wait for whichever happens.
  //
  // `waitForSelector`, not `waitForFunction`: sign-up SUCCEEDS by navigating,
  // and a polled in-page function is evaluated in a context that navigation
  // destroys — the success path would intermittently throw "Execution context
  // was destroyed" and be reported as a failure to create the account.
  await page.waitForSelector('[data-testid="user-menu-trigger"], [data-field-error]', {
    timeout: NAV_TIMEOUT,
    state: 'attached',
  });

  if (await isSignedIn(page)) {
    ok(`created via /signup and signed in — /@${account.handle}`);
    return { created: true };
  }

  const errors = await page.locator('[data-field-error]').allTextContents();
  const alreadyExists = errors.some((text) => /already exists/i.test(text));
  if (!alreadyExists) {
    fail(`/signup refused ${account.email}: ${errors.join(' | ') || 'no error text rendered'}`);
  }

  info('already exists — signing in with the documented password instead');
  await signIn(page, account);
  ok(`signed in via /signin — /@${account.handle}`);
  return { created: false };
}

// ---------------------------------------------------------------------------
// The author's stories — typed into the editor and published from it
// ---------------------------------------------------------------------------

/**
 * Wait until the editor is HYDRATED, not merely rendered.
 *
 * This distinction cost a full debugging cycle and is the single most
 * important line in this file. `editor-surface` is in the server HTML, so it
 * is present before React has attached a single listener. Filling the title
 * in that window sets the DOM value, React hydrates a moment later, re-renders
 * the controlled input from its own (empty) state, and the title is silently
 * gone — after which autosave writes "Untitled" and the publish guard refuses
 * with "Give the article a title before publishing", which reads like a bug in
 * publishing and is nothing of the kind.
 *
 * `editor-body` is the honest signal: the attribute is applied by TipTap to
 * the ProseMirror node, which only exists once the client editor has mounted.
 * (The e2e suites get the same protection from `waitUntil: 'networkidle'` on
 * every editor navigation, which is why they never saw this.)
 */
async function waitForEditorReady(page) {
  await waitForTestId(page, 'editor-surface');
  await waitForTestId(page, 'editor-body', NAV_TIMEOUT);
}

/**
 * Fill a controlled input and prove the value survived the next render.
 *
 * Belt to `waitForEditorReady`'s braces: hydration is the known cause, but any
 * re-render that resets a controlled input produces the same silent data loss,
 * and a demo script that quietly published three untitled articles would be
 * worse than one that failed.
 */
async function fillAndConfirm(page, id, value) {
  const input = page.locator(testId(id));
  const deadline = Date.now() + ACT_TIMEOUT;
  for (;;) {
    await input.fill(value);
    await page.waitForTimeout(200);
    if ((await input.inputValue()) === value) return;
    if (Date.now() > deadline) {
      fail(`${id} would not hold its value — the editor re-rendered it away`);
    }
  }
}

/** Type paragraphs into the ProseMirror surface, one block each. */
async function typeBody(page, paragraphs) {
  const body = page.locator(testId('editor-body'));
  await body.click();
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (i > 0) await page.keyboard.press('Enter');
    // `insertText` rather than per-key typing: the demo does not need to prove
    // anything about keystroke handling, and a 1 200-character article typed at
    // a realistic delay would make this script take minutes per story.
    await page.keyboard.insertText(paragraphs[i]);
  }
}

async function addTags(page, tags) {
  const input = page.getByLabel('Tags', { exact: true });
  for (const tag of tags) {
    await input.fill(tag);
    await input.press('Enter');
  }
}

/**
 * Write one story at `/editor/new`, then publish it if asked.
 *
 * Returns the published slug (or null for a draft). The waits in here are the
 * real state machine, not sleeps: the URL adopting an id IS the first autosave
 * landing (SPEC-007), and the status chip flipping to "Published" IS the
 * publish transition committing.
 */
async function writeStory(page, story, { publish }) {
  await go(page, '/editor/new', { waitUntil: 'networkidle' });
  await waitForEditorReady(page);

  await fillAndConfirm(page, 'article-title', story.title);
  if (story.subtitle) await fillAndConfirm(page, 'article-subtitle', story.subtitle);
  await typeBody(page, story.paragraphs);

  // The first save creates the row and rewrites the URL to its id, without a
  // navigation. Waiting on the URL is what proves autosave actually reached the
  // server — the indicator alone can read "Saved" from a previous state.
  await editorStep(page, `“${story.title}”: first autosave never created the row`, () =>
    page.waitForURL(/\/editor\/[a-z0-9]{26}$/, { timeout: NAV_TIMEOUT }),
  );
  await editorStep(page, `“${story.title}”: the body never reached a saved state`, () =>
    waitForSaved(page),
  );

  if (!publish) {
    await editorStep(page, `“${story.title}”: expected it to still be a Draft`, () =>
      waitForStatus(page, 'Draft'),
    );
    ok(`left “${story.title}” as a Draft`);
    return null;
  }

  await addTags(page, story.tags);
  await editorStep(page, `“${story.title}”: the tags never saved`, () => waitForSaved(page));

  await page.locator(testId('publish-button')).click();
  // A refused publish is a FIELD ERROR on a page that stays a Draft, not an
  // exception — so a bare timeout here would report "the app hung" when what
  // actually happened is that the publish guard said no. The snapshot carries
  // the alert text out.
  await editorStep(page, `“${story.title}”: publish did not take`, () =>
    waitForStatus(page, 'Published'),
  );

  const href = await page.locator(testId('view-published')).first().getAttribute('href');
  const slug = href ? href.replace(/^\/article\//, '') : null;
  ok(`published “${story.title}” → /article/${slug}`);
  return slug;
}

/** How many rows the author's own profile shows on a given tab. */
async function profileRowCount(page, handle, tab) {
  await go(page, `/@${handle}${tab === 'published' ? '' : `?tab=${tab}`}`);
  await waitForTestId(page, 'profile-page');
  return page.locator(`${testId('profile-feed')} ${testId('article-card')}`).count();
}

async function ensureAuthorContent(page) {
  step(`Stories for /@${AUTHOR.handle}`);

  const published = await profileRowCount(page, AUTHOR.handle, 'published');
  const slugs = [];
  if (published >= ARTICLES.length) {
    info(`already has ${published} published stories — writing none`);
  } else {
    for (const story of ARTICLES.slice(published)) {
      slugs.push(await writeStory(page, story, { publish: true }));
    }
  }

  const drafts = await profileRowCount(page, AUTHOR.handle, 'drafts');
  if (drafts > 0) {
    info(`already has ${drafts} draft — writing none`);
  } else {
    await writeStory(page, DRAFT, { publish: false });
  }

  const finalPublished = await profileRowCount(page, AUTHOR.handle, 'published');
  const finalDrafts = await profileRowCount(page, AUTHOR.handle, 'drafts');
  ok(`/@${AUTHOR.handle}: ${finalPublished} published, ${finalDrafts} draft(s)`);
  return { published: finalPublished, drafts: finalDrafts, slugs: slugs.filter(Boolean) };
}

// ---------------------------------------------------------------------------
// The reader's world — follows, claps and bookmarks, all by clicking
// ---------------------------------------------------------------------------

/**
 * Click a two-state toggle only if it is not already on, and wait for the
 * control itself to report the new state.
 *
 * Reading `aria-pressed` is not a convenience — it is the same signal a screen
 * reader gets, and it is what makes this idempotent. A second run that clicked
 * unconditionally would un-follow and un-bookmark everything the first run set
 * up, and would look successful doing it.
 *
 * The optimistic layer (SPEC-009) flips the attribute before the server
 * answers and React drops that layer if the write fails, so polling until it
 * SETTLES on 'true' is a real check rather than a redundant one.
 */
async function ensurePressed(locator, what) {
  if ((await locator.count()) === 0) fail(`no ${what} control on the page`);
  const target = locator.first();

  if ((await target.getAttribute('aria-pressed')) === 'true') {
    info(`${what} already on — leaving it`);
    return false;
  }

  const deadline = Date.now() + ACT_TIMEOUT;
  let lastClick = 0;
  while (Date.now() < deadline) {
    // Re-click every 5s rather than waiting out the whole budget on one
    // attempt: the failure this guards against is a click that never reached
    // React, and no amount of further waiting fixes that. The toggle is
    // idempotent in the direction we want (it only ever turns ON here,
    // because we return early when it is already on), so a duplicate click
    // that DID land settles on the same state.
    if (Date.now() - lastClick > 5_000) {
      lastClick = Date.now();
      await target.click();
    }
    await target.page().waitForTimeout(250);
    if ((await target.getAttribute('aria-pressed')) === 'true') {
      ok(`${what} on`);
      return true;
    }
  }
  return fail(`${what} was clicked but never settled on aria-pressed="true"`);
}

/** Follow an author from their profile page. */
async function followFromProfile(page, handle) {
  await go(page, `/@${handle}`);
  await waitForTestId(page, 'profile-page');
  const button = page.locator(testId('follow-button'));
  if ((await button.count()) === 0) {
    // The button is absent on your own profile by design. Anywhere else it is
    // a real problem, so say which case this is rather than passing silently.
    fail(`no follow control on /@${handle} — is the reader signed in as someone else?`);
  }
  await ensurePressed(button, `follow @${handle}`);
}

/** The slug of the first story listed on a profile, or null if it lists none. */
async function firstArticleSlugOn(page, handle) {
  await go(page, `/@${handle}`);
  await waitForTestId(page, 'profile-page');
  const link = page.locator(`${testId('profile-feed')} a[href^="/article/"]`).first();
  if ((await link.count()) === 0) return null;
  return (await link.getAttribute('href')).replace(/^\/article\//, '');
}

/**
 * A story from the seeded corpus for the reader to engage with.
 *
 * Prefers one by the seeded `demo` author so the reader's claps and the reader's
 * follows point at the same person, but falls back to the top of the ranked
 * feed. The seed distributes 500 articles over 50 users by a PRNG draw, and
 * nothing guarantees any particular user got one — a demo that fell over
 * because @demo happened to draw zero articles would be a confusing way to
 * discover that.
 */
async function seededStorySlug(page, exclude) {
  const fromProfile = await firstArticleSlugOn(page, SEEDED_HANDLE);
  if (fromProfile && !exclude.includes(fromProfile)) return fromProfile;

  info(`/@${SEEDED_HANDLE} had nothing usable — taking a story off the ranked feed instead`);
  await go(page, '/');
  await waitForTestId(page, 'home-feed');
  const hrefs = await page.locator(`${testId('home-feed')} a[href^="/article/"]`).evaluateAll(
    (nodes) => nodes.map((n) => n.getAttribute('href')),
  );
  const slug = hrefs
    .map((href) => href.replace(/^\/article\//, ''))
    .find((candidate) => !exclude.includes(candidate));
  if (!slug) fail('the home feed offered no story the demo author does not already own');
  return slug;
}

/**
 * Clap for an article and bookmark it, from the article page.
 *
 * Two things here are more careful than they first look.
 *
 * IDEMPOTENCE. `data-mine` is the reader's OWN clap count, which is what makes
 * a second run a no-op instead of another five claps. `data-testid` alone
 * could not do that — the visible total is everyone's claps, so it cannot
 * distinguish "I already clapped" from "someone else did".
 *
 * WHAT GETS REPORTED. The number is read from a RELOADED page, not from the
 * live one. SPEC-009's optimistic layer moves the count before the server has
 * answered and React drops that layer when the last transition settles, so a
 * total read straight after a burst can be a number that never existed in the
 * database — a first version of this script cheerfully reported 8 claps for 5
 * taps that had correctly stored 5. Re-reading after a navigation reports the
 * server's number and, in doing so, proves the write actually persisted.
 */
async function clapAndBookmark(page, slug, targetClaps) {
  await go(page, `/article/${slug}`);
  await waitForTestId(page, 'article-page');

  const engagement = page.locator(testId('article-engagement'));
  const clapButton = engagement.locator(testId('clap-button'));
  const mine = async () => Number(await clapButton.first().getAttribute('data-mine')) || 0;

  const before = await mine();
  if (before >= targetClaps) {
    info(`already gave /article/${slug} ${before} claps — clapping no further`);
  } else {
    for (let i = before; i < targetClaps; i += 1) {
      await clapButton.first().click();
      await page.waitForTimeout(150);
    }
  }

  await ensurePressed(engagement.locator(testId('bookmark-button')), `bookmark /article/${slug}`);

  // Reload and read the settled, server-rendered truth.
  await go(page, `/article/${slug}`);
  await waitForTestId(page, 'article-page');
  const stored = await mine();
  const total = Number(
    (await engagement.locator(testId('clap-total')).first().textContent())?.replace(/\D/g, '') ??
      '0',
  );
  if (stored < targetClaps) {
    fail(
      `clapping /article/${slug} did not persist — the server reports ${stored} of my claps, wanted ${targetClaps}`,
    );
  }
  ok(`/article/${slug}: ${stored} claps from this reader, ${total} in total, bookmarked`);
  return { slug, mine: stored, total };
}

async function ensureReaderState(page, authorSlugs) {
  step(`Reading life for /@${READER.handle}`);

  await followFromProfile(page, AUTHOR.handle);
  await followFromProfile(page, SEEDED_HANDLE);

  const authorSlug = authorSlugs[0] ?? (await firstArticleSlugOn(page, AUTHOR.handle));
  if (!authorSlug) fail(`/@${AUTHOR.handle} published nothing for the reader to engage with`);
  const seededSlug = await seededStorySlug(page, [authorSlug, ...authorSlugs]);

  const engaged = [];
  engaged.push(await clapAndBookmark(page, authorSlug, 5));
  engaged.push(await clapAndBookmark(page, seededSlug, 3));

  await go(page, '/bookmarks');
  await waitForTestId(page, 'bookmarks-page');
  const bookmarks = await page.locator(testId('bookmark-row')).count();
  ok(`/bookmarks holds ${bookmarks} saved stor${bookmarks === 1 ? 'y' : 'ies'}`);

  return { follows: [AUTHOR.handle, SEEDED_HANDLE], bookmarks, engaged };
}

// ---------------------------------------------------------------------------
// Verification — a cold browser context, the real /signin, and the real pages
// ---------------------------------------------------------------------------

/**
 * Sign in from a context that has never held a cookie, then check the state
 * the walkthrough is going to rely on.
 *
 * This is the phase that earns the credentials line in the report. Everything
 * above could be true of a broken app that happened to accept one long-lived
 * session; this proves the password stored by sign-up verifies on a fresh
 * sign-in, which is what the person driving the demo will actually do.
 */
async function verifyAccount(browser, account, checks) {
  step(`Verifying ${account.email} through the real /signin`);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, account);

    const cookie = (await context.cookies()).find((c) => c.name === 'titan.session');
    if (!cookie) fail('sign-in set no titan.session cookie');
    if (!cookie.httpOnly) fail('the titan.session cookie is not httpOnly');
    ok(`signed in; titan.session cookie set (httpOnly=${cookie.httpOnly})`);

    const results = {};
    for (const [label, check] of Object.entries(checks)) {
      results[label] = await check(page);
      ok(`${label}: ${results[label]}`);
    }
    return results;
  } finally {
    await context.close();
  }
}

/** Rows on the Following tab of the home feed. */
async function followingCount(page) {
  await go(page, '/?tab=following');
  await waitForTestId(page, 'home-feed');
  return page.locator(`${testId('home-feed')} ${testId('feed-item')}`).count();
}

/** Search hits for a phrase from one of the demo author's stories. */
async function searchHits(page, query) {
  await go(page, `/search?q=${encodeURIComponent(query)}`);
  await waitForTestId(page, 'search-page');
  return page.locator(testId('feed-item')).count();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(summary) {
  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log('titan — demo is ready');
  console.log(line);
  console.log(`URL          ${summary.baseUrl}`);
  console.log('');
  console.log('AUTHOR       email    ' + AUTHOR.email);
  console.log('             password ' + AUTHOR.password);
  console.log(`             profile  ${summary.baseUrl}/@${AUTHOR.handle}`);
  console.log(
    `             owns     ${summary.author.published} published, ${summary.author.drafts} draft`,
  );
  console.log('');
  console.log('READER       email    ' + READER.email);
  console.log('             password ' + READER.password);
  console.log(`             profile  ${summary.baseUrl}/@${READER.handle}`);
  console.log(
    `             has      follows @${AUTHOR.handle} + @${SEEDED_HANDLE}, ` +
      `${summary.reader.bookmarks} bookmarks, claps on ${summary.reader.engaged.length} stories`,
  );
  console.log('');
  console.log('VERIFIED     both accounts signed in from a cold browser context via /signin');
  console.log(`             reader Following tab: ${summary.verified.reader['Following tab rows']} rows`);
  console.log(`             search “${summary.searchQuery}”: ${summary.verified.reader['search hits']} hits`);
  console.log(line);
  if (OPTS.json) console.log(JSON.stringify(summary));
}

// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: !OPTS.headed });
  const summary = { baseUrl: OPTS.baseUrl, searchQuery: 'quiet software' };

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await preflight(page);

    await ensureAccount(page, AUTHOR);
    summary.author = await ensureAuthorContent(page);
    await signOut(page);

    await ensureAccount(page, READER);
    summary.reader = await ensureReaderState(page, summary.author.slugs);
    await signOut(page);

    await context.close();

    summary.verified = {};
    summary.verified.author = await verifyAccount(browser, AUTHOR, {
      'published stories on own profile': (p) =>
        profileRowCount(p, AUTHOR.handle, 'published'),
      'drafts visible to the owner': (p) => profileRowCount(p, AUTHOR.handle, 'drafts'),
    });
    summary.verified.reader = await verifyAccount(browser, READER, {
      'Following tab rows': (p) => followingCount(p),
      'bookmarks': async (p) => {
        await go(p, '/bookmarks');
        await waitForTestId(p, 'bookmarks-page');
        return p.locator(testId('bookmark-row')).count();
      },
      'search hits': (p) => searchHits(p, summary.searchQuery),
    });

    report(summary);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\ndemo setup failed: ${error.message}`);
  process.exitCode = 1;
});
