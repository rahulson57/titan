/**
 * The clap bound and the one-row-per-reader rule (SPEC-004 / SPEC-009).
 *
 * > Inserting a Clap with `count` outside 1–50 is rejected, and a second insert
 * > for the same (userId, articleId) updates rather than duplicates — exactly
 * > one row remains.
 *
 * Both halves are enforced in `lib/db/social.ts` rather than in the schema,
 * because SQLite gives us neither: Prisma emits no CHECK constraint, so the
 * bound is code; the composite primary key does hold the second half, so the
 * test proves the repository actually routes through an upsert rather than
 * relying on an INSERT that would throw.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle, ARTICLE_STATUS } from '../../lib/db/articles';
import {
  ClapCountError,
  MAX_CLAPS_PER_READER,
  MIN_CLAPS_PER_READER,
  countClapRows,
  getClapByReader,
  getClapTotal,
  incrementClap,
  setClap,
} from '../../lib/db/social';

const AT = new Date('2026-01-01T00:00:00.000Z');

let db: TestDatabase;
let reader = '';
let otherReader = '';
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
  await db.client.$executeRawUnsafe('DELETE FROM "Clap"');
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  const author = await createUser({
    email: 'Author@Titan.Local',
    passwordHash: 'x',
    handle: 'author',
    name: 'Author',
    createdAt: AT,
  });
  reader = (
    await createUser({
      email: 'reader@titan.local',
      passwordHash: 'x',
      handle: 'reader',
      name: 'Reader',
      createdAt: AT,
    })
  ).id;
  otherReader = (
    await createUser({
      email: 'other@titan.local',
      passwordHash: 'x',
      handle: 'other',
      name: 'Other',
      createdAt: AT,
    })
  ).id;
  articleId = (
    await createArticle({
      authorId: author.id,
      title: 'A clapped article',
      bodyJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] },
      bodyHtml: '<p>body</p>',
      status: ARTICLE_STATUS.PUBLISHED,
      now: AT,
    })
  ).id;
});

describe('SPEC-004 — a clap count outside 1..50 is rejected', () => {
  it.each([0, -1, 51, 1_000])('refuses %i', async (count) => {
    await expect(setClap(reader, articleId, count, AT)).rejects.toBeInstanceOf(ClapCountError);
    expect(await countClapRows(articleId)).toBe(0);
  });

  it('refuses a non-integer, which would otherwise round into range silently', async () => {
    await expect(setClap(reader, articleId, 2.5, AT)).rejects.toBeInstanceOf(ClapCountError);
  });

  it('accepts both ends of the range', async () => {
    await setClap(reader, articleId, MIN_CLAPS_PER_READER, AT);
    expect(await getClapByReader(reader, articleId)).toBe(1);
    await setClap(reader, articleId, MAX_CLAPS_PER_READER, AT);
    expect(await getClapByReader(reader, articleId)).toBe(50);
  });
});

describe('SPEC-004 — a second clap updates rather than duplicates', () => {
  it('leaves exactly one row for the same (userId, articleId)', async () => {
    await setClap(reader, articleId, 3, AT);
    await setClap(reader, articleId, 9, AT);
    expect(await countClapRows(articleId)).toBe(1);
    expect(await getClapByReader(reader, articleId)).toBe(9);
  });

  it('keeps a different reader on their own row', async () => {
    await setClap(reader, articleId, 3, AT);
    await setClap(otherReader, articleId, 4, AT);
    expect(await countClapRows(articleId)).toBe(2);
    expect(await getClapTotal(articleId)).toBe(7);
  });
});

describe('SPEC-009 — incrementing saturates at the ceiling instead of erroring', () => {
  it('caps at 50 and keeps returning the unchanged total past it', async () => {
    // "Beyond 50 it is a no-op returning the existing total, not an error."
    for (let i = 0; i < 60; i++) await incrementClap(reader, articleId, 1, AT);
    expect(await countClapRows(articleId)).toBe(1);
    expect(await getClapByReader(reader, articleId)).toBe(MAX_CLAPS_PER_READER);
    expect(await getClapTotal(articleId)).toBe(MAX_CLAPS_PER_READER);
  });

  it('coalesces a burst into one call without overshooting', async () => {
    // The client coalesces taps into one action per 400ms burst (SPEC-009),
    // so `by` arrives greater than 1 and must still respect the ceiling.
    await incrementClap(reader, articleId, 47, AT);
    await incrementClap(reader, articleId, 10, AT);
    expect(await getClapByReader(reader, articleId)).toBe(50);
  });

  it('treats a nonsense increment as at least one clap, never zero rows', async () => {
    await incrementClap(reader, articleId, -5, AT);
    expect(await getClapByReader(reader, articleId)).toBe(MIN_CLAPS_PER_READER);
  });
});

describe('SPEC-004 — clapTotal is a read-time aggregate, never a stored column', () => {
  it('is SUM(count) across readers', async () => {
    await setClap(reader, articleId, 12, AT);
    await setClap(otherReader, articleId, 30, AT);
    expect(await getClapTotal(articleId)).toBe(42);
  });

  it('is zero for an article nobody has clapped, not null', async () => {
    expect(await getClapTotal(articleId)).toBe(0);
    expect(await getClapByReader(reader, articleId)).toBe(0);
  });

  it('follows the rows down when a clapping reader is deleted', async () => {
    // A denormalised counter would survive the cascade and start lying here.
    await setClap(reader, articleId, 20, AT);
    await setClap(otherReader, articleId, 5, AT);
    await db.client.$executeRawUnsafe('DELETE FROM "User" WHERE id = ?', reader);
    expect(await getClapTotal(articleId)).toBe(5);
  });

});
