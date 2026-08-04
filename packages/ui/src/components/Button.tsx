import * as React from 'react';
import { twMerge } from 'tailwind-merge';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap font-normal transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed active:translate-y-px',
  {
    variants: {
      variant: {
        default: 'rounded-md bg-brand text-on-brand hover:bg-brand-hover',
        primary: 'rounded-md bg-brand text-on-brand hover:bg-brand-hover',
        tonal:
          'rounded-md bg-brand/10 text-brand-on-surface hover:bg-brand/15 dark:bg-brand/15 dark:hover:bg-brand/25',
        destructive:
          'rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'rounded-md border border-border bg-primary text-normal hover:bg-secondary hover:text-high',
        secondary:
          'rounded-md bg-secondary text-normal border border-border/60 hover:bg-panel hover:text-high',
        ghost: 'rounded-md text-normal hover:bg-secondary hover:text-high',
        link: 'text-brand-on-surface underline-offset-4 hover:underline rounded-md',
        icon: 'rounded-md bg-transparent text-low hover:bg-secondary hover:text-high',
      },
      size: {
        default: 'h-[26px] px-3 text-sm gap-1.5',
        xs: 'h-[22px] px-2 text-xs gap-1',
        sm: 'h-6 px-2.5 text-sm gap-1.5',
        lg: 'h-8 px-4 text-sm gap-2',
        icon: 'h-[26px] w-[26px] p-0',
      },
    },
    compoundVariants: [
      { variant: 'icon', size: 'icon', class: 'h-[26px] w-[26px] p-0' },
      { variant: 'icon', size: 'default', class: 'h-[26px] w-[26px] p-0' },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={twMerge(cn(buttonVariants({ variant, size, className })))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
