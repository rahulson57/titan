/**
 * Canonical row hashing for the seed-determinism gate (SPEC-002).
 *
 * > Seeded data uses a fixed PRNG seed (`titan-2026`) and fixed base timestamp
 * > `2026-01-01T00:00:00Z`; two seed runs produce byte-identical rows for
 * > id, slug, createdAt.
 *
 * "Byte-identical" needs a definition that does not accidentally pass. Two
 * traps this module exists to avoid:
 *
 *  1. **Key order.** `JSON.stringify` preserves insertion order, so two rows
 *     with the same content but different key order hash differently. Every
 *     object is serialised with sorted keys.
 *
 *  2. **Row order.** A seed script is deterministic in *content* but a query
 *     without an ORDER BY is not deterministic in *sequence*. Hashing the
 *     concatenation of unsorted rows would flag a passing seed as broken —
 *     or, worse, an ORDER BY added later would mask a real regression. Rows
 *     are therefore sorted by their own canonical form before being folded in.
 *
 * Dates are normalised to ISO-8601 with millisecond precision so a `Date`
 * instance and the string it round-trips through hash the same.
 */

import { createHash } from 'node:crypto';

/** The PRNG seed every deterministic fixture derives from (SPEC-002). */
export const SEED_PRNG_SEED = 'titan-2026';

/** The base timestamp every fixture's `createdAt` is derived from (SPEC-002). */
export const SEED_BASE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/**
 * The columns the determinism criterion names, per model. Hashing exactly
 * these — rather than the whole row — keeps the gate meaningful when a later
 * slice adds a column that is legitimately non-deterministic.
 */
export const DETERMINISTIC_COLUMNS = {
  User: ['id', 'createdAt'],
  Article: ['id', 'slug', 'createdAt'],
  Clap: ['id', 'createdAt'],
} as const;

export type DeterministicModel = keyof typeof DETERMINISTIC_COLUMNS;

export type Row = Record<string, unknown>;

/** Normalise one value into a form that hashes stably across runs and drivers. */
function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `base64:${value.toString('base64')}`;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object') {
    const src = value as Row;
    const out: Row = {};
    for (const key of Object.keys(src).sort()) out[key] = normalise(src[key]);
    return out;
  }
  return value;
}

/** Deterministic string form of a single row: sorted keys, normalised values. */
export function canonicalise(row: Row, columns?: readonly string[]): string {
  const keys = (columns ?? Object.keys(row)).slice().sort();
  const projected: Row = {};
  for (const key of keys) projected[key] = normalise(row[key]);
  return JSON.stringify(projected);
}

/**
 * Hash a set of rows. Order-insensitive by construction: rows are sorted by
 * their canonical form first, so the result depends on content alone.
 */
export function hashRows(rows: readonly Row[], columns?: readonly string[]): string {
  const canonical = rows.map((row) => canonicalise(row, columns)).sort();
  const digest = createHash('sha256');
  digest.update(`n=${canonical.length}\n`); // length is part of the identity
  for (const line of canonical) digest.update(`${line}\n`);
  return digest.digest('hex');
}

/** Hash one model's rows using exactly the columns the spec names for it. */
export function hashModel(model: DeterministicModel, rows: readonly Row[]): string {
  return hashRows(rows, DETERMINISTIC_COLUMNS[model]);
}

/**
 * Hash every named model into one comparable fingerprint. This is the value
 * two consecutive seed runs must agree on.
 */
export function fingerprint(snapshot: Partial<Record<DeterministicModel, readonly Row[]>>): string {
  const digest = createHash('sha256');
  for (const model of Object.keys(DETERMINISTIC_COLUMNS).sort() as DeterministicModel[]) {
    const rows = snapshot[model] ?? [];
    digest.update(`${model}=${hashModel(model, rows)}\n`);
  }
  return digest.digest('hex');
}
