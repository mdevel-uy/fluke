import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHotkeys } from 'react-hotkeys-hook';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Code2,
  GitPullRequest,
  Save,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import { Button } from '@vibe/ui/components/Button';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { ShellAsidePortal } from '@/shared/components/ui-new/shell/ShellAside';
import { useRepos } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { cn } from '@/shared/lib/utils';
import { compileGraph } from '../model/compiler';
import {
  buildCatalogNode,
  buildMarketplaceNode,
  type CatalogItem,
} from '../model/catalog';
import { emptyGraph, serializePipelineGraph } from '../model/graph';
import { usePipelineStore } from '../model/usePipelineStore';
import {
  useInvalidateWorkflows,
  useOpenWorkflow,
  useWorkflowFiles,
} from '../model/useWorkflows';
import {
  compiledFilesFor,
  saveWorkflowFiles,
  sidecarNameFor,
  sidecarPathForYml,
  ymlPathFor,
} from '../model/workflowFiles';
import { CompilePrDialog } from './CompilePrDialog';
import { InspectorPanel } from './InspectorPanel';
import { PipelineCanvas } from './PipelineCanvas';
import { PipelinesSidebar } from './PipelinesSidebar';
import { StepInspectorPanel } from './StepInspectorPanel';
import { StepsCanvas } from './StepsCanvas';
import { YamlPreviewDialog } from './YamlPreviewDialog';

/**
 * CI Pipeline Studio: node-based editor for GitHub Actions workflows. The
 * graph (sidecar json) is the source of truth; the yml is compiled output.
 */
export function CiPipelinesPage() {
  const { t } = useTranslation('common');
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setSelectedRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);
  const { repos } = useRepos();
  const selectedRepoId = useMemo(() => {
    if (storedRepoId && repos.some((r) => r.id === storedRepoId)) {
      return storedRepoId;
    }
    return repos[0]?.id ?? null;
  }, [storedRepoId, repos]);
  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
  const repoPath = selectedRepo ? String(selectedRepo.path) : null;

  const { workflows, isLoadingWorkflows } = useWorkflowFiles(repoPath);
  const openWorkflow = useOpenWorkflow();
  const invalidateWorkflows = useInvalidateWorkflows();

  const entry = usePipelineStore((s) => s.entry);
  const graph = usePipelineStore((s) => s.graph);
  const savedFingerprint = usePipelineStore((s) => s.savedFingerprint);
  const drifted = usePipelineStore((s) => s.drifted);
  const fromSidecar = usePipelineStore((s) => s.fromSidecar);
  const open = usePipelineStore((s) => s.open);
  const close = usePipelineStore((s) => s.close);
  const markSaved = usePipelineStore((s) => s.markSaved);
  const addNode = usePipelineStore((s) => s.addNode);
  const drillNodeId = usePipelineStore((s) => s.drillNodeId);
  const exitDrill = usePipelineStore((s) => s.exitDrill);
  const drillNode = useMemo(() => {
    if (!graph || !drillNodeId) return null;
    const node = graph.nodes.find((n) => n.id === drillNodeId);
    return node?.type === 'script' ? node : null;
  }, [graph, drillNodeId]);

  // The session is repo-scoped: switching repos closes the open workflow.
  useEffect(() => {
    close();
  }, [selectedRepoId, close]);

  const [showYaml, setShowYaml] = useState(false);
  const [showCompilePr, setShowCompilePr] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newName, setNewName] = useState('');

  const compiled = useMemo(() => {
    if (!graph || !entry) {
      return { yaml: null as string | null, errors: [] };
    }
    const result = compileGraph(graph, {
      sidecarName: sidecarNameFor(entry.name),
    });
    return result.ok
      ? { yaml: result.yaml, errors: [] }
      : { yaml: null, errors: result.errors };
  }, [graph, entry]);

  const isDirty = useMemo(() => {
    if (!graph || savedFingerprint === null) return false;
    return serializePipelineGraph(graph) !== savedFingerprint;
  }, [graph, savedFingerprint]);

  const cascadePosition = useCallback(() => {
    const count = usePipelineStore.getState().graph?.nodes.length ?? 0;
    return { x: 120 + (count % 4) * 80, y: 100 + (count % 6) * 70 };
  }, []);

  const insertItem = useCallback(
    (item: CatalogItem) => {
      const current = usePipelineStore.getState().graph;
      if (!current) return;
      addNode(buildCatalogNode(item, current, cascadePosition()));
    },
    [addNode, cascadePosition]
  );

  const insertMarketplace = useCallback(
    (uses: string) => {
      const current = usePipelineStore.getState().graph;
      if (!current) return;
      addNode(buildMarketplaceNode(uses, current, cascadePosition()));
    },
    [addNode, cascadePosition]
  );

  const createWorkflow = useCallback(() => {
    if (!repoPath) return;
    const name = newName
      .trim()
      .toLowerCase()
      .replace(/\.ya?ml$/, '')
      .replace(/[^a-z0-9-_]+/g, '-');
    if (!name) return;
    const ymlPath = ymlPathFor(repoPath, name);
    open(
      {
        name,
        ymlPath,
        sidecarPath: sidecarPathForYml(ymlPath),
        hasSidecar: false,
      },
      emptyGraph(name),
      { fromSidecar: true, drifted: false }
    );
    setShowNewDialog(false);
    setNewName('');
  }, [repoPath, newName, open]);

  const saveToWorkingTree = useCallback(async () => {
    if (!graph || !entry || !repoPath) return;
    if (compiled.yaml === null) {
      setShowYaml(true);
      return;
    }
    const files = compiledFilesFor(repoPath, entry.name, graph, compiled.yaml);
    await saveWorkflowFiles(files);
    markSaved();
    void invalidateWorkflows(repoPath);
  }, [graph, entry, repoPath, compiled.yaml, markSaved, invalidateWorkflows]);

  useHotkeys(
    'mod+s',
    (event) => {
      event.preventDefault();
      void saveToWorkingTree();
    },
    { enableOnFormTags: true },
    [saveToWorkingTree]
  );

  const isWholeFileImport = useMemo(
    () =>
      graph !== null &&
      graph.nodes.some((n) => n.type === 'raw' && n.scope === 'file'),
    [graph]
  );

  const prFiles = useMemo(() => {
    if (!graph || !entry || compiled.yaml === null) return [];
    return [
      {
        relPath: `.github/workflows/${entry.name}.yml`,
        content: compiled.yaml,
      },
      {
        relPath: `.github/workflows/${sidecarNameFor(entry.name)}`,
        content: serializePipelineGraph(graph),
      },
    ];
  }, [graph, entry, compiled.yaml]);

  return (
    <>
      <ShellSidebarPortal>
        <PipelinesSidebar
          repos={repos}
          selectedRepoId={selectedRepoId}
          onSelectRepo={setSelectedRepoId}
          workflows={workflows}
          isLoadingWorkflows={isLoadingWorkflows}
          activeWorkflowName={entry?.name ?? null}
          onOpenWorkflow={(e) => void openWorkflow(e)}
          onNewWorkflow={() => setShowNewDialog(true)}
          onInsertItem={insertItem}
          onInsertMarketplace={insertMarketplace}
          canInsert={graph !== null && !isWholeFileImport}
        />
      </ShellSidebarPortal>

      {graph && (
        <ShellAsidePortal>
          {drillNode ? <StepInspectorPanel /> : <InspectorPanel />}
        </ShellAsidePortal>
      )}

      <div className="flex h-full min-h-0 flex-col bg-primary">
        {/* Toolbar */}
        <div className="flex h-9 flex-none items-center gap-2 border-b border-md-outline-variant bg-md-surface-container-low px-3">
          {drillNode && entry ? (
            <>
              <button
                type="button"
                onClick={exitDrill}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-md-outline-variant px-2 py-0.5 text-xs text-normal hover:bg-secondary hover:text-high"
              >
                <ArrowLeft className="h-3 w-3" strokeWidth={1.75} />
                {`${entry.name}.yml`}
              </button>
              <span className="text-xs text-low">/</span>
              <span className="truncate font-mono text-sm font-semibold text-high">
                {drillNode.jobId}
              </span>
              <span className="rounded-full border border-md-outline-variant px-2 py-0.5 text-[10.5px] text-low">
                {t('ciPipelines.steps.count', {
                  defaultValue: '{{count}} steps',
                  count: drillNode.steps.length,
                })}
              </span>
            </>
          ) : (
            <>
              <WorkflowIcon
                className="h-3.5 w-3.5 flex-none text-brand"
                strokeWidth={1.75}
              />
              <span className="truncate text-sm font-semibold text-high">
                {entry
                  ? `${entry.name}.yml`
                  : t('ciPipelines.toolbar.noWorkflow', {
                      defaultValue: 'CI Pipeline Studio',
                    })}
              </span>
            </>
          )}

          {entry && (
            <span
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]',
                compiled.errors.length > 0
                  ? 'border-error/40 text-error'
                  : drifted || !fromSidecar
                    ? 'border-warning/40 text-warning'
                    : isDirty
                      ? 'border-warning/40 text-warning'
                      : 'border-success/40 text-success'
              )}
            >
              {compiled.errors.length > 0 ? (
                <>
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                  {t('ciPipelines.toolbar.compileErrors', {
                    defaultValue: '{{count}} compile errors',
                    count: compiled.errors.length,
                  })}
                </>
              ) : drifted ? (
                <>
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                  {t('ciPipelines.toolbar.drifted', {
                    defaultValue: 'YAML changed outside the studio',
                  })}
                </>
              ) : !fromSidecar ? (
                <>
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                  {t('ciPipelines.toolbar.imported', {
                    defaultValue: 'Imported — saving normalizes the file',
                  })}
                </>
              ) : isDirty ? (
                <>
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                  {t('ciPipelines.toolbar.dirty', {
                    defaultValue: 'Unsaved changes',
                  })}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3 w-3" strokeWidth={1.75} />
                  {t('ciPipelines.toolbar.inSync', {
                    defaultValue: 'In sync',
                  })}
                </>
              )}
            </span>
          )}

          <div className="flex-1" />

          {entry && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowYaml(true)}
              >
                <Code2 className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} />
                {t('ciPipelines.toolbar.viewYaml', {
                  defaultValue: 'View YAML',
                })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void saveToWorkingTree()}
                disabled={compiled.yaml === null}
              >
                <Save className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} />
                {t('ciPipelines.toolbar.save', { defaultValue: 'Save' })}
              </Button>
              <Button
                size="sm"
                onClick={() => setShowCompilePr(true)}
                disabled={compiled.yaml === null}
              >
                <GitPullRequest
                  className="mr-1 h-3.5 w-3.5"
                  strokeWidth={1.75}
                />
                {t('ciPipelines.toolbar.compilePr', {
                  defaultValue: 'Compile → PR',
                })}
              </Button>
            </>
          )}
        </div>

        {/* Main area */}
        {graph ? (
          drillNode ? (
            <StepsCanvas />
          ) : (
            <PipelineCanvas onViewYaml={() => setShowYaml(true)} />
          )
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <WorkflowIcon className="h-8 w-8 text-low/60" strokeWidth={1.25} />
            <p className="max-w-sm text-sm text-low">
              {selectedRepo
                ? t('ciPipelines.empty.selectWorkflow', {
                    defaultValue:
                      'Select a workflow from the sidebar, or create a new one to start drawing your pipeline.',
                  })
                : t('ciPipelines.empty.noRepo', {
                    defaultValue: 'Add a repository to design its CI here.',
                  })}
            </p>
          </div>
        )}
      </div>

      {entry && (
        <YamlPreviewDialog
          open={showYaml}
          onOpenChange={setShowYaml}
          workflowName={entry.name}
          yaml={compiled.yaml}
          errors={compiled.errors}
        />
      )}

      {entry && selectedRepo && (
        <CompilePrDialog
          open={showCompilePr}
          onOpenChange={setShowCompilePr}
          repo={selectedRepo}
          workflowName={entry.name}
          files={prFiles}
          onCreated={() => {
            markSaved();
            if (repoPath) void invalidateWorkflows(repoPath);
          }}
        />
      )}

      {/* New workflow dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {t('ciPipelines.newWorkflow.title', {
                defaultValue: 'New workflow',
              })}
            </DialogTitle>
          </DialogHeader>
          <label className="block text-[11px] text-normal">
            {t('ciPipelines.newWorkflow.name', {
              defaultValue: 'Name (file: .github/workflows/<name>.yml)',
            })}
            <input
              autoFocus
              className="mt-1 w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createWorkflow();
              }}
            />
          </label>
          <DialogFooter>
            <Button onClick={createWorkflow} disabled={!newName.trim()}>
              {t('ciPipelines.newWorkflow.create', {
                defaultValue: 'Create',
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
