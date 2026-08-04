"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";

export interface DialogProps {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * UX-02's accessible dialog, built on the native <dialog> element rather
 * than a hand-rolled implementation: `showModal()` gives an implicit
 * `role="dialog"`/`aria-modal="true"`, traps focus inside the dialog,
 * closes on Escape, and restores focus to the previously-focused element
 * on close, all natively. This component only adds the one thing the
 * platform does not provide for free: an accessible name via
 * `aria-labelledby` pointing at the visible title.
 */
export function Dialog({ title, eyebrow, onClose, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === ref.current) {
      ref.current?.close();
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`sheet ${className ?? ""}`}
      onClick={handleBackdropClick}
      onClose={onClose}
    >
      <div className="sheet-handle" aria-hidden="true" />
      <div className="sheet-header">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => ref.current?.close()}
          aria-label="Fermer"
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
