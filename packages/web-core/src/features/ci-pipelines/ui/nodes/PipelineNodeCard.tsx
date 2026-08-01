import type { ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

export type NodeTone = 'trigger' | 'prefab' | 'marketplace' | 'raw';

const TONE_CLASSES: Record<NodeTone, string> = {
  trigger: 'bg-warning/15 text-warning',
  prefab: 'bg-brand/15 text-brand',
  marketplace: 'bg-success/15 text-success',
  raw: 'bg-secondary text-normal',
};

interface PipelineNodeCardProps {
  icon: LucideIcon;
  tone: NodeTone;
  title: string;
  subtitle: string;
  tags?: string[];
  selected?: boolean;
  /** Triggers only emit; jobs receive and emit. */
  hasTarget?: boolean;
  hasSource?: boolean;
  children?: ReactNode;
}

/**
 * Shared node chrome, mirroring the approved mock: icon chip + bold title,
 * muted subtitle, optional tag row, ports on the left/right edges.
 */
export function PipelineNodeCard({
  icon: Icon,
  tone,
  title,
  subtitle,
  tags = [],
  selected = false,
  hasTarget = true,
  hasSource = true,
  children,
}: PipelineNodeCardProps) {
  return (
    <div
      className={cn(
        'min-w-[180px] max-w-[240px] rounded-[10px] border bg-panel px-3 py-2.5 shadow-sm',
        selected
          ? 'border-brand ring-2 ring-brand/30'
          : 'border-md-outline-variant'
      )}
    >
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-[1.5px] !border-md-outline !bg-panel"
        />
      )}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-5 w-5 flex-none items-center justify-center rounded-[5px]',
            TONE_CLASSES[tone]
          )}
        >
          <Icon className="h-3 w-3" strokeWidth={1.75} />
        </span>
        <span className="truncate text-sm font-semibold text-high">
          {title}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-low">{subtitle}</div>
      {tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded border border-md-outline-variant bg-secondary px-1.5 py-px text-[9.5px] text-low"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {children}
      {hasSource && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-2.5 !w-2.5 !border-[1.5px] !border-md-outline !bg-panel"
        />
      )}
    </div>
  );
}
