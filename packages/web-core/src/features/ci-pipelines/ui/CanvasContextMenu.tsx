import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Code2,
  LayoutGrid,
  Maximize2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';

export type ContextMenuTarget =
  | { kind: 'pane' }
  | { kind: 'node'; nodeId: string };

interface CanvasContextMenuProps {
  x: number;
  y: number;
  target: ContextMenuTarget;
  onAddNode: () => void;
  onSearchMarketplace: () => void;
  onAutoLayout: () => void;
  onFitView: () => void;
  onViewYaml: () => void;
  onDeleteNode: (nodeId: string) => void;
  onClose: () => void;
}

const MENU_WIDTH = 224;

/**
 * Right-click menu for the canvas. Shortcuts are shown inline so they are
 * learnable from the menu itself (n8n/Blender pattern).
 */
export function CanvasContextMenu({
  x,
  y,
  target,
  onAddNode,
  onSearchMarketplace,
  onAutoLayout,
  onFitView,
  onViewYaml,
  onDeleteNode,
  onClose,
}: CanvasContextMenuProps) {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 240));

  const itemClass =
    'flex w-full cursor-pointer items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-sm text-normal hover:bg-secondary hover:text-high';
  const kbdClass =
    'ml-auto rounded border border-md-outline-variant bg-secondary px-1.5 text-[10px] font-mono text-low';

  return (
    <div
      ref={containerRef}
      className="fixed z-50 rounded-lg border border-md-outline bg-panel p-1 shadow-lg"
      style={{ left, top, width: MENU_WIDTH }}
    >
      {target.kind === 'pane' ? (
        <>
          <button type="button" className={itemClass} onClick={onAddNode}>
            <Plus className="h-3.5 w-3.5 text-low" strokeWidth={1.75} />
            {t('ciPipelines.contextMenu.addNode', {
              defaultValue: 'Add node…',
            })}
            <span className={kbdClass}>Tab</span>
          </button>
          <button
            type="button"
            className={itemClass}
            onClick={onSearchMarketplace}
          >
            <Search className="h-3.5 w-3.5 text-low" strokeWidth={1.75} />
            {t('ciPipelines.contextMenu.searchMarketplace', {
              defaultValue: 'Search marketplace…',
            })}
            <span className={kbdClass}>M</span>
          </button>
          <div className="mx-1.5 my-1 border-t border-md-outline-variant" />
          <button type="button" className={itemClass} onClick={onAutoLayout}>
            <LayoutGrid className="h-3.5 w-3.5 text-low" strokeWidth={1.75} />
            {t('ciPipelines.contextMenu.autoLayout', {
              defaultValue: 'Auto-layout',
            })}
            <span className={kbdClass}>L</span>
          </button>
          <button type="button" className={itemClass} onClick={onFitView}>
            <Maximize2 className="h-3.5 w-3.5 text-low" strokeWidth={1.75} />
            {t('ciPipelines.contextMenu.fitView', {
              defaultValue: 'Fit view',
            })}
            <span className={kbdClass}>F</span>
          </button>
          <div className="mx-1.5 my-1 border-t border-md-outline-variant" />
          <button type="button" className={itemClass} onClick={onViewYaml}>
            <Code2 className="h-3.5 w-3.5 text-low" strokeWidth={1.75} />
            {t('ciPipelines.contextMenu.viewYaml', {
              defaultValue: 'View compiled YAML',
            })}
          </button>
        </>
      ) : (
        <button
          type="button"
          className={itemClass}
          onClick={() => onDeleteNode(target.nodeId)}
        >
          <Trash2 className="h-3.5 w-3.5 text-error" strokeWidth={1.75} />
          {t('ciPipelines.contextMenu.deleteNode', {
            defaultValue: 'Delete node',
          })}
          <span className={kbdClass}>Del</span>
        </button>
      )}
    </div>
  );
}
