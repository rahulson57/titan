/**
 * `/editor/new` — a blank document (SPEC-007).
 *
 * ── This route creates no row ─────────────────────────────────────────────
 * The obvious implementation is to insert a DRAFT here and redirect to
 * `/editor/<id>`. It is rejected deliberately: a page that writes on GET mints
 * an article for every visit, every refresh and every back-button press. All of
 * them belong to a real author — `/editor` is behind the session check — so all
 * of them appear in that author's drafts, and none of them contain anything.
 *
 * The row is created by the FIRST AUTOSAVE instead (`createDraftContent`), at
 * the first moment there is something to store. `Editor` then swaps its URL to
 * `/editor/<id>` with `history.replaceState`, so a refresh after that lands on
 * the draft rather than on another blank document — without a navigation that
 * would unmount the editor and take the author's cursor with it.
 *
 * ── Why `requireAuth()` when middleware already redirects ─────────────────
 * `middleware.ts` only checks that a `titan.session` COOKIE is present; it runs
 * on the Edge runtime and cannot reach SQLite to find out whether that cookie
 * names a live session. A hand-written cookie gets past it. This is the check
 * that resolves the session against the database, and it is the one that
 * decides `authorId` for whatever gets written.
 */

import type { Metadata } from 'next';

import { Editor } from '../../../components/editor/Editor';
import { requireAuth } from '../../../lib/auth/session';
import { emptyDoc } from '../../../lib/content/schema';

export const metadata: Metadata = { title: 'New story' };

export default async function NewStoryPage() {
  await requireAuth();

  return (
    <Editor
      draft={{
        id: null,
        title: '',
        subtitle: '',
        bodyJson: emptyDoc(),
        coverPath: null,
        tags: [],
        version: 0,
        status: 'DRAFT',
        slug: null,
      }}
    />
  );
}
