import * as React from "react"

import { cn } from "@valuz/ui/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-surface px-2.5 py-0 text-sm leading-none text-foreground shadow-none outline-none transition-[border-color,box-shadow,color,background-color] selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-disabled disabled:opacity-100",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "aria-invalid:border-error aria-invalid:ring-error/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
