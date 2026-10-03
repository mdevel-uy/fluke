import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PencilSimpleIcon, ArrowUUpLeftIcon } from '@phosphor-icons/react';
import { ChatEntryContainer } from './ChatEntryContainer';
import { Tooltip } from './Tooltip';
import { cn } from '../lib/cn';

export interface ChatUserMessageRenderProps {
  content: string;
  workspaceId?: string;
}

interface ChatUserMessageProps {
  content: string;
  expanded?: boolean;
  onToggle?: () => void;
  className?: string;
  workspaceId?: string;
  onEdit?: () => void;
  onReset?: () => void;
  isGreyed?: boolean;
  /** `bubble`: right-aligned chat bubble with labelled hover actions. */
  variant?: 'card' | 'bubble';
  renderMarkdown: (props: ChatUserMessageRenderProps) => ReactNode;
}

/** "question?: answer" lines (quick-reply answers) as pairs, else null. */
function parseAnswers(content: string) {
  const lines = content.trim().split('\n');
  const pairs = lines.map((line) => line.match(/^(.+\?)\s*:\s*(.+)$/));
  return pairs.every(Boolean)
    ? pairs.map((m) => ({ question: m![1], answer: m![2] }))
    : null;
}

export function ChatUserMessage({
  content,
  expanded = true,
  onToggle,
  className,
  workspaceId,
  onEdit,
  onReset,
  isGreyed,
  variant = 'card',
  renderMarkdown,
}: ChatUserMessageProps) {
  const { t } = useTranslation('tasks');

  if (variant === 'bubble') {
    const answers = parseAnswers(content);
    const action =
      'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-low hover:bg-secondary hover:text-normal [&>svg]:size-icon-xs';
    return (
      <div
        className={cn(
          'group flex flex-col items-end gap-1.5',
          isGreyed && 'pointer-events-none opacity-50',
          className
        )}
      >
        <div className="max-w-[78%] rounded-2xl rounded-br-sm border border-border-strong bg-secondary px-4 py-3 text-high">
          {answers ? (
            <dl className="m-0 flex flex-col gap-2">
              {answers.map(({ question, answer }) => (
                <div key={question} className="flex flex-col">
                  <dt className="text-xs text-low">{question}</dt>
                  <dd className="m-0">{answer}</dd>
                </div>
              ))}
            </dl>
          ) : (
            renderMarkdown({ content: content.trim(), workspaceId })
          )}
        </div>
        {(onEdit || onReset) && (
          <div className="flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {onEdit && (
              <button type="button" onClick={onEdit} className={action}>
                <PencilSimpleIcon />
                {t('conversation.actions.edit')}
              </button>
            )}
            {onReset && (
              <button type="button" onClick={onReset} className={action}>
                <ArrowUUpLeftIcon />
                {t('conversation.actions.resetTooltip')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const headerActions =
    !isGreyed && (onEdit || onReset) ? (
      <div className="flex items-center gap-1">
        {onReset && (
          <Tooltip content={t('conversation.actions.resetTooltip')}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReset();
              }}
              className="p-1 rounded hover:bg-muted text-low hover:text-normal transition-colors"
              aria-label={t('conversation.actions.reset')}
            >
              <ArrowUUpLeftIcon className="size-icon-xs" />
            </button>
          </Tooltip>
        )}
        {onEdit && (
          <Tooltip content={t('conversation.actions.edit')}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="p-1 rounded hover:bg-muted text-low hover:text-normal transition-colors"
              aria-label={t('conversation.actions.edit')}
            >
              <PencilSimpleIcon className="size-icon-xs" />
            </button>
          </Tooltip>
        )}
      </div>
    ) : undefined;

  return (
    <ChatEntryContainer
      variant="user"
      title={t('conversation.you')}
      expanded={expanded}
      onToggle={onToggle}
      className={className}
      isGreyed={isGreyed}
      headerRight={headerActions}
    >
      {renderMarkdown({ content, workspaceId })}
    </ChatEntryContainer>
  );
}
