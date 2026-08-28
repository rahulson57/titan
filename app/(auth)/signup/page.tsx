'use client';

/**
 * `/signup` (SPEC-005, "Routes & actions").
 *
 * Same shape as `/signin` and for the same reasons — see the header there for
 * why this is a client component and why the styles are inline token reads
 * rather than classes in `app/globals.css` (which SPEC-003 owns and this task
 * may not edit).
 *
 * The difference that matters is error handling. Sign-in has exactly one
 * failure message by design; sign-up has four fields that can each fail
 * independently, and SPEC-005's oracle asks for "a field-level error" —
 * so `validateSignUp` returns every problem at once and each is rendered
 * against its own input, wired with `aria-describedby` and
 * `aria-invalid`. A form that reports one error at a time is a form the user
 * submits four times.
 */

import Link from 'next/link';
import { useActionState } from 'react';

import { Button } from '../../../components/ui/Button';
import { signUp } from '../actions';
import {
  EMPTY_FORM_STATE,
  PASSWORD_MIN,
  type AuthField,
} from '../../../lib/auth/validation';

const column: React.CSSProperties = {
  maxWidth: '26rem',
  margin: '0 auto',
  padding: 'var(--space-7) var(--space-5)',
  fontFamily: 'var(--font-ui)',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  marginBottom: 'var(--space-5)',
};

const inputStyle: React.CSSProperties = {
  padding: 'var(--space-3)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 'var(--text-ui-size)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  fontWeight: 600,
  color: 'var(--fg)',
};

const hintStyle: React.CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg-muted)',
};

/**
 * `--fg` on `--bg-subtle`, not a red.
 *
 * SPEC-002's accessibility budget requires >= 4.5:1 body contrast in BOTH
 * themes, and SPEC-003's token set has no error colour with a verified ratio.
 * Inventing one here would put an unmeasured value on the page and risk the
 * contrast gate; the border plus `role="alert"` carries the emphasis instead.
 * Colour was never the accessible signal anyway — it is invisible to a screen
 * reader and unreliable for a colour-blind reader.
 */
const errorTextStyle: React.CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-2) var(--space-3)',
};

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUp, EMPTY_FORM_STATE);

  const errorFor = (name: AuthField): string | null =>
    state.errors.find((e) => e.field === name)?.message ?? null;

  /**
   * Render one field with its error wired up.
   *
   * `aria-describedby` is set ONLY when there is an error. Pointing it at an
   * id that does not exist is not harmless — several screen readers announce
   * nothing at all for the field rather than falling back to the label.
   */
  const renderField = (
    name: AuthField,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement>,
    hint?: string,
  ) => {
    const error = errorFor(name);
    const errorId = `${name}-error`;
    const hintId = `${name}-hint`;
    const describedBy = [error ? errorId : null, hint ? hintId : null]
      .filter(Boolean)
      .join(' ');

    return (
      <div style={fieldStyle}>
        <label htmlFor={name} style={labelStyle}>
          {label}
        </label>
        <input
          id={name}
          name={name}
          style={inputStyle}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...props}
        />
        {hint ? (
          <span id={hintId} style={hintStyle}>
            {hint}
          </span>
        ) : null}
        {error ? (
          <span id={errorId} role="alert" data-field-error={name} style={errorTextStyle}>
            {error}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <main style={column}>
      <h1 style={{ font: 'var(--text-h1)', marginBottom: 'var(--space-6)' }}>
        Create your account
      </h1>

      <form action={formAction} noValidate>
        {renderField('name', 'Name', {
          type: 'text',
          autoComplete: 'name',
          required: true,
          maxLength: 60,
        })}

        {renderField(
          'handle',
          'Handle',
          { type: 'text', autoComplete: 'username', required: true, maxLength: 24 },
          'Your profile lives at /@handle. Lowercase letters, numbers and underscores.',
        )}

        {renderField('email', 'Email', {
          type: 'email',
          autoComplete: 'email',
          required: true,
        })}

        {renderField(
          'password',
          'Password',
          { type: 'password', autoComplete: 'new-password', required: true },
          `At least ${PASSWORD_MIN} characters. Length beats punctuation — a short phrase is stronger than a mangled word.`,
        )}

        <Button type="submit" disabled={pending} style={{ width: '100%' }}>
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <p style={{ marginTop: 'var(--space-5)', fontSize: 'var(--text-meta-size)' }}>
        Already have an account? <Link href="/signin">Sign in</Link>
      </p>
    </main>
  );
}
