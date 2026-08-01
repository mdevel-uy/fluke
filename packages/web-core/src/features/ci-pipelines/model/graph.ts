import { z } from 'zod';

/**
 * Pipeline graph — the source of truth for a workflow edited in the CI
 * Pipeline Studio. The GitHub Actions YAML is a compiled artifact derived
 * from this structure (see compiler.ts); the graph is persisted as a sidecar
 * file next to the generated YAML (`<name>.vibe.json`, see workflowFiles.ts).
 *
 * Mapping to Actions concepts:
 * - job nodes  → entries under `jobs:`
 * - job→job edges → `needs:` (always derived from edges, never hand-edited)
 * - trigger nodes → merged into the `on:` block (edges from triggers are
 *   visual only)
 */

export const PIPELINE_GRAPH_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodePosition {
  x: number;
  y: number;
}

export type TriggerSpec =
  | {
      kind: 'push';
      branches: string[];
      pathsIgnore?: string[];
      tags?: string[];
    }
  | { kind: 'pull_request'; branches: string[] }
  | { kind: 'schedule'; cron: string }
  | { kind: 'workflow_dispatch' };

export type TriggerKind = TriggerSpec['kind'];

interface NodeBase {
  id: string;
  position: NodePosition;
}

export interface TriggerNode extends NodeBase {
  type: 'trigger';
  trigger: TriggerSpec;
}

interface JobNodeBase extends NodeBase {
  /** YAML job key. Unique across the graph, `^[a-zA-Z_][a-zA-Z0-9_-]*$`. */
  jobId: string;
  /** Human title; compiled to the job `name:` when it differs from jobId. */
  label: string;
  runsOn: string;
}

export interface PrefabJobNode extends JobNodeBase {
  type: 'prefab';
  prefabId: string;
  params: Record<string, string | boolean>;
}

export interface MarketplaceJobNode extends JobNodeBase {
  type: 'marketplace';
  /** e.g. `docker/build-push-action@v6` */
  uses: string;
  with: Record<string, string>;
  /** Prepend an actions/checkout step before the action. */
  checkout: boolean;
}

/** YAML scalars survive imports typed (numbers/booleans re-emit as-is). */
export type ScalarValue = string | number | boolean;

/** One step of a script job: either `run` or `uses` (with optional inputs),
 * plus optional per-step env. */
export interface ScriptStep {
  name?: string;
  uses?: string;
  with?: Record<string, ScalarValue>;
  run?: string;
  env?: Record<string, ScalarValue>;
}

/** The general-purpose structured job: an ordered list of run/uses steps
 * and optional job-level env. Absorbs what used to fall into raw YAML. */
export interface ScriptJobNode extends JobNodeBase {
  type: 'script';
  steps: ScriptStep[];
  env?: Record<string, ScalarValue>;
}

export interface RawYamlJobNode extends JobNodeBase {
  type: 'raw';
  /**
   * 'job'  — `yaml` holds a single job body mapping, spliced under `jobs:`.
   * 'file' — `yaml` holds an entire workflow file, emitted verbatim. Used for
   *          best-effort import of workflows that have no sidecar graph; must
   *          be the only node in the graph.
   */
  scope: 'job' | 'file';
  yaml: string;
}

export type PipelineJobNode =
  | PrefabJobNode
  | MarketplaceJobNode
  | ScriptJobNode
  | RawYamlJobNode;
export type PipelineNode = TriggerNode | PipelineJobNode;

export interface PipelineEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Workflow-level remainder the graph does not model as nodes (top-level
 * `env:`, `permissions:`, `concurrency:`, unsupported `on:` entries, …).
 * Kept as a YAML mapping string and re-emitted verbatim by the compiler, so
 * importing a workflow never silently drops them. Shrinking what ends up
 * here is the ongoing goal — it is a remainder, not a destination.
 */
export interface PipelineExtras {
  workflowYaml: string;
}

export interface PipelineGraph {
  version: typeof PIPELINE_GRAPH_VERSION;
  /** Compiled to the workflow `name:`. */
  workflowName: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  extras?: PipelineExtras;
}

// ---------------------------------------------------------------------------
// Sidecar (de)serialization
// ---------------------------------------------------------------------------

const positionSchema = z.object({ x: z.number(), y: z.number() });

const triggerSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('push'),
    branches: z.array(z.string()),
    pathsIgnore: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('pull_request'),
    branches: z.array(z.string()),
  }),
  z.object({ kind: z.literal('schedule'), cron: z.string() }),
  z.object({ kind: z.literal('workflow_dispatch') }),
]);

const jobBaseShape = {
  id: z.string(),
  position: positionSchema,
  jobId: z.string(),
  label: z.string(),
  runsOn: z.string(),
};

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('trigger'),
    id: z.string(),
    position: positionSchema,
    trigger: triggerSpecSchema,
  }),
  z.object({
    type: z.literal('prefab'),
    ...jobBaseShape,
    prefabId: z.string(),
    params: z.record(z.union([z.string(), z.boolean()])),
  }),
  z.object({
    type: z.literal('marketplace'),
    ...jobBaseShape,
    uses: z.string(),
    with: z.record(z.string()),
    checkout: z.boolean(),
  }),
  z.object({
    type: z.literal('script'),
    ...jobBaseShape,
    steps: z.array(
      z.object({
        name: z.string().optional(),
        uses: z.string().optional(),
        with: z.record(scalarSchema).optional(),
        run: z.string().optional(),
        env: z.record(scalarSchema).optional(),
      })
    ),
    env: z.record(scalarSchema).optional(),
  }),
  z.object({
    type: z.literal('raw'),
    ...jobBaseShape,
    scope: z.union([z.literal('job'), z.literal('file')]),
    yaml: z.string(),
  }),
]);

export const pipelineGraphSchema = z.object({
  version: z.literal(PIPELINE_GRAPH_VERSION),
  workflowName: z.string(),
  nodes: z.array(nodeSchema),
  edges: z.array(
    z.object({ id: z.string(), source: z.string(), target: z.string() })
  ),
  extras: z.object({ workflowYaml: z.string() }).optional(),
});

/** Parse a sidecar file. Returns null when the content is not a valid graph
 * (corrupt, foreign, or future-versioned) — callers fall back to raw import. */
export function parsePipelineGraph(content: string): PipelineGraph | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const result = pipelineGraphSchema.safeParse(json);
  return result.success ? result.data : null;
}

export function serializePipelineGraph(graph: PipelineGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const JOB_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export function isJobNode(node: PipelineNode): node is PipelineJobNode {
  return node.type !== 'trigger';
}

export function isTriggerNode(node: PipelineNode): node is TriggerNode {
  return node.type === 'trigger';
}

let nodeIdCounter = 0;

/** Ids only need to be unique within one graph; keep them short and stable. */
export function newNodeId(): string {
  nodeIdCounter += 1;
  return `n-${Date.now().toString(36)}-${nodeIdCounter.toString(36)}`;
}

export function newEdgeId(source: string, target: string): string {
  return `e-${source}-${target}`;
}

export function emptyGraph(workflowName: string): PipelineGraph {
  return {
    version: PIPELINE_GRAPH_VERSION,
    workflowName,
    nodes: [],
    edges: [],
  };
}

/** Best-effort import: a workflow file we did not generate (or whose sidecar
 * is missing/corrupt) becomes a single opaque raw node. */
export function rawImportGraph(
  workflowName: string,
  yamlContent: string
): PipelineGraph {
  return {
    version: PIPELINE_GRAPH_VERSION,
    workflowName,
    nodes: [
      {
        type: 'raw',
        id: newNodeId(),
        position: { x: 80, y: 120 },
        jobId: 'imported',
        label: workflowName,
        runsOn: '',
        scope: 'file',
        yaml: yamlContent,
      },
    ],
    edges: [],
  };
}

/** jobIds of the job-node sources of a job's incoming edges, sorted — the
 * single source of truth for `needs:`. */
export function needsForNode(graph: PipelineGraph, nodeId: string): string[] {
  const jobNodesById = new Map(
    graph.nodes.filter(isJobNode).map((n) => [n.id, n])
  );
  return graph.edges
    .filter((e) => e.target === nodeId)
    .map((e) => jobNodesById.get(e.source)?.jobId)
    .filter((jobId): jobId is string => jobId !== undefined)
    .sort();
}
