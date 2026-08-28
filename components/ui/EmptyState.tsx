/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** One short sentence naming what is absent. Rendered as the heading. */
  title: string;
  /** Optional second line: what the reader can do about it. */
  description?: ReactNode;
  /** Usually a `Button`. Rendered below the description. */
  action?: ReactNode;
  /**
   * Heading level, so the state slots into the page outline correctly.
   * Defaults to `h2` — an empty state is almost never the page's own title.
   */
  headingLevel?: 2 | 3;
  className?: string;
}

/**
 * The "nothing here" surface (SPEC-003).
 *
 * A real heading rather than styled text, because an empty state is a
 * landmark a screen-reader user navigates to, and because "Nothing saved yet"
 * is genuinely the section's title when the section is empty.
 */
export function EmptyState({
  title,
  description,
  action,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const classes = ['empty-state', className].filter(Boolean).join(' ');

  return (
    <div className={classes} data-testid="empty-state">
      <Heading className="empty-state__title">{title}</Heading>
      {description ? <p className="empty-state__description">{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
