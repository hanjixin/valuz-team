import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface FormFieldProps {
  /** Field label text */
  label: string;
  /** htmlFor attribute to link label with input */
  htmlFor?: string;
  /** Error message displayed below the field */
  error?: string;
  /** Optional control rendered right-aligned on the label row (e.g. an
   *  expand/maximize button). */
  labelAction?: ReactNode;
  /** The input/control element */
  children: ReactNode;
  /** Extra class on the wrapper */
  className?: string;
}

/**
 * Form field wrapper with a styled label and optional error message.
 * Wraps any input/control (Input, Textarea, Select, etc.).
 */
export const FormField = ({
  label,
  htmlFor,
  error,
  labelAction,
  children,
  className,
}: FormFieldProps) => (
  <div className={cn("flex flex-col", className)}>
    <div className="mb-[5px] flex min-h-4 items-center justify-between gap-2">
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium text-ink-label"
      >
        {label}
      </label>
      {labelAction}
    </div>
    {children}
    {error && <p className="mt-[3px] text-xs text-error-text">{error}</p>}
  </div>
);
