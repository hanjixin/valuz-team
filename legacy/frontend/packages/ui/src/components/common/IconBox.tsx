import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const iconBoxVariants = cva(
  "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        sm: "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        md: "size-9 rounded-lg",
        lg: "size-10 rounded-xl [&_svg:not([class*='size-'])]:size-5",
        xl: "size-11 rounded-xl [&_svg:not([class*='size-'])]:size-5",
      },
      variant: {
        default: "bg-surface-soft text-ink-body",
        brand: "border border-brand/10 bg-brand-light text-brand",
        muted: "bg-surface-soft text-ink-muted",
        outline: "border border-surface-border bg-surface-soft text-ink-body",
      },
    },
    defaultVariants: {
      size: "md",
      variant: "default",
    },
  },
);

export interface IconBoxProps
  extends VariantProps<typeof iconBoxVariants> {
  children?: ReactNode;
  className?: string;
}

export const IconBox = ({
  size = "md",
  variant = "default",
  children,
  className,
}: IconBoxProps) => (
  <div
    data-slot="icon-box"
    className={cn(iconBoxVariants({ size, variant }), className)}
  >
    {children}
  </div>
);

export { iconBoxVariants };
