import { fileSystemApi, workspacesApi } from '@/shared/lib/api';
import { compileGraph } from './compiler';
import {
  parsePipelineGraph,
  serializePipelineGraph,
  type PipelineGraph,
} from './graph';
import { importWorkflowYaml } from './importer';

/**
 * File-level plumbing for the studio: a workflow on disk is the pair
 * `.github/workflows/<name>.yml` (compiled artifact) + `<name>.fluke.json`
 * (graph, source of truth). Everything goes through the existing editor file
 * API — no dedicated backend.
 */

const WORKFLOWS_SUBDIR = '.github/workflows';
const SIDECAR_SUFFIX = '.fluke.json';

export interface WorkflowFileEntry {
  /** Workflow name = yml file stem, e.g. `deploy` for `deploy.yml`. */
  name: string;
  ymlPath: string;
  sidecarPath: string;
  hasSidecar: boolean;
}

export interface LoadedWorkflow {
  entry: WorkflowFileEntry;
  graph: PipelineGraph;
  /** False when the yml was authored elsewhere (no usable sidecar). */
  fromSidecar: boolean;
  /** True when the sidecar graph no longer compiles to the on-disk yml
   * (someone edited the yml outside the studio). */
  drifted: boolean;
}

export function workflowsDirPath(repoPath: string): string {
  return `${repoPath}/${WORKFLOWS_SUBDIR}`;
}

export function isWorkflowYml(fileName: string): boolean {
  return /\.ya?ml$/i.test(fileName) && !fileName.endsWith(SIDECAR_SUFFIX);
}

export function workflowNameFromYml(fileName: string): string {
  return fileName.replace(/\.ya?ml$/i, '');
}

export function sidecarPathForYml(ymlPath: string): string {
  return ymlPath.replace(/\.ya?ml$/i, SIDECAR_SUFFIX);
}

export function ymlPathFor(repoPath: string, workflowName: string): string {
  return `${workflowsDirPath(repoPath)}/${workflowName}.yml`;
}

export function sidecarNameFor(workflowName: string): string {
  return `${workflowName}${SIDECAR_SUFFIX}`;
}

/** List the repo's workflows. A missing `.github/workflows` directory is the
 * empty state, not an error. */
export async function listWorkflowFiles(
  repoPath: string
): Promise<WorkflowFileEntry[]> {
  let entries;
  try {
    entries = (await fileSystemApi.list(workflowsDirPath(repoPath))).entries;
  } catch {
    return [];
  }
  const fileNames = new Set(
    entries.filter((e) => !e.is_directory).map((e) => e.name)
  );
  return entries
    .filter((e) => !e.is_directory && isWorkflowYml(e.name))
    .map((e) => {
      const sidecarName = sidecarNameFor(workflowNameFromYml(e.name));
      return {
        name: workflowNameFromYml(e.name),
        ymlPath: e.path,
        sidecarPath: sidecarPathForYml(e.path),
        hasSidecar: fileNames.has(sidecarName),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a workflow pair. Sidecar missing or unparseable → structured
 * best-effort import (trigger nodes, job nodes, extras), collapsing into a
 * single raw whole-file node only when the round-trip guard refuses. */
export async function loadWorkflow(
  entry: WorkflowFileEntry
): Promise<LoadedWorkflow> {
  const { content: ymlContent } = await workspacesApi.readEditorFile(
    entry.ymlPath
  );

  let graph: PipelineGraph | null = null;
  if (entry.hasSidecar) {
    try {
      const { content } = await workspacesApi.readEditorFile(entry.sidecarPath);
      graph = parsePipelineGraph(content);
    } catch {
      graph = null;
    }
  }

  if (graph === null) {
    const imported = importWorkflowYaml(entry.name, ymlContent);
    return {
      entry,
      graph: imported.graph,
      fromSidecar: false,
      drifted: false,
    };
  }

  const compiled = compileGraph(graph, {
    sidecarName: sidecarNameFor(entry.name),
  });
  const drifted = !compiled.ok || compiled.yaml !== ymlContent;
  return { entry, graph, fromSidecar: true, drifted };
}

/** Write both files to the repo working tree. The editor save endpoint only
 * overwrites existing files, so create first and ignore the "already exists"
 * failure; create also makes `.github/workflows/` when absent. */
async function createThenSave(path: string, content: string): Promise<void> {
  try {
    await workspacesApi.createEditorEntry(path, false);
  } catch {
    // Already exists — fine, we are about to overwrite it.
  }
  await workspacesApi.saveEditorFile(path, content);
}

export interface CompiledWorkflowFiles {
  ymlPath: string;
  ymlContent: string;
  sidecarPath: string;
  sidecarContent: string;
}

export function compiledFilesFor(
  repoPath: string,
  workflowName: string,
  graph: PipelineGraph,
  ymlContent: string
): CompiledWorkflowFiles {
  return {
    ymlPath: ymlPathFor(repoPath, workflowName),
    ymlContent,
    sidecarPath: sidecarPathForYml(ymlPathFor(repoPath, workflowName)),
    sidecarContent: serializePipelineGraph(graph),
  };
}

export async function saveWorkflowFiles(
  files: CompiledWorkflowFiles
): Promise<void> {
  await createThenSave(files.ymlPath, files.ymlContent);
  await createThenSave(files.sidecarPath, files.sidecarContent);
}
