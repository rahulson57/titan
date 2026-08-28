/** @jsxRuntime automatic */
/** @jsxImportSource react */
/*
 * The two one-line pragmas above are not decoration, and every component in
 * this directory repeats them. `tsconfig.json` sets `jsx: "preserve"` — correct
 * for Next, whose own compiler owns the transform — but Vitest transforms these
 * same files with esbuild, which reads that setting and falls back to the
 * CLASSIC runtime, emitting bare `React.createElement` calls that die with
 * "React is not defined". The pragmas pin the automatic runtime for the test
 * transform and change not one rendered byte of Next's build.
 *
 * They have to be their own single-line comments: esbuild reads a pragma to the
 * end of its line, so folding them into this block would parse the value as
 * `automatic\n` and be rejected as invalid.
 *
 * The two tidier fixes are both out of this slice's reach — `tsconfig.json`
 * belongs to SPEC-001 and `vitest.config.ts` to SPEC-002, and neither section
 * lets another edit its files.
 */
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonBaseProps {
  children?: ReactNode;
  /** Visual weight. `primary` is the single accent-filled call to action. */
  variant?: ButtonVariant;
  /** `md` (36px) is the default target; `sm` is for dense rows, `lg` for hero actions. */
  size?: ButtonSize;
  /** Square padding for a control whose only content is an icon. Requires `aria-label`. */
  iconOnly?: boolean;
  className?: string;
}

type ButtonAsButton = ButtonBaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonBaseProps> & {
    href?: undefined;
  };

type ButtonAsLink = ButtonBaseProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonBaseProps> & {
    /** When present the button renders as an anchor — a navigation, not an action. */
    href: string;
  };

export type ButtonProps = ButtonAsButton | ButtonAsLink;

export function buttonClassName({
  variant = 'primary',
  size = 'md',
  iconOnly = false,
  className,
}: Pick<ButtonBaseProps, 'variant' | 'size' | 'iconOnly' | 'className'> = {}): string {
  return [
    'btn',
    `btn--${variant}`,
    // `md` is the base `.btn` size, so it adds no modifier — one class fewer
    // in the common case and no empty rule in the stylesheet.
    size === 'md' ? null : `btn--${size}`,
    iconOnly ? 'btn--icon' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The one button primitive (SPEC-003). Every surface composes this; none
 * redefines it.
 *
 * It renders an `<a>` when given `href` and a `<button>` otherwise, because
 * the two are not interchangeable to a screen reader or to the keyboard: a
 * link navigates and answers Enter, a button acts and answers Enter *and*
 * Space. Styling an anchor to look like a button is fine; telling assistive
 * tech it is a button when it navigates is not.
 *
 * The focus ring is not set here. It comes from the `:focus-visible` rule in
 * globals.css that covers every interactive element at once, so no component
 * can accidentally ship without one — SPEC-003 forbids `outline: none` with no
 * replacement, and the way to guarantee that is to never let a component own
 * the decision.
 */
export function Button(props: ButtonProps) {
  const { children, variant, size, iconOnly, className, ...rest } = props;
  const classes = buttonClassName({ variant, size, iconOnly, className });

  if (typeof rest.href === 'string') {
    const { href, ...anchorRest } = rest as AnchorHTMLAttributes<HTMLAnchorElement> & {
      href: string;
    };
    return (
      <a className={classes} href={href} {...anchorRest}>
        {children}
      </a>
    );
  }

  const buttonRest = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button className={classes} type={buttonRest.type ?? 'button'} {...buttonRest}>
      {children}
    </button>
  );
}

export default Button;
