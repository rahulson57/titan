/**
 * The User + Session repository (SPEC-004).
 *
 * Consumed as `UserRepo` and `SessionStore` by Identity & Auth (SPEC-005), and
 * as `ProfileRepo`'s write path by Profiles (SPEC-010). Password hashing,
 * session cookies and authorization all live in those slices — this module
 * owns storage shape and the invariants the database cannot express itself.
 *
 * Two normalisations happen here rather than at the call sites, because a
 * uniqueness constraint is only as good as the form it is checked against:
 * email is lowercased and trimmed before every read and write, and handle is
 * lowercased and validated against SPEC-004's `^[a-z0-9_]{3,24}$`. If sign-up
 * normalised but a profile edit did not, two rows could differ only by case
 * and the unique index would happily allow it.
 */

import type { Prisma, User } from '@prisma/client';
import { getDb } from './client';
import { createId, createSessionId } from './ids';

export type { User };

/** SPEC-004: handle is `^[a-z0-9_]{3,24}$` and appears in `/@handle`. */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;

/** SPEC-004: display name is 1-60 chars; bio is at most 220. */
export const NAME_MAX = 60;
export const BIO_MAX = 220;

/** The `socials` JSON column's shape (SPEC-004 / SPEC-010). */
export interface SocialLinks {
  twitter?: string;
  github?: string;
  website?: string;
}

/** A user with `socials` already parsed out of its TEXT column. */
export type UserRecord = Omit<User, 'socials'> & { socials: SocialLinks };

export class InvalidHandleError extends Error {
  constructor(handle: string) {
    super(`handle ${JSON.stringify(handle)} does not match ${HANDLE_PATTERN}`);
    this.name = 'InvalidHandleError';
  }
}

export class UserNotFoundError extends Error {
  constructor(what: string) {
    super(`no user matching ${what}`);
    this.name = 'UserNotFoundError';
  }
}

/** Lowercase + trim. The form every email comparison is made against. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lowercase + trim, then validate. Throws rather than storing a bad handle. */
export function normalizeHandle(handle: string): string {
  const normalized = handle.trim().toLowerCase();
  if (!HANDLE_PATTERN.test(normalized)) throw new InvalidHandleError(handle);
  return normalized;
}

/** Parse the `socials` TEXT column; unreadable JSON degrades to no links. */
export function parseSocials(raw: string | null | undefined): SocialLinks {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SocialLinks;
  } catch {
    return {};
  }
}

/** Serialise `socials` for storage, dropping empty entries so `{}` is canonical. */
export function serializeSocials(socials: SocialLinks | null | undefined): string {
  const out: SocialLinks = {};
  for (const key of ['twitter', 'github', 'website'] as const) {
    const value = socials?.[key];
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim();
  }
  return JSON.stringify(out);
}

function toRecord(row: User): UserRecord {
  return { ...row, socials: parseSocials(row.socials) };
}

function toRecordOrNull(row: User | null): UserRecord | null {
  return row ? toRecord(row) : null;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  handle: string;
  name: string;
  bio?: string | null;
  avatarPath?: string | null;
  coverPath?: string | null;
  socials?: SocialLinks;
  /** Injected so the deterministic seed corpus does not read a wall clock. */
  createdAt?: Date;
  /** Injected by the seed so ids come from the fixed PRNG. */
  id?: string;
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  const row = await getDb().user.create({
    data: {
      id: input.id ?? createId(),
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      handle: normalizeHandle(input.handle),
      name: input.name.slice(0, NAME_MAX),
      bio: input.bio?.slice(0, BIO_MAX) ?? null,
      avatarPath: input.avatarPath ?? null,
      coverPath: input.coverPath ?? null,
      socials: serializeSocials(input.socials),
      createdAt: input.createdAt ?? new Date(),
    },
  });
  return toRecord(row);
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  return toRecordOrNull(await getDb().user.findUnique({ where: { id } }));
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  return toRecordOrNull(
    await getDb().user.findUnique({ where: { email: normalizeEmail(email) } }),
  );
}

/**
 * `/@handle` resolution. Tolerates a leading `@` and any casing so a pasted
 * URL and a typed handle resolve to the same row.
 */
export async function findUserByHandle(handle: string): Promise<UserRecord | null> {
  const normalized = handle.trim().replace(/^@/, '').toLowerCase();
  if (!HANDLE_PATTERN.test(normalized)) return null;
  return toRecordOrNull(await getDb().user.findUnique({ where: { handle: normalized } }));
}

export interface UpdateUserInput {
  name?: string;
  handle?: string;
  bio?: string | null;
  avatarPath?: string | null;
  coverPath?: string | null;
  socials?: SocialLinks;
  passwordHash?: string;
}

/** The write path SPEC-010's `updateProfile` action funnels through. */
export async function updateUser(id: string, patch: UpdateUserInput): Promise<UserRecord> {
  const data: Prisma.UserUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name.slice(0, NAME_MAX);
  if (patch.handle !== undefined) data.handle = normalizeHandle(patch.handle);
  if (patch.bio !== undefined) data.bio = patch.bio === null ? null : patch.bio.slice(0, BIO_MAX);
  if (patch.avatarPath !== undefined) data.avatarPath = patch.avatarPath;
  if (patch.coverPath !== undefined) data.coverPath = patch.coverPath;
  if (patch.socials !== undefined) data.socials = serializeSocials(patch.socials);
  if (patch.passwordHash !== undefined) data.passwordHash = patch.passwordHash;

  const row = await getDb().user.update({ where: { id }, data });
  return toRecord(row);
}

/**
 * Delete a user. Every dependent row goes with them by `onDelete: Cascade` —
 * articles, claps, bookmarks, follows in both directions, and sessions. That is
 * a schema property rather than a loop here on purpose: a loop can be
 * incomplete, and `tests/unit/repo-cascade.test.ts` counts the orphans.
 */
export async function deleteUser(id: string): Promise<void> {
  await getDb().user.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// SessionStore (DEC-005) — the table lives here, the rules live in SPEC-005.
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  userId: string;
  expiresAt: Date;
  createdAt?: Date;
  id?: string;
}

export async function createSession(input: CreateSessionInput) {
  return getDb().session.create({
    data: {
      id: input.id ?? createSessionId(),
      userId: input.userId,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt ?? new Date(),
    },
  });
}

/**
 * Resolve a session id to its user, treating an expired row as absent.
 *
 * `now` is a parameter so expiry is testable without sleeping. Expired rows are
 * not deleted on read: sign-out must be the thing that revokes, and silently
 * reaping here would make "the row is gone" ambiguous in SPEC-005's assertions.
 */
export async function findSessionUser(
  sessionId: string,
  now: Date = new Date(),
): Promise<UserRecord | null> {
  const row = await getDb().session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  return toRecord(row.user);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await getDb().session.deleteMany({ where: { id: sessionId } });
}

/** Housekeeping for the sessions a database-backed scheme accumulates. */
export async function deleteExpiredSessions(now: Date = new Date()): Promise<number> {
  const { count } = await getDb().session.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
