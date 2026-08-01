import { parse, stringify } from 'yaml';
import { compileGraph } from './compiler';
import {
  newEdgeId,
  newNodeId,
  PIPELINE_GRAPH_VERSION,
  rawImportGraph,
  type PipelineEdge,
  type PipelineGraph,
  type PipelineJobNode,
  type PipelineNode,
  type RawYamlJobNode,
  type ScalarValue,
  type ScriptJobNode,
  type ScriptStep,
  type TriggerNode,
  type TriggerSpec,
} from './graph';

/**
 * Structured best-effort importer: turns an existing workflow file into a
 * graph with as little raw-YAML absorption as possible.
 *
 * Granularity ladder (most structured wins):
 * 1. `on:` entries the model understands → trigger nodes.
 * 2. Jobs made of plain run/uses steps (plus job-level env) → script nodes
 *    with every step editable (this covers checkout+action jobs too — a
 *    marketplace action is just a `uses` step).
 * 3. Any other job → a raw *job* node (its `needs` still become edges).
 * 4. Workflow-level keys the model lacks (env, permissions, concurrency,
 *    unsupported `on:` kinds …) → `graph.extras`, re-emitted verbatim.
 * 5. Only when parsing fails or the round-trip guard detects a semantic
 *    difference does the whole file collapse into a single raw-file node.
 *
 * Safety property: importing structured and compiling back must be
 * semantically identical to the source (deep-equal modulo formatting,
 * comments, key order and `{}`-vs-null). Otherwise we refuse and fall back —
 * the studio must never silently change what a workflow does.
 */

export interface ImportResult {
  graph: PipelineGraph;
  /** False when the file collapsed into a single raw-file node. */
  structured: boolean;
}

export function importWorkflowYaml(
  workflowName: string,
  yamlContent: string
): ImportResult {
  const fallback = (): ImportResult => ({
    graph: rawImportGraph(workflowName, yamlContent),
    structured: false,
  });

  let doc: unknown;
  try {
    doc = parse(yamlContent);
  } catch {
    return fallback();
  }
  if (!isMapping(doc)) return fallback();

  const name =
    typeof doc.name === 'string' && doc.name.trim() !== ''
      ? doc.name
      : workflowName;

  // ---- Triggers --------------------------------------------------------
  const onEntries = normalizeOn(doc.on);
  if (onEntries === null) return fallback();
  const triggerNodes: TriggerNode[] = [];
  const extrasOn: Record<string, unknown> = {};
  for (const [kind, spec] of onEntries) {
    const trigger = importTrigger(kind, spec);
    if (trigger) {
      triggerNodes.push({
        type: 'trigger',
        id: newNodeId(),
        position: { x: 0, y: 0 },
        trigger,
      });
    } else {
      extrasOn[kind] = spec ?? null;
    }
  }

  // ---- Jobs ------------------------------------------------------------
  if (!isMapping(doc.jobs)) return fallback();
  const jobEntries = Object.entries(doc.jobs);
  if (jobEntries.length === 0) return fallback();

  const jobNodes: PipelineJobNode[] = [];
  const needsByNodeId = new Map<string, string[]>();
  for (const [jobId, body] of jobEntries) {
    if (!isMapping(body)) return fallback();
    const needs = normalizeNeeds(body.needs);
    if (needs === null) return fallback();
    const node = importJob(jobId, body);
    jobNodes.push(node);
    needsByNodeId.set(node.id, needs);
  }

  // needs → edges; a reference to an unknown job would be silently dropped
  // by compilation, so it forces the fallback.
  const nodeIdByJobId = new Map(jobNodes.map((n) => [n.jobId, n.id]));
  const edges: PipelineEdge[] = [];
  for (const [nodeId, needs] of needsByNodeId) {
    for (const needed of needs) {
      const sourceId = nodeIdByJobId.get(needed);
      if (!sourceId) return fallback();
      edges.push({
        id: newEdgeId(sourceId, nodeId),
        source: sourceId,
        target: nodeId,
      });
    }
  }

  // Visual-only edges from triggers to root jobs (jobs without needs) —
  // that is how Actions actually flows, and the canvas should show it.
  // The compiler ignores trigger edges when deriving `needs`.
  for (const jobNode of jobNodes) {
    if ((needsByNodeId.get(jobNode.id) ?? []).length > 0) continue;
    for (const trigger of triggerNodes) {
      edges.push({
        id: newEdgeId(trigger.id, jobNode.id),
        source: trigger.id,
        target: jobNode.id,
      });
    }
  }

  // ---- Workflow-level extras ------------------------------------------
  const extrasObj: Record<string, unknown> = {};
  if (Object.keys(extrasOn).length > 0) extrasObj.on = extrasOn;
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'name' || key === 'on' || key === 'jobs') continue;
    extrasObj[key] = value;
  }

  const nodes: PipelineNode[] = [...triggerNodes, ...jobNodes];
  const graph: PipelineGraph = {
    version: PIPELINE_GRAPH_VERSION,
    workflowName: name,
    nodes,
    edges,
    ...(Object.keys(extrasObj).length > 0
      ? { extras: { workflowYaml: stringify(extrasObj, { lineWidth: 0 }) } }
      : {}),
  };
  layoutImportedGraph(graph);

  // ---- Round-trip guard ------------------------------------------------
  const compiled = compileGraph(graph);
  if (!compiled.ok) return fallback();
  let compiledDoc: unknown;
  try {
    compiledDoc = parse(compiled.yaml);
  } catch {
    return fallback();
  }
  // Normalize representation noise the compiler canonicalizes on purpose:
  // it always emits `name:`, `on:` in mapping form, and `needs:` as a
  // sorted sequence.
  const normalizedSource = {
    ...doc,
    name,
    on: Object.fromEntries(onEntries),
    jobs: Object.fromEntries(
      jobEntries.map(([jobId, body]) => {
        const mapping = body as Record<string, unknown>;
        const { needs: _needs, ...rest } = mapping;
        const needs = normalizeNeeds(mapping.needs) ?? [];
        return [
          jobId,
          needs.length > 0 ? { ...rest, needs: [...needs].sort() } : rest,
        ];
      })
    ),
  };
  if (!semanticallyEqual(normalizedSource, compiledDoc)) return fallback();

  return { graph, structured: true };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** `on` accepts a string, an array of kinds, or a mapping. */
function normalizeOn(on: unknown): Array<[string, unknown]> | null {
  if (typeof on === 'string') return [[on, null]];
  if (Array.isArray(on)) {
    if (!on.every((k) => typeof k === 'string')) return null;
    return on.map((k) => [k, null]);
  }
  if (isMapping(on)) return Object.entries(on);
  return null;
}

function importTrigger(kind: string, spec: unknown): TriggerSpec | null {
  const mapping = spec === null || spec === undefined ? {} : spec;
  if (!isMapping(mapping)) return null;

  if (kind === 'push') {
    if (!hasOnlyKeys(mapping, ['branches', 'paths-ignore', 'tags'])) {
      return null;
    }
    const branches = optionalStringArray(mapping.branches);
    const pathsIgnore = optionalStringArray(mapping['paths-ignore']);
    const tags = optionalStringArray(mapping.tags);
    if (branches === null || pathsIgnore === null || tags === null) return null;
    return {
      kind: 'push',
      branches: branches ?? [],
      ...(pathsIgnore && pathsIgnore.length > 0 ? { pathsIgnore } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
  }
  if (kind === 'pull_request') {
    if (!hasOnlyKeys(mapping, ['branches'])) return null;
    const branches = optionalStringArray(mapping.branches);
    if (branches === null) return null;
    return { kind: 'pull_request', branches: branches ?? [] };
  }
  if (kind === 'schedule') {
    // `schedule` is a sequence of {cron}; the model holds exactly one.
    if (
      Array.isArray(spec) &&
      spec.length === 1 &&
      isMapping(spec[0]) &&
      hasOnlyKeys(spec[0], ['cron']) &&
      typeof spec[0].cron === 'string'
    ) {
      return { kind: 'schedule', cron: spec[0].cron };
    }
    return null;
  }
  if (kind === 'workflow_dispatch') {
    if (Object.keys(mapping).length > 0) return null;
    return { kind: 'workflow_dispatch' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function normalizeNeeds(needs: unknown): string[] | null {
  if (needs === undefined || needs === null) return [];
  if (typeof needs === 'string') return [needs];
  if (Array.isArray(needs) && needs.every((n) => typeof n === 'string')) {
    return needs;
  }
  return null;
}

function importJob(
  jobId: string,
  body: Record<string, unknown>
): PipelineJobNode {
  const script = tryImportScriptJob(jobId, body);
  if (script) return script;

  // Raw job node: the body passes through minus `needs`, which lives as
  // edges (single source of truth — the compiler re-derives it).
  const { needs: _needs, ...rest } = body;
  const raw: RawYamlJobNode = {
    type: 'raw',
    id: newNodeId(),
    position: { x: 0, y: 0 },
    jobId,
    label: typeof body.name === 'string' ? body.name : jobId,
    runsOn: typeof body['runs-on'] === 'string' ? body['runs-on'] : '',
    scope: 'job',
    yaml: stringify(rest, { lineWidth: 0 }),
  };
  return raw;
}

/** Jobs made purely of run/uses steps (plus optional job-level env) become
 * script nodes — every step editable, nothing opaque. Constraints mirror
 * the compiler's emission so recognition is round-trip-safe. */
function tryImportScriptJob(
  jobId: string,
  body: Record<string, unknown>
): ScriptJobNode | null {
  if (!hasOnlyKeys(body, ['name', 'runs-on', 'needs', 'steps', 'env'])) {
    return null;
  }
  if (typeof body['runs-on'] !== 'string') return null;
  if (body.name !== undefined && typeof body.name !== 'string') return null;
  if (!Array.isArray(body.steps) || body.steps.length === 0) return null;

  const env = importScalarMapping(body.env);
  if (env === null) return null;

  const steps: ScriptStep[] = [];
  for (const rawStep of body.steps) {
    const step = importScriptStep(rawStep);
    if (step === null) return null;
    steps.push(step);
  }

  // The compiler emits the job `name:` iff label !== jobId.
  const label = typeof body.name === 'string' ? body.name : jobId;
  if (body.name !== undefined && body.name === jobId) return null;

  return {
    type: 'script',
    id: newNodeId(),
    position: { x: 0, y: 0 },
    jobId,
    label,
    runsOn: body['runs-on'],
    steps,
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

function importScriptStep(rawStep: unknown): ScriptStep | null {
  if (!isMapping(rawStep)) return null;
  if (!hasOnlyKeys(rawStep, ['name', 'uses', 'with', 'run', 'env'])) {
    return null;
  }
  const hasRun = typeof rawStep.run === 'string';
  const hasUses = typeof rawStep.uses === 'string';
  if (hasRun === hasUses) return null;
  if (rawStep.name !== undefined && typeof rawStep.name !== 'string') {
    return null;
  }
  // `with` only makes sense on uses-steps.
  if (rawStep.with !== undefined && !hasUses) return null;

  const withEntries = importScalarMapping(rawStep.with);
  const envEntries = importScalarMapping(rawStep.env);
  if (withEntries === null || envEntries === null) return null;

  return {
    ...(rawStep.name !== undefined ? { name: rawStep.name as string } : {}),
    ...(hasUses ? { uses: rawStep.uses as string } : {}),
    ...(withEntries && Object.keys(withEntries).length > 0
      ? { with: withEntries }
      : {}),
    ...(hasRun ? { run: rawStep.run as string } : {}),
    ...(envEntries && Object.keys(envEntries).length > 0
      ? { env: envEntries }
      : {}),
  };
}

/** Mapping of scalars (string/number/boolean); null = not importable,
 * undefined = absent. */
function importScalarMapping(
  value: unknown
): Record<string, ScalarValue> | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isMapping(value)) return null;
  const out: Record<string, ScalarValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      return null;
    }
    out[key] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Same layered layout as the canvas auto-layout: triggers on the left,
 * jobs by dependency depth. */
function layoutImportedGraph(graph: PipelineGraph): void {
  const jobNodes = graph.nodes.filter(
    (n): n is PipelineJobNode => n.type !== 'trigger'
  );
  const jobIds = new Set(jobNodes.map((n) => n.id));
  const depth = new Map<string, number>();
  const computeDepth = (id: string, seen: Set<string>): number => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    if (seen.has(id)) return 0;
    seen.add(id);
    const incoming = graph.edges.filter(
      (e) => e.target === id && jobIds.has(e.source)
    );
    const value =
      incoming.length === 0
        ? 0
        : Math.max(...incoming.map((e) => computeDepth(e.source, seen) + 1));
    depth.set(id, value);
    return value;
  };
  jobNodes.forEach((n) => computeDepth(n.id, new Set()));

  const perDepthCount = new Map<number, number>();
  for (const node of [...jobNodes].sort((a, b) =>
    a.jobId.localeCompare(b.jobId)
  )) {
    const d = depth.get(node.id) ?? 0;
    const row = perDepthCount.get(d) ?? 0;
    perDepthCount.set(d, row + 1);
    node.position = { x: 320 + d * 280, y: 80 + row * 150 };
  }
  graph.nodes
    .filter((n) => n.type === 'trigger')
    .forEach((n, index) => {
      n.position = { x: 40, y: 80 + index * 120 };
    });
}

// ---------------------------------------------------------------------------
// Semantic comparison
// ---------------------------------------------------------------------------

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  mapping: Record<string, unknown>,
  allowed: string[]
): boolean {
  return Object.keys(mapping).every((key) => allowed.includes(key));
}

function optionalStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value;
  }
  return null;
}

/** Deep equality modulo representation noise: `null`, `undefined` and `{}`
 * are interchangeable (YAML's `push:` vs `push: {}`), key order is ignored,
 * array order matters. */
export function semanticallyEqual(a: unknown, b: unknown): boolean {
  if (isEmptyish(a) && isEmptyish(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => semanticallyEqual(item, b[i]));
  }
  if (isMapping(a) || isMapping(b)) {
    if (!isMapping(a) || !isMapping(b)) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!semanticallyEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return a === b;
}

function isEmptyish(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (isMapping(value) && Object.keys(value).length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}
