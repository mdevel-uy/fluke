import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { compileGraph, wouldCreateCycle, type CompileError } from './compiler';
import {
  isJobNode,
  newEdgeId,
  serializePipelineGraph,
  type NodePosition,
  type PipelineGraph,
  type PipelineNode,
  type ScriptStep,
} from './graph';
import { sidecarNameFor, type WorkflowFileEntry } from './workflowFiles';

/**
 * Editing session for one open workflow. Session-scoped (not persisted): the
 * durable copy is the sidecar file on disk. Dirty = serialized graph differs
 * from the last-saved fingerprint.
 */

interface PipelineSessionState {
  /** Entry of the open workflow; null = nothing open. */
  entry: WorkflowFileEntry | null;
  graph: PipelineGraph | null;
  /** Serialized graph at last load/save. */
  savedFingerprint: string | null;
  /** True when the on-disk yml did not match the compiled sidecar at load. */
  drifted: boolean;
  /** True when the graph came from raw import (no sidecar). */
  fromSidecar: boolean;
  selectedNodeId: string | null;
  /** Script node whose steps are open in the drill-down view. */
  drillNodeId: string | null;
  /** Selected step (index into the drilled node's steps). */
  selectedStepIndex: number | null;

  open(
    entry: WorkflowFileEntry,
    graph: PipelineGraph,
    meta: { fromSidecar: boolean; drifted: boolean }
  ): void;
  close(): void;
  markSaved(): void;
  select(nodeId: string | null): void;
  addNode(node: PipelineNode): void;
  updateNode(nodeId: string, patch: Partial<PipelineNode>): void;
  removeNode(nodeId: string): void;
  moveNode(nodeId: string, position: NodePosition): void;
  /** Returns false when the connection is rejected (dup/self/cycle). */
  addEdge(source: string, target: string): boolean;
  removeEdge(edgeId: string): void;
  setWorkflowName(name: string): void;

  // Drill-down (steps of one script job as a linear chain)
  enterDrill(nodeId: string): void;
  exitDrill(): void;
  selectStep(index: number | null): void;
  insertStep(nodeId: string, index: number, step: ScriptStep): void;
  updateStep(nodeId: string, index: number, patch: Partial<ScriptStep>): void;
  moveStepTo(nodeId: string, from: number, to: number): void;
  removeStep(nodeId: string, index: number): void;
}

export const usePipelineStore = create<PipelineSessionState>()(
  immer((set, get) => ({
    entry: null,
    graph: null,
    savedFingerprint: null,
    drifted: false,
    fromSidecar: true,
    selectedNodeId: null,
    drillNodeId: null,
    selectedStepIndex: null,

    open: (entry, graph, meta) =>
      set((state) => {
        state.entry = entry;
        state.graph = graph;
        state.savedFingerprint = serializePipelineGraph(graph);
        state.fromSidecar = meta.fromSidecar;
        state.drifted = meta.drifted;
        state.selectedNodeId = null;
        state.drillNodeId = null;
        state.selectedStepIndex = null;
      }),

    close: () =>
      set((state) => {
        state.entry = null;
        state.graph = null;
        state.savedFingerprint = null;
        state.drifted = false;
        state.fromSidecar = true;
        state.selectedNodeId = null;
        state.drillNodeId = null;
        state.selectedStepIndex = null;
      }),

    markSaved: () =>
      set((state) => {
        if (state.graph) {
          state.savedFingerprint = serializePipelineGraph(state.graph);
          state.drifted = false;
          state.fromSidecar = true;
        }
      }),

    select: (nodeId) =>
      set((state) => {
        state.selectedNodeId = nodeId;
      }),

    addNode: (node) =>
      set((state) => {
        if (!state.graph) return;
        state.graph.nodes.push(node);
        state.selectedNodeId = node.id;
      }),

    updateNode: (nodeId, patch) =>
      set((state) => {
        const node = state.graph?.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        Object.assign(node, patch);
      }),

    removeNode: (nodeId) =>
      set((state) => {
        if (!state.graph) return;
        state.graph.nodes = state.graph.nodes.filter((n) => n.id !== nodeId);
        state.graph.edges = state.graph.edges.filter(
          (e) => e.source !== nodeId && e.target !== nodeId
        );
        if (state.selectedNodeId === nodeId) state.selectedNodeId = null;
        if (state.drillNodeId === nodeId) {
          state.drillNodeId = null;
          state.selectedStepIndex = null;
        }
      }),

    moveNode: (nodeId, position) =>
      set((state) => {
        const node = state.graph?.nodes.find((n) => n.id === nodeId);
        if (node) node.position = position;
      }),

    addEdge: (source, target) => {
      const graph = get().graph;
      if (!graph) return false;
      if (source === target) return false;
      const exists = graph.edges.some(
        (e) => e.source === source && e.target === target
      );
      if (exists) return false;
      const sourceNode = graph.nodes.find((n) => n.id === source);
      const targetNode = graph.nodes.find((n) => n.id === target);
      if (!sourceNode || !targetNode) return false;
      // Triggers can only feed jobs, never receive edges.
      if (targetNode.type === 'trigger') return false;
      if (
        isJobNode(sourceNode) &&
        isJobNode(targetNode) &&
        wouldCreateCycle(graph, source, target)
      ) {
        return false;
      }
      set((state) => {
        state.graph?.edges.push({
          id: newEdgeId(source, target),
          source,
          target,
        });
      });
      return true;
    },

    removeEdge: (edgeId) =>
      set((state) => {
        if (!state.graph) return;
        state.graph.edges = state.graph.edges.filter((e) => e.id !== edgeId);
      }),

    setWorkflowName: (name) =>
      set((state) => {
        if (state.graph) state.graph.workflowName = name;
      }),

    enterDrill: (nodeId) =>
      set((state) => {
        const node = state.graph?.nodes.find((n) => n.id === nodeId);
        if (node?.type !== 'script') return;
        state.drillNodeId = nodeId;
        state.selectedStepIndex = null;
      }),

    exitDrill: () =>
      set((state) => {
        state.drillNodeId = null;
        state.selectedStepIndex = null;
      }),

    selectStep: (index) =>
      set((state) => {
        state.selectedStepIndex = index;
      }),

    insertStep: (nodeId, index, step) =>
      set((state) => {
        const node = state.graph?.nodes.find((n) => n.id === nodeId);
        if (node?.type !== 'script') return;
        const at = Math.max(0, Math.min(index, node.steps.length));
        node.steps.splice(at, 0, step);
        state.selectedStepIndex = at;
      }),

    updateStep: (nodeId, index, patch) =>
      set((state) => {
        const node = state.graph?.nodes.find((n) => n.id === nodeId);
        if (node?.type !== 'script') return;
        const step = node.steps[index];
        if (!step) return;
        Object.assign(step, patch);
        // Explicit undefined in the patch means "remove the key".
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) {
            delete (step as Record<string, unknown>)[key];
          }
        }
      }),

    moveStepTo: (nodeId, from, to) =>
      set((state) => {
        const node = state.graph?.nodes.find((n) => n.id === nodeId);
        if (node?.type !== 'script') return;
        if (from < 0 || from >= node.steps.length) return;
        const clamped = Math.max(0, Math.min(to, node.steps.length - 1));
        const [moved] = node.steps.splice(from, 1);
        node.steps.splice(clamped, 0, moved);
        if (state.selectedStepIndex === from) {
          state.selectedStepIndex = clamped;
        }
      }),

    removeStep: (nodeId, index) =>
      set((state) => {
        const node = state.graph?.nodes.find((n) => n.id === nodeId);
        if (node?.type !== 'script') return;
        node.steps.splice(index, 1);
        state.selectedStepIndex = null;
      }),
  }))
);

// ---------------------------------------------------------------------------
// Derived selectors (plain functions over the store state)
// ---------------------------------------------------------------------------

export function selectIsDirty(state: PipelineSessionState): boolean {
  if (!state.graph || state.savedFingerprint === null) return false;
  return serializePipelineGraph(state.graph) !== state.savedFingerprint;
}

export function selectCompile(state: PipelineSessionState): {
  yaml: string | null;
  errors: CompileError[];
} {
  if (!state.graph || !state.entry) return { yaml: null, errors: [] };
  const result = compileGraph(state.graph, {
    sidecarName: sidecarNameFor(state.entry.name),
  });
  if (result.ok) return { yaml: result.yaml, errors: [] };
  return { yaml: null, errors: result.errors };
}
