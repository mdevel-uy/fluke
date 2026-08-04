import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compileGraph } from './compiler';
import { importWorkflowYaml, semanticallyEqual } from './importer';
import { isJobNode, needsForNode } from './graph';

/** Real-world fixture: the repo's own ci-mdev.yml (multi-step jobs,
 * workflow-level concurrency + env). */
const CI_MDEV = `name: CI (mdev)

on:
  pull_request:
    branches:
      - mdev

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

env:
  CARGO_TERM_COLOR: always
  NODE_VERSION: '20'

jobs:
  frontend:
    name: Frontend build & typecheck
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Build local-web
        env:
          NODE_OPTIONS: --max-old-space-size=8192
        run: pnpm --filter @vibe/local-web run build

  backend:
    name: Backend cargo check
    runs-on: ubuntu-24.04
    env:
      CARGO_INCREMENTAL: '0'
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: cargo check -p server
        run: cargo check --locked -p server
`;

function expectRoundTrip(source: string, workflowName = 'test') {
  const result = importWorkflowYaml(workflowName, source);
  expect(result.structured).toBe(true);
  const compiled = compileGraph(result.graph);
  if (!compiled.ok) {
    throw new Error(
      `compile failed: ${compiled.errors.map((e) => e.message).join('; ')}`
    );
  }
  return { graph: result.graph, yaml: compiled.yaml };
}

describe('importWorkflowYaml', () => {
  it('imports ci-mdev structured: trigger + 2 script jobs + extras', () => {
    const { graph, yaml } = expectRoundTrip(CI_MDEV, 'ci-mdev');

    const triggers = graph.nodes.filter((n) => n.type === 'trigger');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type === 'trigger' && triggers[0].trigger).toEqual({
      kind: 'pull_request',
      branches: ['mdev'],
    });

    const jobs = graph.nodes.filter(isJobNode);
    expect(jobs.map((j) => j.jobId).sort()).toEqual(['backend', 'frontend']);
    // Multi-step jobs become structured script nodes — nothing raw.
    expect(jobs.every((j) => j.type === 'script')).toBe(true);
    const backend = jobs.find((j) => j.jobId === 'backend');
    if (backend?.type === 'script') {
      expect(backend.steps).toHaveLength(2);
      // Job-level env survives typed.
      expect(backend.env).toEqual({ CARGO_INCREMENTAL: '0' });
    }
    const frontend = jobs.find((j) => j.jobId === 'frontend');
    if (frontend?.type === 'script') {
      expect(frontend.steps).toHaveLength(3);
      // Per-step env survives.
      expect(frontend.steps[2].env).toEqual({
        NODE_OPTIONS: '--max-old-space-size=8192',
      });
    }

    // Visual connectors: the trigger links to both root jobs.
    const triggerEdges = graph.edges.filter((e) => e.source === triggers[0].id);
    expect(triggerEdges).toHaveLength(2);

    // Workflow-level remainder captured, not dropped.
    expect(graph.extras?.workflowYaml).toContain('concurrency');
    expect(graph.extras?.workflowYaml).toContain('CARGO_TERM_COLOR');

    // Semantic round trip against the source.
    expect(semanticallyEqual(parse(CI_MDEV), parse(yaml))).toBe(true);
    // The remainder is re-emitted at the top level.
    expect(yaml).toContain('cancel-in-progress: true');
  });

  it('imports checkout+action jobs as script nodes (an action is a step)', () => {
    const source = `name: release
on:
  push:
    branches:
      - main
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: release
        uses: softprops/action-gh-release@v2
        with:
          draft: 'true'
`;
    const { graph } = expectRoundTrip(source);
    const job = graph.nodes.find(isJobNode);
    expect(job?.type).toBe('script');
    if (job?.type === 'script') {
      expect(job.steps).toHaveLength(2);
      expect(job.steps[1].uses).toBe('softprops/action-gh-release@v2');
      expect(job.steps[1].with).toEqual({ draft: 'true' });
    }
  });

  it('turns needs into edges, including string-form needs', () => {
    const source = `on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  deploy:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: make deploy
`;
    const { graph } = expectRoundTrip(source);
    // 1 needs edge + 1 visual trigger→build edge.
    expect(graph.edges).toHaveLength(2);
    const deploy = graph.nodes
      .filter(isJobNode)
      .find((j) => j.jobId === 'deploy');
    expect(deploy && needsForNode(graph, deploy.id)).toEqual(['build']);
    // deploy hangs off build, not off the trigger.
    const triggerId = graph.nodes.find((n) => n.type === 'trigger')?.id;
    expect(
      graph.edges.some((e) => e.source === triggerId && e.target === deploy?.id)
    ).toBe(false);
  });

  it('keeps unsupported trigger kinds in extras and round-trips them', () => {
    const source = `on:
  workflow_call: {}
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`;
    const { graph, yaml } = expectRoundTrip(source);
    const triggers = graph.nodes.filter((n) => n.type === 'trigger');
    expect(triggers).toHaveLength(1);
    expect(graph.extras?.workflowYaml).toContain('workflow_call');
    expect(yaml).toContain('workflow_call');
  });

  it('supports string and array forms of on', () => {
    const { graph } = expectRoundTrip(`on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`);
    expect(graph.nodes.filter((n) => n.type === 'trigger')).toHaveLength(2);
  });

  it('falls back to a whole-file raw node on unparseable YAML', () => {
    const result = importWorkflowYaml('broken', 'jobs: [\n  :::');
    expect(result.structured).toBe(false);
    expect(result.graph.nodes).toHaveLength(1);
    expect(
      result.graph.nodes[0].type === 'raw' &&
        result.graph.nodes[0].scope === 'file'
    ).toBe(true);
  });

  it('falls back when needs references an unknown job', () => {
    const result = importWorkflowYaml(
      'bad-needs',
      `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: ghost
    steps:
      - run: make deploy
`
    );
    expect(result.structured).toBe(false);
  });
});

describe('semanticallyEqual', () => {
  it('treats null, undefined, {} and [] as interchangeable', () => {
    expect(semanticallyEqual(null, {})).toBe(true);
    expect(semanticallyEqual(undefined, null)).toBe(true);
    expect(semanticallyEqual([], undefined)).toBe(true);
    expect(semanticallyEqual({ a: {} }, {})).toBe(true);
  });

  it('is order-insensitive for keys, order-sensitive for arrays', () => {
    expect(semanticallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(semanticallyEqual([1, 2], [2, 1])).toBe(false);
  });
});
