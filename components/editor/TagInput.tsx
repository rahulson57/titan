'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The tag field (SPEC-007's publish guard, SPEC-004's ceiling).
 *
 * Publishing requires 1-5 tags. This component is the place an author finds
 * that out BEFORE they press Publish — but it is not where the rule lives. The
 * rule lives in `validatePublish` (`lib/content/publish.ts`) and, underneath
 * it, in `setArticleTags`, which refuses a sixth tag no matter which write path
 * reaches it. What is here is a UI that makes the rule visible.
 *
 * That split matters because the obvious alternative — enforce it here and
 * trust the form — is how a six-tagged article gets created by the seed script,
 * an import, or a second client. `tests/unit/repo-tag.test.ts` proves the
 * repository refuses; `tests/unit/publish-guards.test.ts` proves the publish
 * path refuses; this file only has to be honest.
 *
 * ── The list is a real list ───────────────────────────────────────────────
 * `<ul>` of `<li>`, each with a named remove button ("Remove tag design"), not
 * a row of `<span>`s with an "x". A screen-reader user needs to know how many
 * tags there are, which one they are on, and what a given button removes; an
 * unnamed "x" answers none of those. The count is announced through a live
 * region so that adding a fifth tag says so rather than silently disabling the
 * input.
 */

import { useId, useRef, useState, type CSSProperties } from 'react';

// From `autosave.ts`, the client-safe half of `lib/content/` — importing
// these from `publish.ts` would pull the repository layer (and `node:crypto`)
// into the browser bundle. See that module's header.
import { MAX_TAGS, MIN_TAGS, normalizeTagList } from '../../lib/content/autosave';

export interface TagInputProps {
  tags: string[];
  onChange(tags: string[]): void;
  /** Rendered against the field — the publish guard's `tags` error. */
  error?: string | null;
  disabled?: boolean;
}

const wrapper: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  fontFamily: 'var(--font-ui)',
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--space-2)',
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
  padding: 'var(--space-1) var(--space-3)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-pill)',
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg)',
};

const removeStyle: CSSProperties = {
  font: 'inherit',
  lineHeight: 1,
  padding: '0 var(--space-1)',
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 'var(--text-ui-size)',
  padding: 'var(--space-2) var(--space-3)',
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  minWidth: '14rem',
};

const hintStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg-muted)',
};

const errorStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-2) var(--space-3)',
};

export function TagInput({ tags, onChange, error, disabled }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const id = useId();

  const inputId = `${id}-tag-input`;
  const hintId = `${id}-tag-hint`;
  const errorId = `${id}-tag-error`;
  const full = tags.length >= MAX_TAGS;

  const commit = (raw: string) => {
    const value = raw.trim();
    if (value.length === 0) return;
    // Deduplicated through the SAME function the publish guard counts with, so
    // "you have five" here and "you have five" there can never disagree.
    const next = normalizeTagList([...tags, value]);
    if (next.length > MAX_TAGS) return;
    onChange(next);
    setDraft('');
  };

  return (
    <div style={wrapper} data-testid="tag-input">
      <label htmlFor={inputId} style={{ fontSize: 'var(--text-meta-size)', fontWeight: 600 }}>
        Tags
      </label>

      {tags.length > 0 ? (
        <ul style={listStyle} data-testid="tag-list">
          {tags.map((tag) => (
            <li key={tag.toLowerCase()} style={chipStyle}>
              <span>{tag}</span>
              <button
                type="button"
                style={removeStyle}
                aria-label={`Remove tag ${tag}`}
                disabled={disabled}
                onClick={() => {
                  onChange(tags.filter((entry) => entry !== tag));
                  inputRef.current?.focus();
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        id={inputId}
        ref={inputRef}
        type="text"
        style={inputStyle}
        value={draft}
        disabled={disabled || full}
        aria-describedby={[error ? errorId : null, hintId].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        placeholder={full ? `You have ${MAX_TAGS} tags` : 'Add a tag and press Enter'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            // Enter must not submit the surrounding form — in an editor that
            // would publish the article from the tag field.
            event.preventDefault();
            commit(draft);
            return;
          }
          if (event.key === 'Backspace' && draft.length === 0 && tags.length > 0) {
            // The behaviour every chip input has, and its absence is noticed
            // immediately: backspace on an empty field removes the last tag.
            event.preventDefault();
            onChange(tags.slice(0, -1));
          }
        }}
        // Committing on blur as well as on Enter: a half-typed tag left in the
        // field when the author clicks Publish would otherwise be silently
        // dropped, and they would be told they have too few tags while looking
        // at the one they just typed.
        onBlur={() => commit(draft)}
      />

      <p id={hintId} style={hintStyle} role="status" aria-live="polite">
        {`${tags.length} of ${MAX_TAGS} — publishing needs at least ${MIN_TAGS}.`}
      </p>

      {error ? (
        <p id={errorId} role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default TagInput;
