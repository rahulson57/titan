/**
 * The Following tab (SPEC-008).
 *
 * > The Following tab returns only articles authored by users the viewer
 * > follows, in strict `publishedAt DESC` order, and is empty for an anonymous
 * > viewer.
 *
 * > **Following** is a pure reverse-chronological list of articles by authors
 * > the viewer follows; no scoring.
 *
 * ── The three ways this goes wrong, and a case for each ───────────────────
 * 1. **Direction.** `Follow` is a directed edge and the relation is named from
 *    both ends — `User.following` and `User.followers` are two different sets
 *    of the same rows. Reading the wrong one produces a feed of articles by
 *    people who follow YOU, which looks entirely plausible in a fixture where
 *    the follow is mutual. So the fixture below is deliberately ASYMMETRIC:
 *    the viewer follows one author, a different author follows the viewer, and
 *    only the first one's work may appear.
 * 2. **Scoring leaking in.** The tab shares its cursor and its comparator with
 *    the ranked feed (`chronological` pins every score to zero). If a score
 *    ever survived into this path, a heavily-clapped old article would jump
 *    the queue — so the fixture gives the OLDEST article all the claps, and
 *    asserts it stays last.
 * 3. **The anonymous case.** `viewerId` of null must be an empty page, not
 *    "everything" — a relation filter on a null scalar is the kind of
 *    predicate that matches nothing in one ORM version and everything in the
 *    next.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import { follow, setClap } from '../../lib/db/social';
import { DEFAULT_FEED_TAB, FEED_TABS, getFollowingPage, parseFeedTab } from '../../lib/feed/queries';

const NOW = new Date('2026-05-01T00:00:00.000Z');
const HOUR = 3_600_000;

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function articleIdFor(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(25, '0')}`;
}

/** Articles by the author the viewer follows. Index 0 is the newest. */
const FOLLOWED_IDS = [0, 1, 2, 3].map((i) => articleIdFor('f', i));
/** Articles by an author who follows the viewer but is not followed BACK. */
const FOLLOWER_IDS = [0, 1].map((i) => articleIdFor('b', i));
/** Articles by someone with no relationship to the viewer at all. */
const STRANGER_IDS = [0, 1].map((i) => articleIdFor('s', i));

let db: TestDatabase;
let viewerId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  const viewer = await createUser({
    email: 'viewer@titan.test',
    passwordHash: 'x',
    handle: 'viewer',
    name: 'Viewer',
  });
  const followed = await createUser({
    email: 'followed@titan.test',
    passwordHash: 'x',
    handle: 'followed',
    name: 'Followed',
  });
  const follower = await createUser({
    email: 'follower@titan.test',
    passwordHash: 'x',
    handle: 'follower',
    name: 'Follower',
  });
  const stranger = await createUser({
    email: 'stranger@titan.test',
    passwordHash: 'x',
    handle: 'stranger',
    name: 'Stranger',
  });
  viewerId = viewer.id;

  // Asymmetric on purpose. See the module header, case 1.
  await follow(viewerId, followed.id, NOW);
  await follow(follower.id, viewerId, NOW);

  const write = async (id: string, author: string, hoursOld: number) => {
    await createArticle({
      id,
      authorId: author,
      title: `Story ${id.slice(0, 1)}${id.slice(-2)}`,
      subtitle: null,
      bodyJson: doc(`Body of ${id}.`),
      bodyHtml: '<p>body</p>',
      status: 'PUBLISHED',
      now: new Date(NOW.getTime() - hoursOld * HOUR),
    });
  };

  for (const [i, id] of FOLLOWED_IDS.entries()) await write(id, followed.id, i * 24);
  for (const [i, id] of FOLLOWER_IDS.entries()) await write(id, follower.id, i);
  for (const [i, id] of STRANGER_IDS.entries()) await write(id, stranger.id, i);

  // All the claps on the OLDEST followed article. Under the ranked formula
  // this would lift it to the top; under reverse-chronological it must not
  // move at all.
  const oldest = FOLLOWED_IDS[FOLLOWED_IDS.length - 1];
  if (oldest) await setClap(stranger.id, oldest, 50, NOW);
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

describe('SPEC-008 — which tab a URL selects', () => {
  it('names exactly the two tabs the spec does, For you first', () => {
    expect([...FEED_TABS]).toEqual(['for-you', 'following']);
    expect(DEFAULT_FEED_TAB).toBe('for-you');
  });

  it('reads the tab out of ?tab=', () => {
    expect(parseFeedTab('following')).toBe('following');
    expect(parseFeedTab('for-you')).toBe('for-you');
  });

  it('falls back to the default rather than erroring on anything else', () => {
    // A typo in a shared link should land the reader on the feed, not on a
    // 404 — and `?tab=__proto__` should not be interesting.
    for (const input of ['', 'Following', 'followin', '__proto__', 'toString', null, undefined]) {
      expect(parseFeedTab(input)).toBe(DEFAULT_FEED_TAB);
    }
  });
});

describe('SPEC-008 — the Following tab', () => {
  it('is empty for an anonymous viewer', async () => {
    expect(await getFollowingPage({ viewerId: null, now: NOW })).toEqual([]);
    expect(await getFollowingPage({ viewerId: undefined, now: NOW })).toEqual([]);
    expect(await getFollowingPage({ viewerId: '', now: NOW })).toEqual([]);
  });

  it('returns only articles by authors the viewer follows', async () => {
    const page = await getFollowingPage({ viewerId, now: NOW, limit: 100 });
    expect(page.map((item) => item.id).sort()).toEqual([...FOLLOWED_IDS].sort());
  });

  it('excludes articles by someone who follows the viewer but is not followed back', async () => {
    const page = await getFollowingPage({ viewerId, now: NOW, limit: 100 });
    const ids = page.map((item) => item.id);
    for (const id of FOLLOWER_IDS) expect(ids).not.toContain(id);
    for (const id of STRANGER_IDS) expect(ids).not.toContain(id);
  });

  it('is in strict publishedAt DESC order', async () => {
    const page = await getFollowingPage({ viewerId, now: NOW, limit: 100 });
    const instants = page.map((item) => item.publishedAt.getTime());
    expect(instants).toEqual([...instants].sort((a, b) => b - a));
    // And specifically the fixture's own order, so "sorted" cannot be
    // satisfied by a single-element or accidentally-ordered result.
    expect(page.map((item) => item.id)).toEqual(FOLLOWED_IDS);
  });

  it('does not score: the most-clapped article stays in its chronological place', async () => {
    const page = await getFollowingPage({ viewerId, now: NOW, limit: 100 });
    const clapped = page[page.length - 1];
    expect(clapped?.id).toBe(FOLLOWED_IDS[FOLLOWED_IDS.length - 1]);
    expect(clapped?.clapTotal).toBe(50);
    // Every row carries score 0 — `chronological` pins it, which is what makes
    // the shared cursor degenerate to `publishedAt DESC, id ASC`.
    for (const item of page) expect(item.score).toBe(0);
  });

  it('pages with the cursor without repeating or skipping a row', async () => {
    const first = await getFollowingPage({ viewerId, now: NOW, limit: 2 });
    expect(first).toHaveLength(2);

    const second = await getFollowingPage({
      viewerId,
      cursor: first[first.length - 1]?.cursor,
      limit: 2,
    });

    expect([...first, ...second].map((item) => item.id)).toEqual(FOLLOWED_IDS);
    expect(await getFollowingPage({ viewerId, cursor: second[1]?.cursor, limit: 2 })).toEqual([]);
  });

  it('ignores a malformed cursor rather than failing the request', async () => {
    const page = await getFollowingPage({ viewerId, now: NOW, cursor: 'not-a-cursor', limit: 100 });
    expect(page.map((item) => item.id)).toEqual(FOLLOWED_IDS);
  });
});
