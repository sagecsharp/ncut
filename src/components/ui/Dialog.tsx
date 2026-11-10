import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** buttons row at the bottom */
  footer?: ReactNode;
  /** max width in px. default 480 */
  width?: number;
  /** when false, escape / backdrop click / the x button do nothing (e.g. while exporting) */
  dismissable?: boolean;
}

/** flat modal. closes on escape and backdrop click. */
export function Dialog({ open, title, onClose, children, footer, width, dismissable = true }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);
  onCloseRef.current = onClose;
  dismissableRef.current = dismissable;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissableRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        style={width ? { maxWidth: width } : undefined}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} disabled={!dismissable} aria-label="close" title="close">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
