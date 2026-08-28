/**
 * `bodyJson` -> `bodyHtml`, and the derived caches that travel with it
 * (SPEC-007, "Sanitization boundary").
 *
 * > `bodyHtml` is generated server-side from `bodyJson` by
 * > `lib/content/render.ts` and is the ONLY HTML the article page renders.
 *
 * ── Why this is a `switch`, and why that is the security boundary ──────────
 * There is no template, no interpolation of a caller-supplied tag name, and no
 * pass-through branch. Every tag this module can emit is written as a literal
 * in `renderBlock`/`renderInline` below, and every text or attribute value goes
 * through `escapeText`/`escapeAttr` on the way out. That is what SPEC-007 means
 * by "safe by construction": producing a `<script>`, an `on*` attribute or a
 * `javascript:` URL would require adding a case for it here — it is not a
 * filter that could be bypassed, it is an output alphabet.
 *
 * Two independent guards therefore sit on the same path, and both are
 * deliberate. `lib/content/schema.ts` decides what may be in the DOCUMENT;
 * this module decides what may be in the HTML. A defect in either one is
 * caught by the other, and `tests/unit/content-sanitize.test.ts` asserts the
 * output of the pair rather than the internals of one.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * SPEC-007's last criterion compares the STORED `bodyHtml`, `bodyText` and
 * `readingMinutes` against the values recomputed here from the stored
 * `bodyJson`, and expects them to be exactly equal. So rendering has to be a
 * pure function of the document: no clock, no random ids, no configuration, no
 * whitespace that depends on how the document was built. Blocks are
 * concatenated with no separator and marks nest in a fixed order (`MARK_SPECS`
 * ranks them) for that reason.
 */

import { deriveReading } from '../derive/reading';
import {
  type ContentMark,
  type ContentNode,
  type MarkType,
  MARK_SPECS,
  sanitizeDoc,
  toProseMirrorNode,
} from './schema';

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Text content.
 *
 * `&` must be replaced first or the replacement's own ampersands get
 * re-encoded, turning `<` into `&amp;lt;` — which renders as the literal text
 * "&lt;" on the page.
 */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * An attribute value.
 *
 * Both quote characters are escaped, not just the double quote this module
 * happens to use. The reason is durability rather than present necessity: every
 * attribute below is written with `"`, so escaping `'` changes nothing today —
 * but the day someone writes one with single quotes, the value that closes it
 * early is already neutralised. Backtick is escaped for the same reason; older
 * IE treated it as a quote character in attribute values.
 */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}

function attr(name: string, value: string | number | undefined): string {
  if (value === undefined) return '';
  return ` ${name}="${escapeAttr(String(value))}"`;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

/** The single `<a>` this module can emit. */
function openLink(mark: ContentMark): string {
  const href = String(mark.attrs?.href ?? '');
  const title = mark.attrs?.title;

  // `rel` is unconditional rather than computed from the host. An external link
  // needs `noopener` (the opened page can otherwise reach back through
  // `window.opener`) and `nofollow` (an article body is user-submitted content
  // and should not pass ranking signal); an internal link is unharmed by
  // either. Deciding per-URL would mean parsing a host out of a relative URL,
  // which is a second place to get URL handling wrong for no gain.
  return `<a href="${escapeAttr(href)}"${attr('title', title)} rel="nofollow noopener noreferrer">`;
}

const MARK_TAGS: Readonly<Record<Exclude<MarkType, 'link'>, string>> = Object.freeze({
  bold: 'strong',
  italic: 'em',
  strike: 's',
  code: 'code',
});

function renderMarked(text: string, marks: ContentMark[] | undefined): string {
  const escaped = escapeText(text);
  if (!marks || marks.length === 0) return escaped;

  // Sorted defensively as well as in the sanitiser: this module is called
  // directly by the derive-consistency check on documents read back out of the
  // database, and a row written before a schema change could carry marks in
  // another order. Sorting here makes the render depend on the SET of marks,
  // not on their stored sequence.
  const ordered = [...marks].sort(
    (a, b) => (MARK_SPECS[a.type as MarkType]?.rank ?? 99) - (MARK_SPECS[b.type as MarkType]?.rank ?? 99),
  );

  let open = '';
  let close = '';
  for (const mark of ordered) {
    if (mark.type === 'link') {
      open += openLink(mark);
      close = `</a>${close}`;
      continue;
    }
    const tag = MARK_TAGS[mark.type as Exclude<MarkType, 'link'>];
    // Unreachable for a sanitised document, and deliberately a no-op rather
    // than a throw: rendering is on the read path for every article, and an
    // unrecognised mark should cost the reader a lost emphasis, not a 500.
    if (!tag) continue;
    open += `<${tag}>`;
    close = `</${tag}>${close}`;
  }
  return `${open}${escaped}${close}`;
}

function renderInline(node: ContentNode): string {
  switch (node.type) {
    case 'text':
      return renderMarked(node.text ?? '', node.marks);
    case 'hardBreak':
      return '<br />';
    default:
      return '';
  }
}

function renderInlineContent(node: ContentNode): string {
  return (node.content ?? []).map(renderInline).join('');
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderChildren(node: ContentNode): string {
  return (node.content ?? []).map(renderBlock).join('');
}

/** Text content with marks discarded — for a code block, whose content is text. */
function plainText(node: ContentNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(plainText).join('');
}

function renderBlock(node: ContentNode): string {
  switch (node.type) {
    case 'paragraph': {
      const inner = renderInlineContent(node);
      // An empty paragraph is rendered, not skipped: it is a deliberate blank
      // line in the author's document, and dropping it would make the rendered
      // article disagree with the editor the author was looking at.
      return `<p>${inner}</p>`;
    }

    case 'heading': {
      const level = node.attrs?.level === 3 ? 3 : 2;
      return `<h${level}>${renderInlineContent(node)}</h${level}>`;
    }

    case 'blockquote':
      return `<blockquote>${renderChildren(node)}</blockquote>`;

    case 'bulletList':
      return `<ul>${renderChildren(node)}</ul>`;

    case 'orderedList': {
      const start = node.attrs?.start;
      const startAttr = typeof start === 'number' && start !== 1 ? attr('start', start) : '';
      return `<ol${startAttr}>${renderChildren(node)}</ol>`;
    }

    case 'listItem':
      return `<li>${renderChildren(node)}</li>`;

    case 'codeBlock': {
      const language = node.attrs?.language;
      const className = typeof language === 'string' ? ` class="language-${escapeAttr(language)}"` : '';
      return `<pre><code${className}>${escapeText(plainText(node))}</code></pre>`;
    }

    case 'horizontalRule':
      return '<hr />';

    case 'image': {
      const src = String(node.attrs?.src ?? '');
      const alt = String(node.attrs?.alt ?? '');
      const title = node.attrs?.title;
      // `loading="lazy"` and `decoding="async"` are here rather than on the
      // reading page because this is the only place an article <img> is
      // produced. SPEC-002 budgets LCP < 1500ms, and an article with six
      // in-body images should not make the reader wait for the ones below the
      // fold. A figure wrapper is emitted only when there is a caption, so the
      // `.prose figure` rules in globals.css apply exactly when they are meant
      // to.
      const img = `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async" />`;
      if (typeof title !== 'string' || title.length === 0) return img;
      return `<figure>${img}<figcaption>${escapeText(title)}</figcaption></figure>`;
    }

    // Inline content that reached a block slot. Unreachable for a sanitised
    // document (`fitContent` wraps it in a paragraph), but rendering it inline
    // rather than dropping it means a hand-written document still shows its
    // text instead of silently rendering blank.
    case 'text':
    case 'hardBreak':
      return renderInline(node);

    case 'doc':
      return renderChildren(node);

    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/**
 * Render a document to `bodyHtml`.
 *
 * The document is sanitised first, unconditionally. Callers that have already
 * sanitised pay one idempotent pass; callers that forgot do not open a hole —
 * and "the renderer is safe only if you remembered to sanitise" is exactly the
 * contract that eventually gets forgotten.
 */
export function renderHtml(doc: unknown): string {
  return renderBlock(sanitizeDoc(doc));
}

/**
 * Everything a write path needs from a document, derived together.
 *
 * Returned as one object for the same reason `deriveReading` does it: a caller
 * cannot store a `bodyHtml` rendered from one document and a `bodyText`
 * derived from another. `doc` comes back too — it is the SANITISED document,
 * and it is what must be stored as `bodyJson`. Storing the raw input while
 * storing HTML derived from the sanitised version is the one way to make these
 * four columns disagree, and returning the sanitised doc is what makes that
 * mistake awkward to write.
 */
export interface DerivedContent {
  /** The sanitised document — this, not the input, is what `bodyJson` must hold. */
  doc: ContentNode;
  bodyHtml: string;
  bodyText: string;
  wordCount: number;
  readingMinutes: number;
}

export function deriveContent(raw: unknown): DerivedContent {
  const doc = sanitizeDoc(raw);
  const reading = deriveReading(toProseMirrorNode(doc));
  return {
    doc,
    bodyHtml: renderBlock(doc),
    bodyText: reading.bodyText,
    wordCount: reading.wordCount,
    readingMinutes: reading.readingMinutes,
  };
}

/**
 * The patterns SPEC-007's sanitisation criterion forbids in `bodyHtml`.
 *
 * Exported as a constant so the guard used by the tests and the one described
 * by the spec are the same object rather than two regexes that agree today.
 */
export const FORBIDDEN_HTML = /<script|on[a-z]+=|javascript:/i;

/** True when rendered HTML is free of the constructs the criterion names. */
export function isSafeHtml(html: string): boolean {
  return !FORBIDDEN_HTML.test(html);
}
