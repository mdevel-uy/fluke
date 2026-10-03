import { type ReactNode } from 'react';
import { ImageIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { Toolbar } from './Toolbar';

export enum VisualVariant {
  NORMAL = 'NORMAL',
  FEEDBACK = 'FEEDBACK',
  EDIT = 'EDIT',
  PLAN = 'PLAN',
}

export interface DropzoneProps {
  getRootProps: () => Record<string, unknown>;
  getInputProps: () => Record<string, unknown>;
  isDragActive: boolean;
}

interface ChatBoxBaseProps {
  // Editor node (provided by frontend)
  editor: ReactNode;

  // Error display
  error?: string | null;

  // Header content (right side - session/executor dropdown)
  headerRight?: ReactNode;

  // Header content (left side - stats)
  headerLeft?: ReactNode;

  // Footer left content (additional toolbar items like attach button)
  footerLeft?: ReactNode;

  // Footer right content (action buttons)
  footerRight: ReactNode;

  // Model selector node (rendered with footer controls)
  modelSelector?: ReactNode;

  // Banner content (queued message indicator, feedback mode indicator)
  banner?: ReactNode;

  // Compact layout: no header row; contextual info renders via contextStrip
  compact?: boolean;

  // Slim contextual strip above the editor (diff stats, running todo) —
  // only rendered in compact mode, and only when there is something to say
  contextStrip?: ReactNode;

  // visualVariant
  visualVariant: VisualVariant;

  // Whether the workspace is running (shows animated border)
  isRunning?: boolean;

  // Dropzone props for drag-and-drop image uploads
  dropzone?: DropzoneProps;
}

/**
 * Base chat box layout component.
 * Provides shared structure for CreateChatBox and SessionChatBox.
 */
export function ChatBoxBase({
  editor,
  error,
  headerRight,
  headerLeft,
  footerLeft,
  footerRight,
  modelSelector,
  banner,
  compact,
  contextStrip,
  visualVariant,
  isRunning,
  dropzone,
}: ChatBoxBaseProps) {
  const { t } = useTranslation(['common', 'tasks']);

  const isDragActive = dropzone?.isDragActive ?? false;

  return (
    <div
      {...(dropzone?.getRootProps() ?? {})}
      className={cn(
        'relative flex w-chat max-w-full flex-col rounded-lg border border-border-strong bg-card',
        (visualVariant === VisualVariant.FEEDBACK ||
          visualVariant === VisualVariant.EDIT ||
          visualVariant === VisualVariant.PLAN) &&
          'border-brand bg-brand/10',
        isRunning && 'chat-box-running'
      )}
    >
      {dropzone && <input {...dropzone.getInputProps()} />}

      {isDragActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-sm border-2 border-dashed border-brand bg-primary/80 backdrop-blur-sm pointer-events-none animate-in fade-in-0 duration-150">
          <div className="text-center">
            <div className="mx-auto mb-2 w-10 h-10 rounded-full bg-brand/10 flex items-center justify-center">
              <ImageIcon className="h-5 w-5 text-brand-on-surface" />
            </div>
            <p className="text-sm font-medium text-high">
              {t('tasks:dropzone.dropImagesHere')}
            </p>
            <p className="text-xs text-low mt-0.5">
              {t('tasks:dropzone.supportedFormats')}
            </p>
          </div>
        </div>
      )}
      {/* Error alert */}
      {error && (
        <div className="bg-error/10 border-b px-double py-base">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {/* Banner content (queued indicator, feedback mode, etc.) */}
      {banner}

      {/* Header - Stats and selector (hidden in compact mode) */}
      {visualVariant === VisualVariant.NORMAL && !compact && (
        <div className="flex items-center gap-base border-b px-base py-base">
          <div className="flex flex-1 items-center gap-base text-sm min-w-0 overflow-hidden">
            {headerLeft}
          </div>
          <Toolbar className="gap-[9px]">{headerRight}</Toolbar>
        </div>
      )}

      {/* Compact mode: slim contextual strip above the editor */}
      {compact && contextStrip}

      {/* Editor area */}
      <div className="flex flex-col gap-plusfifty px-base py-base rounded-md">
        {/* Own border and fill so the field reads against the card (>= 3:1,
            design/director-spacing-contrast-mock.html). */}
        <div className="min-h-14 rounded-md border border-md-outline bg-md-surface-container-low px-3 py-2 focus-within:border-brand focus-within:ring-1 focus-within:ring-brand">
          {editor}
        </div>

        {/* Footer - Controls */}
        <div className="flex items-end justify-between gap-base">
          <Toolbar className="flex-1 min-w-0 flex-wrap !gap-half">
            {modelSelector}
            {footerLeft}
          </Toolbar>
          <div className="flex shrink-0 gap-base">{footerRight}</div>
        </div>
      </div>
    </div>
  );
}
