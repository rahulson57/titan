/**
 * The sanitisation boundary (SPEC-007).
 *
 * Sealed criterion, verbatim:
 *
 * > Pasting HTML containing `<script>alert(1)</script>`, `<img onerror=alert(1)>`
 * > and `<a href="javascript:alert(1)">` produces a `bodyJson` with none of
 * > those nodes/attrs and a `bodyHtml` matching none of
 * > `/<script|on[a-z]+=|javascript:/i`.
 *
 * ── Why this is a unit test and not a browser test ─────────────────────────
 * SPEC-007 puts the guarantee server-side and states it structurally: "Because
 * it is generated from a closed schema it contains no `<script>`, no `on*`
 * attribute, and no `javascript:` URL **by construction**." A browser test
 * could only show that one paste, through one editor build, produced clean
 * output. What has to be true is stronger — that no input produces dirty
 * output — and that is a property of `lib/content/schema.ts` and
 * `lib/content/render.ts`, which are pure and can therefore be attacked
 * directly, exhaustively, with no DOM and no editor in the loop.
 *
 * So the suite attacks the two entry points a hostile document can arrive
 * through, and treats them as equals:
 *
 *  - `parseHtmlToDoc` — the PASTE path. This is the one the criterion is
 *    literally about.
 *  - `sanitizeDoc` — the SAVE path, where the browser posts `bodyJson`
 *    directly. This one matters more. A reader who only tests paste is
 *    testing the attack that goes through the editor's UI, when the cheaper
 *    attack is to skip the editor entirely and POST a hand-written document to
 *    the Server Action. `saveDraftContent` runs every document through
 *    `sanitizeDoc` for exactly that reason, and the tests below hold it to the
 *    same standard as the paste path rather than assuming the client is honest.
 *
 * ── The forbidden pattern is imported, not retyped ─────────────────────────
 * `FORBIDDEN_HTML` comes from `lib/content/render.ts`. Writing the regex out a
 * second time here would let the two drift, and the drift would be silent in
 * the direction that matters: a weakened copy in the test still passes.
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_HTML,
  deriveContent,
  escapeAttr,
  escapeText,
  isSafeHtml,
  renderHtml,
} from '../../lib/content/render';
import {
  ALLOWED_MARKS,
  ALLOWED_NODES,
  type ContentNode,
  MAX_DEPTH,
  decodeEntities,
  isEmptyDoc,
  parseHtmlToDoc,
  sanitizeDoc,
  sanitizeSrc,
  sanitizeUrl,
  urlScheme,
} from '../../lib/content/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every node type present in a document, at any depth. */
function nodeTypes(node: ContentNode): string[] {
  return [node.type, ...(node.content ?? []).flatMap(nodeTypes)];
}

/** Every mark type present in a document, at any depth. */
function markTypes(node: ContentNode): string[] {
  return [
    ...(node.marks ?? []).map((mark) => mark.type),
    ...(node.content ?? []).flatMap(markTypes),
  ];
}

/** Every attribute NAME present in a document, on nodes and on marks. */
function attrNames(node: ContentNode): string[] {
  return [
    ...Object.keys(node.attrs ?? {}),
    ...(node.marks ?? []).flatMap((mark) => Object.keys(mark.attrs ?? {})),
    ...(node.content ?? []).flatMap(attrNames),
  ];
}

/** Every attribute VALUE in a document, stringified — where a payload would hide. */
function attrValues(node: ContentNode): string[] {
  return [
    ...Object.values(node.attrs ?? {}).map(String),
    ...(node.marks ?? []).flatMap((mark) => Object.values(mark.attrs ?? {}).map(String)),
    ...(node.content ?? []).flatMap(attrValues),
  ];
}

/** All text in a document. */
function allText(node: ContentNode): string {
  return [node.text ?? '', ...(node.content ?? []).map(allText)].join('');
}

/**
 * The full assertion, applied to every hostile input in this file.
 *
 * Both halves of the criterion at once — the document AND the HTML — because
 * either alone is satisfiable by an implementation that is wrong. A clean
 * `bodyJson` with a renderer that interpolates raw attribute values is still
 * an XSS; clean HTML derived from a document that retained an `onerror`
 * attribute is one schema change away from being one.
 */
function expectClosed(doc: ContentNode): string {
  for (const type of nodeTypes(doc)) expect(ALLOWED_NODES).toContain(type);
  for (const type of markTypes(doc)) expect(ALLOWED_MARKS).toContain(type);

  // No event-handler attribute survived under any name.
  for (const name of attrNames(doc)) expect(name).not.toMatch(/^on/i);

  const html = renderHtml(doc);
  expect(html).not.toMatch(FORBIDDEN_HTML);
  expect(isSafeHtml(html)).toBe(true);
  return html;
}

// ---------------------------------------------------------------------------
// The criterion, literally
// ---------------------------------------------------------------------------

/** The three payloads the sealed criterion names, in one fragment. */
const CRITERION_HTML = [
  '<p>Before</p>',
  '<script>alert(1)</script>',
  '<img onerror=alert(1) src="/uploads/inline/u1/a.webp">',
  '<a href="javascript:alert(1)">click me</a>',
  '<p>After</p>',
].join('');

describe('SPEC-007 — the paste in the acceptance criterion', () => {
  it('produces a bodyJson with none of those nodes or attributes', () => {
    const doc = parseHtmlToDoc(CRITERION_HTML);

    expect(nodeTypes(doc)).not.toContain('script');
    expect(attrNames(doc)).not.toContain('onerror');
    expect(attrValues(doc).join(' ')).not.toMatch(/javascript:/i);

    expectClosed(doc);
  });

  it('produces a bodyHtml matching none of /<script|on[a-z]+=|javascript:/i', () => {
    const html = renderHtml(parseHtmlToDoc(CRITERION_HTML));
    expect(html).not.toMatch(FORBIDDEN_HTML);
  });

  it('drops the payload without eating the prose around it', () => {
    // The half a sanitiser fails silently. Removing everything would satisfy
    // both assertions above and be a data-loss bug indistinguishable, from the
    // criterion's point of view, from working correctly.
    const doc = parseHtmlToDoc(CRITERION_HTML);
    const text = allText(doc);

    expect(text).toContain('Before');
    expect(text).toContain('After');
    // The anchor's TEXT survives; only its href-bearing mark is dropped.
    expect(text).toContain('click me');
  });

  it('does not turn <script>alert(1)</script> into the paragraph "alert(1)"', () => {
    // The classic near-miss. A sanitiser that drops the `script` NODE but lifts
    // its children passes every "no <script> tag" assertion and puts the
    // attacker's source code into the article as visible prose. `script` is in
    // `OPAQUE_TYPES` precisely so its subtree goes with it.
    const doc = parseHtmlToDoc('<p>a</p><script>alert(1)</script><p>b</p>');
    expect(allText(doc)).not.toContain('alert(1)');
    expect(allText(doc)).toBe('ab');
  });

  it('drops the img entirely rather than emitting one with no src', () => {
    // `<img onerror=... >` with no usable src: the attribute is gone either
    // way, but an <img> with no src renders a broken-image icon mid-article
    // AND re-arms the same attack the moment someone "fixes" the missing src.
    const doc = parseHtmlToDoc('<img onerror=alert(1)>');
    expect(nodeTypes(doc)).not.toContain('image');
    expect(isEmptyDoc(doc)).toBe(true);
  });

  it('keeps a legitimate image from the uploads path', () => {
    // The control. Without it, "drops every image" would pass the test above.
    const doc = parseHtmlToDoc(
      '<img src="/uploads/inline/u1/a.webp" alt="A diagram" onerror="alert(1)">',
    );
    expect(nodeTypes(doc)).toContain('image');
    expect(attrNames(doc)).not.toContain('onerror');

    const html = expectClosed(doc);
    expect(html).toContain('src="/uploads/inline/u1/a.webp"');
    expect(html).toContain('alt="A diagram"');
  });
});

// ---------------------------------------------------------------------------
// The same attacks, arriving as JSON on the save path
// ---------------------------------------------------------------------------

describe('SPEC-007 — a hand-written document posted straight to the save action', () => {
  it('drops an unknown node type and its whole subtree when it is dangerous', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    });

    expect(nodeTypes(doc)).not.toContain('script');
    expect(allText(doc)).toBe('kept');
    expectClosed(doc);
  });

  it('lifts the children of an unknown but harmless wrapper', () => {
    // The other half of the same rule. A document nesting a real paragraph
    // inside a node this version of the schema does not know — a future node
    // type, a `div` from an importer — must keep the author's words.
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'someFutureLayoutNode',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'still here' }] }],
        },
      ],
    });

    expect(nodeTypes(doc)).not.toContain('someFutureLayoutNode');
    expect(allText(doc)).toBe('still here');
  });

  it('strips an on* attribute smuggled into a known node', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            src: '/uploads/inline/u1/a.webp',
            alt: 'ok',
            onerror: 'alert(1)',
            onload: 'alert(2)',
            style: 'position:fixed',
          },
        },
      ],
    });

    expect(attrNames(doc).sort()).toEqual(['alt', 'src']);
    expectClosed(doc);
  });

  it('strips an unknown mark and keeps the text it was on', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'emphasis',
              marks: [{ type: 'bold' }, { type: 'evilMark', attrs: { onclick: 'alert(1)' } }],
            },
          ],
        },
      ],
    });

    expect(markTypes(doc)).toEqual(['bold']);
    expect(allText(doc)).toBe('emphasis');
    expect(expectClosed(doc)).toBe('<p><strong>emphasis</strong></p>');
  });

  it('drops a link mark whose href is not usable, keeping the words', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click me',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    });

    expect(markTypes(doc)).toEqual([]);
    expect(expectClosed(doc)).toBe('<p>click me</p>');
  });

  it('survives values that are not documents at all', () => {
    // The save path takes `unknown`. Each of these is something a malformed or
    // hostile client can actually send, and none may throw — an exception here
    // is a 500 on every save, which is a denial of service reachable by anyone
    // with a session.
    for (const input of [null, undefined, 0, '', 'a string', [], { type: 'doc' }, { nope: 1 }]) {
      const doc = sanitizeDoc(input);
      expect(doc.type).toBe('doc');
      expect(() => renderHtml(doc)).not.toThrow();
      expectClosed(doc);
    }
  });

  it('refuses a document nested deeper than MAX_DEPTH instead of overflowing the stack', () => {
    // Depth is attacker-controlled on the save path, and the overflow would
    // happen inside the RENDERER — i.e. while serving a reader — rather than in
    // a validator. Dropping past the limit is the safe direction.
    let node: ContentNode = { type: 'paragraph', content: [{ type: 'text', text: 'deep' }] };
    for (let i = 0; i < MAX_DEPTH * 3; i++) node = { type: 'blockquote', content: [node] };

    const doc = sanitizeDoc({ type: 'doc', content: [node] });
    expect(() => renderHtml(doc)).not.toThrow();
    // Everything below the limit is gone, so the innermost text does not
    // survive — dropped, not smuggled up.
    expect(allText(doc)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// URL handling — the part that is easiest to get subtly wrong
// ---------------------------------------------------------------------------

describe('SPEC-007 — the URL allowlist sees what the browser will see', () => {
  const HOSTILE = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'java script:alert(1)',
    'jav ascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///etc/passwd',
    '//evil.example/x',
  ];

  it.each(HOSTILE)('rejects %j as a link href', (url) => {
    expect(sanitizeUrl(url)).toBeNull();
  });

  it.each(HOSTILE)('rejects %j as an image src', (url) => {
    expect(sanitizeSrc(url)).toBeNull();
  });

  it('strips the whitespace a browser strips BEFORE resolving the scheme', () => {
    // This is the single most important case in the file. `java\tscript:` is a
    // working `javascript:` URL in every major browser, because the URL parser
    // removes tabs and newlines before it looks for the colon. A scheme check
    // run against the raw string sees `java\tscript`, does not find it in the
    // allowlist, concludes it has no scheme, and passes it through as a
    // relative URL — the attribute reaches the page intact and working.
    expect(urlScheme('java\tscript:alert(1)')).toBe(null);
    expect(sanitizeUrl('java\tscript:alert(1)')).toBeNull();

    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'link', attrs: { href: 'java\tscript:alert(1)' } }],
            },
          ],
        },
      ],
    });
    expect(renderHtml(doc)).not.toMatch(FORBIDDEN_HTML);
  });

  it('decodes character references before checking the scheme', () => {
    // `&#106;` is `j`. Left encoded, the scheme reads as `&#106;avascript`,
    // which is not in the allowlist and so falls through as "relative" — and
    // the browser decodes it back to `javascript:` when it navigates.
    expect(decodeEntities('&#106;avascript:alert(1)')).toBe('javascript:alert(1)');
    expect(decodeEntities('&#x6a;avascript:alert(1)')).toBe('javascript:alert(1)');

    const doc = parseHtmlToDoc('<a href="&#106;avascript:alert(1)">x</a>');
    expect(attrValues(doc).join(' ')).not.toMatch(/javascript:/i);
    expectClosed(doc);
  });

  it.each([
    ['https://example.com/a', 'link'],
    ['http://example.com/a', 'link'],
    ['mailto:someone@example.com', 'link'],
    ['/uploads/inline/u1/a.webp', 'both'],
    ['/article/some-slug-abc123', 'link'],
    ['relative/path.html', 'both'],
  ])('accepts %j', (url, kind) => {
    expect(sanitizeUrl(url)).toBe(url);
    if (kind === 'both') expect(sanitizeSrc(url)).toBe(url);
  });

  it('does not let mailto: through as an image src', () => {
    // `IMAGE_SCHEMES` is deliberately narrower than `LINK_SCHEMES`. An <img>
    // pointing at a mailto: URL is not a thing that renders; it is a thing
    // somebody is trying.
    expect(sanitizeUrl('mailto:a@b.example')).toBe('mailto:a@b.example');
    expect(sanitizeSrc('mailto:a@b.example')).toBeNull();
  });

  it('does not mistake a colon in a relative path for a scheme', () => {
    // The false positive that would break real links: `./notes:2026/a.html` is
    // a path, not a `./notes` URL.
    expect(urlScheme('./notes:2026/a.html')).toBeNull();
    expect(sanitizeUrl('./notes:2026/a.html')).toBe('./notes:2026/a.html');
  });
});

// ---------------------------------------------------------------------------
// The renderer's own escaping
// ---------------------------------------------------------------------------

describe('SPEC-007 — the renderer escapes what it emits', () => {
  it('escapes & first so an entity is not double-encoded', () => {
    // `<` -> `&amp;lt;` is the classic ordering bug, and it is visible rather
    // than dangerous: the reader sees the literal text "&lt;" on the page.
    expect(escapeText('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(escapeText('&amp;')).toBe('&amp;amp;');
  });

  it('escapes both quote characters in an attribute value', () => {
    expect(escapeAttr('a"b\'c')).toBe('a&quot;b&#39;c');
    expect(escapeAttr('</a><script>')).toBe('&lt;/a&gt;&lt;script&gt;');
  });

  it('renders hostile text as text, not as markup', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '<script>alert(1)</script>' }],
        },
      ],
    });

    // The text is preserved — an author writing ABOUT a script tag is doing
    // something legitimate — but it is escaped, so it renders and never runs.
    expect(allText(doc)).toBe('<script>alert(1)</script>');
    const html = renderHtml(doc);
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toMatch(FORBIDDEN_HTML);
  });

  /**
   * Escaping an attribute value, and the one place `FORBIDDEN_HTML` is NOT the
   * right question to ask.
   *
   * The payload tries to break out of the `title` attribute and land an
   * `onmouseover` handler on the `<a>`. It fails: both quote characters are
   * escaped, so the `"` never terminates the attribute and the whole payload
   * stays INSIDE the title's value, where it is a tooltip string and not
   * markup. The output is asserted exactly, character for character, because
   * "is it escaped" is a question about the precise bytes.
   *
   * ── Why this test does not use `FORBIDDEN_HTML` ───────────────────────────
   * It would fail, and it SHOULD fail, and that is worth writing down.
   * `/on[a-z]+=/i` matches the literal text `onmouseover=` sitting harmlessly
   * inside the escaped attribute value. The regex is a proxy for "an event
   * handler reached the page"; it cannot tell an attribute from a string that
   * looks like one.
   *
   * That is not a defect in the criterion — SPEC-007 scopes the regex to the
   * three specific payloads it names, and those are asserted against it
   * verbatim at the top of this file and pass. It is a limit on how far the
   * regex generalises, and the limit is reachable by ordinary content: an
   * author writing an article ABOUT HTML, whose prose contains the characters
   * `onclick=`, produces a perfectly safe `bodyHtml` that this pattern matches.
   * A blogging platform has to be able to render that article.
   *
   * So the security property is asserted directly — the document carries no
   * event-handler attribute, and the rendered `<a>` has exactly three
   * attributes, none of them an `on*` — rather than through a proxy that has a
   * known false positive. Reported to the coordinator rather than worked
   * around silently.
   */
  it('escapes a link title rather than letting it close the attribute', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [
                {
                  type: 'link',
                  attrs: { href: 'https://example.com', title: '" onmouseover="alert(1)' },
                },
              ],
            },
          ],
        },
      ],
    });

    const html = renderHtml(doc);

    // Exact, not `toContain`: the defect this guards against is a single
    // unescaped `"`, and a substring match would pass with one present.
    expect(html).toBe(
      '<p><a href="https://example.com" title="&quot; onmouseover=&quot;alert(1)"' +
        ' rel="nofollow noopener noreferrer">x</a></p>',
    );

    // The payload never became an attribute — in the document or in the HTML.
    expect(attrNames(doc)).not.toContain('onmouseover');
    const attributes = [...(html.match(/\s([a-zA-Z-]+)="/g) ?? [])].map((match) => match.trim());
    expect(attributes).toEqual(['href="', 'title="', 'rel="']);
  });

  it('renders an article ABOUT html without mangling it', () => {
    // The control for the note above, and a real product requirement rather
    // than a hypothetical: this platform has to be able to publish a post that
    // discusses `onclick=` and `<script>`. Both survive as readable text, both
    // are escaped, and neither is executable — even though the criterion's
    // proxy regex matches the result.
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Never write onclick= in your markup, and never inline a ' },
            { type: 'text', text: '<script>', marks: [{ type: 'code' }] },
            { type: 'text', text: ' tag.' },
          ],
        },
      ],
    });

    const html = renderHtml(doc);
    expect(html).toBe(
      '<p>Never write onclick= in your markup, and never inline a ' +
        '<code>&lt;script&gt;</code> tag.</p>',
    );
    // No angle bracket in the author's text survived as markup: every `<` in
    // the output opens a tag this renderer wrote, and there are exactly two.
    expect(html.match(/<script/i)).toBeNull();
    expect(attrNames(doc)).toEqual([]);
  });

  it('keeps a code block’s content as text even when it looks like markup', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'html' },
          content: [{ type: 'text', text: '<img src=x>' }],
        },
      ],
    });

    expect(renderHtml(doc)).toBe(
      '<pre><code class="language-html">&lt;img src=x&gt;</code></pre>',
    );
  });

  it('refuses a code-block language that is not an identifier', () => {
    // It lands inside `class="language-…"`. Escaping alone would be enough;
    // restricting the value as well means nothing that could close the
    // attribute is even representable in the document.
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: '" onload="alert(1)' },
          content: [{ type: 'text', text: 'x' }],
        },
      ],
    });

    expect(attrNames(doc)).not.toContain('language');
    expect(renderHtml(doc)).toBe('<pre><code>x</code></pre>');
  });
});

// ---------------------------------------------------------------------------
// A hostile document end to end
// ---------------------------------------------------------------------------

describe('SPEC-007 — the whole pipeline against one hostile document', () => {
  const HOSTILE_HTML = [
    '<!-- <script>alert(0)</script> -->',
    '<style>body{background:url(javascript:alert(1))}</style>',
    '<h1 onclick="alert(1)">A heading</h1>',
    '<p>Ordinary <b onmouseover="alert(1)">bold</b> text.</p>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg><script>alert(1)</script></svg>',
    '<form action="https://evil.example"><input name="x"><button>go</button></form>',
    '<a href="JAVASCRIPT:alert(1)" onfocus="alert(1)">a link</a>',
    '<img src="x" onerror="alert(1)">',
    '<div style="position:fixed" onload="alert(1)"><p>nested but fine</p></div>',
    '<object data="evil.swf"></object>',
    '<blockquote>A quotation.</blockquote>',
    '<pre><code>const x = 1;</code></pre>',
    '<ul><li>one</li><li>two</li></ul>',
    '<hr>',
  ].join('');

  it('yields a document inside the closed schema and HTML free of every forbidden pattern', () => {
    const doc = parseHtmlToDoc(HOSTILE_HTML);
    const html = expectClosed(doc);

    // Nothing executable survived, in either representation.
    expect(html).not.toMatch(/<script|<iframe|<object|<style|<form|<input|<button/i);
    expect(html).not.toMatch(/on[a-z]+=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(JSON.stringify(doc)).not.toMatch(/onerror|onclick|onload|onfocus|onmouseover/i);
  });

  it('keeps every piece of legitimate content in the same document', () => {
    // Run against the SAME hostile input, so this is not a separate happy path
    // — it is the assertion that the sanitiser is discriminating rather than
    // merely destructive.
    const doc = parseHtmlToDoc(HOSTILE_HTML);
    const text = allText(doc);
    const html = renderHtml(doc);

    for (const fragment of [
      'A heading',
      'Ordinary ',
      'bold',
      ' text.',
      'a link',
      'nested but fine',
      'A quotation.',
      'const x = 1;',
      'one',
      'two',
    ]) {
      expect(text).toContain(fragment);
    }

    // Structure, not just words: an h1 flattens to h2 (the article title is the
    // page's only h1), the bold survives as a mark, the quote and list and rule
    // are all still there.
    expect(html).toContain('<h2>A heading</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ul><li>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<pre><code>');
  });

  it('is idempotent — sanitising an already-sanitised document changes nothing', () => {
    // The property that makes it safe to sanitise on both the paste path and
    // the save path. Without it, defence in depth would be lossy: every extra
    // pass would degrade the document a little, and the second save of an
    // unchanged draft would produce a different `bodyJson` from the first.
    const once = parseHtmlToDoc(HOSTILE_HTML);
    const twice = sanitizeDoc(once);
    expect(twice).toEqual(once);
    expect(renderHtml(twice)).toBe(renderHtml(once));
  });

  it('derives the same values however many times it is asked', () => {
    const a = deriveContent(parseHtmlToDoc(HOSTILE_HTML));
    const b = deriveContent(a.doc);

    expect(b.doc).toEqual(a.doc);
    expect(b.bodyHtml).toBe(a.bodyHtml);
    expect(b.bodyText).toBe(a.bodyText);
    expect(b.readingMinutes).toBe(a.readingMinutes);
  });

  /**
   * Every object in a sanitised document has `Object.prototype`.
   *
   * This looks like a test about nothing, and it is the regression test for the
   * worst bug found in this slice. `components/editor/Editor.tsx` sends the
   * document to a Server Action, and ProseMirror builds each node's `attrs`
   * with `Object.create(null)` — so `editor.getJSON()` hands back values whose
   * prototype is `null`. React's Server Action serializer encodes plain objects
   * and arrays; a null-prototype value it drops SILENTLY. The action returns
   * 200, the editor shows `Saved`, and every attribute in the article is gone.
   *
   * What that costs is not cosmetic, because the attributes ARE the content:
   * `heading.attrs.level` is the only thing separating an H3 from an H2, an
   * `image` that loses `attrs.src` fails the sanitiser's `{ ok: false }` check
   * and the picture disappears from the article, and a `link` mark stripped of
   * `attrs.href` stops being a link. Each one degrades into something that
   * still looks like a document, which is why it survived until the keyboard
   * suite compared stored HTML against the DOM.
   *
   * `sanitizeDoc` is what makes the payload safe to send — it rebuilds the
   * document from fresh object literals instead of forwarding the editor's own
   * nodes — so this asserts the property the fix depends on rather than the
   * line of code that uses it. Asserted structurally, on a document that
   * carries an attribute of every kind the schema allows.
   */
  it('produces only plain-prototype objects, so Server Action serialization keeps attrs', () => {
    const doc = sanitizeDoc({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'A heading' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a link',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/essay' } }],
            },
          ],
        },
        { type: 'image', attrs: { src: '/uploads/x.webp', alt: 'alt text' } },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x' }] },
        { type: 'orderedList', attrs: { start: 3 }, content: [] },
      ],
    });

    const nullPrototypes: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      if (Object.getPrototypeOf(value) !== Object.prototype) nullPrototypes.push(path);
      for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
    };
    walk(doc, 'doc');

    expect(
      nullPrototypes,
      'these values would be dropped silently crossing the Server Action boundary',
    ).toEqual([]);

    // And the walk actually reached the attributes it is protecting, so a
    // sanitiser that stripped every `attrs` could not pass this vacuously.
    const heading = doc.content?.[0];
    expect(heading?.attrs?.level).toBe(3);
    expect(doc.content?.[1]?.content?.[0]?.marks?.[0]?.attrs?.href).toBe(
      'https://example.com/essay',
    );
    expect(doc.content?.[2]?.attrs?.src).toBe('/uploads/x.webp');
    expect(doc.content?.[3]?.attrs?.language).toBe('ts');
  });
});
