'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The `+` insert menu (SPEC-007).
 *
 * > ... + slash-free `+` button for image / divider / code block
 *
 * "Slash-free" is the requirement that shapes this component. A slash command
 * ("type `/` to insert…") is discoverable only by people who already know it
 * exists, is invisible to a screen reader, and collides with the act of typing
 * a slash. A real button with a real menu is discoverable, announced, and
 * cannot be triggered by accident.
 *
 * ── The image entry hands off to SPEC-006 ─────────────────────────────────
 * "Image" opens a file picker and POSTs to `/api/upload`, which is Local Media's
 * (SPEC-006, TASK-005 — landed). This component does not validate, re-encode or
 * store anything: it sends the file and inserts the `path` the handler returns.
 * The upload route is the single place that sniffs magic bytes, strips EXIF and
 * decides where a file lives, and duplicating any of that here would create a
 * second, weaker copy of a security boundary that already exists.
 *
 * ── Menu semantics, spelled out ───────────────────────────────────────────
 * `aria-haspopup="menu"` + `aria-expanded` on the trigger, `role="menu"` on the
 * list, `role="menuitem"` on each entry, arrow keys to move, Escape to close
 * and return focus to the trigger. This is the widget the a11y gate is most
 * likely to fail on — a `div` full of buttons called a menu is the classic
 * serious-severity axe violation — so the roles are complete rather than
 * decorative.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Editor } from '@tiptap/react';

export interface InsertMenuProps {
  editor: Editor | null;
  /** Surfaced to the author when an upload fails. */
  onError?(message: string): void;
}

const triggerStyle: CSSProperties = {
  font: 'inherit',
  width: '36px',
  height: '36px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--fg)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-pill)',
  cursor: 'pointer',
  fontSize: '20px',
  lineHeight: 1,
};

const menuStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  insetInlineStart: 0,
  marginBlockStart: 'var(--space-1)',
  minWidth: '12rem',
  padding: 'var(--space-1)',
  margin: 0,
  listStyle: 'none',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: '0 2px 12px rgb(0 0 0 / 12%)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-ui-size)',
};

const itemStyle: CSSProperties = {
  font: 'inherit',
  display: 'block',
  width: '100%',
  textAlign: 'start',
  padding: 'var(--space-2) var(--space-3)',
  color: 'var(--fg)',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

export function InsertMenu({ editor, onError }: InsertMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  if (!editor) return null;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const uploadImage = async (file: File) => {
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('kind', 'inline');

      const response = await fetch('/api/upload', { method: 'POST', body });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'That image could not be uploaded.';
        onError?.(message);
        return;
      }

      const path =
        payload && typeof payload === 'object' && 'path' in payload
          ? String((payload as { path: unknown }).path)
          : '';
      if (!path) {
        onError?.('The upload succeeded but returned no path.');
        return;
      }

      // `alt` is empty rather than absent, and that is not the same thing. An
      // <img> with NO alt attribute is a serious axe violation; `alt=""` marks
      // the image decorative, which is the honest default until the author
      // describes it. The description is editable from the image itself.
      editor.chain().focus().setImage({ src: path, alt: '' }).run();
    } catch {
      onError?.('That image could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };

  const items = [
    {
      id: 'image',
      label: 'Image',
      run: () => fileRef.current?.click(),
    },
    {
      id: 'divider',
      label: 'Divider',
      run: () => editor.chain().focus().setHorizontalRule().run(),
    },
    {
      id: 'code-block',
      label: 'Code block',
      run: () => editor.chain().focus().toggleCodeBlock().run(),
    },
  ];

  /** Roving arrow-key movement, wrapping at both ends. */
  const onItemKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (index + delta + items.length) % items.length;
      itemRefs.current[next]?.focus();
    }
    if (event.key === 'Home') {
      event.preventDefault();
      itemRefs.current[0]?.focus();
    }
    if (event.key === 'End') {
      event.preventDefault();
      itemRefs.current[items.length - 1]?.focus();
    }
  };

  return (
    <div style={{ position: 'relative' }} data-testid="insert-menu">
      <button
        ref={triggerRef}
        type="button"
        data-testid="insert-trigger"
        aria-label="Insert"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || undefined}
        style={triggerStyle}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          // ArrowDown opens AND lands on the first item, which is the behaviour
          // a keyboard user expects from a menu button and the reason this is
          // not simply a click handler.
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">+</span>
      </button>

      {open ? (
        <ul role="menu" aria-label="Insert" style={menuStyle} data-testid="insert-list">
          {items.map((item, index) => (
            <li key={item.id} role="none">
              <button
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                data-testid={`insert-${item.id}`}
                style={itemStyle}
                onKeyDown={(event) => onItemKeyDown(event, index)}
                onClick={() => {
                  item.run();
                  // The image entry opens a file dialog, so focus must NOT be
                  // yanked back to the trigger underneath it.
                  close(item.id !== 'image');
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="visually-hidden"
        // Not `hidden` and not `display: none`: a hidden input cannot be
        // activated by `.click()` in every browser, and `visually-hidden` keeps
        // it in the tree. It carries a label because an unlabelled file input
        // is an axe violation even when it is off-screen.
        aria-label="Choose an image to insert"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first: choosing the SAME file twice in a row fires no change
          // event otherwise, and the second insert silently does nothing.
          event.target.value = '';
          if (file) void uploadImage(file);
        }}
      />
    </div>
  );
}

export default InsertMenu;
