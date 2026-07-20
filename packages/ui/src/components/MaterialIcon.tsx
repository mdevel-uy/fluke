import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export interface MaterialIconProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  /** FILL 1 = filled (active states), FILL 0 = outlined (default) */
  fill?: 0 | 1;
  /** Font weight (100–700) */
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700;
  /** Optical size */
  opsz?: 20 | 24 | 40 | 48;
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl';
}

const sizeClass: Record<NonNullable<MaterialIconProps['size']>, string> = {
  xs: 'text-[14px]',
  sm: 'text-[18px]',
  base: 'text-[20px]',
  lg: 'text-[22px]',
  xl: 'text-[24px]',
};

export function MaterialIcon({
  name,
  fill = 0,
  weight = 400,
  opsz = 24,
  size = 'base',
  className,
  style,
  ...props
}: MaterialIconProps) {
  return (
    <span
      className={cn('material-symbols-outlined', sizeClass[size], className)}
      style={{
        fontVariationSettings: `'FILL' ${fill}, 'wght' ${weight}, 'GRAD' 0, 'opsz' ${opsz}`,
        ...style,
      }}
      aria-hidden="true"
      {...props}
    >
      {name}
    </span>
  );
}
