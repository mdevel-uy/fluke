import {
  newNodeId,
  type NodePosition,
  type PipelineGraph,
  type PipelineNode,
  type RawYamlJobNode,
  type ScriptJobNode,
  type ScriptStep,
  type TriggerKind,
  type TriggerSpec,
} from './graph';
import {
  defaultParamsFor,
  getPrefab,
  PREFABS,
  type WorkflowStep,
} from './prefabs';

/**
 * Shared node catalog: the palette browses it, the Tab picker searches it.
 * One data source, two speeds.
 */

export type CatalogItem =
  | {
      kind: 'trigger';
      triggerKind: TriggerKind;
      name: string;
      subtitle: string;
    }
  | { kind: 'prefab'; prefabId: string; name: string; subtitle: string }
  | { kind: 'script'; name: string; subtitle: string }
  | { kind: 'raw'; name: string; subtitle: string };

export const CATALOG: CatalogItem[] = [
  {
    kind: 'trigger',
    triggerKind: 'push',
    name: 'Push',
    subtitle: 'branches, paths',
  },
  {
    kind: 'trigger',
    triggerKind: 'pull_request',
    name: 'Pull request',
    subtitle: 'branches',
  },
  {
    kind: 'trigger',
    triggerKind: 'schedule',
    name: 'Schedule',
    subtitle: 'cron',
  },
  {
    kind: 'trigger',
    triggerKind: 'workflow_dispatch',
    name: 'Manual',
    subtitle: 'workflow_dispatch',
  },
  {
    kind: 'script',
    name: 'Script job',
    subtitle: 'run / uses steps',
  },
  ...PREFABS.map((p) => ({
    kind: 'prefab' as const,
    prefabId: p.id,
    name: p.name,
    subtitle: p.subtitle,
  })),
  { kind: 'raw', name: 'Raw YAML', subtitle: 'anything the graph cannot say' },
];

/** Curated marketplace list for PR 1; live search arrives later. */
export interface MarketplaceCatalogItem {
  uses: string;
  verified: boolean;
  version: string;
  stars: string;
  description: string;
}

export const MARKETPLACE_ACTIONS: MarketplaceCatalogItem[] = [
  {
    uses: 'docker/build-push-action@v6',
    verified: true,
    version: 'v6',
    stars: '4.6k',
    description: 'Build and push Docker images with Buildx',
  },
  {
    uses: 'actions/checkout@v4',
    verified: true,
    version: 'v4',
    stars: '6.4k',
    description: 'Checkout a Git repository',
  },
  {
    uses: 'actions/setup-node@v4',
    verified: true,
    version: 'v4',
    stars: '4.2k',
    description: 'Setup Node.js environment with caching',
  },
  {
    uses: 'microsoft/playwright-github-action@v1',
    verified: true,
    version: 'v1',
    stars: '2.1k',
    description: 'Run Playwright end-to-end tests',
  },
  {
    uses: 'softprops/action-gh-release@v2',
    verified: false,
    version: 'v2',
    stars: '3.2k',
    description: 'GitHub releases from CI',
  },
  {
    uses: 'codecov/codecov-action@v4',
    verified: true,
    version: 'v4',
    stars: '1.9k',
    description: 'Upload coverage reports to Codecov',
  },
  {
    uses: 'aquasecurity/trivy-action@0.24.0',
    verified: false,
    version: 'v0.24',
    stars: '1.6k',
    description: 'Scan images and repos for vulnerabilities',
  },
  {
    uses: 'peter-evans/create-pull-request@v6',
    verified: false,
    version: 'v6',
    stars: '2.3k',
    description: 'Create a pull request from changed files',
  },
];

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

function defaultTriggerSpec(kind: TriggerKind): TriggerSpec {
  switch (kind) {
    case 'push':
      return { kind: 'push', branches: ['main'] };
    case 'pull_request':
      return { kind: 'pull_request', branches: ['main'] };
    case 'schedule':
      return { kind: 'schedule', cron: '0 6 * * 1' };
    case 'workflow_dispatch':
      return { kind: 'workflow_dispatch' };
  }
}

function uniqueJobId(graph: PipelineGraph, base: string): string {
  const taken = new Set(
    graph.nodes.flatMap((n) => (n.type === 'trigger' ? [] : [n.jobId]))
  );
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

export function buildCatalogNode(
  item: CatalogItem,
  graph: PipelineGraph,
  position: NodePosition
): PipelineNode {
  if (item.kind === 'trigger') {
    return {
      type: 'trigger',
      id: newNodeId(),
      position,
      trigger: defaultTriggerSpec(item.triggerKind),
    };
  }
  if (item.kind === 'prefab') {
    // Prefabs are templates, not a node type: they insert a script job with
    // the expanded step chain visible and editable.
    const prefab = getPrefab(item.prefabId);
    const base = prefab?.defaultJobId ?? 'job';
    const jobId = uniqueJobId(graph, base);
    return {
      type: 'script',
      id: newNodeId(),
      position,
      jobId,
      label: prefab?.name ?? jobId,
      runsOn: 'ubuntu-latest',
      steps: prefab
        ? prefab.compile(defaultParamsFor(prefab)).map(toScriptStep)
        : [{ run: '' }],
    };
  }
  if (item.kind === 'script') {
    const jobId = uniqueJobId(graph, 'job');
    return {
      type: 'script',
      id: newNodeId(),
      position,
      jobId,
      label: jobId,
      runsOn: 'ubuntu-latest',
      steps: [
        { name: 'Checkout', uses: 'actions/checkout@v4' },
        { run: 'echo hello' },
      ],
    };
  }
  const raw: RawYamlJobNode = {
    type: 'raw',
    id: newNodeId(),
    position,
    jobId: uniqueJobId(graph, 'custom'),
    label: 'custom',
    runsOn: 'ubuntu-latest',
    scope: 'job',
    yaml: 'runs-on: ubuntu-latest\nsteps:\n  - run: echo hello\n',
  };
  return raw;
}

/** A marketplace action inserted at job level is just a script job with a
 * checkout + one `uses` step — its chain stays visible and extensible. */
export function buildMarketplaceNode(
  uses: string,
  graph: PipelineGraph,
  position: NodePosition
): ScriptJobNode {
  const slug = uses.split('/')[1]?.split('@')[0] ?? 'action';
  const base = slug.replace(/[^a-zA-Z0-9_-]/g, '-') || 'action';
  const jobId = uniqueJobId(graph, base);
  return {
    type: 'script',
    id: newNodeId(),
    position,
    jobId,
    label: slug,
    runsOn: 'ubuntu-latest',
    steps: [
      { name: 'Checkout', uses: 'actions/checkout@v4' },
      { name: slug, uses, with: {} },
    ],
  };
}

function toScriptStep(step: WorkflowStep): ScriptStep {
  return {
    ...(step.name !== undefined ? { name: step.name } : {}),
    ...(step.uses !== undefined ? { uses: step.uses } : {}),
    ...(step.with !== undefined ? { with: step.with } : {}),
    ...(step.run !== undefined ? { run: step.run } : {}),
    ...(step.env !== undefined ? { env: step.env } : {}),
  };
}
