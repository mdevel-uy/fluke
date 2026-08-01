import type { Node, NodeProps, NodeTypes } from '@xyflow/react';
import {
  Clock,
  Code2,
  GitPullRequest,
  Package,
  Play,
  Store,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import type { PipelineNode, TriggerNode } from '../../model/graph';
import { getPrefab } from '../../model/prefabs';
import { PipelineNodeCard } from './PipelineNodeCard';

/**
 * React Flow node wrappers. The flow node's data carries the graph node plus
 * presentation extras derived by the canvas (needs count).
 */

export interface PipelineFlowData extends Record<string, unknown> {
  node: PipelineNode;
  needsCount: number;
}

export type PipelineFlowNode = Node<PipelineFlowData>;

const TRIGGER_ICONS: Record<TriggerNode['trigger']['kind'], typeof Zap> = {
  push: Zap,
  pull_request: GitPullRequest,
  schedule: Clock,
  workflow_dispatch: Play,
};

function triggerSubtitle(trigger: TriggerNode['trigger']): string {
  switch (trigger.kind) {
    case 'push':
      return trigger.branches.length > 0
        ? `branches: ${trigger.branches.join(', ')}`
        : 'any branch';
    case 'pull_request':
      return trigger.branches.length > 0
        ? `branches: ${trigger.branches.join(', ')}`
        : 'any branch';
    case 'schedule':
      return `cron: ${trigger.cron}`;
    case 'workflow_dispatch':
      return 'workflow_dispatch';
  }
}

function TriggerFlowNode({ data, selected }: NodeProps<PipelineFlowNode>) {
  const node = data.node;
  if (node.type !== 'trigger') return null;
  return (
    <PipelineNodeCard
      icon={TRIGGER_ICONS[node.trigger.kind]}
      tone="trigger"
      title={`on: ${node.trigger.kind}`}
      subtitle={triggerSubtitle(node.trigger)}
      selected={selected}
      hasTarget={false}
    />
  );
}

function PrefabFlowNode({ data, selected }: NodeProps<PipelineFlowNode>) {
  const node = data.node;
  if (node.type !== 'prefab') return null;
  const prefab = getPrefab(node.prefabId);
  const stepCount = prefab ? prefab.compile(node.params).length : 0;
  const tags = ['prefab', node.runsOn];
  if (data.needsCount > 0) tags.push(`needs: ${data.needsCount}`);
  return (
    <PipelineNodeCard
      icon={Package}
      tone="prefab"
      title={node.label}
      subtitle={`${prefab?.subtitle ?? node.prefabId} · ${stepCount} steps`}
      tags={tags}
      selected={selected}
    />
  );
}

function MarketplaceFlowNode({ data, selected }: NodeProps<PipelineFlowNode>) {
  const node = data.node;
  if (node.type !== 'marketplace') return null;
  const tags = ['marketplace', node.runsOn];
  if (data.needsCount > 0) tags.push(`needs: ${data.needsCount}`);
  return (
    <PipelineNodeCard
      icon={Store}
      tone="marketplace"
      title={node.label}
      subtitle={node.uses}
      tags={tags}
      selected={selected}
    />
  );
}

function ScriptFlowNode({ data, selected }: NodeProps<PipelineFlowNode>) {
  const node = data.node;
  if (node.type !== 'script') return null;
  const tags = ['script', node.runsOn];
  if (node.env && Object.keys(node.env).length > 0) tags.push('env');
  if (data.needsCount > 0) tags.push(`needs: ${data.needsCount}`);
  const runStep = node.steps.find((s) => s.run);
  return (
    <PipelineNodeCard
      icon={TerminalSquare}
      tone="prefab"
      title={node.label}
      subtitle={
        runStep?.run
          ? `${node.steps.length} steps · ${runStep.run.split('\n')[0]}`
          : `${node.steps.length} steps`
      }
      tags={tags}
      selected={selected}
    />
  );
}

function RawYamlFlowNode({ data, selected }: NodeProps<PipelineFlowNode>) {
  const node = data.node;
  if (node.type !== 'raw') return null;
  const lineCount = node.yaml.split('\n').length;
  const isFile = node.scope === 'file';
  return (
    <PipelineNodeCard
      icon={Code2}
      tone="raw"
      title={isFile ? node.label : node.jobId}
      subtitle={
        isFile
          ? `imported workflow · ${lineCount} lines`
          : `raw job · ${lineCount} lines`
      }
      tags={isFile ? [] : ['yaml', node.runsOn]}
      selected={selected}
      hasTarget={!isFile}
      hasSource={!isFile}
    />
  );
}

export const pipelineNodeTypes: NodeTypes = {
  trigger: TriggerFlowNode,
  prefab: PrefabFlowNode,
  marketplace: MarketplaceFlowNode,
  script: ScriptFlowNode,
  raw: RawYamlFlowNode,
};
