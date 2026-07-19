import * as React from "react";
import { twMerge } from "tailwind-merge";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "rounded-lg bg-brand text-on-brand shadow-soft hover:bg-brand-hover",
        primary:
          "rounded-lg bg-brand text-on-brand shadow-soft hover:bg-brand-hover",
        tonal:
          "rounded-lg bg-brand/10 text-brand hover:bg-brand/15 dark:bg-brand/15 dark:hover:bg-brand/25",
        destructive:
          "rounded-lg bg-destructive text-destructive-foreground shadow-soft hover:bg-destructive/90",
        outline:
          "rounded-lg border border-border bg-primary text-normal hover:bg-secondary hover:text-high",
        secondary:
          "rounded-lg bg-secondary text-normal border border-border/60 hover:bg-panel hover:text-high",
        ghost: "rounded-lg text-normal hover:bg-secondary hover:text-high",
        link: "text-brand underline-offset-4 hover:underline rounded-md",
        icon: "rounded-md bg-transparent text-low hover:bg-secondary hover:text-high",
      },
      size: {
        default: "h-9 px-4 text-sm gap-1.5",
        xs: "h-7 px-2.5 text-xs gap-1",
        sm: "h-8 px-3 text-sm gap-1.5",
        lg: "h-11 px-6 text-base gap-2",
        icon: "h-8 w-8 p-0",
      },
    },
    compoundVariants: [
      { variant: "icon", size: "icon", class: "h-8 w-8 p-0" },
      { variant: "icon", size: "default", class: "h-8 w-8 p-0" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={twMerge(cn(buttonVariants({ variant, size, className })))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
