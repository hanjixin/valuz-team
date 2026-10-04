import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const isUuidLike = (s: string) => /^[0-9a-f]{8}-/i.test(s);

// Inline rename input — mirrors the sidebar's conversation rename (same logic
// and style): autofocus + select on mount, deferred one rAF so the closing
// dropdown's auto-focus housekeeping doesn't wipe the caret right after we
// focus. Enter confirms (when non-empty), Escape / empty cancels, blur commits.
// Replaces the broken ``window.prompt`` path (prompts are disabled in Electron,
// so the old menu item did nothing).
export const RenameInput = ({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) => {
  const startValue = isUuidLike(initial) ? "" : initial;
  const [value, setValue] = useState(startValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed) onConfirm(trimmed);
      else onCancel();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed) onConfirm(trimmed);
        else onCancel();
      }}
      onKeyDown={handleKeyDown}
      // Clicks inside the input must not bubble to the row's navigation.
      onClick={(e) => e.stopPropagation()}
      className="h-full w-full rounded-none border-0 border-b border-brand bg-transparent px-1 text-sm text-ink-heading outline-none"
    />
  );
};
