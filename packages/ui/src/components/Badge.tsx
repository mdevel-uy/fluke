import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-1",
  {
    variants: {
      variant: {
        default:
          "bg-brand/10 text-brand dark:bg-brand/15 border border-transparent",
        secondary: "bg-secondary text-normal border border-border/60",
        destructive:
          "bg-destructive/10 text-destructive dark:bg-destructive/15 border border-transparent",
        success:
          "bg-success/10 text-success dark:bg-success/15 border border-transparent",
        warning:
          "bg-warning/10 text-warning dark:bg-warning/15 border border-transparent",
        outline: "text-normal border border-border/70 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
