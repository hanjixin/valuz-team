import * as React from "react";

import { cn } from "@valuz/ui/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      // ``field-sizing-content`` makes the textarea auto-grow with its
      // content — great for short prompts, disastrous for thousand-line
      // pastes (was blowing out the agent edit dialog past the viewport).
      // ``max-h-[40vh]`` caps the visible height so the textarea grows
      // until ~40% of the viewport, then its own scrollbar takes over.
      className={cn(
        "flex field-sizing-content max-h-[40vh] min-h-16 w-full overflow-y-auto rounded-lg border border-input bg-surface px-2.5 py-2 text-sm text-foreground shadow-none outline-none transition-[border-color,box-shadow,color,background-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-disabled disabled:opacity-100 aria-invalid:border-error aria-invalid:ring-error/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
