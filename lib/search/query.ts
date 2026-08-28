/**
 * Turning what a reader typed into something FTS5 will accept (SPEC-008).
 *
 * > User input is escaped and joined as quoted terms; FTS5 operators typed by
 * > the user are treated as literals (a lone `"` or `*` must not throw).
 *
 * ── Why this is not optional politeness ───────────────────────────────────
 * The FTS5 `MATCH` right-hand side is a QUERY LANGUAGE, not a string. Passing
 * a reader's words through untouched is the full-text equivalent of string-
 * concatenating SQL. Measured against this repository's own index:
 *
 *   | typed             | raw `MATCH`                              |
 *   |-------------------|------------------------------------------|
 *   | `"`               | `fts5: unterminated string`              |
 *   | `*`               | `fts5: unknown special query:`           |
 *   | `AND`             | `fts5: syntax error near "AND"`          |
 *   | `foo NEAR/2 bar`  | `fts5: syntax error near "/"`            |
 *
 * Four of the most ordinary things a person can type, and every one of them a
 * 500 on the search page. Parameter binding does NOT help — the parameter is
 * bound and then parsed as a query — which is the trap here, because binding
 * is the reflex that protects every other query in the codebase.
 *
 * ── The fix, and why quoting is the whole of it ───────────────────────────
 * Inside an FTS5 double-quoted string every character is a literal: `*`, `-`,
 * `^`, `AND`, `NEAR/2` all stop being syntax. A literal double quote is
 * written by doubling it, exactly as in SQL. So each token becomes `"token"`,
 * and the tokens are joined with spaces — which FTS5 reads as implicit AND,
 * the behaviour a reader expects from a search box.
 *
 * Verified against the real index: `"*"`, `""""`, `"AND"` and
 * `"foo" "near/2" "bar"` all return a result set rather than throwing.
 * `tests/unit/search-escaping.test.ts` holds the four cases the criterion
 * names against the database rather than against this function's return
 * value — a parser that produces beautiful strings SQLite rejects would pass
 * the second kind of test and fail every reader.
 *
 * ── What is deliberately NOT supported ────────────────────────────────────
 * No operator passthrough: a reader who types `AND` gets articles containing
 * the word "and", not a boolean. SPEC-008 asks for exactly that ("operators
 * treated as literal terms"), and the alternative — a mini-language where some
 * punctuation is magic — is a surface where every unquoted apostrophe is a
 * potential 500 and the rules are undiscoverable.
 */

/**
 * How many tokens of a query are used.
 *
 * A bound, not a guess at what people search for. FTS5 intersects a postings
 * list per token, so cost grows with token count, and the query string is
 * attacker-controlled — a 50 000-word `?q=` should not become 50 000 postings
 * lookups. Twelve is far past any real search and far short of a denial of
 * service. Extra tokens are dropped, not rejected: silently narrowing to the
 * first twelve returns something useful, where an error page returns nothing.
 */
export const MAX_SEARCH_TERMS = 12;

/**
 * Longest single token used. `unicode61` will not produce a token longer than
 * this from natural prose, so anything longer is a paste or an attack; it is
 * truncated rather than dropped so a long word still matches by prefix of its
 * own text.
 */
export const MAX_TERM_LENGTH = 64;

export interface ParsedQuery {
  /** What the reader typed, trimmed — for echoing back into the UI. */
  raw: string;
  /** The tokens actually searched, after capping and truncation. */
  terms: string[];
  /** The FTS5 `MATCH` expression: `"one" "two"`. Empty when `isEmpty`. */
  match: string;
  /** True when there is nothing to search for. Callers must not query. */
  isEmpty: boolean;
}

/**
 * One token as an FTS5 string literal.
 *
 * Exported because `tests/unit/search-escaping.test.ts` asserts the doubling
 * rule directly; a quoting function that is only reachable through the parser
 * can only be tested through whatever the parser happens to feed it.
 */
export function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Parse a reader's query.
 *
 * Splitting on whitespace ONLY, and leaving punctuation inside the token, is
 * deliberate. `unicode61` will split `near/2` into `near` and `2` when it
 * indexes the quoted string, so the phrase search does the sensible thing
 * without this function having to own a second, subtly different idea of what
 * a word is. Two tokenizers that disagree is how a search box starts finding
 * nothing for hyphenated words.
 */
export function parseSearchQuery(input: string | null | undefined): ParsedQuery {
  const raw = (input ?? '').trim();

  const terms = raw
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .slice(0, MAX_SEARCH_TERMS)
    .map((token) => token.slice(0, MAX_TERM_LENGTH));

  return {
    raw,
    terms,
    match: terms.map(quoteTerm).join(' '),
    isEmpty: terms.length === 0,
  };
}
