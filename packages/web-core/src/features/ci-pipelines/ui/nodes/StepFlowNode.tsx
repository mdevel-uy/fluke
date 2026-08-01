import type { Node, NodeProps, NodeTypes } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { Store, TerminalSquare } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { ScriptStep } from '../../model/graph';

/**
 * One step of a script job, rendered as a node in the drill-down chain.
 * The chain is strictly linear — handles exist for visual continuity, not
 * for free-form connections.
 */

export interface StepFlowData extends Record<string, unknown> {
  step: ScriptStep;
  index: number;
  total: number;
}

export type StepFlowNodeType = Node<StepFlowData>;

export function stepTitle(step: ScriptStep, index: number): string {
  if (step.name) return step.name;
  if (step.run) return step.run.split('\n')[0];
  if (step.uses) return step.uses.split('@')[0].split('/').pop() ?? step.uses;
  return `step ${index + 1}`;
}

function stepSubtitle(step: ScriptStep): string {
  if (step.uses) return step.uses;
  if (step.run) return step.run.split('\n')[0];
  return '';
}

function StepNode({ data, selected }: NodeProps<StepFlowNodeType>) {
  const { step, index, total } = data;
  const isUses = step.uses !== undefined;
  const tags: string[] = [];
  if (step.with && Object.keys(step.with).length > 0) {
    tags.push(`with: ${Object.keys(step.with).length}`);
  }
  if (step.env && Object.keys(step.env).length > 0) {
    tags.push(`env: ${Object.keys(step.env).length}`);
  }

  return (
    <div
      className={cn(
        'relative min-w-[170px] max-w-[230px] rounded-[10px] border bg-panel px-3 py-2.5 shadow-sm',
        selected
          ? 'border-brand ring-2 ring-brand/30'
          : 'border-md-outline-variant'
      )}
    >
      <span className="absolute -left-2 -top-2 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-md-outline bg-panel font-mono text-[9.5px] text-low">
        {index + 1}
      </span>
      {index > 0 && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={false}
          className="!h-2.5 !w-2.5 !border-[1.5px] !border-md-outline !bg-panel"
        />
      )}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-5 w-5 flex-none items-center justify-center rounded-[5px]',
            isUses ? 'bg-success/15 text-success' : 'bg-brand/15 text-brand'
          )}
        >
          {isUses ? (
            <Store className="h-3 w-3" strokeWidth={1.75} />
          ) : (
            <TerminalSquare className="h-3 w-3" strokeWidth={1.75} />
          )}
        </span>
        <span className="truncate text-sm font-semibold text-high">
          {stepTitle(step, index)}
        </span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-low">
        {stepSubtitle(step)}
      </div>
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
      {index < total - 1 && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={false}
          className="!h-2.5 !w-2.5 !border-[1.5px] !border-md-outline !bg-panel"
        />
      )}
    </div>
  );
}

export const stepNodeTypes: NodeTypes = {
  step: StepNode,
};
