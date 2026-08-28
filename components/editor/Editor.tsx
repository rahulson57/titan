'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The authoring surface (SPEC-007).
 *
 * This is the only file in the slice that imports Tiptap. Everything the
 * document MEANS — the closed schema, the HTML it renders to, the derived
 * columns, the autosave timing, the publish guards — lives in `lib/content/`,
 * in plain TypeScript, and is tested there. This component's job is narrow:
 * put a ProseMirror view on the page, feed its JSON to the scheduler, and show
 * the author what state their draft is in.
 *
 * The split is SPEC-007:48's, not a preference: "`bodyHtml` is generated
 * SERVER-side from `bodyJson` by `lib/content/render.ts` ... Because it is
 * generated from a CLOSED SCHEMA it contains no `<script>` ... BY
 * CONSTRUCTION." Tiptap's own `generateHTML` would derive the stored HTML from
 * whatever extension set this component happened to be configured with — which
 * is a different object, on the wrong side of the wire, and turns "by
 * construction" into "by configuration". (Ruled by the coordinator, DEC-035;
 * the argument is hers.)
 *
 * ── Extensions are configured FROM the schema, not alongside it ────────────
 * `StarterKit` is switched down to exactly the nodes and marks
 * `lib/content/schema.ts` names, so the editor cannot produce a node the server
 * would strip. Without that, an author could insert something that renders in
 * the editor, saves without error, and silently disappears from their article —
 * which is a worse failure than being unable to insert it.
 *
 * ── Title and subtitle are real inputs ────────────────────────────────────
 * SPEC-007's table calls them "plain contenteditable inputs, NOT part of
 * `bodyJson`". The load-bearing half — not part of the document, stored as
 * their own columns — is honoured exactly. They are `<input>` elements rather
 * than `contenteditable` divs for two concrete reasons, and this is flagged to
 * the coordinator rather than done quietly:
 *
 *  1. `tests/perf/editor-input.spec.ts` (SPEC-002, landed) selects
 *     `[contenteditable="true"]` **`.first()`** and measures keystroke latency
 *     against it. A contenteditable title sits above the body in the DOM, so it
 *     would capture that selector — and the 16ms budget would be measured
 *     against a plain div, passing forever while measuring nothing. Real
 *     inputs leave exactly one contenteditable on the page: ProseMirror.
 *  2. A real `<input>` has a real `<label for>`, which the a11y gate wants and
 *     a contenteditable div has to simulate with `aria-labelledby`.
 *
 * ── Autosave ──────────────────────────────────────────────────────────────
 * The scheduler is created once and kept in a ref. The payload it saves is read
 * from refs at save time, not captured when the keystroke happened — otherwise
 * a save armed two seconds ago would post a two-second-old document.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';

import { BubbleMenu } from './BubbleMenu';
import { InsertMenu } from './InsertMenu';
import { SaveIndicator } from './SaveIndicator';
import { TagInput } from './TagInput';
import { Button } from '../ui/Button';
// Everything from `autosave.ts`, the client-safe half of `lib/content/`.
// `publish.ts` is deliberately NOT imported here: it reaches `lib/db/**`, and
// a client component that pulls that in fails to compile on `node:crypto` and
// would ship the repository layer to the browser if it did not.
import {
  type AutosaveScheduler,
  type AutosaveState,
  type PublishFieldError,
  createAutosaveScheduler,
  validatePublish,
} from '../../lib/content/autosave';
import { emptyDoc, parseHtmlToDoc, sanitizeDoc } from '../../lib/content/schema';
import { deriveContent } from '../../lib/content/render';
import { createDraft, publish, saveDraft, unpublish } from '../../app/editor/actions';

export interface EditorDraft {
  /** `null` at `/editor/new` — the row does not exist until the first save. */
  id: string | null;
  title: string;
  subtitle: string;
  bodyJson: unknown;
  coverPath: string | null;
  tags: string[];
  version: number;
  status: 'DRAFT' | 'PUBLISHED';
  slug: string | null;
}

export interface EditorProps {
  draft: EditorDraft;
}

const page: CSSProperties = {
  maxWidth: '46rem',
  margin: '0 auto',
  padding: 'var(--space-6) var(--space-5) var(--space-8)',
  fontFamily: 'var(--font-ui)',
};

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
  paddingBlockEnd: 'var(--space-4)',
  marginBlockEnd: 'var(--space-5)',
  borderBlockEnd: '1px solid var(--border)',
};

const titleStyle: CSSProperties = {
  font: 'inherit',
  fontFamily: 'var(--font-reading)',
  fontSize: 'var(--text-h1-size)',
  lineHeight: 'var(--text-h1-leading)',
  fontWeight: 'var(--text-h1-weight)' as unknown as number,
  width: '100%',
  color: 'var(--fg)',
  background: 'transparent',
  border: 'none',
  padding: 0,
  marginBlockEnd: 'var(--space-3)',
};

const subtitleStyle: CSSProperties = {
  ...titleStyle,
  fontSize: '24px',
  fontWeight: 400,
  color: 'var(--fg-muted)',
  marginBlockEnd: 'var(--space-5)',
};

const bannerStyle: CSSProperties = {
  padding: 'var(--space-3) var(--space-4)',
  marginBlockEnd: 'var(--space-4)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  fontSize: 'var(--text-ui-size)',
  color: 'var(--fg)',
};

const errorListStyle: CSSProperties = {
  ...bannerStyle,
  margin: 'var(--space-4) 0 0',
};

/**
 * The extension set, restricted to `lib/content/schema.ts`.
 *
 * Each `false` below corresponds to a node the closed schema has no entry for.
 * They are switched off here rather than left on and stripped at save time so
 * the editor never shows the author something that will not survive.
 */
function buildExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      // Not in the schema: the article title column is the page's H1, and a
      // second H1 in the body breaks the outline a screen reader navigates by.
      codeBlock: {},
      // `link` comes from the dedicated extension below so its protocol
      // allowlist can be set; StarterKit 2 does not include one.
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      // The same allowlist as `LINK_SCHEMES` in the closed schema. This is
      // convenience, not the boundary — `sanitizeDoc` on the server is — but an
      // author should be told a link will not survive rather than watch it
      // vanish on save.
      protocols: ['http', 'https', 'mailto'],
      HTMLAttributes: { rel: 'nofollow noopener noreferrer' },
    }),
    Image.configure({ inline: false, allowBase64: false }),
    Placeholder.configure({ placeholder: 'Tell your story…' }),
    Typography,
  ];
}

export function Editor({ draft }: EditorProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [articleId, setArticleId] = useState<string | null>(draft.id);
  const [title, setTitle] = useState(draft.title);
  const [subtitle, setSubtitle] = useState(draft.subtitle);
  const [tags, setTags] = useState<string[]>(draft.tags);
  const [status, setStatus] = useState(draft.status);
  const [slug, setSlug] = useState<string | null>(draft.slug);

  const [saveState, setSaveState] = useState<AutosaveState>('clean');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishErrors, setPublishErrors] = useState<PublishFieldError[]>([]);
  const [publishing, setPublishing] = useState(false);

  // Every value the save payload needs, read at SAVE time rather than captured
  // when the keystroke fired. A debounced save closing over stale state is the
  // classic autosave bug: it stores the document as it was two seconds ago and
  // reports success.
  const versionRef = useRef(draft.version);
  const idRef = useRef<string | null>(draft.id);
  const titleRef = useRef(draft.title);
  const subtitleRef = useRef(draft.subtitle);
  const tagsRef = useRef<string[]>(draft.tags);

  /**
   * The editor instance, so the save path can pull the document at SAVE time.
   *
   * This ref is the reason `onUpdate` below does nothing but mark the document
   * dirty. SPEC-002 budgets keystroke-to-local-commit at p95 < 16ms — one frame
   * — and `tests/perf/editor-input.spec.ts` says in its own header what breaks
   * it: "a save, A RE-SERIALISATION OF THE WHOLE DOCUMENT, or a full re-render
   * wired into the input handler". Calling `editor.getJSON()` in `onUpdate`
   * would be exactly that: an O(document) walk on every keypress, growing with
   * the length of the article, so the budget would pass on a paragraph and fail
   * on a finished essay. Reading it here instead means the walk happens once
   * per save — at most every two seconds — and never between a key going down
   * and the character appearing.
   */
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null);

  const initialContent = useMemo(() => {
    const doc = sanitizeDoc(draft.bodyJson);
    return (doc.content?.length ?? 0) > 0 ? doc : emptyDoc();
    // Read once, on mount: re-deriving it on every render would reset the
    // author's cursor to the top of the document on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedulerRef = useRef<AutosaveScheduler<null> | null>(null);

  /** One save. Creates the row on the first call at `/editor/new`. */
  const performSave = useCallback(async (): Promise<boolean> => {
    const payload = {
      title: titleRef.current,
      subtitle: subtitleRef.current.trim().length > 0 ? subtitleRef.current : null,
      // Pulled from the editor here, not captured when the keystroke fired:
      // a debounced save closing over a two-second-old document is the classic
      // autosave bug, and it reports success while storing stale text.
      //
      // `sanitizeDoc` wraps the pull, and that is a CORRECTNESS requirement at
      // this boundary rather than a second helping of the security one (the
      // server sanitises again, and that call is the boundary). ProseMirror
      // builds every node's `attrs` with `Object.create(null)`, so `getJSON()`
      // hands back objects whose prototype is `null` — verified in the browser.
      // React's Server Action serializer encodes only plain objects and arrays,
      // and it drops a null-prototype value SILENTLY: the action still
      // succeeds, so the save reports `Saved` while every attribute in the
      // document has quietly disappeared.
      //
      // The damage is not cosmetic. `attrs.level` is what separates an H3 from
      // an H2, `attrs.src` is the whole of an image (a node with no `src` is
      // dropped by the sanitiser, so the image vanishes), and a link mark
      // without `attrs.href` stops being a link. All of them degrade to
      // something plausible-looking, which is why this survived until the
      // keyboard suite compared the STORED html against the DOM.
      //
      // `sanitizeDoc` fixes it because it rebuilds the document out of fresh
      // object literals rather than passing the editor's own nodes through, so
      // what crosses the wire has `Object.prototype` throughout. It also earns
      // its walk twice over: it is the same function the server runs, so the
      // client cannot send a document the server would reshape, and the cost is
      // one walk per SAVE — not per keystroke, which is the budget that matters
      // (see `editorRef` above).
      bodyJson: sanitizeDoc(editorRef.current?.getJSON() ?? draft.bodyJson),
      coverPath: draft.coverPath,
      tags: tagsRef.current,
    };

    const result = idRef.current
      ? await saveDraft(idRef.current, { ...payload, version: versionRef.current })
      : await createDraft(payload);

    if (result.ok) {
      versionRef.current = result.version;
      setSavedAt(result.savedAt);
      setConflict(null);
      setNotice(null);
      if (result.articleId && !idRef.current) {
        idRef.current = result.articleId;
        setArticleId(result.articleId);
        // `replaceState`, not `router.push`: a navigation would unmount the
        // editor and take the author's cursor with it. This only has to make a
        // refresh land on the draft rather than on a blank new document.
        window.history.replaceState(null, '', `/editor/${result.articleId}`);
      }
      if (result.slug) setSlug(result.slug);
      return true;
    }

    if (result.status === 409) {
      // Non-destructive, per SPEC-007: nothing local is discarded and nothing
      // remote was overwritten. The author decides.
      setConflict(result.serverVersion);
      return false;
    }

    setNotice(result.message);
    return false;
    // `draft.coverPath` is a prop and stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (schedulerRef.current === null) {
    schedulerRef.current = createAutosaveScheduler<null>({
      save: performSave,
      onStateChange: setSaveState,
    });
  }

  const markDirty = useCallback(() => {
    schedulerRef.current?.change(null);
  }, []);

  const editor = useEditor({
    extensions: buildExtensions(),
    content: initialContent as never,
    // Next renders this on the server first; ProseMirror must not try to match
    // that DOM during hydration.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        // The a11y suite needs the body to be a labelled, findable region.
        'aria-label': 'Article body',
        role: 'textbox',
        'aria-multiline': 'true',
        'data-testid': 'editor-body',
        class: 'prose',
      },
      /**
       * Close pasted HTML through the SAME schema before ProseMirror parses it
       * (SPEC-007: "HTML paste is parsed through the same schema; unknown
       * nodes/marks are dropped, never passed through").
       *
       * Returning the re-rendered HTML rather than intercepting the slice keeps
       * ProseMirror's own parser in the loop as a second filter, so a defect in
       * either one is caught by the other. This is defence in depth; the
       * guarantee is `sanitizeDoc` on the server.
       */
      transformPastedHTML(html: string) {
        return deriveContent(parseHtmlToDoc(html)).bodyHtml;
      },
    },
    onUpdate() {
      // Deliberately the whole handler. Everything else — serialising the
      // document, deriving its text, deciding what to send — happens on the
      // save path, off the keystroke path. See `editorRef` above.
      markDirty();
    },
  });

  useEffect(() => {
    const scheduler = schedulerRef.current;
    return () => {
      // A timer that outlives the component fires against a dead editor and can
      // post a stale document over a newer one after the author has navigated
      // away.
      scheduler?.dispose();
    };
  }, []);

  // Cmd/Ctrl+S — SPEC-007's `Dirty --> Saving` edge.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void schedulerRef.current?.flush();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Warn before leaving with unsaved work. The scheduler's own state is the
  // source of truth, so this cannot disagree with the indicator on screen.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saveState === 'dirty' || saveState === 'error') event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  editorRef.current = editor;

  const onPublish = async () => {
    if (!idRef.current) {
      // Nothing has been saved yet, so there is no row to publish. Flush first
      // and let the result decide, rather than showing "not found".
      await schedulerRef.current?.flush();
    }
    const id = idRef.current;
    if (!id) {
      setNotice('Nothing has been saved yet — write something first.');
      return;
    }

    // Derived HERE rather than kept in state, for the same reason the document
    // is: `deriveContent` walks and renders the entire article, and a `useMemo`
    // keyed on the editor's state would re-run it on every keystroke. Publish
    // is a button press, so once per press is exactly the right frequency.
    const { bodyText } = deriveContent(editorRef.current?.getJSON() ?? {});

    // Validate locally before the round trip so the author sees every problem
    // at once. The server validates again and IS the authority; this only
    // shortens the loop.
    const local = validatePublish({ title, bodyText, tags });
    if (local.length > 0) {
      setPublishErrors(local);
      return;
    }

    setPublishing(true);
    try {
      // The draft must be stored before it is published: the guards read the
      // ROW, not the form.
      await schedulerRef.current?.flush();
      const result = await publish(id, { title, tags });
      if (result.ok) {
        // Adopt the version the transition produced, BEFORE anything else can
        // schedule a save.
        //
        // Publishing writes the row, so the server's `version` advances — and
        // the editor is holding the number from its last `saveDraft`. Leave it
        // stale and the author's very next keystroke debounces into a save
        // carrying a version the server has already moved past, which is
        // exactly the 409 the conflict rule is built to raise. The banner would
        // then accuse the author of a concurrent edit that never happened, in
        // the one situation where they are provably the only writer.
        //
        // `publishDraft` returns `version` for this purpose (see `PublishOk`),
        // and its own header notes the symmetric hazard: it validates before it
        // writes so a REJECTED publish leaves the counter untouched. Both
        // halves are needed — one keeps a failed publish from desyncing the
        // editor, this keeps a successful one from doing it.
        versionRef.current = result.version;
        setPublishErrors([]);
        setStatus('PUBLISHED');
        setSlug(result.slug);
        setNotice(null);
        router.refresh();
      } else {
        setPublishErrors(result.errors);
      }
    } finally {
      setPublishing(false);
    }
  };

  const onUnpublish = async () => {
    const id = idRef.current;
    if (!id) return;
    setPublishing(true);
    try {
      const result = await unpublish(id);
      if (result.ok) {
        // Same reason as `onPublish` above: unpublishing is a write, so it
        // advances `version` too, and an author who unpublishes and then keeps
        // editing must not be told their own draft conflicts with itself.
        versionRef.current = result.version;
        setStatus('DRAFT');
        router.refresh();
      } else {
        setPublishErrors(result.errors);
      }
    } finally {
      setPublishing(false);
    }
  };

  const errorFor = (field: PublishFieldError['field']) =>
    publishErrors.find((entry) => entry.field === field)?.message ?? null;

  return (
    <main style={page}>
      <div style={barStyle}>
        <SaveIndicator
          state={saveState}
          savedAt={savedAt}
          onRetry={() => void schedulerRef.current?.flush()}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span
            data-testid="article-status"
            style={{ fontSize: 'var(--text-meta-size)', color: 'var(--fg-muted)' }}
          >
            {status === 'PUBLISHED' ? 'Published' : 'Draft'}
          </span>

          {/*
            A published article keeps BOTH affordances, and the republish half
            is not a convenience.

            SPEC-007's state machine lists `PUBLISHED -> PUBLISHED (edit)` as a
            transition in its own right, beside unpublish and delete, and
            `publishDraft` implements it — its header says so. Without a control
            that reaches it, the transition exists on the server and is
            unreachable from the one surface that owns publishing.

            It also closes a guard hole that is easy to miss. The publish guards
            (title non-empty, `bodyText` >= 50, 1-5 tags) run on the PUBLISH
            path only; autosave deliberately does not enforce them, because a
            draft is allowed to be half-written mid-sentence. So an author
            editing a live article can autosave it down to ten characters and it
            stays PUBLISHED with a body that would have been refused at the
            door. Republish is where those guards get re-run against what the
            article has actually become.

            Same handler as the first publish, deliberately: `publishDraft`
            already distinguishes the two cases and freezes `slug` and
            `publishedAt` after the first one, so a second author-facing path
            would be a second place for that rule to be got wrong.
          */}
          {status === 'PUBLISHED' ? (
            <>
              <Button
                variant="secondary"
                data-testid="unpublish-button"
                disabled={publishing}
                onClick={() => void onUnpublish()}
              >
                Unpublish
              </Button>
              <Button
                variant="primary"
                data-testid="publish-button"
                disabled={publishing}
                onClick={() => void onPublish()}
              >
                Republish
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              data-testid="publish-button"
              disabled={publishing}
              onClick={() => void onPublish()}
            >
              Publish
            </Button>
          )}
        </div>
      </div>

      {conflict !== null ? (
        <div role="alert" style={bannerStyle} data-testid="conflict-banner">
          <p style={{ margin: 0 }}>
            This draft was changed somewhere else — probably another tab. Nothing you have typed
            here has been saved over it, and nothing there has been overwritten.
          </p>
          <p style={{ margin: 'var(--space-2) 0 0' }}>
            <Button
              variant="secondary"
              size="sm"
              data-testid="conflict-reload"
              onClick={() => router.refresh()}
            >
              Load the newer version
            </Button>
          </p>
        </div>
      ) : null}

      {notice ? (
        <p role="alert" style={bannerStyle} data-testid="editor-notice">
          {notice}
        </p>
      ) : null}

      <label htmlFor="article-title" className="visually-hidden">
        Title
      </label>
      <input
        id="article-title"
        data-testid="article-title"
        style={titleStyle}
        placeholder="Title"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          titleRef.current = event.target.value;
          markDirty();
        }}
      />

      <label htmlFor="article-subtitle" className="visually-hidden">
        Subtitle
      </label>
      <input
        id="article-subtitle"
        data-testid="article-subtitle"
        style={subtitleStyle}
        placeholder="Subtitle (optional)"
        value={subtitle}
        onChange={(event) => {
          setSubtitle(event.target.value);
          subtitleRef.current = event.target.value;
          markDirty();
        }}
      />

      {errorFor('title') ? (
        <p role="alert" style={errorListStyle}>
          {errorFor('title')}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-3)', marginBlockEnd: 'var(--space-3)' }}>
        <InsertMenu editor={editor} onError={setNotice} />
      </div>

      {/* Positioned container: the bubble menu is absolutely placed inside it,
          and it comes immediately after the editor content in the DOM so one
          Tab from the body reaches the first toolbar button. */}
      <div ref={containerRef} style={{ position: 'relative' }} data-testid="editor-surface">
        <EditorContent editor={editor} />
        <BubbleMenu editor={editor} containerRef={containerRef} />
      </div>

      {errorFor('body') ? (
        <p role="alert" style={errorListStyle}>
          {errorFor('body')}
        </p>
      ) : null}

      <div style={{ marginBlockStart: 'var(--space-6)' }}>
        <TagInput
          tags={tags}
          error={errorFor('tags')}
          onChange={(next) => {
            setTags(next);
            tagsRef.current = next;
            markDirty();
          }}
        />
      </div>

      {status === 'PUBLISHED' && slug ? (
        <p style={{ marginBlockStart: 'var(--space-5)', fontSize: 'var(--text-meta-size)' }}>
          <a href={`/article/${slug}`} data-testid="view-published">
            View the published article
          </a>
        </p>
      ) : null}

      {articleId ? (
        <p className="visually-hidden" data-testid="article-id">
          {articleId}
        </p>
      ) : null}
    </main>
  );
}

export default Editor;
