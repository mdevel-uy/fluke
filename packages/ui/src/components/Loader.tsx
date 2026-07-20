import { Loader2 } from 'lucide-react';
import React from 'react';

interface LoaderProps {
  message?: string | React.ReactElement;
  size?: number;
  className?: string;
}

export const Loader: React.FC<LoaderProps> = ({
  message,
  size = 32,
  className = '',
}) => (
  <div
    className={`flex flex-col items-center justify-center gap-3 ${className}`}
  >
    <Loader2
      className="animate-spin text-brand"
      style={{ width: size, height: size }}
    />
    {!!message && <div className="text-center text-sm text-low">{message}</div>}
  </div>
);
