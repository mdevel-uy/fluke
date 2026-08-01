import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { buildCatalogNode, buildMarketplaceNode } from '../model/catalog';
import { isJobNode, type NodePosition } from '../model/graph';
import { usePipelineStore } from '../model/usePipelineStore';
import { CanvasContextMenu, type ContextMenuTarget } from './CanvasContextMenu';
import { MarketplacePopover } from './MarketplacePopover';
import { NodePicker } from './NodePicker';
import {
  pipelineNodeTypes,
  type PipelineFlowNode,
} from './nodes/PipelineFlowNodes';

interface PipelineCanvasProps {
  onViewYaml: () => void;
}

interface OverlayAt {
  x: number;
  y: number;
}

interface MarketplaceOverlay extends OverlayAt {
  query: string;
}

interface MenuOverlay extends OverlayAt {
  target: ContextMenuTarget;
}

export function PipelineCanvas(props: PipelineCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onViewYaml }: PipelineCanvasProps) {
  const { t } = useTranslation('common');
  const graph = usePipelineStore((s) => s.graph);
  const selectedNodeId = usePipelineStore((s) => s.selectedNodeId);
  const select = usePipelineStore((s) => s.select);
  const addNode = usePipelineStore((s) => s.addNode);
  const removeNode = usePipelineStore((s) => s.removeNode);
  const moveNode = usePipelineStore((s) => s.moveNode);
  const addEdge = usePipelineStore((s) => s.addEdge);
  const removeEdge = usePipelineStore((s) => s.removeEdge);
  const enterDrill = usePipelineStore((s) => s.enterDrill);

  const { fitView, zoomIn, zoomOut, screenToFlowPosition } = useReactFlow();

  const [picker, setPicker] = useState<OverlayAt | null>(null);
  const [marketplace, setMarketplace] = useState<MarketplaceOverlay | null>(
    null
  );
  const [menu, setMenu] = useState<MenuOverlay | null>(null);

  const hoveredRef = useRef(false);
  const lastMouseRef = useRef<OverlayAt>({ x: 0, y: 0 });

  const flowNodes = useMemo<PipelineFlowNode[]>(() => {
    if (!graph) return [];
    const jobIds = new Set(graph.nodes.filter(isJobNode).map((n) => n.id));
    return graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      selected: node.id === selectedNodeId,
      data: {
        node,
        needsCount: graph.edges.filter(
          (e) => e.target === node.id && jobIds.has(e.source)
        ).length,
      },
    }));
  }, [graph, selectedNodeId]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    return graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }));
  }, [graph]);

  const onNodesChange = useCallback(
    (changes: NodeChange<PipelineFlowNode>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position);
        } else if (change.type === 'select') {
          if (change.selected) select(change.id);
          else if (usePipelineStore.getState().selectedNodeId === change.id) {
            select(null);
          }
        } else if (change.type === 'remove') {
          removeNode(change.id);
        }
      }
    },
    [moveNode, select, removeNode]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') removeEdge(change.id);
      }
    },
    [removeEdge]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        addEdge(connection.source, connection.target);
      }
    },
    [addEdge]
  );

  const insertPositionFor = useCallback(
    (at: OverlayAt): NodePosition => screenToFlowPosition(at),
    [screenToFlowPosition]
  );

  const autoLayout = useCallback(() => {
    if (!graph) return;
    const jobNodes = graph.nodes.filter(isJobNode);
    const jobIds = new Set(jobNodes.map((n) => n.id));
    // Depth = longest chain of job→job edges into the node.
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
      moveNode(node.id, { x: 320 + d * 280, y: 80 + row * 150 });
    }
    graph.nodes
      .filter((n) => n.type === 'trigger')
      .forEach((n, index) => {
        moveNode(n.id, { x: 40, y: 80 + index * 120 });
      });
    requestAnimationFrame(() => void fitView({ padding: 0.2 }));
  }, [graph, moveNode, fitView]);

  // Canvas-scoped shortcuts: Tab (picker), M (marketplace), L (layout),
  // F (fit). Only while the pointer is over the canvas and focus is not in
  // an input — never steal global Tab navigation.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!hoveredRef.current || !graph) return;
      if (picker || marketplace) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const at = lastMouseRef.current;
      if (event.key === 'Tab') {
        event.preventDefault();
        setMenu(null);
        setPicker(at);
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        setMenu(null);
        setMarketplace({ ...at, query: '' });
      } else if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        autoLayout();
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        void fitView({ padding: 0.2 });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [graph, picker, marketplace, autoLayout, fitView]);

  if (!graph) return null;

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
        nodeTypes={pipelineNodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          setPicker(null);
          setMarketplace(null);
          setMenu({
            x: 'clientX' in event ? event.clientX : 0,
            y: 'clientY' in event ? event.clientY : 0,
            target: { kind: 'pane' },
          });
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          setPicker(null);
          setMarketplace(null);
          setMenu({
            x: event.clientX,
            y: event.clientY,
            target: { kind: 'node', nodeId: node.id },
          });
        }}
        onPaneClick={() => {
          setMenu(null);
          select(null);
        }}
        onNodeDoubleClick={(_event, flowNode) => {
          // Script jobs explode into their step chain.
          enterDrill(flowNode.id);
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
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

      {/* Zoom cluster + discoverability hint (mock bottom-left). */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
        <div className="flex flex-col overflow-hidden rounded-lg border border-md-outline bg-panel shadow-sm">
          <button
            type="button"
            aria-label={t('ciPipelines.canvas.zoomIn', {
              defaultValue: 'Zoom in',
            })}
            onClick={() => void zoomIn()}
            className="flex h-6 w-7 cursor-pointer items-center justify-center text-normal hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label={t('ciPipelines.canvas.zoomOut', {
              defaultValue: 'Zoom out',
            })}
            onClick={() => void zoomOut()}
            className="flex h-6 w-7 cursor-pointer items-center justify-center border-t border-md-outline-variant text-normal hover:bg-secondary"
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label={t('ciPipelines.canvas.fitView', {
              defaultValue: 'Fit view',
            })}
            onClick={() => void fitView({ padding: 0.2 })}
            className="flex h-6 w-7 cursor-pointer items-center justify-center border-t border-md-outline-variant text-normal hover:bg-secondary"
          >
            <Maximize2 className="h-3 w-3" strokeWidth={1.75} />
          </button>
        </div>
        <span className="rounded-md border border-md-outline-variant bg-panel/80 px-2 py-1 text-[10.5px] text-low">
          {t('ciPipelines.canvas.hint', {
            defaultValue: 'Tab add node · right-click menu',
          })}
        </span>
      </div>

      {menu && (
        <CanvasContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          onAddNode={() => {
            setPicker({ x: menu.x, y: menu.y });
            setMenu(null);
          }}
          onSearchMarketplace={() => {
            setMarketplace({ x: menu.x, y: menu.y, query: '' });
            setMenu(null);
          }}
          onAutoLayout={() => {
            autoLayout();
            setMenu(null);
          }}
          onFitView={() => {
            void fitView({ padding: 0.2 });
            setMenu(null);
          }}
          onViewYaml={() => {
            onViewYaml();
            setMenu(null);
          }}
          onDeleteNode={(nodeId) => {
            removeNode(nodeId);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {picker && (
        <NodePicker
          x={picker.x}
          y={picker.y}
          onPick={(item) => {
            addNode(buildCatalogNode(item, graph, insertPositionFor(picker)));
            setPicker(null);
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
            addNode(
              buildMarketplaceNode(uses, graph, insertPositionFor(marketplace))
            );
            setMarketplace(null);
          }}
          onClose={() => setMarketplace(null)}
        />
      )}
    </div>
  );
}
