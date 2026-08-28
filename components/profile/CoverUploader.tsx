'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The cover picker on `/settings/profile` (SPEC-010).
 *
 * > cover — uploaded via `/api/upload?kind=cover`, replaces `coverPath`
 *
 * The upload/error/preview machinery is `ImageUploader`, which lives in
 * `AvatarUploader.tsx` — see the note there for why it is in that file rather
 * than a third one this slice was not granted. What differs for a cover is
 * only the four values passed below.
 *
 * The preview is a 3:1 band because that is the crop box SPEC-010 gives the
 * cover on the public profile. Showing a square here and a 3:1 slice there is
 * how someone picks an image whose subject is outside the crop and only finds
 * out after saving.
 */

import { ImageUploader } from './AvatarUploader';
import type { CSSProperties } from 'react';

const coverPreviewStyle: CSSProperties = {
  inlineSize: '240px',
  aspectRatio: '3 / 1',
  flex: '0 0 auto',
  borderRadius: 'var(--radius-md)',
  overflow: 'hidden',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
};

export interface CoverUploaderProps {
  initialPath: string | null;
  name: string;
}

export function CoverUploader({ initialPath, name }: CoverUploaderProps) {
  return (
    <ImageUploader
      kind="cover"
      fieldName="coverPath"
      initialPath={initialPath}
      name={`${name}'s cover image`}
      label="Cover image"
      placeholder={<span aria-hidden="true">No cover</span>}
      previewStyle={coverPreviewStyle}
      testId="cover-uploader"
    />
  );
}
