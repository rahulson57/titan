/**
 * `/editor/[id]` — an existing draft or published article (SPEC-007).
 *
 * ── Authorization is on the path to the data, not beside it ───────────────
 * `requireArticleOwner` is called with the loaded row and RETURNS it. That
 * shape is deliberate and it is `lib/auth/session.ts`'s own reasoning: a guard
 * that answers a boolean can be checked and then ignored, and the resulting bug
 * — a render that happened despite a failed check — is invisible in review
 * because the check sits three lines above it. Here the article is unreachable
 * unless the check passed.
 *
 * The status codes come from SPEC-005 and they are not interchangeable:
 *
 *  - a stranger asking for someone else's DRAFT gets **404**, not 403. A 403
 *    would confirm the id names a real unpublished article, turning a guessable
 *    URL into an oracle that leaks an author's titles one guess at a time.
 *  - a signed-in non-author asking for someone else's PUBLISHED article gets
 *    **403**: they already know it exists, so hiding behind a 404 would obscure
 *    a real permission error for no privacy gain.
 *
 * `notFound()` is Next's 404; the 403 case renders a page rather than throwing,
 * because a thrown error in a Server Component reaches the reader as the
 * generic error boundary, which says nothing useful and offers no way out.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Editor } from '../../../components/editor/Editor';
import { getArticleById } from '../../../lib/db/articles';
import { listTagsForArticle } from '../../../lib/db/tags';
import { ForbiddenError, auth, requireArticleOwner } from '../../../lib/auth/session';
import { sanitizeDoc } from '../../../lib/content/schema';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const article = await getArticleById(id);
  // Deliberately does NOT run the ownership check: metadata is generated for a
  // page that may be about to 404, and leaking a draft's title into a <title>
  // tag would defeat the 404 the page itself is careful to return.
  return { title: article ? 'Editing' : 'Not found' };
}

export default async function EditArticlePage({ params }: PageProps) {
  const { id } = await params;

  const session = await auth();
  const article = await getArticleById(id);

  try {
    requireArticleOwner(session?.user ?? null, article);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return (
        <main style={{ maxWidth: '46rem', margin: '0 auto', padding: 'var(--space-8) var(--space-5)' }}>
          <h1>You cannot edit this article</h1>
          <p>It belongs to somebody else. You can still read it.</p>
        </main>
      );
    }
    // Everything else — absent, or a draft belonging to someone else — is a 404.
    notFound();
  }

  if (!article) notFound();

  const tags = await listTagsForArticle(id);

  return (
    <Editor
      draft={{
        id: article.id,
        title: article.title,
        subtitle: article.subtitle ?? '',
        // Sanitised on the way OUT as well as on the way in. A row written
        // before a schema change could carry a node this editor no longer
        // knows; closing it here means the editor is fed a document it can
        // definitely represent, rather than silently dropping the difference on
        // the next save.
        bodyJson: sanitizeDoc(article.bodyJson),
        coverPath: article.coverPath,
        tags: tags.map((tag) => tag.name),
        version: article.version,
        status: article.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
        slug: article.slug,
      }}
    />
  );
}
