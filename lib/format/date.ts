/**
 * Timestamp rendering (SPEC-004).
 *
 * > All timestamps are stored as UTC `DateTime`; the app never renders a raw
 * > timestamp without formatting through `lib/format/date.ts`.
 *
 * Why a module rather than an inline `toLocaleDateString` at each call site:
 * a bare locale call reads the RUNTIME's timezone and locale. On a server
 * component that is the machine's zone, on the client it is the visitor's, and
 * the two disagree — which is the classic Next.js hydration mismatch, and it
 * shows up as an article dated a day earlier on the server than in the browser.
 * Every formatter here pins `timeZone: 'UTC'` and `en-US`, so server and client
 * produce the same string by construction and a Playwright assertion on a
 * rendered date is stable.
 */

/** Anything the app might hold a timestamp in before rendering it. */
export type DateLike = Date | string | number;

/** Normalise to a `Date`, or `null` if the input is not a usable timestamp. */
export function toDate(value: DateLike | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date);
}

/**
 * The byline date: `Jan 4, 2026`. Used wherever a published date sits next to
 * an author (feed cards, article header, profile lists).
 */
export function formatArticleDate(value: DateLike | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  return format(date, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** `January 4, 2026` — for surfaces with room, e.g. a profile "joined" line. */
export function formatLongDate(value: DateLike | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  return format(date, { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * The machine-readable form for a `<time dateTime=…>` attribute. Screen
 * readers and crawlers get the unambiguous instant; the element's text content
 * gets the human form above.
 */
export function toDateTimeAttribute(value: DateLike | null | undefined): string {
  return toDate(value)?.toISOString() ?? '';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `just now` / `4 min ago` / `3 h ago` / `2 d ago`, falling back to an absolute
 * date past a week.
 *
 * `now` is a parameter, never `Date.now()` read inside. Relative time computed
 * from an ambient clock is untestable and non-deterministic — the same
 * reasoning SPEC-008 applies to the feed's ranking clock, applied here so a
 * rendered "2 d ago" can be asserted rather than approximated.
 */
export function formatRelative(
  value: DateLike | null | undefined,
  now: DateLike,
): string {
  const date = toDate(value);
  const reference = toDate(now);
  if (!date || !reference) return '';

  const elapsed = reference.getTime() - date.getTime();
  if (elapsed < 0) return formatArticleDate(date); // a future date is not "ago"
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`;
  return formatArticleDate(date);
}

/** `5 min read` — the reading-time label, from `lib/derive/reading.ts`'s value. */
export function formatReadingTime(minutes: number): string {
  const safe = Number.isFinite(minutes) && minutes > 0 ? Math.ceil(minutes) : 1;
  return `${safe} min read`;
}
