"use client";

import { useId, type InputHTMLAttributes } from "react";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  error?: string;
  hint?: string;
}

/**
 * UX-05: every required field gets a real <label>, inline validation is
 * linked to its input via aria-describedby/aria-invalid (never color-only
 * or a single page-level banner), and the user's input is never cleared by
 * a failed submission (this is a plain controlled input, so that is the
 * caller's responsibility to preserve — it just never happens implicitly).
 */
export function TextField({ label, error, hint, className, ...inputProps }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <label className="field-label" htmlFor={id}>
      {label}
      <input
        id={id}
        className={`input ${className ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...inputProps}
      />
      {hint && !error && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
