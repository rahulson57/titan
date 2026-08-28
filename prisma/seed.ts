/**
 * The deterministic seed corpus (SPEC-004 / SPEC-002).
 *
 * > 50 users, 500 published articles + 40 drafts, 30 tags, 2 000 claps,
 * > 400 follows, 300 bookmarks — PRNG seed `titan-2026`, base timestamp
 * > `2026-01-01T00:00:00Z`.
 *
 * DETERMINISM IS THE POINT, and it is a stronger property than "reproducible
 * enough". Every performance budget in SPEC-002 is stated against this corpus,
 * so if two seed runs differ, a p95 regression and a corpus change are
 * indistinguishable and the budget stops carrying information. Three rules keep
 * that true, and all three are load-bearing:
 *
 *  1. **No wall clock.** Every timestamp is derived from `BASE_TIMESTAMP` by
 *     arithmetic. Neither a `Date` "now" read nor an argument-less `Date`
 *     construction appears anywhere in this file — those two spellings are
 *     what `tests/unit/seed-determinism.test.ts` greps this source for, and a
 *     single stray one would otherwise show up only as a flake weeks later.
 *     (Stated without writing either literally, so this comment does not fail
 *     the very check it is describing.)
 *  2. **No ambient randomness.** Ids, titles, bodies and every edge in the
 *     social graph come from one `createSeededRandom('titan-2026')` stream,
 *     drawn in a fixed order. `Math.random()` is never called.
 *  3. **No third-party text.** Article bodies are generated from the word pool
 *     below (SPEC-004: "no third-party text is copied into the repo"), so the
 *     corpus carries no copyright and no trademark.
 *
 * Re-running is safe: the corpus is deleted and rebuilt, so `npm run setup`
 * twice leaves the same database rather than 1 080 articles.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getDb, disconnectDb } from '../lib/db/client';
import { createSeededRandom, createIdFrom, type Random } from '../lib/db/ids';
import { buildSlug, ARTICLE_STATUS } from '../lib/db/articles';
import { deriveReading, type ProseMirrorNode } from '../lib/derive/reading';
import { serializeSocials } from '../lib/db/users';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// The constants the determinism gate pins
// ---------------------------------------------------------------------------

/** SPEC-002: the fixed PRNG seed. */
const PRNG_SEED = 'titan-2026';

/** SPEC-002: the fixed base timestamp every derived date counts from. */
const BASE_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_TIMESTAMP);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** SPEC-004's corpus sizes. Every one of these is asserted by seed-counts.test.ts. */
const COUNTS = {
  users: 50,
  publishedArticles: 500,
  draftArticles: 40,
  tags: 30,
  claps: 2_000,
  follows: 400,
  bookmarks: 300,
} as const;

/** SPEC-005: the documented demo account, and the password all 50 users share. */
const DEMO_EMAIL = 'demo@titan.local';
const DEMO_HANDLE = 'demo';
const DEMO_PASSWORD = 'titan1234';

/**
 * Stand-in for the password hash until Identity & Auth (TASK-004, SPEC-005)
 * lands `lib/auth/password.ts`.
 *
 * argon2id hashing is SPEC-005's to own — `@node-rs/argon2` is its dependency,
 * declared in a `package.json` this slice does not own and cannot edit. Rather
 * than invent a hash that would not verify, the seed PROBES for the real hasher
 * and uses it the moment it exists (see `resolvePasswordHash`). Until then it
 * writes this value, which is deliberately not a valid argon2id encoding: a
 * string that merely looked like one would let a broken auth path pass review.
 */
const PLACEHOLDER_PASSWORD_HASH =
  'awaiting-TASK-004:lib/auth/password.ts-does-not-exist-yet';

// ---------------------------------------------------------------------------
// Generated content — ours, not borrowed
// ---------------------------------------------------------------------------

const WORDS = [
  'design', 'systems', 'system', 'interface', 'reading', 'typography', 'measure',
  'rhythm', 'contrast', 'craft', 'editor', 'draft', 'publish', 'archive', 'signal',
  'noise', 'attention', 'surface', 'boundary', 'constraint', 'tradeoff', 'budget',
  'latency', 'throughput', 'cache', 'index', 'query', 'schema', 'migration', 'seed',
  'corpus', 'gradient', 'palette', 'baseline', 'column', 'spacing', 'weight',
  'serif', 'legible', 'quiet', 'dense', 'sparse', 'durable', 'brittle', 'honest',
  'ambiguous', 'explicit', 'implicit', 'canonical', 'derived', 'cached', 'stale',
  'fresh', 'ordering', 'sequence', 'threshold', 'ceiling', 'floor', 'invariant',
  'property', 'assertion', 'evidence', 'anecdote', 'estimate', 'measurement',
  'writing', 'revision', 'sentence', 'paragraph', 'structure', 'argument', 'claim',
  'reader', 'author', 'audience', 'voice', 'tone', 'clarity', 'brevity', 'detail',
  'context', 'history', 'practice', 'discipline', 'habit', 'ritual', 'friction',
  'affordance', 'gesture', 'motion', 'stillness', 'balance', 'tension', 'release',
  'attention', 'memory', 'recall', 'pattern', 'exception', 'edge', 'boundary',
  'default', 'override', 'fallback', 'guard', 'ledger', 'record', 'trace', 'log',
  'window', 'session', 'state', 'transition', 'lifecycle', 'origin', 'destination',
];

const TITLE_OPENERS = [
  'Notes on', 'The case for', 'Against', 'Rebuilding', 'Reading', 'Measuring',
  'The quiet cost of', 'What I learned about', 'A short history of', 'Unlearning',
  'On the shape of', 'Everything wrong with', 'In defence of', 'Rethinking',
  'The limits of',
];

const TITLE_SUBJECTS = [
  'design systems', 'reading systems', 'typographic rhythm', 'slow interfaces',
  'the editing surface', 'deterministic builds', 'legible defaults', 'quiet software',
  'the long paragraph', 'measurement culture', 'the second draft', 'index design',
  'schema migrations', 'attention budgets', 'the reading column', 'honest estimates',
  'small corpora', 'stale caches', 'text as an interface', 'the publish button',
];

const TAG_NAMES = [
  'design', 'systems', 'typography', 'writing', 'engineering', 'product', 'craft',
  'process', 'tools', 'interfaces', 'performance', 'databases', 'testing',
  'accessibility', 'reading', 'editing', 'publishing', 'architecture', 'culture',
  'career', 'learning', 'research', 'measurement', 'simplicity', 'constraints',
  'decisions', 'documentation', 'collaboration', 'maintenance', 'reliability',
];

const FIRST_NAMES = [
  'Ada', 'Bram', 'Cora', 'Dara', 'Eli', 'Fern', 'Gil', 'Hana', 'Ines', 'Jonas',
  'Kira', 'Luca', 'Mira', 'Noor', 'Otis', 'Pia', 'Quinn', 'Rune', 'Sana', 'Tobias',
  'Uma', 'Vera', 'Wren', 'Xavi', 'Yara', 'Zeno',
];

const LAST_NAMES = [
  'Alderman', 'Broom', 'Castellan', 'Dunmore', 'Ellery', 'Fairweather', 'Gale',
  'Hollins', 'Ivory', 'Jessop', 'Kestrel', 'Larkin', 'Mowbray', 'Northcote',
  'Oakes', 'Pemberton', 'Quill', 'Ravensworth', 'Selby', 'Thorne', 'Underhill',
  'Vane', 'Winterbourne', 'Yarrow',
];

/** Draw an element from a list. The only way this file consumes randomness. */
function pick<T>(random: Random, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] ?? (list[0] as T);
}

/** An integer in [min, max]. */
function pickInt(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function sentence(random: Random, words: number): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(pick(random, WORDS));
  const text = parts.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(random: Random, targetWords: number): string {
  const sentences: string[] = [];
  let used = 0;
  while (used < targetWords) {
    const length = Math.min(pickInt(random, 8, 22), targetWords - used);
    if (length <= 0) break;
    sentences.push(sentence(random, length));
    used += length;
  }
  return sentences.join(' ');
}

/**
 * A ProseMirror document of roughly `targetWords` words.
 *
 * Node types are limited to heading / paragraph / blockquote — the ones the
 * closed schema in SPEC-007 will certainly contain. The seed does not invent
 * node types the editor might later refuse to load.
 */
function buildDoc(random: Random, targetWords: number): ProseMirrorNode {
  const content: ProseMirrorNode[] = [];
  let remaining = targetWords;

  while (remaining > 0) {
    const roll = random();
    if (roll < 0.12 && remaining > 60) {
      const words = pickInt(random, 3, 6);
      content.push({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: sentence(random, words).replace(/\.$/, '') }],
      });
      remaining -= words;
    } else if (roll < 0.2 && remaining > 60) {
      const words = Math.min(pickInt(random, 20, 40), remaining);
      content.push({
        type: 'blockquote',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: paragraph(random, words) }] },
        ],
      });
      remaining -= words;
    } else {
      const words = Math.min(pickInt(random, 45, 130), remaining);
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: paragraph(random, words) }],
      });
      remaining -= words;
    }
  }

  return { type: 'doc', content };
}

/**
 * A minimal HTML projection of the generated document.
 *
 * The real `bodyHtml` is produced by SPEC-007's `lib/content/render.ts`
 * (`generateHTML` over the closed schema) — which does not exist yet and is not
 * this slice's to write. This projection covers exactly the three node types
 * `buildDoc` emits and nothing else, so it cannot quietly become a second
 * renderer: the moment the editor saves an article, the real renderer replaces
 * this output for that row.
 */
function toHtml(node: ProseMirrorNode): string {
  const children = (node.content ?? []).map(toHtml).join('');
  switch (node.type) {
    case 'doc':
      return children;
    case 'heading':
      return `<h${(node.attrs as { level?: number } | undefined)?.level ?? 2}>${children}</h${
        (node.attrs as { level?: number } | undefined)?.level ?? 2
      }>`;
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`;
    case 'paragraph':
      return `<p>${children}</p>`;
    case 'text':
      return escapeHtml(node.text ?? '');
    default:
      return children;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Password hashing — probed, never faked
// ---------------------------------------------------------------------------

async function resolvePasswordHash(): Promise<string> {
  const module = join(REPO_ROOT, 'lib', 'auth', 'password.ts');
  if (!existsSync(module)) return PLACEHOLDER_PASSWORD_HASH;
  try {
    // Non-literal specifier on purpose: a static import of a file owned by a
    // slice that has not landed would fail `tsc --noEmit` on this tree.
    const specifier: string = pathToFileURL(module).href;
    const mod = (await import(specifier)) as {
      hashPassword?: (plain: string) => Promise<string>;
    };
    if (typeof mod.hashPassword === 'function') return await mod.hashPassword(DEMO_PASSWORD);
  } catch {
    /* fall through — a corpus with a placeholder hash beats a failed seed */
  }
  return PLACEHOLDER_PASSWORD_HASH;
}

// ---------------------------------------------------------------------------
// The corpus, built one table at a time
// ---------------------------------------------------------------------------
//
// Each builder below draws from the one PRNG stream and returns plain rows;
// `main` calls them in a fixed order and only then writes. Splitting the work
// this way does not perturb determinism — the draw *sequence* is what the
// corpus hashes depend on, and it is unchanged: users, then tags, then
// articles, then claps, follows, bookmarks. Reordering these calls, or drawing
// inside the write step, would change the corpus even though every count
// stayed the same.

type SeedUser = {
  id: string;
  email: string;
  passwordHash: string;
  handle: string;
  name: string;
  bio: string;
  avatarPath: null;
  coverPath: null;
  socials: string;
  createdAt: Date;
};

type SeedTag = { id: string; slug: string; name: string };

type SeedArticle = {
  id: string;
  authorId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  bodyJson: string;
  bodyHtml: string;
  bodyText: string;
  coverPath: null;
  readingMinutes: number;
  status: string;
  version: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SeedArticleTag = { articleId: string; tagId: string };
type SeedClap = { userId: string; articleId: string; count: number; createdAt: Date };
type SeedFollow = { followerId: string; followingId: string; createdAt: Date };
type SeedBookmark = { userId: string; articleId: string; createdAt: Date };

type Corpus = {
  users: SeedUser[];
  tags: SeedTag[];
  articles: SeedArticle[];
  articleTags: SeedArticleTag[];
  claps: SeedClap[];
  follows: SeedFollow[];
  bookmarks: SeedBookmark[];
};

function buildUsers(random: Random, passwordHash: string): SeedUser[] {
  return Array.from({ length: COUNTS.users }, (_, index) => {
    const first = pick(random, FIRST_NAMES);
    const last = pick(random, LAST_NAMES);
    const handle = index === 0 ? DEMO_HANDLE : `${first.toLowerCase()}_${index}`;
    return {
      id: createIdFrom(random),
      email: index === 0 ? DEMO_EMAIL : `${handle}@titan.local`,
      passwordHash,
      handle,
      name: `${first} ${last}`,
      bio: `${sentence(random, pickInt(random, 8, 16))}`.slice(0, 220),
      avatarPath: null,
      coverPath: null,
      socials: serializeSocials({
        twitter: handle,
        github: handle,
        website: `https://${handle}.titan.local`,
      }),
      // One user per day from the base timestamp — ordered, and every value
      // is >= BASE_TIMESTAMP by construction.
      createdAt: new Date(BASE_MS + index * DAY),
    };
  });
}

function buildTags(random: Random): SeedTag[] {
  return TAG_NAMES.slice(0, COUNTS.tags).map((name) => ({
    id: createIdFrom(random),
    slug: name,
    name: name.charAt(0).toUpperCase() + name.slice(1),
  }));
}

/**
 * One article plus the tag edges it owns.
 *
 * `index` decides publication rather than a coin flip: the first
 * `COUNTS.publishedArticles` are PUBLISHED and the rest are DRAFT, so the
 * split seed-counts.test.ts asserts is a property of the loop, not of luck.
 */
function buildArticle(
  random: Random,
  index: number,
  users: SeedUser[],
  tags: SeedTag[],
): { article: SeedArticle; articleTags: SeedArticleTag[] } {
  const published = index < COUNTS.publishedArticles;
  const id = createIdFrom(random);
  const author = users[index % users.length]!;
  const title = `${pick(random, TITLE_OPENERS)} ${pick(random, TITLE_SUBJECTS)}`;

  // SPEC-004: bodies are 400-1800 words.
  const doc = buildDoc(random, pickInt(random, 400, 1_800));
  const derived = deriveReading(doc);

  // Strictly increasing from the base timestamp, so every createdAt is
  // >= BASE_TIMESTAMP and the corpus has a stable chronological order for
  // the recency half of SPEC-008's ranking formula.
  const createdAt = new Date(BASE_MS + index * 6 * HOUR);
  const publishedAt = published
    ? new Date(createdAt.getTime() + pickInt(random, 1, 48) * HOUR)
    : null;

  const article: SeedArticle = {
    id,
    authorId: author.id,
    slug: buildSlug(title, id),
    title,
    subtitle: sentence(random, pickInt(random, 6, 14)).slice(0, 160),
    bodyJson: JSON.stringify(doc),
    bodyHtml: toHtml(doc),
    bodyText: derived.bodyText,
    coverPath: null,
    readingMinutes: derived.readingMinutes,
    status: published ? ARTICLE_STATUS.PUBLISHED : ARTICLE_STATUS.DRAFT,
    version: 1,
    publishedAt,
    createdAt,
    updatedAt: publishedAt ?? createdAt,
  };

  // 1-5 tags per article, deduplicated — the ceiling `lib/db/tags.ts`
  // enforces is respected by the fixture that feeds every tag page.
  const wanted = pickInt(random, 1, 5);
  const chosen = new Set<string>();
  while (chosen.size < wanted) chosen.add(pick(random, tags).id);

  return { article, articleTags: [...chosen].map((tagId) => ({ articleId: id, tagId })) };
}

function buildArticles(
  random: Random,
  users: SeedUser[],
  tags: SeedTag[],
): { articles: SeedArticle[]; articleTags: SeedArticleTag[] } {
  const total = COUNTS.publishedArticles + COUNTS.draftArticles;
  const articles: SeedArticle[] = [];
  const articleTags: SeedArticleTag[] = [];
  for (let index = 0; index < total; index++) {
    const built = buildArticle(random, index, users, tags);
    articles.push(built.article);
    articleTags.push(...built.articleTags);
  }
  return { articles, articleTags };
}

/**
 * Claps land on published articles only: a clap on a draft nobody can read
 * would make `clapTotal` disagree with what the feed can possibly show.
 */
function buildClaps(random: Random, users: SeedUser[], published: SeedArticle[]): SeedClap[] {
  const claps: SeedClap[] = [];
  const seen = new Set<string>();
  while (claps.length < COUNTS.claps) {
    const user = pick(random, users);
    const article = pick(random, published);
    const key = `${user.id}:${article.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claps.push({
      userId: user.id,
      articleId: article.id,
      count: pickInt(random, 1, 50),
      createdAt: new Date((article.publishedAt ?? article.createdAt).getTime() + HOUR),
    });
  }
  return claps;
}

function buildFollows(random: Random, users: SeedUser[]): SeedFollow[] {
  const follows: SeedFollow[] = [];
  const seen = new Set<string>();
  while (follows.length < COUNTS.follows) {
    const follower = pick(random, users);
    const following = pick(random, users);
    if (follower.id === following.id) continue; // the SelfFollowError case
    const key = `${follower.id}:${following.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    follows.push({
      followerId: follower.id,
      followingId: following.id,
      createdAt: new Date(BASE_MS + follows.length * HOUR),
    });
  }
  return follows;
}

function buildBookmarks(
  random: Random,
  users: SeedUser[],
  published: SeedArticle[],
): SeedBookmark[] {
  const bookmarks: SeedBookmark[] = [];
  const seen = new Set<string>();
  while (bookmarks.length < COUNTS.bookmarks) {
    const user = pick(random, users);
    const article = pick(random, published);
    const key = `${user.id}:${article.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bookmarks.push({
      userId: user.id,
      articleId: article.id,
      createdAt: new Date(BASE_MS + bookmarks.length * HOUR),
    });
  }
  return bookmarks;
}

function buildCorpus(random: Random, passwordHash: string): Corpus {
  const users = buildUsers(random, passwordHash);
  const tags = buildTags(random);
  const { articles, articleTags } = buildArticles(random, users, tags);
  const published = articles.filter((a) => a.status === ARTICLE_STATUS.PUBLISHED);
  return {
    users,
    tags,
    articles,
    articleTags,
    claps: buildClaps(random, users, published),
    follows: buildFollows(random, users),
    bookmarks: buildBookmarks(random, users, published),
  };
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

function chunk<T>(rows: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Write the whole corpus in one transaction.
 *
 * Not atomicity theatre: SQLite commits (and fsyncs) per statement otherwise,
 * which turns ~3 300 inserts into minutes rather than seconds — and this
 * script runs several times inside `npm test`.
 */
async function writeCorpus(db: ReturnType<typeof getDb>, corpus: Corpus): Promise<void> {
  await db.$transaction([
    // Delete in dependency order so re-running is a rebuild, not a pile-up.
    // (The cascades would do it from User alone; being explicit means a
    // partially-seeded database from an interrupted run also comes out clean.)
    db.clap.deleteMany(),
    db.bookmark.deleteMany(),
    db.follow.deleteMany(),
    db.articleTag.deleteMany(),
    db.article.deleteMany(),
    db.tag.deleteMany(),
    db.session.deleteMany(),
    db.user.deleteMany(),

    db.user.createMany({ data: corpus.users }),
    db.tag.createMany({ data: corpus.tags }),
    ...chunk(corpus.articles).map((rows) => db.article.createMany({ data: rows })),
    ...chunk(corpus.articleTags).map((rows) => db.articleTag.createMany({ data: rows })),
    ...chunk(corpus.claps).map((rows) => db.clap.createMany({ data: rows })),
    ...chunk(corpus.follows).map((rows) => db.follow.createMany({ data: rows })),
    ...chunk(corpus.bookmarks).map((rows) => db.bookmark.createMany({ data: rows })),

    // Rebuild the FTS5 index from the rows just written.
    //
    // `'rebuild'` re-reads the whole index from `article_fts_source`, the view
    // the migration points `content` at — which selects only PUBLISHED rows.
    // So this lands exactly the 500 published articles in the index and no
    // drafts, without the seed having to restate that rule.
    //
    // Doing it as a rebuild rather than per-article inserts is also what keeps
    // this correct once SPEC-008 adds its write triggers: whatever those
    // triggers wrote during the inserts above is discarded and replaced by the
    // canonical projection, so the corpus cannot end up double-indexed.
    db.$executeRawUnsafe(`INSERT INTO "article_fts"("article_fts") VALUES('rebuild')`),
  ]);
}

function reportCorpus(corpus: Corpus, usedPlaceholder: boolean): void {
  const published = corpus.articles.filter((a) => a.status === ARTICLE_STATUS.PUBLISHED).length;
  console.log(
    `seeded ${corpus.users.length} users, ${corpus.articles.length} articles ` +
      `(${published} published + ${corpus.articles.length - published} drafts), ` +
      `${corpus.tags.length} tags, ${corpus.claps.length} claps, ` +
      `${corpus.follows.length} follows, ${corpus.bookmarks.length} bookmarks`,
  );
  console.log(
    usedPlaceholder
      ? `  password hashes are placeholders — lib/auth/password.ts (TASK-004) does not exist yet`
      : `  demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
  );
}

async function main(): Promise<void> {
  const random = createSeededRandom(PRNG_SEED);
  const passwordHash = await resolvePasswordHash();
  const corpus = buildCorpus(random, passwordHash);
  await writeCorpus(getDb(), corpus);
  reportCorpus(corpus, passwordHash === PLACEHOLDER_PASSWORD_HASH);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
