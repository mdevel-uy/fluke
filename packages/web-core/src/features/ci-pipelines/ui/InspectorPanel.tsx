import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Trash2, X } from 'lucide-react';
import {
  isJobNode,
  needsForNode,
  type MarketplaceJobNode,
  type PipelineNode,
  type ScalarValue,
  type ScriptJobNode,
  type ScriptStep,
  type TriggerSpec,
} from '../model/graph';
import { getPrefab, type PrefabParamDef } from '../model/prefabs';
import { usePipelineStore } from '../model/usePipelineStore';

/**
 * Aside inspector: forms for the selected node, or the workflow-level form
 * when nothing is selected. Prefab forms render generically from the prefab
 * param definitions — no per-prefab UI.
 */
export function InspectorPanel() {
  const { t } = useTranslation('common');
  const graph = usePipelineStore((s) => s.graph);
  const selectedNodeId = usePipelineStore((s) => s.selectedNodeId);
  const updateNode = usePipelineStore((s) => s.updateNode);
  const removeNode = usePipelineStore((s) => s.removeNode);
  const setWorkflowName = usePipelineStore((s) => s.setWorkflowName);

  if (!graph) return null;
  const node = graph.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const labelClass = 'mb-1 block text-[11px] text-normal';
  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand';
  const sectionClass =
    'mb-2 text-[10px] font-semibold uppercase tracking-wider text-low';

  if (!node) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <div>
          <div className={sectionClass}>
            {t('ciPipelines.inspector.workflowSection', {
              defaultValue: 'Workflow',
            })}
          </div>
          <label className={labelClass}>
            {t('ciPipelines.inspector.workflowName', {
              defaultValue: 'Workflow name',
            })}
            <input
              className={inputClass}
              value={graph.workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
            />
          </label>
          <p className="mt-2 text-[11px] leading-relaxed text-low">
            {t('ciPipelines.inspector.emptyHint', {
              defaultValue:
                'Select a node to edit it. The YAML is compiled from this graph — job order and needs always come from the canvas.',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {node.type === 'trigger' ? (
        <TriggerForm
          trigger={node.trigger}
          onChange={(trigger) => updateNode(node.id, { trigger })}
        />
      ) : (
        <JobForm node={node} />
      )}

      {isJobNode(node) && (
        <div>
          <div className={sectionClass}>
            {t('ciPipelines.inspector.executionSection', {
              defaultValue: 'Execution',
            })}
          </div>
          <label className={labelClass}>
            {t('ciPipelines.inspector.runsOn', { defaultValue: 'runs-on' })}
            <input
              className={inputClass}
              value={node.runsOn}
              onChange={(e) => updateNode(node.id, { runsOn: e.target.value })}
            />
          </label>
          <div className="mt-2">
            <span className={labelClass}>
              {t('ciPipelines.inspector.needs', {
                defaultValue: 'needs · derived from edges',
              })}
            </span>
            <div className="flex flex-wrap gap-1">
              {needsForNode(graph, node.id).length === 0 ? (
                <span className="text-[11px] text-low">
                  {t('ciPipelines.inspector.needsNone', {
                    defaultValue: 'No dependencies',
                  })}
                </span>
              ) : (
                needsForNode(graph, node.id).map((jobId) => (
                  <span
                    key={jobId}
                    className="rounded-full border border-md-outline-variant bg-secondary px-2 py-0.5 text-[10.5px] text-normal"
                  >
                    {jobId}
                  </span>
                ))
              )}
            </div>
            <p className="mt-1 text-[10.5px] text-low">
              {t('ciPipelines.inspector.needsHint', {
                defaultValue:
                  'Connections define needs — they override any needs written in raw YAML.',
              })}
            </p>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => removeNode(node.id)}
        className="mt-auto flex cursor-pointer items-center gap-1.5 self-start text-[12px] text-error/80 hover:text-error"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        {t('ciPipelines.inspector.deleteNode', {
          defaultValue: 'Delete node',
        })}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger form
// ---------------------------------------------------------------------------

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function TriggerForm({
  trigger,
  onChange,
}: {
  trigger: TriggerSpec;
  onChange: (trigger: TriggerSpec) => void;
}) {
  const { t } = useTranslation('common');
  const labelClass = 'mb-1 block text-[11px] text-normal';
  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand';

  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-low">
        {t('ciPipelines.inspector.triggerSection', {
          defaultValue: 'Trigger · {{kind}}',
          kind: trigger.kind,
        })}
      </div>
      {(trigger.kind === 'push' || trigger.kind === 'pull_request') && (
        <label className={labelClass}>
          {t('ciPipelines.inspector.branches', {
            defaultValue: 'Branches (comma-separated)',
          })}
          <input
            className={inputClass}
            value={trigger.branches.join(', ')}
            onChange={(e) =>
              onChange({ ...trigger, branches: splitList(e.target.value) })
            }
          />
        </label>
      )}
      {trigger.kind === 'push' && (
        <label className={labelClass}>
          {t('ciPipelines.inspector.pathsIgnore', {
            defaultValue: 'Paths ignore (comma-separated)',
          })}
          <input
            className={inputClass}
            value={(trigger.pathsIgnore ?? []).join(', ')}
            onChange={(e) =>
              onChange({ ...trigger, pathsIgnore: splitList(e.target.value) })
            }
          />
        </label>
      )}
      {trigger.kind === 'schedule' && (
        <label className={labelClass}>
          {t('ciPipelines.inspector.cron', { defaultValue: 'Cron' })}
          <input
            className={inputClass}
            value={trigger.cron}
            onChange={(e) => onChange({ ...trigger, cron: e.target.value })}
          />
        </label>
      )}
      {trigger.kind === 'workflow_dispatch' && (
        <p className="text-[11px] text-low">
          {t('ciPipelines.inspector.manualHint', {
            defaultValue: 'Manually triggered from the Actions tab.',
          })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Job forms
// ---------------------------------------------------------------------------

function JobForm({ node }: { node: PipelineNode }) {
  const { t } = useTranslation('common');
  const updateNode = usePipelineStore((s) => s.updateNode);
  const labelClass = 'mb-1 block text-[11px] text-normal';
  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand';
  const sectionClass =
    'mb-2 text-[10px] font-semibold uppercase tracking-wider text-low';

  if (!isJobNode(node)) return null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className={sectionClass}>
          {t('ciPipelines.inspector.jobSection', { defaultValue: 'Job' })}
        </div>
        {!(node.type === 'raw' && node.scope === 'file') && (
          <>
            <label className={labelClass}>
              {t('ciPipelines.inspector.jobId', { defaultValue: 'Job id' })}
              <input
                className={inputClass}
                value={node.jobId}
                onChange={(e) => updateNode(node.id, { jobId: e.target.value })}
              />
            </label>
            <label className={labelClass}>
              {t('ciPipelines.inspector.label', { defaultValue: 'Label' })}
              <input
                className={inputClass}
                value={node.label}
                onChange={(e) => updateNode(node.id, { label: e.target.value })}
              />
            </label>
          </>
        )}
      </div>

      {node.type === 'prefab' && <PrefabParamsForm node={node} />}
      {node.type === 'marketplace' && <MarketplaceForm node={node} />}
      {node.type === 'script' && <ScriptForm node={node} />}
      {node.type === 'raw' && (
        <div>
          <div className={sectionClass}>
            {node.scope === 'file'
              ? t('ciPipelines.inspector.rawFileSection', {
                  defaultValue: 'Imported workflow (whole file)',
                })
              : t('ciPipelines.inspector.rawJobSection', {
                  defaultValue: 'Job YAML',
                })}
          </div>
          <textarea
            className={`${inputClass} min-h-[220px] resize-y leading-relaxed`}
            value={node.yaml}
            spellCheck={false}
            onChange={(e) => updateNode(node.id, { yaml: e.target.value })}
          />
          {node.scope === 'file' && (
            <p className="mt-1 text-[10.5px] text-low">
              {t('ciPipelines.inspector.rawFileHint', {
                defaultValue:
                  'This workflow was authored outside the studio; it is edited and committed as-is.',
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PrefabParamsForm({ node }: { node: PipelineNode }) {
  const { t } = useTranslation('common');
  const updateNode = usePipelineStore((s) => s.updateNode);
  if (node.type !== 'prefab') return null;
  const prefab = getPrefab(node.prefabId);
  if (!prefab) return null;

  const setParam = (key: string, value: string | boolean) =>
    updateNode(node.id, { params: { ...node.params, [key]: value } });

  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand';

  const renderParam = (def: PrefabParamDef) => {
    const value = node.params[def.key] ?? def.default;
    if (def.type === 'boolean') {
      return (
        <label
          key={def.key}
          className="flex cursor-pointer items-center justify-between py-1 text-[12px] text-normal"
        >
          {def.label}
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => setParam(def.key, e.target.checked)}
            className="h-3.5 w-3.5 accent-[hsl(var(--brand))]"
          />
        </label>
      );
    }
    if (def.type === 'select') {
      return (
        <label key={def.key} className="mb-1 block text-[11px] text-normal">
          {def.label}
          <select
            className={inputClass}
            value={String(value)}
            onChange={(e) => setParam(def.key, e.target.value)}
          >
            {def.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );
    }
    return (
      <label key={def.key} className="mb-1 block text-[11px] text-normal">
        {def.label}
        <input
          className={inputClass}
          value={String(value)}
          onChange={(e) => setParam(def.key, e.target.value)}
        />
        {def.hint && (
          <span className="mt-0.5 block text-[10px] text-low">{def.hint}</span>
        )}
      </label>
    );
  };

  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-low">
        {t('ciPipelines.inspector.prefabSection', {
          defaultValue: 'Prefab · {{name}}',
          name: prefab.name,
        })}
      </div>
      {prefab.params.map(renderParam)}
    </div>
  );
}

/** Key/value editor for scalar mappings (with:, env:). Values edit as
 * strings; imported numbers/booleans keep their type until touched. */
export function ScalarRows({
  entries,
  onChange,
  addLabel,
}: {
  entries: Record<string, ScalarValue>;
  onChange: (entries: Record<string, ScalarValue>) => void;
  addLabel: string;
}) {
  const { t } = useTranslation('common');
  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1 font-mono text-[11px] text-high outline-none focus:border-brand';
  const rows = Object.entries(entries);

  const setRows = (next: Array<[string, ScalarValue]>) =>
    onChange(Object.fromEntries(next));

  return (
    <div className="flex flex-col gap-1">
      {rows.map(([key, value], index) => (
        <div key={index} className="flex gap-1">
          <input
            className={`${inputClass} basis-2/5`}
            value={key}
            placeholder={t('ciPipelines.inspector.inputKey', {
              defaultValue: 'key',
            })}
            onChange={(e) => {
              const next: Array<[string, ScalarValue]> = [...rows];
              next[index] = [e.target.value, value];
              setRows(next);
            }}
          />
          <input
            className={`${inputClass} basis-3/5`}
            value={String(value)}
            placeholder={t('ciPipelines.inspector.inputValue', {
              defaultValue: 'value',
            })}
            onChange={(e) => {
              const next: Array<[string, ScalarValue]> = [...rows];
              next[index] = [key, e.target.value];
              setRows(next);
            }}
          />
          <button
            type="button"
            aria-label={t('ciPipelines.inspector.removeInput', {
              defaultValue: 'Remove input',
            })}
            onClick={() => setRows(rows.filter((_, i) => i !== index))}
            className="cursor-pointer px-1 text-low hover:text-error"
          >
            <X className="h-3 w-3" strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows([...rows, ['', '']])}
        className="cursor-pointer self-start text-[11px] text-brand hover:underline"
      >
        {addLabel}
      </button>
    </div>
  );
}

function ScriptForm({ node }: { node: ScriptJobNode }) {
  const { t } = useTranslation('common');
  const updateNode = usePipelineStore((s) => s.updateNode);
  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1 font-mono text-[11px] text-high outline-none focus:border-brand';
  const sectionClass =
    'mb-2 text-[10px] font-semibold uppercase tracking-wider text-low';

  const setSteps = (steps: ScriptStep[]) => updateNode(node.id, { steps });

  const patchStep = (index: number, patch: Partial<ScriptStep>) => {
    const next = node.steps.map((step, i) =>
      i === index ? { ...step, ...patch } : step
    );
    setSteps(next);
  };

  const moveStep = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= node.steps.length) return;
    const next = [...node.steps];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setSteps(next);
  };

  return (
    <div>
      <div className={sectionClass}>
        {t('ciPipelines.inspector.stepsSection', {
          defaultValue: 'Steps ({{count}})',
          count: node.steps.length,
        })}
      </div>
      <div className="flex flex-col gap-2">
        {node.steps.map((step, index) => {
          const isUses = step.uses !== undefined;
          return (
            <div
              key={index}
              className="rounded-md border border-md-outline-variant bg-secondary/40 p-2"
            >
              <div className="mb-1.5 flex items-center gap-1">
                <span className="flex-none font-mono text-[10px] text-low">
                  {index + 1}
                </span>
                <input
                  className={inputClass}
                  value={step.name ?? ''}
                  placeholder={t('ciPipelines.inspector.stepName', {
                    defaultValue: 'step name (optional)',
                  })}
                  onChange={(e) =>
                    patchStep(index, {
                      name: e.target.value === '' ? undefined : e.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={t('ciPipelines.inspector.moveUp', {
                    defaultValue: 'Move up',
                  })}
                  onClick={() => moveStep(index, -1)}
                  className="cursor-pointer p-0.5 text-low hover:text-high disabled:opacity-30"
                  disabled={index === 0}
                >
                  <ArrowUp className="h-3 w-3" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label={t('ciPipelines.inspector.moveDown', {
                    defaultValue: 'Move down',
                  })}
                  onClick={() => moveStep(index, 1)}
                  className="cursor-pointer p-0.5 text-low hover:text-high disabled:opacity-30"
                  disabled={index === node.steps.length - 1}
                >
                  <ArrowDown className="h-3 w-3" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label={t('ciPipelines.inspector.removeStep', {
                    defaultValue: 'Remove step',
                  })}
                  onClick={() =>
                    setSteps(node.steps.filter((_, i) => i !== index))
                  }
                  className="cursor-pointer p-0.5 text-low hover:text-error"
                >
                  <X className="h-3 w-3" strokeWidth={1.75} />
                </button>
              </div>
              {isUses ? (
                <>
                  <input
                    className={inputClass}
                    value={step.uses ?? ''}
                    placeholder="owner/repo@ref"
                    onChange={(e) => patchStep(index, { uses: e.target.value })}
                  />
                  <div className="mt-1.5">
                    <ScalarRows
                      entries={step.with ?? {}}
                      onChange={(entries) =>
                        patchStep(index, {
                          with:
                            Object.keys(entries).length > 0
                              ? entries
                              : undefined,
                        })
                      }
                      addLabel={t('ciPipelines.inspector.addWith', {
                        defaultValue: '+ with',
                      })}
                    />
                  </div>
                </>
              ) : (
                <textarea
                  className={`${inputClass} min-h-[52px] resize-y leading-relaxed`}
                  value={step.run ?? ''}
                  spellCheck={false}
                  onChange={(e) => patchStep(index, { run: e.target.value })}
                />
              )}
              <div className="mt-1.5">
                <ScalarRows
                  entries={step.env ?? {}}
                  onChange={(entries) =>
                    patchStep(index, {
                      env:
                        Object.keys(entries).length > 0 ? entries : undefined,
                    })
                  }
                  addLabel={t('ciPipelines.inspector.addEnv', {
                    defaultValue: '+ env',
                  })}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={() => setSteps([...node.steps, { run: '' }])}
          className="cursor-pointer text-[11.5px] text-brand hover:underline"
        >
          {t('ciPipelines.inspector.addRunStep', {
            defaultValue: '+ run step',
          })}
        </button>
        <button
          type="button"
          onClick={() => setSteps([...node.steps, { uses: '' }])}
          className="cursor-pointer text-[11.5px] text-brand hover:underline"
        >
          {t('ciPipelines.inspector.addUsesStep', {
            defaultValue: '+ uses step',
          })}
        </button>
      </div>

      <div className="mt-3">
        <div className={sectionClass}>
          {t('ciPipelines.inspector.jobEnvSection', {
            defaultValue: 'Job env',
          })}
        </div>
        <ScalarRows
          entries={node.env ?? {}}
          onChange={(entries) =>
            updateNode(node.id, {
              env: Object.keys(entries).length > 0 ? entries : undefined,
            })
          }
          addLabel={t('ciPipelines.inspector.addEnv', {
            defaultValue: '+ env',
          })}
        />
      </div>
    </div>
  );
}

function MarketplaceForm({ node }: { node: MarketplaceJobNode }) {
  const { t } = useTranslation('common');
  const updateNode = usePipelineStore((s) => s.updateNode);
  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand';

  const entries = Object.entries(node.with);

  const setWith = (entries: Array<[string, string]>) =>
    updateNode(node.id, { with: Object.fromEntries(entries) });

  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-low">
        {t('ciPipelines.inspector.actionSection', {
          defaultValue: 'Marketplace action',
        })}
      </div>
      <label className="mb-1 block text-[11px] text-normal">
        {t('ciPipelines.inspector.uses', { defaultValue: 'uses' })}
        <input
          className={inputClass}
          value={node.uses}
          onChange={(e) => updateNode(node.id, { uses: e.target.value })}
        />
      </label>
      <label className="flex cursor-pointer items-center justify-between py-1 text-[12px] text-normal">
        {t('ciPipelines.inspector.checkout', {
          defaultValue: 'Checkout repo first',
        })}
        <input
          type="checkbox"
          checked={node.checkout}
          onChange={(e) => updateNode(node.id, { checkout: e.target.checked })}
          className="h-3.5 w-3.5 accent-[hsl(var(--brand))]"
        />
      </label>
      <div className="mt-2">
        <span className="mb-1 block text-[11px] text-normal">
          {t('ciPipelines.inspector.with', { defaultValue: 'Inputs (with)' })}
        </span>
        <div className="flex flex-col gap-1">
          {entries.map(([key, value], index) => (
            <div key={index} className="flex gap-1">
              <input
                className={`${inputClass} basis-2/5`}
                value={key}
                placeholder={t('ciPipelines.inspector.inputKey', {
                  defaultValue: 'key',
                })}
                onChange={(e) => {
                  const next: Array<[string, string]> = [...entries];
                  next[index] = [e.target.value, value];
                  setWith(next);
                }}
              />
              <input
                className={`${inputClass} basis-3/5`}
                value={value}
                placeholder={t('ciPipelines.inspector.inputValue', {
                  defaultValue: 'value',
                })}
                onChange={(e) => {
                  const next: Array<[string, string]> = [...entries];
                  next[index] = [key, e.target.value];
                  setWith(next);
                }}
              />
              <button
                type="button"
                aria-label={t('ciPipelines.inspector.removeInput', {
                  defaultValue: 'Remove input',
                })}
                onClick={() => setWith(entries.filter((_, i) => i !== index))}
                className="cursor-pointer px-1 text-low hover:text-error"
              >
                <X className="h-3 w-3" strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setWith([...entries, ['', '']])}
          className="mt-1.5 cursor-pointer text-[11.5px] text-brand hover:underline"
        >
          {t('ciPipelines.inspector.addInput', {
            defaultValue: '+ Add input',
          })}
        </button>
      </div>
    </div>
  );
}
