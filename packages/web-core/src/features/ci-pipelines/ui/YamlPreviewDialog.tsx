import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import type { CompileError } from '../model/compiler';

interface YamlPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowName: string;
  yaml: string | null;
  errors: CompileError[];
}

/** Read-only view of the compiled YAML (or the compile errors blocking it). */
export function YamlPreviewDialog({
  open,
  onOpenChange,
  workflowName,
  yaml,
  errors,
}: YamlPreviewDialogProps) {
  const { t } = useTranslation('common');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {t('ciPipelines.yamlPreview.title', {
              defaultValue: 'Compiled YAML · {{name}}.yml',
              name: workflowName,
            })}
          </DialogTitle>
        </DialogHeader>
        {yaml !== null ? (
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-md-outline-variant bg-secondary p-3 font-mono text-xs leading-relaxed text-normal">
            {yaml}
          </pre>
        ) : (
          <div className="flex flex-col gap-1.5">
            {errors.map((error, index) => (
              <div
                key={index}
                className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
              >
                {error.message}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
