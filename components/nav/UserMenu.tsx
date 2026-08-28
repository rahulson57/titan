/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx. */
'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Avatar } from '../ui/Avatar';
import { SETTINGS_PROFILE, draftsHref, profileHref } from '../../lib/routes';

export interface UserMenuUser {
  handle: string;
  name: string;
  avatarPath: string | null;
}

export interface UserMenuProps {
  user: UserMenuUser;
  /**
   * SPEC-005's `signOut` Server Action, passed in rather than imported.
   *
   * This is a client component; importing `app/(auth)/actions` here would pull
   * a `'use server'` module into the client graph. Next supports that, but the
   * dependency direction is wrong — `components/` would then know about a
   * specific route group's actions, and this component could not be rendered
   * from anywhere else. Taking the action as a prop keeps the menu a pure
   * presentation of whatever "sign out" means to its caller, and Server
   * Actions are designed to cross this boundary as props.
   */
  signOutAction: () => Promise<void>;
  className?: string;
}

/**
 * The avatar menu (SPEC-011).
 *
 * > "Avatar menu items: `Profile` (`/@handle`), `Drafts` (`/@handle?tab=drafts`),
 * >  `Settings`, `Sign out`. The menu is a keyboard-navigable `menu`/`menuitem`
 * >  widget: `Escape` closes and returns focus to the trigger; `ArrowUp`/
 * >  `ArrowDown` cycle items."
 *
 * ── Why this is hand-built rather than a `<details>` or a library ─────────
 * The spec asks for the `menu`/`menuitem` pattern by name, and that pattern
 * has behaviour no native element provides: arrow-key roving focus, wrap-around
 * cycling, Escape-restores-focus, and a trigger that reports `aria-expanded`.
 * `<details>`/`<summary>` gives disclosure semantics, not menu semantics, and
 * announces "expandable" rather than a list of actions. A dependency would be
 * the other way to get it, but SPEC-001's constraints do not name one and this
 * is ~120 lines of well-understood WAI-ARIA.
 *
 * ── The three details that are easy to get wrong ──────────────────────────
 *
 * 1. **Roving tabindex, not `tabIndex={0}` on every item.** Exactly one item
 *    is tabbable at a time. Without this, Tab walks through four menu items
 *    before reaching the rest of the page, which is precisely the trap the
 *    menu pattern exists to avoid — arrows move *within* the widget, Tab moves
 *    *past* it.
 *
 * 2. **Focus is moved in an effect, after the open state has painted.** Calling
 *    `.focus()` in the same tick as `setOpen(true)` targets an element React
 *    has not committed yet, so the call silently does nothing and the first
 *    ArrowDown appears to be swallowed.
 *
 * 3. **Escape restores focus to the trigger.** A menu that closes and drops
 *    focus onto `<body>` strands a keyboard user at the top of the document —
 *    they have to Tab from the beginning of the page to get back. This is a
 *    sealed criterion, and it is also the single most common defect in
 *    hand-rolled menus.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the surface reads design tokens from `style` props rather
 * than adding `.user-menu` rules. Every colour, radius and step below is a
 * SPEC-003 token; none is a literal.
 */

/** SPEC-011's four items, in the spec's order. `Sign out` is the odd one out. */
type MenuItem =
  | { kind: 'link'; key: string; label: string; href: string }
  | { kind: 'signout'; key: string; label: string };

const triggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  background: 'none',
  border: 0,
  padding: 0,
  cursor: 'pointer',
  borderRadius: 'var(--radius-pill)',
  color: 'var(--fg)',
};

const menuStyle: CSSProperties = {
  position: 'absolute',
  insetBlockStart: 'calc(100% + var(--space-2))',
  insetInlineEnd: 0,
  minInlineSize: '13rem',
  margin: 0,
  padding: 'var(--space-2) 0',
  listStyle: 'none',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  // A menu that sits under the page content is a menu nobody can click.
  zIndex: 50,
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-ui-size)',
};

const itemStyle: CSSProperties = {
  display: 'block',
  inlineSize: '100%',
  textAlign: 'start',
  padding: 'var(--space-2) var(--space-4)',
  background: 'none',
  border: 0,
  color: 'var(--fg)',
  textDecoration: 'none',
  cursor: 'pointer',
  font: 'inherit',
  whiteSpace: 'nowrap',
};

export function UserMenu({ user, signOutAction, className }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  /** Which item owns focus. `-1` while closed, so opening always starts at 0. */
  const [activeIndex, setActiveIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  // `useId` rather than a constant: two menus on one page (a mobile and a
  // desktop nav, say) would otherwise share an id, and `aria-controls` would
  // point half of them at the wrong element.
  const menuId = useId();

  const items: MenuItem[] = [
    { kind: 'link', key: 'profile', label: 'Profile', href: profileHref(user.handle) },
    { kind: 'link', key: 'drafts', label: 'Drafts', href: draftsHref(user.handle) },
    { kind: 'link', key: 'settings', label: 'Settings', href: SETTINGS_PROFILE },
    { kind: 'signout', key: 'signout', label: 'Sign out' },
  ];

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    // The criterion is "closes on Escape and returns focus to its trigger".
    triggerRef.current?.focus();
  }, []);

  const openAt = useCallback((index: number) => {
    setOpen(true);
    setActiveIndex(index);
  }, []);

  // Detail (2) above: focus the active item only once React has committed the
  // open menu, which is what makes it exist in the DOM to be focused.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // A click anywhere else dismisses the menu — but WITHOUT stealing focus back
  // to the trigger, because the user is already looking somewhere else and
  // yanking the caret back would be worse than leaving it. Escape is the path
  // that restores focus; a click is not.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const itemCount = items.length;

  /** Move by `delta`, wrapping — SPEC-011 says "cycle", not "stop at the end". */
  const move = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const from = current < 0 ? (delta > 0 ? -1 : 0) : current;
        return (from + delta + itemCount) % itemCount;
      });
    },
    [itemCount],
  );

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    // Enter and Space already reach us as a click on a native <button>, so they
    // are deliberately not handled here — doing both would open and immediately
    // re-open, and the duplicate is invisible until it isn't.
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(itemCount - 1);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeAndRestoreFocus();
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(itemCount - 1);
        break;
      case 'Escape':
        event.preventDefault();
        closeAndRestoreFocus();
        break;
      case 'Tab':
        // Tab leaves the widget. Close it on the way out — but do NOT
        // preventDefault, because swallowing Tab would trap focus inside a
        // menu the user is explicitly trying to leave.
        setOpen(false);
        setActiveIndex(-1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', display: 'inline-flex' }}
      data-testid="user-menu"
    >
      <button
        ref={triggerRef}
        type="button"
        style={triggerStyle}
        // `aria-haspopup="menu"` is what tells a screen reader this is not an
        // ordinary button; `aria-expanded` is what tells it the current state.
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // The avatar is an image with no text, so the trigger needs a name.
        // Naming the user makes it useful rather than merely present.
        aria-label={`Account menu for ${user.name}`}
        onClick={() => (open ? closeAndRestoreFocus() : openAt(0))}
        onKeyDown={onTriggerKeyDown}
        data-testid="user-menu-trigger"
      >
        <Avatar name={user.name} src={user.avatarPath} size="sm" />
        {/*
          `data-session-handle` — required by DEC-025(b), and the load-bearing
          observation in SPEC-005's revocation oracle: `tests/e2e/auth.spec.ts`
          reads it to prove WHO is signed in, not merely that someone is.

          It sits on the trigger rather than inside the dropdown deliberately.
          Inside the menu it would exist only while the menu is open, so the
          assertion would be testing the menu's open state as much as the
          session — and it would silently start failing the first time anyone
          changed how the menu mounts. On the trigger it is in the DOM whenever
          a session is live, and absent whenever one is not, which is exactly
          the property being asserted.

          Visually hidden because the avatar already carries this information
          to a sighted reader, and `aria-label` on the button supplies the
          accessible name — so this text is an observation point, not a second
          label competing with the first.
        */}
        <span className="visually-hidden" data-session-handle>
          @{user.handle}
        </span>
      </button>

      {open ? (
        <ul
          id={menuId}
          role="menu"
          aria-label="Account"
          style={menuStyle}
          onKeyDown={onMenuKeyDown}
          data-testid="user-menu-items"
        >
          {items.map((item, index) => (
            // `role="none"` on the <li>: a `role="menu"` may only contain
            // menuitems, and an implicit `listitem` between the two breaks the
            // relationship for screen readers that check it.
            <li key={item.key} role="none">
              {item.kind === 'link' ? (
                <a
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  role="menuitem"
                  href={item.href}
                  style={itemStyle}
                  // Detail (1): roving tabindex — exactly one tab stop.
                  tabIndex={activeIndex === index ? 0 : -1}
                  onClick={() => setOpen(false)}
                  data-testid={`user-menu-${item.key}`}
                >
                  {item.label}
                </a>
              ) : (
                // Sign out is a real form posting to SPEC-005's Server Action,
                // not a link: it mutates (it deletes the Session row), and a
                // GET that mutates is prefetchable — a link here could be
                // signed out by a hovering browser. The form also means the
                // control works with JavaScript disabled.
                <form action={signOutAction} style={{ margin: 0 }}>
                  <button
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    role="menuitem"
                    type="submit"
                    style={itemStyle}
                    tabIndex={activeIndex === index ? 0 : -1}
                    data-testid="user-menu-signout"
                  >
                    {item.label}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default UserMenu;
