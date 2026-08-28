/**
 * The closed content schema (SPEC-007).
 *
 * > Because it is generated from a closed schema it contains no `<script>`, no
 * > `on*` attribute, and no `javascript:` URL **by construction**.
 *
 * That sentence is the whole design, and "by construction" is the part worth
 * defending. The usual way to make user HTML safe is to take arbitrary HTML and
 * remove the bad parts — a denylist, which is only ever as good as the list.
 * This module inverts it: nothing enters a document unless a node type, a mark
 * type and an attribute name are all named HERE, and `lib/content/render.ts`
 * can only emit tags it has an explicit case for. A `<script>` is not filtered
 * out; there is no path that could produce one.
 *
 * ── Why this is plain TypeScript and not Tiptap ─────────────────────────────
 * Tiptap owns the *editing* surface, in `components/editor/`. It does not own
 * this, for three reasons:
 *
 *  1. `bodyHtml` is served to every reader on the article page. Deriving it
 *     from the browser's extension configuration would make the security
 *     boundary depend on how a client component happened to be constructed —
 *     and the boundary belongs on the server, below the point where anything a
 *     client sends can influence it.
 *  2. SPEC-002 puts an 80% statement-coverage floor on `lib/**`. Keeping this
 *     pure means the hostile-input suite runs under Vitest in milliseconds with
 *     no DOM, which is the only way an exhaustive one gets written.
 *  3. It is the same schema either way. The node and mark tables below are
 *     exactly SPEC-007's extension allowlist (StarterKit + Link, Image,
 *     Placeholder, CodeBlock, Blockquote, HorizontalRule, Typography), and
 *     `components/editor/Editor.tsx` is configured FROM them — so there is one
 *     list, not two that can drift.
 *
 * ── The entry points, and which one is the guarantee ───────────────────────
 *  - `sanitizeDoc(unknown)`  — JSON document -> closed document. This is the
 *    one that matters: it runs SERVER-side on every save, so whatever a client
 *    posts, the stored `bodyJson` is inside the schema.
 *  - `parseHtmlToDoc(html)`  — HTML -> closed document. Used on the paste path,
 *    where it closes pasted markup before ProseMirror ever parses it.
 *  - `sanitizeUrl` / `sanitizeSrc` — the URL allowlist both of the above use.
 *
 * Defence in depth is deliberate, and the layers are not equal. Removing the
 * paste parser would cost fidelity. Removing `sanitizeDoc` would cost safety —
 * which is why it sits on the write path and not in a component.
 */

import type { ProseMirrorNode } from '../derive/reading';

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

export interface ContentMark {
  type: string;
  attrs?: Record<string, string | number>;
}

export interface ContentNode {
  type: string;
  attrs?: Record<string, string | number>;
  content?: ContentNode[];
  marks?: ContentMark[];
  text?: string;
}

/**
 * A document with no content.
 *
 * ProseMirror's `doc` requires at least one block, so this is a doc holding one
 * empty paragraph rather than an empty `content` array — an editor initialised
 * from `{ type: 'doc', content: [] }` has no valid cursor position and refuses
 * the first keystroke.
 */
export const EMPTY_DOC: ContentNode = { type: 'doc', content: [{ type: 'paragraph' }] };

/** A fresh copy, so a caller mutating its document cannot corrupt the constant. */
export function emptyDoc(): ContentNode {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

// ---------------------------------------------------------------------------
// The node table
// ---------------------------------------------------------------------------

/**
 * What a node may contain.
 *
 *  - `block`    — only block nodes (`doc`, `blockquote`, `listItem`)
 *  - `inline`   — only inline nodes (`paragraph`, `heading`)
 *  - `listItem` — only list items (`bulletList`, `orderedList`)
 *  - `text`     — text only, marks stripped (`codeBlock`)
 *  - `leaf`     — nothing (`image`, `horizontalRule`, `hardBreak`, `text`)
 */
export type ContentKind = 'block' | 'inline' | 'listItem' | 'text' | 'leaf';

/** Which slot a node occupies in its parent. */
export type NodeGroup = 'block' | 'inline' | 'listItem';

export interface NodeSpec {
  /** What this node may contain. */
  readonly content: ContentKind;
  /** Which slot it occupies in its parent. */
  readonly group: NodeGroup;
  /** Attribute names that can survive sanitisation. Everything else is dropped. */
  readonly attrs: readonly string[];
  /** Drop the node when it ends up with no content (an empty `<blockquote>`). */
  readonly dropWhenEmpty?: boolean;
}

/**
 * Every node type this application can represent — SPEC-007's extension list,
 * one entry each.
 *
 * `heading` is restricted to levels 2 and 3 by `nodeAttrs` below, not merely by
 * the toolbar: the article's `title` column is the page's H1, so an H1 inside
 * the body would produce two and break the document outline a screen reader
 * navigates by. SPEC-007's toolbar offers exactly H2 and H3 for this reason.
 */
export const NODE_SPECS = {
  doc: { content: 'block', group: 'block', attrs: [] },
  paragraph: { content: 'inline', group: 'block', attrs: [] },
  heading: { content: 'inline', group: 'block', attrs: ['level'] },
  blockquote: { content: 'block', group: 'block', attrs: [], dropWhenEmpty: true },
  codeBlock: { content: 'text', group: 'block', attrs: ['language'] },
  bulletList: { content: 'listItem', group: 'block', attrs: [], dropWhenEmpty: true },
  orderedList: { content: 'listItem', group: 'block', attrs: ['start'], dropWhenEmpty: true },
  listItem: { content: 'block', group: 'listItem', attrs: [], dropWhenEmpty: true },
  horizontalRule: { content: 'leaf', group: 'block', attrs: [] },
  image: { content: 'leaf', group: 'block', attrs: ['src', 'alt', 'title'] },
  hardBreak: { content: 'leaf', group: 'inline', attrs: [] },
  text: { content: 'leaf', group: 'inline', attrs: [] },
} as const satisfies Record<string, NodeSpec>;

export type NodeType = keyof typeof NODE_SPECS;

export const ALLOWED_NODES: readonly string[] = Object.freeze(Object.keys(NODE_SPECS));

export function isAllowedNode(type: string): type is NodeType {
  return Object.prototype.hasOwnProperty.call(NODE_SPECS, type);
}

// ---------------------------------------------------------------------------
// The mark table
// ---------------------------------------------------------------------------

export interface MarkSpec {
  readonly attrs: readonly string[];
  /**
   * Nesting order when a text node carries several marks.
   *
   * Fixed rather than "whatever order the client sent", because the derive
   * consistency criterion compares stored `bodyHtml` byte-for-byte against a
   * re-render of `bodyJson`. Two renders of the same document differing only in
   * whether `<strong>` sits inside `<em>` or outside it would fail that check
   * for a difference no reader could see.
   */
  readonly rank: number;
}

export const MARK_SPECS = {
  link: { attrs: ['href', 'title'], rank: 0 },
  bold: { attrs: [], rank: 1 },
  italic: { attrs: [], rank: 2 },
  strike: { attrs: [], rank: 3 },
  code: { attrs: [], rank: 4 },
} as const satisfies Record<string, MarkSpec>;

export type MarkType = keyof typeof MARK_SPECS;

export const ALLOWED_MARKS: readonly string[] = Object.freeze(Object.keys(MARK_SPECS));

export function isAllowedMark(type: string): type is MarkType {
  return Object.prototype.hasOwnProperty.call(MARK_SPECS, type);
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Schemes a link may use. */
export const LINK_SCHEMES: readonly string[] = Object.freeze(['http', 'https', 'mailto']);

/** Schemes an image may use. Deliberately narrower — no `mailto:`, no `data:`. */
export const IMAGE_SCHEMES: readonly string[] = Object.freeze(['http', 'https']);

/**
 * Characters a browser discards from a URL before it resolves the scheme.
 *
 * This is not cosmetic trimming, and it is the single most important line in
 * the URL handling. `java\tscript:alert(1)` navigates in every major browser,
 * because the URL parser strips tabs, newlines and C0 controls *before* it
 * looks for the colon. A scheme check run against the raw string therefore sees
 * `java\tscript`, which is not in the allowlist — so it falls through as a
 * "relative URL" and the attribute reaches the page intact, working. Stripping
 * first means the check sees exactly what the browser will see.
 */
const URL_IGNORED = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

/**
 * The scheme of a URL, lowercased, or `null` when it has none (a relative URL).
 *
 * A scheme is `[a-z][a-z0-9+.-]*` followed by `:`, and it must come before any
 * `/`, `?` or `#` — otherwise `./a:b`, a relative path that happens to contain
 * a colon, would read as the scheme `./a`.
 */
export function urlScheme(url: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!match) return null;
  const name = match[1] ?? '';
  if (/[/?#]/.test(name)) return null;
  return name.toLowerCase();
}

function sanitizeWithSchemes(raw: unknown, schemes: readonly string[]): string | null {
  if (typeof raw !== 'string') return null;

  const cleaned = raw.replace(URL_IGNORED, '');
  if (cleaned.length === 0) return null;
  if (cleaned.length > 2048) return null;

  // Protocol-relative (`//evil.example`) is rejected rather than resolved. It
  // inherits the page's scheme, so it is not dangerous in the `javascript:`
  // sense — but this application serves one origin on localhost and has no use
  // for one, and a stored URL whose host is decided by the deployment is
  // exactly the kind of thing that should not be in an article body.
  if (cleaned.startsWith('//')) return null;

  const scheme = urlScheme(cleaned);
  // No scheme at all is a relative or root-relative URL — `/uploads/...`, which
  // is where SPEC-006 puts local media.
  if (scheme === null) return cleaned;

  return schemes.includes(scheme) ? cleaned : null;
}

/** A link `href`, or `null` if it is not one this application will emit. */
export function sanitizeUrl(raw: unknown): string | null {
  return sanitizeWithSchemes(raw, LINK_SCHEMES);
}

/** An image `src`, or `null`. Narrower than `sanitizeUrl` — see `IMAGE_SCHEMES`. */
export function sanitizeSrc(raw: unknown): string | null {
  return sanitizeWithSchemes(raw, IMAGE_SCHEMES);
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Narrow a node's attributes to the allowlist, coercing each to its declared
 * type and dropping anything that fails.
 *
 * `{ ok: false }` drops the whole node, and it is used for exactly one case: an
 * `image` whose `src` did not survive. An `<img>` with no `src` renders as a
 * broken-image icon in the middle of an article, which is worse for a reader
 * than the image simply not being there.
 */
function nodeAttrs(
  type: NodeType,
  raw: unknown,
): { ok: true; attrs?: Record<string, string | number> } | { ok: false } {
  const source = isRecord(raw) ? raw : {};
  const out: Record<string, string | number> = {};

  switch (type) {
    case 'heading': {
      // Levels 2 and 3 only. Anything else becomes an H2 rather than being
      // dropped: a pasted H1 is still a heading, and turning it into a
      // paragraph would silently lose the author's structure.
      out.level = Number(source.level) === 3 ? 3 : 2;
      break;
    }
    case 'orderedList': {
      const start = Number(source.start);
      if (Number.isInteger(start) && start > 0 && start <= 1_000_000) out.start = start;
      break;
    }
    case 'codeBlock': {
      const language = readString(source, 'language');
      // Rendered into `class="language-…"`, so it is restricted to an
      // identifier — nothing that could close the attribute can reach it. The
      // renderer escapes it as well; this is the belt to that pair of braces.
      if (language !== null && /^[a-zA-Z0-9+#._-]{1,32}$/.test(language)) out.language = language;
      break;
    }
    case 'image': {
      const src = sanitizeSrc(source.src);
      if (src === null) return { ok: false };
      out.src = src;
      const alt = readString(source, 'alt');
      // `alt=""` is meaningful — it marks a decorative image — so an empty
      // string is kept. A MISSING alt is stored as empty rather than omitted,
      // because an `<img>` with no alt attribute at all is an axe violation and
      // SPEC-002 budgets zero serious violations.
      out.alt = (alt ?? '').slice(0, 512);
      const title = readString(source, 'title');
      if (title !== null && title.trim().length > 0) out.title = title.slice(0, 512);
      break;
    }
    default:
      break;
  }

  return Object.keys(out).length > 0 ? { ok: true, attrs: out } : { ok: true };
}

/** Sanitise one mark, or drop it. */
function sanitizeMark(raw: unknown): ContentMark | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (typeof type !== 'string' || !isAllowedMark(type)) return null;

  if (type !== 'link') return { type };

  const source = isRecord(raw.attrs) ? raw.attrs : {};
  const href = sanitizeUrl(source.href);
  // A link with an unusable href drops the MARK, not the text: the words the
  // author wrote stay in the document, they simply stop being a link. Dropping
  // the text instead would make a hostile paste silently delete content, which
  // is a data-loss bug wearing a security badge.
  if (href === null) return null;

  const attrs: Record<string, string | number> = { href };
  const title = readString(source, 'title');
  if (title !== null && title.trim().length > 0) attrs.title = title.slice(0, 512);
  return { type, attrs };
}

function sanitizeMarks(raw: unknown): ContentMark[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const seen = new Set<string>();
  const marks: ContentMark[] = [];
  for (const entry of raw) {
    const mark = sanitizeMark(entry);
    if (!mark || seen.has(mark.type)) continue;
    seen.add(mark.type);
    marks.push(mark);
  }
  if (marks.length === 0) return undefined;

  marks.sort((a, b) => MARK_SPECS[a.type as MarkType].rank - MARK_SPECS[b.type as MarkType].rank);
  return marks;
}

// ---------------------------------------------------------------------------
// Document sanitisation
// ---------------------------------------------------------------------------

/**
 * Node types whose SUBTREE is discarded rather than lifted.
 *
 * This distinction is the reason `<script>alert(1)</script>` does not become a
 * paragraph reading "alert(1)". For an unrecognised but ordinary wrapper — a
 * `<div>`, or a hostile document nesting a real paragraph inside a made-up node
 * — lifting the children preserves what the author actually wrote. For the
 * types below, the children ARE the payload, and preserving them is precisely
 * how a sanitiser leaks.
 *
 * Note that this list is a convenience, not the boundary: an unknown type not
 * on it still cannot survive, because only `NODE_SPECS` types are kept. The
 * list only decides whether the CHILDREN are lifted or dropped.
 */
const OPAQUE_TYPES: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'link',
  'meta',
  'head',
  'title',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'frame',
  'frameset',
  'portal',
  'xmp',
  'plaintext',
]);

/** True when a node type's children must be discarded along with it. */
export function isOpaqueType(type: string): boolean {
  return OPAQUE_TYPES.has(type.toLowerCase());
}

interface Sanitized {
  node: ContentNode;
  group: NodeGroup;
}

/**
 * The recursion limit.
 *
 * A JSON document is attacker-controlled input on the save path, and a
 * thousand-deep nest of blockquotes would overflow the stack inside the
 * renderer — i.e. while serving a reader — rather than inside a validator.
 * Content below the limit is dropped, which is the safe direction: nothing an
 * author can legitimately write comes anywhere near it.
 */
export const MAX_DEPTH = 64;

function sanitizeChildren(raw: unknown, depth: number): Sanitized[] {
  if (!Array.isArray(raw)) return [];
  const out: Sanitized[] = [];
  for (const child of raw) out.push(...sanitizeAny(child, depth));
  return out;
}

function sanitizeAny(raw: unknown, depth: number): Sanitized[] {
  if (depth > MAX_DEPTH) return [];
  if (!isRecord(raw)) return [];

  const type = raw.type;
  if (typeof type !== 'string') return [];

  if (!isAllowedNode(type)) {
    if (isOpaqueType(type)) return [];
    return sanitizeChildren(raw.content, depth + 1);
  }

  if (type === 'text') {
    const text = raw.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    const marks = sanitizeMarks(raw.marks);
    const node: ContentNode = { type: 'text', text };
    if (marks) node.marks = marks;
    return [{ node, group: 'inline' }];
  }

  // Annotated rather than inferred: `as const satisfies` narrows each entry to
  // its own literal shape, so `dropWhenEmpty` is invisible on the entries that
  // omit it. Widening to the declared interface is what makes the OPTIONAL
  // member readable — the alternative is adding `dropWhenEmpty: false` to nine
  // entries that do not need it.
  const spec: NodeSpec = NODE_SPECS[type];
  const attrs = nodeAttrs(type, raw.attrs);
  if (!attrs.ok) return [];

  const node: ContentNode = { type };
  if (attrs.attrs) node.attrs = attrs.attrs;

  if (spec.content !== 'leaf') {
    const content = fitContent(spec.content, sanitizeChildren(raw.content, depth + 1));
    if (content.length > 0) node.content = content;
    else if (spec.dropWhenEmpty) return [];
  }

  return [{ node, group: spec.group }];
}

/** Every inline descendant of a node, in document order. */
function inlineDescendants(node: ContentNode): ContentNode[] {
  if (node.type === 'text' || node.type === 'hardBreak') return [node];
  return (node.content ?? []).flatMap(inlineDescendants);
}

/**
 * Coerce a sanitised child list into what the parent's content model allows.
 *
 * ProseMirror does this itself while parsing; here it has to be explicit,
 * because the input is JSON that no editor necessarily produced. The rules are
 * chosen so content is never silently lost:
 *
 *  - inline content in a block slot is wrapped in a paragraph, and consecutive
 *    inlines share ONE paragraph rather than getting one each (otherwise a
 *    bold word mid-sentence would break the sentence into three paragraphs);
 *  - block content in an inline slot contributes its inline descendants;
 *  - a stray `listItem` outside a list gets a `bulletList` around it, and a
 *    stray block inside a list gets a `listItem`.
 */
function fitContent(kind: ContentKind, children: Sanitized[]): ContentNode[] {
  if (kind === 'leaf') return [];

  if (kind === 'text') {
    // A code block holds text and nothing else, marks included: `<code>` is
    // already the presentation, and a bold run inside it is not representable.
    const text = children
      .flatMap((child) => inlineDescendants(child.node))
      .map((node) => (node.type === 'hardBreak' ? '\n' : (node.text ?? '')))
      .join('');
    return text.length > 0 ? [{ type: 'text', text }] : [];
  }

  if (kind === 'inline') {
    return children.flatMap((child) =>
      child.group === 'inline' ? [child.node] : inlineDescendants(child.node),
    );
  }

  if (kind === 'listItem') {
    const items: ContentNode[] = [];
    for (const child of children) {
      if (child.group === 'listItem') items.push(child.node);
      else items.push({ type: 'listItem', content: fitContent('block', [child]) });
    }
    return items.filter((item) => (item.content?.length ?? 0) > 0);
  }

  const out: ContentNode[] = [];
  let paragraph: ContentNode[] = [];

  const flush = () => {
    if (paragraph.length > 0) out.push({ type: 'paragraph', content: paragraph });
    paragraph = [];
  };

  for (const child of children) {
    if (child.group === 'inline') {
      paragraph.push(child.node);
      continue;
    }
    flush();
    if (child.group === 'listItem') out.push({ type: 'bulletList', content: [child.node] });
    else out.push(child.node);
  }
  flush();
  return out;
}

/**
 * Close an arbitrary value into a valid document.
 *
 * This is the function the save path calls, and the one the security claim
 * rests on. It accepts genuinely anything — `undefined`, a string, a document
 * from a future version of the editor, a document hand-written to smuggle a
 * `<script>` — and returns a document containing only what the tables above
 * name.
 */
export function sanitizeDoc(raw: unknown): ContentNode {
  const source = isRecord(raw) && raw.type === 'doc' ? raw : { content: [raw] };
  const content = fitContent('block', sanitizeChildren(source.content, 0));
  return content.length > 0 ? { type: 'doc', content } : emptyDoc();
}

/**
 * `ContentNode` viewed as the structural `ProseMirrorNode` the repository and
 * `lib/derive/reading.ts` read.
 *
 * The two types describe the same JSON; this exists so the cast happens once,
 * here, with a comment on it, instead of at every call site.
 */
export function toProseMirrorNode(doc: ContentNode): ProseMirrorNode {
  return doc as ProseMirrorNode;
}

/** True when a document holds nothing a reader would see. */
export function isEmptyDoc(doc: ContentNode): boolean {
  if (hasBlockLeaf(doc)) return false;
  return inlineDescendants(doc).every((node) => (node.text ?? '').trim().length === 0);
}

function hasBlockLeaf(node: ContentNode): boolean {
  if (node.type === 'image' || node.type === 'horizontalRule') return true;
  return (node.content ?? []).some(hasBlockLeaf);
}

// ---------------------------------------------------------------------------
// HTML -> document
// ---------------------------------------------------------------------------

/**
 * How an HTML element maps into the schema.
 *
 * `null` means "not a node of its own" — the element contributes its children
 * to the parent, which is what makes a pasted `<div><p>hi</p></div>` produce a
 * paragraph rather than nothing.
 */
const HTML_ELEMENTS: Readonly<Record<string, NodeType | null>> = Object.freeze({
  p: 'paragraph',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  blockquote: 'blockquote',
  pre: 'codeBlock',
  ul: 'bulletList',
  ol: 'orderedList',
  li: 'listItem',
  hr: 'horizontalRule',
  img: 'image',
  br: 'hardBreak',
  div: null,
  section: null,
  article: null,
  main: null,
  aside: null,
  nav: null,
  header: null,
  footer: null,
  figure: null,
  figcaption: null,
  span: null,
  font: null,
  center: null,
  table: null,
  thead: null,
  tbody: null,
  tfoot: null,
  tr: null,
  td: null,
  th: null,
  dl: null,
  dt: null,
  dd: null,
  small: null,
  big: null,
  sub: null,
  sup: null,
  abbr: null,
  cite: null,
  time: null,
  label: null,
});

/** Which mark an inline element applies. */
const HTML_MARKS: Readonly<Record<string, MarkType>> = Object.freeze({
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  code: 'code',
  kbd: 'code',
  samp: 'code',
  a: 'link',
  u: 'italic',
  mark: 'bold',
});

/** Elements with no closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
});

/**
 * Decode the character references a pasted fragment can carry.
 *
 * Decoding happens BEFORE the URL allowlist runs, and that ordering is the
 * whole reason this function exists rather than leaving entities in place:
 * `href="&#106;avascript:alert(1)"` is `javascript:alert(1)` by the time the
 * browser resolves it, so a scheme check on the undecoded string would miss it
 * exactly the way the whitespace check in `URL_IGNORED` would.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // Surrogate halves are not scalar values; `String.fromCodePoint` throws.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

interface HtmlToken {
  kind: 'open' | 'close' | 'text';
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  text: string;
}

/** Attributes out of a raw tag body. Values are entity-decoded. */
function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Tokenise HTML.
 *
 * This is a tokeniser, not a conforming HTML parser, and it does not need to be
 * one: its output is fed through the same node/mark/attribute allowlist as
 * everything else, so the worst a mis-tokenised fragment can produce is a
 * document that reads oddly, not one that carries an executable payload. The
 * cases it does handle carefully are the ones where getting it wrong would
 * change what is DROPPED — comments, and the raw-text content of `<script>` and
 * `<style>`, which must not be re-tokenised as markup.
 */
function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let index = 0;

  const pushText = (text: string) => {
    if (text.length > 0) {
      tokens.push({ kind: 'text', name: '', attrs: {}, selfClosing: false, text });
    }
  };

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      pushText(decodeEntities(html.slice(index)));
      break;
    }
    pushText(decodeEntities(html.slice(index, next)));

    // Comments, CDATA and doctypes carry no content and are skipped whole. A
    // comment left in the stream would otherwise have its `<` and `>` treated
    // as tags, which is how `<!-- <script> -->` turns into a live token.
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', next) || html.startsWith('<?', next)) {
      const end = html.indexOf('>', next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const tagMatch = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(
      html.slice(next),
    );
    if (!tagMatch) {
      // A bare `<` that starts no tag is text — and it is emitted as text, so
      // the renderer will escape it back to `&lt;`.
      pushText('<');
      index = next + 1;
      continue;
    }

    const closing = tagMatch[1] === '/';
    const name = (tagMatch[2] ?? '').toLowerCase();
    const body = tagMatch[3] ?? '';
    index = next + tagMatch[0].length;

    // Raw-text elements: their content is CHARACTER DATA, not markup, so it is
    // consumed here and thrown away rather than tokenised. This is what makes
    // `<script>alert(1)</script>` contribute nothing at all — if the body were
    // tokenised as text, `alert(1)` would survive as a pasted paragraph.
    if (!closing && (name === 'script' || name === 'style' || name === 'noscript')) {
      const close = html.toLowerCase().indexOf(`</${name}`, index);
      index = close === -1 ? html.length : close;
      continue;
    }

    tokens.push({
      kind: closing ? 'close' : 'open',
      name,
      attrs: closing ? {} : parseAttributes(body),
      selfClosing: body.trimEnd().endsWith('/') || VOID_ELEMENTS.has(name),
      text: '',
    });
  }

  return tokens;
}

interface Frame {
  /** The schema node being built, or `null` for a transparent wrapper. */
  type: NodeType | null;
  attrs?: Record<string, string | number>;
  /** Marks contributed to every text node inside this frame. */
  marks: ContentMark[];
  children: ContentNode[];
  /** The HTML tag that opened the frame, so a close tag can find it. */
  tag: string;
  /** True when the element is dropped along with everything inside it. */
  opaque: boolean;
}

/**
 * Parse an HTML fragment into a document inside the closed schema.
 *
 * Used on the paste path (`components/editor/Editor.tsx` runs pasted HTML
 * through this before ProseMirror sees it) and directly by the sanitisation
 * suite, which is where the criterion about `<script>`, `onerror=` and
 * `javascript:` is actually proven.
 *
 * The output is passed through `sanitizeDoc` on the way out, so this function
 * cannot produce something the save path would reject: the two agree by
 * composition rather than by both being careful.
 */
export function parseHtmlToDoc(html: string): ContentNode {
  if (typeof html !== 'string' || html.trim().length === 0) return emptyDoc();

  const root: Frame = { type: 'doc', marks: [], children: [], tag: '', opaque: false };
  const state: ParseState = { root, stack: [root] };

  for (const token of tokenizeHtml(html)) {
    if (token.kind === 'text') appendTextToken(state, token);
    else if (token.kind === 'close') closeMatchingFrame(state, token.name);
    else openTokenFrame(state, token);
  }

  while (state.stack.length > 1) closeTopFrame(state);

  // Straight through the same closer the save path uses: this function and
  // `sanitizeDoc` cannot disagree, because one ends by calling the other.
  return sanitizeDoc({ type: 'doc', content: root.children });
}

/**
 * The parser's whole mutable state: the document frame and the open frames above
 * it. `root` is kept alongside the stack so `topFrame` has a total answer without
 * throwing on an empty stack — the stack is never popped past `root`, so the
 * fallback is unreachable rather than a silent recovery.
 */
interface ParseState {
  root: Frame;
  stack: Frame[];
}

/** The frame currently being filled. */
function topFrame(state: ParseState): Frame {
  return state.stack[state.stack.length - 1] ?? state.root;
}

/** Add `node` to the frame being filled, unless that frame discards its children. */
function emitNode(state: ParseState, node: ContentNode): void {
  const frame = topFrame(state);
  if (!frame.opaque) frame.children.push(node);
}

/** Pop the innermost frame and fold it into its parent. */
function closeTopFrame(state: ParseState): void {
  const frame = state.stack.pop();
  if (!frame || frame.opaque) return;

  if (frame.type === null) {
    // Transparent wrapper: hand the children up.
    for (const child of frame.children) emitNode(state, child);
    return;
  }

  const node: ContentNode = { type: frame.type };
  if (frame.attrs) node.attrs = frame.attrs;
  if (frame.children.length > 0) node.content = frame.children;
  emitNode(state, node);
}

/** Append a text token, carrying whatever marks the enclosing frames contribute. */
function appendTextToken(state: ParseState, token: HtmlToken): void {
  const frame = topFrame(state);
  if (frame.opaque) return;
  const node: ContentNode = { type: 'text', text: token.text };
  if (frame.marks.length > 0) node.marks = frame.marks;
  emitNode(state, node);
}

/**
 * Close frames up to and including the one `name` opened. An unmatched close tag is
 * ignored rather than closing something it did not open, which is what keeps a stray
 * `</div>` from unwinding the whole document.
 */
function closeMatchingFrame(state: ParseState, name: string): void {
  const at = [...state.stack].reverse().findIndex((frame) => frame.tag === name);
  if (at === -1) return;
  const target = state.stack.length - 1 - at;
  while (state.stack.length > target && state.stack.length > 1) closeTopFrame(state);
}

/** Route an open tag to the one frame kind it can produce. */
function openTokenFrame(state: ParseState, token: HtmlToken): void {
  const name = token.name;

  if (isOpaqueType(name) || !(name in HTML_ELEMENTS || name in HTML_MARKS)) {
    openDroppedFrame(state, token);
    return;
  }

  const markType = HTML_MARKS[name];
  if (markType) {
    openMarkFrame(state, token, markType);
    return;
  }

  openElementFrame(state, token);
}

/**
 * Open a frame for an element the schema has no node for — unknown tags, and the
 * dangerous ones whose children must not survive either. Void ones vanish outright;
 * the rest open a frame that swallows its children so nothing inside reaches the
 * document.
 */
function openDroppedFrame(state: ParseState, token: HtmlToken): void {
  if (token.selfClosing) return;
  state.stack.push({
    type: null,
    marks: topFrame(state).marks,
    children: [],
    tag: token.name,
    opaque: isOpaqueType(token.name),
  });
}

/** Open a transparent frame that contributes one mark to every text node inside it. */
function openMarkFrame(state: ParseState, token: HtmlToken, markType: MarkType): void {
  const frame = topFrame(state);
  const mark = sanitizeMark({ type: markType, attrs: token.attrs });
  const marks = mark
    ? sanitizeMarks([...frame.marks, mark]) ?? frame.marks
    : frame.marks;
  if (token.selfClosing) return;
  state.stack.push({ type: null, marks, children: [], tag: token.name, opaque: frame.opaque });
}

/**
 * Open a frame for a mapped element. A `null` mapping is transparent: the tag itself
 * contributes no node, but its children still do.
 */
function openElementFrame(state: ParseState, token: HtmlToken): void {
  const frame = topFrame(state);
  const nodeType = HTML_ELEMENTS[token.name] ?? null;

  if (nodeType === null) {
    if (!token.selfClosing) {
      state.stack.push({
        type: null,
        marks: frame.marks,
        children: [],
        tag: token.name,
        opaque: frame.opaque,
      });
    }
    return;
  }

  const attrs = nodeAttrs(nodeType, rawAttrsFor(token, nodeType));
  if (!attrs.ok) return;

  if (token.selfClosing || NODE_SPECS[nodeType].content === 'leaf') {
    const node: ContentNode = { type: nodeType };
    if (attrs.attrs) node.attrs = attrs.attrs;
    emitNode(state, node);
    return;
  }

  state.stack.push({
    type: nodeType,
    attrs: attrs.attrs,
    marks: nodeType === 'codeBlock' ? [] : frame.marks,
    children: [],
    tag: token.name,
    opaque: frame.opaque,
  });
}

/**
 * The attributes handed to `nodeAttrs`. Headings need one adjustment the tag name
 * carries rather than the attributes: h1/h2 collapse to level 2 and anything deeper
 * to 3, because the schema has no h4+ and flattening a deep outline upward reads
 * better than dropping it.
 */
function rawAttrsFor(token: HtmlToken, nodeType: NodeType): Record<string, unknown> {
  const attrs: Record<string, unknown> = { ...token.attrs };
  if (nodeType === 'heading') attrs.level = Number(token.name.slice(1)) >= 3 ? 3 : 2;
  return attrs;
}
