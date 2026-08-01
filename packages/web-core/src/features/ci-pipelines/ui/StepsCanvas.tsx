import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus } from 'lucide-react';
import type { ScriptJobNode } from '../model/graph';
import { usePipelineStore } from '../model/usePipelineStore';
import { MarketplacePopover } from './MarketplacePopover';
import { StepPicker } from './StepPicker';
import { stepNodeTypes, type StepFlowNodeType } from './nodes/StepFlowNode';

/**
 * Drill-down canvas: the steps of one script job as a linear chain. Two
 * semantics, two surfaces — out on the jobs canvas edges mean `needs`;
 * here the chain *is* the order (Actions cannot branch steps), so nodes
 * reorder by dragging along the chain and edges are not user-connectable.
 */

const STEP_X = 60;
const STEP_GAP = 250;
const STEP_Y = 140;

interface OverlayAt {
  x: number;
  y: number;
  insertIndex: number;
}

interface MarketplaceOverlay extends OverlayAt {
  query: string;
}

export function StepsCanvas() {
  return (
    <ReactFlowProvider>
      <StepsCanvasInner />
    </ReactFlowProvider>
  );
}

function buildFlowNodes(
  node: ScriptJobNode,
  selectedStepIndex: number | null
): StepFlowNodeType[] {
  return node.steps.map((step, index) => ({
    id: `step-${index}`,
    type: 'step',
    position: { x: STEP_X + index * STEP_GAP, y: STEP_Y },
    selected: index === selectedStepIndex,
    data: { step, index, total: node.steps.length },
  }));
}

function StepsCanvasInner() {
  const { t } = useTranslation('common');
  const graph = usePipelineStore((s) => s.graph);
  const drillNodeId = usePipelineStore((s) => s.drillNodeId);
  const selectedStepIndex = usePipelineStore((s) => s.selectedStepIndex);
  const selectStep = usePipelineStore((s) => s.selectStep);
  const insertStep = usePipelineStore((s) => s.insertStep);
  const moveStepTo = usePipelineStore((s) => s.moveStepTo);
  const removeStep = usePipelineStore((s) => s.removeStep);
  const exitDrill = usePipelineStore((s) => s.exitDrill);

  const { fitView } = useReactFlow();

  const node = graph?.nodes.find(
    (n): n is ScriptJobNode => n.id === drillNodeId && n.type === 'script'
  );

  const [picker, setPicker] = useState<OverlayAt | null>(null);
  const [marketplace, setMarketplace] = useState<MarketplaceOverlay | null>(
    null
  );
  const hoveredRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // Local flow-node state so dragging stays fluid; the steps array is the
  // source of truth and rebuilds it on every structural change.
  const [flowNodes, setFlowNodes] = useState<StepFlowNodeType[]>([]);
  const stepsRef = useRef(node?.steps);
  useEffect(() => {
    if (!node) return;
    stepsRef.current = node.steps;
    setFlowNodes(buildFlowNodes(node, selectedStepIndex));
  }, [node, node?.steps, selectedStepIndex]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StepFlowNodeType>[]) => {
      if (!node) return;
      for (const change of changes) {
        if (change.type === 'select') {
          const index = Number(change.id.replace('step-', ''));
          if (change.selected) selectStep(index);
          else if (usePipelineStore.getState().selectedStepIndex === index) {
            selectStep(null);
          }
        } else if (change.type === 'remove') {
          removeStep(node.id, Number(change.id.replace('step-', '')));
          return;
        }
      }
      setFlowNodes((nodes) => applyNodeChanges(changes, nodes));
    },
    [node, selectStep, removeStep]
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, dragged: StepFlowNodeType) => {
      if (!node) return;
      const from = Number(dragged.id.replace('step-', ''));
      // New order = position in the chain by x coordinate.
      const byX = [...flowNodes]
        .map((n) => (n.id === dragged.id ? dragged : n))
        .sort((a, b) => a.position.x - b.position.x);
      const to = byX.findIndex((n) => n.id === dragged.id);
      if (to !== -1 && to !== from) {
        moveStepTo(node.id, from, to);
      } else {
        // Snap back to the normalized chain layout.
        setFlowNodes(buildFlowNodes(node, selectedStepIndex));
      }
    },
    [node, flowNodes, moveStepTo, selectedStepIndex]
  );

  const openPickerAt = useCallback(
    (x: number, y: number, insertIndex: number) => {
      setMarketplace(null);
      setPicker({ x, y, insertIndex });
    },
    []
  );

  const edgeTypes: EdgeTypes = useMemo(
    () => ({
      'step-edge': (props: EdgeProps) => (
        <StepInsertEdge
          {...props}
          onInsert={(x, y) =>
            openPickerAt(x, y, Number(props.target.replace('step-', '')))
          }
        />
      ),
    }),
    [openPickerAt]
  );

  const flowEdges: Edge[] = node
    ? node.steps.slice(1).map((_, index) => ({
        id: `step-edge-${index}`,
        source: `step-${index}`,
        target: `step-${index + 1}`,
        type: 'step-edge',
      }))
    : [];

  // Canvas shortcuts: Tab inserts (after selection / at the end), Esc goes
  // back to the jobs canvas when no overlay is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!node) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'Escape') {
        if (!picker && !marketplace) exitDrill();
        return;
      }
      if (!hoveredRef.current || picker || marketplace) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        const at = lastMouseRef.current;
        const index =
          usePipelineStore.getState().selectedStepIndex ??
          node.steps.length - 1;
        openPickerAt(at.x, at.y, index + 1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [node, picker, marketplace, exitDrill, openPickerAt]);

  if (!node) return null;

  return (
    <div
      className="relative h-full min-h-0 w-full"
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
      onMouseMove={(event) => {
        lastMouseRef.current = { x: event.clientX, y: event.clientY };
      }}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={stepNodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => selectStep(null)}
        nodesConnectable={false}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.75}
        className="bg-primary"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          className="!bg-primary"
        />
      </ReactFlow>

      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            openPickerAt(
              window.innerWidth / 2 - 150,
              window.innerHeight / 3,
              node.steps.length
            );
          }}
          className="flex cursor-pointer items-center gap-1 rounded-lg border border-md-outline bg-panel px-2 py-1 text-[11px] text-normal shadow-sm hover:bg-secondary"
        >
          <Plus className="h-3 w-3" strokeWidth={1.75} />
          {t('ciPipelines.steps.addStep', { defaultValue: 'Add step' })}
        </button>
        <span className="rounded-md border border-md-outline-variant bg-panel/80 px-2 py-1 text-[10.5px] text-low">
          {t('ciPipelines.steps.hint', {
            defaultValue: 'Tab insert step · drag to reorder · Esc back',
          })}
        </span>
      </div>

      {picker && (
        <StepPicker
          x={picker.x}
          y={picker.y}
          onPick={(step) => {
            insertStep(node.id, picker.insertIndex, step);
            setPicker(null);
            requestAnimationFrame(() => void fitView({ padding: 0.25 }));
          }}
          onPickMarketplace={(query) => {
            setMarketplace({ ...picker, query });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {marketplace && (
        <MarketplacePopover
          x={marketplace.x}
          y={marketplace.y}
          initialQuery={marketplace.query}
          onPick={(uses) => {
            const slug = uses.split('@')[0].split('/').pop() ?? uses;
            insertStep(node.id, marketplace.insertIndex, {
              name: slug,
              uses,
              with: {},
            });
            setMarketplace(null);
            requestAnimationFrame(() => void fitView({ padding: 0.25 }));
          }}
          onClose={() => setMarketplace(null)}
        />
      )}
    </div>
  );
}

/** Sequential edge with an insert button on its midpoint. */
function StepInsertEdge({
  onInsert,
  ...props
}: EdgeProps & { onInsert: (x: number, y: number) => void }) {
  const { t } = useTranslation('common');
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  return (
    <>
      <BaseEdge id={props.id} path={path} />
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label={t('ciPipelines.steps.insertHere', {
            defaultValue: 'Insert step here',
          })}
          onClick={(event) => onInsert(event.clientX - 150, event.clientY + 16)}
          className="pointer-events-auto absolute flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border border-md-outline bg-panel text-low opacity-0 shadow-sm transition-opacity hover:border-brand hover:text-brand [.react-flow:hover_&]:opacity-100"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <Plus className="h-3 w-3" strokeWidth={1.75} />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
