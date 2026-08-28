/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
import type { CSSProperties } from 'react';

export type SkeletonVariant = 'text' | 'rect' | 'circle';

export interface SkeletonProps {
  /** `text` sizes to one line of the current font; `rect` and `circle` need dimensions. */
  variant?: SkeletonVariant;
  /** CSS length. Number is treated as px. */
  width?: string | number;
  /** CSS length. Number is treated as px. Ignored for `text`, which is 1em tall. */
  height?: string | number;
  /** For `text`: how many lines to render. The last is short, as real text is. */
  lines?: number;
  className?: string;
}

function toLength(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

/**
 * Loading placeholder (SPEC-003). SPEC-011 renders it from every route's
 * `loading.tsx`, so no route ever shows a blank frame.
 *
 * The whole block is one `aria-busy` region labelled "Loading" and its bars
 * are `aria-hidden`, so assistive tech announces the wait once instead of
 * reading out a list of empty boxes. The shimmer is a background animation,
 * which the reduced-motion rule in globals.css stops for anyone who has asked
 * for less movement.
 */
export function Skeleton({ variant = 'text', width, height, lines = 1, className }: SkeletonProps) {
  const lineCount = variant === 'text' ? Math.max(1, Math.floor(lines)) : 1;

  const style: CSSProperties = {
    width: toLength(width),
    ...(variant === 'text' ? {} : { height: toLength(height) }),
  };

  const classes = ['skeleton', `skeleton--${variant}`, className].filter(Boolean).join(' ');

  if (variant === 'text' && lineCount > 1) {
    return (
      <span role="status" aria-busy="true" aria-label="Loading" data-testid="skeleton">
        {Array.from({ length: lineCount }, (_unused, index) => (
          <span
            key={index}
            className={classes}
            aria-hidden="true"
            style={{
              ...style,
              // The final line of a paragraph is rarely full width; stopping at
              // 62% is what stops a stack of identical bars reading as a table.
              width: index === lineCount - 1 ? '62%' : style.width,
              marginBlockStart: index === 0 ? undefined : '0.5em',
            }}
          />
        ))}
      </span>
    );
  }

  return (
    <span
      className={classes}
      style={style}
      role="status"
      aria-busy="true"
      aria-label="Loading"
      data-testid="skeleton"
    />
  );
}

export default Skeleton;
