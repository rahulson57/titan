'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The selection toolbar (SPEC-007).
 *
 * > Toolbar | Bubble menu on selection (bold, italic, link, H2, H3, quote,
 * > code) + slash-free `+` button | **Keyboard-reachable, not hover-only**
 *
 * ── Why this is hand-rolled instead of `@tiptap/extension-bubble-menu` ─────
 * The sealed criterion is "every toolbar command is reachable and activatable
 * by keyboard alone with no pointer events", and Tiptap's bubble menu cannot
 * satisfy it. Its default `shouldShow` requires the EDITOR to hold focus, so
 * the moment you press Tab to reach the toolbar, the editor blurs and the
 * toolbar you were tabbing into unmounts. That is not a bug in the extension —
 * a hover-first floating menu is what it is for — it is the wrong primitive for
 * a criterion about keyboard access.
 *
 * So visibility here is a function of the SELECTION, not of focus:
 *
 *   show = (the selection is a non-empty text range) OR (focus is inside me)
 *
 * The second clause is what makes tabbing in survive, and the first is what
 * makes the menu behave like a bubble menu for everyone else. It also drops one
 * dependency (`tippy.js`, which the extension pulls in) and its positioning
 * quirks.
 *
 * ── Ordering in the DOM is load-bearing ───────────────────────────────────
 * This renders immediately AFTER the editor content, so a single Tab from the
 * body reaches the first toolbar button. It is positioned with `position:
 * absolute` rather than reordered visually, so the reading order a screen
 * reader and the tab sequence both follow is the same one.
 *
 * ── `onMouseDown` preventDefault, on every button ─────────────────────────
 * A mousedown on a button steals focus from the contenteditable, which
 * collapses the ProseMirror selection before the click handler runs — so the
 * command would apply to an empty range. Preventing the default keeps the
 * selection alive. It is the one place this component knows about the mouse,
 * and it exists so the mouse behaves like the keyboard rather than the other
 * way round.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Editor } from '@tiptap/react';

import { sanitizeUrl } from '../../lib/content/schema';

export interface BubbleMenuProps {
  editor: Editor | null;
  /** The positioned container the menu is absolutely placed inside. */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface Command {
  id: string;
  label: string;
  /** Announced by a screen reader; the visible label is the short form. */
  description: string;
  run(editor: Editor): void;
  isActive(editor: Editor): boolean;
}

/**
 * The seven commands the criterion enumerates, in one array.
 *
 * A list rather than seven hand-written buttons: the a11y suite asserts every
 * command is keyboard-activatable, and a table is the only shape where adding
 * an eighth command cannot quietly skip the wiring that makes it reachable.
 */
export const TOOLBAR_COMMANDS: readonly Command[] = Object.freeze([
  {
    id: 'bold',
    label: 'B',
    description: 'Bold',
    run: (editor) => editor.chain().focus().toggleBold().run(),
    isActive: (editor) => editor.isActive('bold'),
  },
  {
    id: 'italic',
    label: 'I',
    description: 'Italic',
    run: (editor) => editor.chain().focus().toggleItalic().run(),
    isActive: (editor) => editor.isActive('italic'),
  },
  {
    id: 'h2',
    label: 'H2',
    description: 'Heading level 2',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'H3',
    description: 'Heading level 3',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
  },
  {
    id: 'quote',
    label: '❝',
    description: 'Block quote',
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
    isActive: (editor) => editor.isActive('blockquote'),
  },
  {
    id: 'code',
    label: '</>',
    description: 'Inline code',
    run: (editor) => editor.chain().focus().toggleCode().run(),
    isActive: (editor) => editor.isActive('code'),
  },
]);

const menuStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
  padding: 'var(--space-1)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: '0 2px 12px rgb(0 0 0 / 12%)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-meta-size)',
};

function buttonStyle(active: boolean): CSSProperties {
  return {
    font: 'inherit',
    minWidth: '32px',
    height: '32px',
    padding: '0 var(--space-2)',
    color: active ? 'var(--accent-contrast)' : 'var(--fg)',
    background: active ? 'var(--accent)' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  };
}

const linkFormStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
  paddingInlineStart: 'var(--space-1)',
  borderInlineStart: '1px solid var(--border)',
};

const linkInputStyle: CSSProperties = {
  font: 'inherit',
  width: '16rem',
  padding: 'var(--space-1) var(--space-2)',
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
};

export function BubbleMenu({ editor, containerRef }: BubbleMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);

  const [hasSelection, setHasSelection] = useState(false);
  const [holdsFocus, setHoldsFocus] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  // Bumped on every editor transaction so the active states re-read.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!editor) return;

    const sync = () => {
      const { from, to, empty } = editor.state.selection;
      const nonEmpty = !empty && to > from;
      setHasSelection(nonEmpty);
      setTick((n) => n + 1);

      if (!nonEmpty) return;
      try {
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        const box = containerRef.current?.getBoundingClientRect();
        if (!box) return;
        setPosition({
          // Above the selection, with a small gap. Clamped at 0 so a selection
          // on the first line does not push the toolbar off the top of the
          // container, where it would be unreachable by mouse and invisible.
          top: Math.max(0, Math.min(start.top, end.top) - box.top - 44),
          left: Math.max(0, (start.left + end.left) / 2 - box.left - 120),
        });
      } catch {
        // `coordsAtPos` throws while the view is being torn down. A toolbar
        // that fails to reposition is a cosmetic problem; one that throws
        // during an update takes the editor down with it.
      }
    };

    editor.on('selectionUpdate', sync);
    editor.on('transaction', sync);
    sync();
    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('transaction', sync);
    };
  }, [editor, containerRef]);

  // Close the link form whenever the menu itself goes away, so it is never
  // reopened already-expanded against a different selection.
  useEffect(() => {
    if (!hasSelection && !holdsFocus) {
      setLinkOpen(false);
      setLinkError(null);
    }
  }, [hasSelection, holdsFocus]);

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus();
  }, [linkOpen]);

  if (!editor) return null;

  const visible = hasSelection || holdsFocus;

  const applyLink = () => {
    const cleaned = sanitizeUrl(href.trim());
    if (cleaned === null) {
      // The same allowlist the document sanitiser uses, applied here purely so
      // the author gets told. It is NOT the security boundary — `sanitizeDoc`
      // on the server is — but a link silently vanishing on save is worse than
      // a message saying why it will not be kept.
      setLinkError('Use an http(s), mailto: or site-relative link.');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: cleaned }).run();
    setLinkOpen(false);
    setHref('');
    setLinkError(null);
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkOpen(false);
    setLinkError(null);
  };

  return (
    <div
      ref={menuRef}
      role="toolbar"
      aria-label="Text formatting"
      aria-orientation="horizontal"
      data-testid="bubble-menu"
      data-visible={visible ? 'true' : 'false'}
      // Hidden rather than unmounted. An unmounted toolbar cannot be tabbed
      // into, and `hidden` removes it from the accessibility tree AND the tab
      // order, so axe does not see seven controls the author cannot reach.
      hidden={!visible}
      onFocusCapture={() => setHoldsFocus(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setHoldsFocus(false);
        }
      }}
      style={{
        ...menuStyle,
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        display: visible ? 'flex' : 'none',
      }}
    >
      {TOOLBAR_COMMANDS.map((command) => {
        const active = command.isActive(editor);
        return (
          <button
            key={command.id}
            type="button"
            data-testid={`toolbar-${command.id}`}
            aria-label={command.description}
            aria-pressed={active}
            style={buttonStyle(active)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command.run(editor)}
          >
            <span aria-hidden="true">{command.label}</span>
          </button>
        );
      })}

      <button
        type="button"
        data-testid="toolbar-link"
        aria-label="Link"
        aria-pressed={editor.isActive('link')}
        aria-expanded={linkOpen}
        style={buttonStyle(editor.isActive('link'))}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const existing = String(editor.getAttributes('link').href ?? '');
          setHref(existing);
          setLinkError(null);
          setLinkOpen((open) => !open);
        }}
      >
        <span aria-hidden="true">🔗</span>
      </button>

      {linkOpen ? (
        <span style={linkFormStyle}>
          <label htmlFor="editor-link-href" className="visually-hidden">
            Link address
          </label>
          <input
            id="editor-link-href"
            ref={linkInputRef}
            data-testid="toolbar-link-input"
            type="text"
            inputMode="url"
            value={href}
            style={linkInputStyle}
            aria-invalid={linkError ? true : undefined}
            aria-describedby={linkError ? 'editor-link-error' : undefined}
            placeholder="https://"
            onChange={(event) => {
              setHref(event.target.value);
              setLinkError(null);
            }}
            onKeyDown={(event) => {
              // Enter applies and Escape cancels, so the whole interaction is
              // completable without ever leaving the input.
              if (event.key === 'Enter') {
                event.preventDefault();
                applyLink();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setLinkOpen(false);
                editor.chain().focus().run();
              }
            }}
          />
          <button
            type="button"
            data-testid="toolbar-link-apply"
            style={buttonStyle(false)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={applyLink}
          >
            Apply
          </button>
          <button
            type="button"
            data-testid="toolbar-link-remove"
            style={buttonStyle(false)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={removeLink}
          >
            Remove
          </button>
          {linkError ? (
            <span
              id="editor-link-error"
              role="alert"
              style={{ color: 'var(--fg)', fontSize: 'var(--text-meta-size)' }}
            >
              {linkError}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export default BubbleMenu;
