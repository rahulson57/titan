'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The avatar picker on `/settings/profile` (SPEC-010).
 *
 * > avatar — uploaded via `/api/upload?kind=avatar`, replaces `avatarPath`;
 * > the previous file becomes garbage collectable by `uploads:gc`
 *
 * ── How this hands its result to the form ─────────────────────────────────
 * The upload is a separate request that finishes before the profile is saved,
 * so its result has to survive until submit. It lands in a **hidden input**
 * named `avatarPath`, which means the value travels with the rest of the form
 * through the ordinary Server Action, and the server re-validates it like any
 * other field — `validateMediaPath` checks it is a path of the right kind
 * inside the acting user's own directory. Nothing here is trusted; this
 * component only fills a box the server then inspects.
 *
 * That also gives the "no image" case for free: an empty hidden input clears
 * the column, so Remove is a state change here rather than a second endpoint.
 *
 * ── Why the shared core lives in this file ────────────────────────────────
 * `AvatarUploader` and `CoverUploader` differ in four values — kind, field
 * name, preview shape, wording — and share an upload/error/preview state
 * machine that is the whole substance of both. Two copies of that would be two
 * places for the 5 MB limit's error handling to drift.
 *
 * This slice's file scope names exactly `AvatarUploader.tsx` and
 * `CoverUploader.tsx`, so there is no third file to hold the common part
 * without inventing one outside the scope I was granted. It therefore lives
 * with the first consumer and is exported; `CoverUploader` imports it. If a
 * later slice adds a third uploader, `components/ui/` is where this should
 * move.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** SPEC-006's limit, restated so the client can refuse before uploading. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** What `/api/upload` answers with on success (SPEC-006's `StoredImage`). */
interface StoredImageResponse {
  path?: unknown;
}

interface UploadErrorResponse {
  error?: unknown;
}

export interface ImageUploaderProps {
  /** SPEC-006's `kind` parameter. */
  kind: 'avatar' | 'cover';
  /** The form field the resulting path is submitted under. */
  fieldName: 'avatarPath' | 'coverPath';
  /** The path already stored, or null. */
  initialPath: string | null;
  /** The person's name — the preview's alt text. */
  name: string;
  label: string;
  /** Rendered instead of an image when there is nothing to show. */
  placeholder: ReactNode;
  /** Applied to the preview box: a circle for avatars, a 3:1 band for covers. */
  previewStyle: CSSProperties;
  testId: string;
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  marginBlockEnd: 'var(--space-5)',
};

const labelStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-ui)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
};

const errorStyle: CSSProperties = {
  color: 'var(--accent)',
  fontSize: 'var(--text-meta-size)',
};

const imageStyle: CSSProperties = {
  inlineSize: '100%',
  blockSize: '100%',
  objectFit: 'cover',
};

/**
 * Read the server's message out of a failed response without trusting it to
 * have one.
 *
 * A 500 from a crashed handler is HTML, not JSON, and `response.json()` throws
 * on it — which would replace a useful "the upload failed" with an unhandled
 * rejection and a form that appears to do nothing.
 */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as UploadErrorResponse;
    if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  } catch {
    /* not JSON — fall through to the generic message */
  }
  return 'That image could not be uploaded. Try another one.';
}

export function ImageUploader({
  kind,
  fieldName,
  initialPath,
  name,
  label,
  placeholder,
  previewStyle,
  testId,
}: ImageUploaderProps) {
  const [path, setPath] = useState<string | null>(initialPath);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Whether React has attached to this control yet.
   *
   * The file input is disabled until it has, and that is a correctness fix
   * rather than a nicety. This control does its entire job in `onChange` — it
   * uploads via `fetch` and writes the result into a hidden field — so before
   * hydration it is a picker that silently discards whatever the person
   * selects. They get a filename beside the button, no preview, no error, and
   * a save that stores nothing.
   *
   * Measured rather than reasoned: a browser script that selected a file
   * immediately after navigation produced no `/api/upload` request at all and
   * no error, because the change event fired on an element React had not yet
   * bound. A person on a slow connection is in exactly that window, and so is
   * any e2e test that treats "visible" as "ready".
   *
   * The server render and React's first client render both see `false`, so
   * this cannot produce a hydration mismatch — the enable happens in the
   * effect, after the attach it is reporting.
   */
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function upload(file: File) {
    setError(null);

    // Refuse oversize locally as well as server-side. The server check is the
    // one that counts; this one exists so a user on a slow link is not made to
    // wait for a 5 MB upload that was always going to be refused.
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That image is too large. The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
      return;
    }

    setBusy(true);
    try {
      const body = new FormData();
      body.set('file', file);
      // The handler reads `kind` from the multipart body; SPEC-010 spells the
      // endpoint with a query parameter. Both are sent so the request matches
      // the spec's URL and the handler's actual contract at the same time.
      body.set('kind', kind);

      const response = await fetch(`/api/upload?kind=${kind}`, { method: 'POST', body });
      if (!response.ok) {
        setError(await errorMessage(response));
        return;
      }

      const stored = (await response.json()) as StoredImageResponse;
      if (typeof stored.path !== 'string' || stored.path.length === 0) {
        setError('The upload finished but returned no image. Try again.');
        return;
      }
      setPath(stored.path);
    } catch {
      // A network failure, an aborted request, a server that hung up. None of
      // them is the user's fault and none is actionable beyond retrying.
      setError('That image could not be uploaded. Check your connection and try again.');
    } finally {
      setBusy(false);
      // Clear the file input so choosing the SAME file again still fires
      // `change` — otherwise a failed upload cannot be retried without picking
      // a different file, which reads as the control being broken.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const inputId = `${fieldName}-file`;

  return (
    <div style={fieldStyle} data-testid={testId}>
      <label htmlFor={inputId} style={labelStyle}>
        {label}
      </label>

      <div style={rowStyle}>
        <span style={previewStyle} data-testid={`${testId}-preview`}>
          {path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={path} alt={name} style={imageStyle} data-testid={`${testId}-image`} />
          ) : (
            placeholder
          )}
        </span>

        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            // The three types SPEC-006 accepts. An `accept` hint, not a check —
            // the server sniffs magic bytes, because a filter on file extension
            // is advice to a file picker and nothing more.
            accept="image/jpeg,image/png,image/webp"
            disabled={busy || !ready}
            data-testid={`${testId}-input`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {path ? (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={busy || !ready}
              data-testid={`${testId}-remove`}
              onClick={() => {
                setPath(null);
                setError(null);
              }}
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>

      {busy ? (
        // `aria-live` so the state change is announced rather than only shown.
        <span role="status" style={labelStyle} data-testid={`${testId}-busy`}>
          Uploading…
        </span>
      ) : null}

      {error ? (
        <span role="alert" style={errorStyle} data-testid={`${testId}-error`}>
          {error}
        </span>
      ) : null}

      {/* The value the form submits. Empty string means "clear it", which is
          exactly what `validateMediaPath` reads it as. */}
      <input type="hidden" name={fieldName} value={path ?? ''} data-testid={`${testId}-value`} />
    </div>
  );
}

const avatarPreviewStyle: CSSProperties = {
  inlineSize: '96px',
  blockSize: '96px',
  flex: '0 0 auto',
  borderRadius: 'var(--radius-pill)',
  overflow: 'hidden',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
};

export interface AvatarUploaderProps {
  initialPath: string | null;
  name: string;
}

export function AvatarUploader({ initialPath, name }: AvatarUploaderProps) {
  return (
    <ImageUploader
      kind="avatar"
      fieldName="avatarPath"
      initialPath={initialPath}
      name={name}
      label="Profile photo"
      placeholder={<span aria-hidden="true">No photo</span>}
      previewStyle={avatarPreviewStyle}
      testId="avatar-uploader"
    />
  );
}
