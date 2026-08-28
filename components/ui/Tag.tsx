/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
import type { AnchorHTMLAttributes, ReactNode } from 'react';

export interface TagProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  children: ReactNode;
  /** Tag pages live at `/tag/[slug]` (SPEC-011). Omit for a non-navigating chip. */
  href?: string;
  /** The tag whose page the reader is currently on. */
  active?: boolean;
  className?: string;
}

/**
 * A topic chip (SPEC-003).
 *
 * With `href` it is an anchor; without, a plain `<span>` rather than a
 * disabled link — a chip that goes nowhere should not be in the tab order or
 * announced as a link. `aria-current="page"` marks the active one, which is
 * what tells a screen-reader user which tag page they are on; colour alone
 * would not.
 */
export function Tag({ children, href, active = false, className, ...rest }: TagProps) {
  const classes = ['tag', active ? 'tag--active' : null, className].filter(Boolean).join(' ');

  if (typeof href === 'string') {
    return (
      <a className={classes} href={href} aria-current={active ? 'page' : undefined} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <span className={classes} data-testid="tag">
      {children}
    </span>
  );
}

export default Tag;
