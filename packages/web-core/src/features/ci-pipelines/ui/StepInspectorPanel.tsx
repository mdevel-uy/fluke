import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { ScriptJobNode } from '../model/graph';
import { usePipelineStore } from '../model/usePipelineStore';
import { ScalarRows } from './InspectorPanel';
import { stepTitle } from './nodes/StepFlowNode';

/**
 * Aside inspector for the drill-down: the selected step's form, or the
 * job-level settings when nothing is selected. The chain on the canvas owns
 * the order — there is no order field here.
 */
export function StepInspectorPanel() {
  const { t } = useTranslation('common');
  const graph = usePipelineStore((s) => s.graph);
  const drillNodeId = usePipelineStore((s) => s.drillNodeId);
  const selectedStepIndex = usePipelineStore((s) => s.selectedStepIndex);
  const updateNode = usePipelineStore((s) => s.updateNode);
  const updateStep = usePipelineStore((s) => s.updateStep);
  const removeStep = usePipelineStore((s) => s.removeStep);

  const node = graph?.nodes.find(
    (n): n is ScriptJobNode => n.id === drillNodeId && n.type === 'script'
  );
  if (!node) return null;

  const step =
    selectedStepIndex !== null ? node.steps[selectedStepIndex] : undefined;

  const labelClass = 'mb-1 block text-[11px] text-normal';
  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand';
  const sectionClass =
    'mb-2 text-[10px] font-semibold uppercase tracking-wider text-low';

  if (!step || selectedStepIndex === null) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <div>
          <div className={sectionClass}>
            {t('ciPipelines.inspector.jobSection', { defaultValue: 'Job' })}
          </div>
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
          <label className={labelClass}>
            {t('ciPipelines.inspector.runsOn', { defaultValue: 'runs-on' })}
            <input
              className={inputClass}
              value={node.runsOn}
              onChange={(e) => updateNode(node.id, { runsOn: e.target.value })}
            />
          </label>
        </div>
        <div>
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
        <p className="text-[11px] leading-relaxed text-low">
          {t('ciPipelines.steps.emptyHint', {
            defaultValue:
              'Select a step on the chain to edit it. The chain defines the execution order.',
          })}
        </p>
      </div>
    );
  }

  const isUses = step.uses !== undefined;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <div className={sectionClass}>
          {t('ciPipelines.steps.stepSection', {
            defaultValue: 'Step {{position}} of {{total}} · {{job}}',
            position: selectedStepIndex + 1,
            total: node.steps.length,
            job: node.jobId,
          })}
        </div>
        <label className={labelClass}>
          {t('ciPipelines.inspector.stepName', {
            defaultValue: 'step name (optional)',
          })}
          <input
            className={inputClass}
            value={step.name ?? ''}
            onChange={(e) =>
              updateStep(node.id, selectedStepIndex, {
                name: e.target.value === '' ? undefined : e.target.value,
              })
            }
          />
        </label>
        {isUses ? (
          <>
            <label className={labelClass}>
              {t('ciPipelines.inspector.uses', { defaultValue: 'uses' })}
              <input
                className={inputClass}
                value={step.uses ?? ''}
                placeholder="owner/repo@ref"
                onChange={(e) =>
                  updateStep(node.id, selectedStepIndex, {
                    uses: e.target.value,
                  })
                }
              />
            </label>
            <div className="mt-2">
              <span className={labelClass}>
                {t('ciPipelines.inspector.with', {
                  defaultValue: 'Inputs (with)',
                })}
              </span>
              <ScalarRows
                entries={step.with ?? {}}
                onChange={(entries) =>
                  updateStep(node.id, selectedStepIndex, {
                    with: Object.keys(entries).length > 0 ? entries : undefined,
                  })
                }
                addLabel={t('ciPipelines.inspector.addWith', {
                  defaultValue: '+ with',
                })}
              />
            </div>
          </>
        ) : (
          <label className={labelClass}>
            {t('ciPipelines.steps.runCommand', { defaultValue: 'run' })}
            <textarea
              className={`${inputClass} min-h-[90px] resize-y leading-relaxed`}
              value={step.run ?? ''}
              spellCheck={false}
              onChange={(e) =>
                updateStep(node.id, selectedStepIndex, {
                  run: e.target.value,
                })
              }
            />
          </label>
        )}
      </div>

      <div>
        <div className={sectionClass}>
          {t('ciPipelines.steps.stepEnvSection', {
            defaultValue: 'Step env',
          })}
        </div>
        <ScalarRows
          entries={step.env ?? {}}
          onChange={(entries) =>
            updateStep(node.id, selectedStepIndex, {
              env: Object.keys(entries).length > 0 ? entries : undefined,
            })
          }
          addLabel={t('ciPipelines.inspector.addEnv', {
            defaultValue: '+ env',
          })}
        />
      </div>

      <button
        type="button"
        onClick={() => removeStep(node.id, selectedStepIndex)}
        className="mt-auto flex cursor-pointer items-center gap-1.5 self-start text-[12px] text-error/80 hover:text-error"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        {t('ciPipelines.steps.deleteStep', {
          defaultValue: 'Delete step "{{name}}"',
          name: stepTitle(step, selectedStepIndex),
        })}
      </button>
    </div>
  );
}
