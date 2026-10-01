import { useState } from 'react';
import type { PendingQuestion } from 'shared/types';
import { cn } from '@/shared/lib/utils';

/**
 * Questions the Director left open (at most 3), each with clickable answers.
 * One question sends on click; with several, the reply goes once every
 * question has an answer. Free text still goes through the composer.
 */
export function QuickReplies({
  questions,
  disabled,
  onSend,
}: {
  questions: PendingQuestion[];
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  if (questions.length === 0) return null;

  const choose = (index: number, option: string) => {
    const next = { ...answers, [index]: option };
    setAnswers(next);
    if (questions.every((_, i) => next[i])) {
      onSend(
        questions.length === 1
          ? option
          : questions.map((q, i) => `${q.question}: ${next[i]}`).join('\n')
      );
      setAnswers({});
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 pt-2">
      {questions.map((q, i) => (
        <div key={i} className="flex flex-col gap-1">
          <p className="text-xs text-normal">{q.question}</p>
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {q.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={disabled}
                  onClick={() => choose(i, option)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs transition-colors',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    answers[i] === option
                      ? 'border-brand bg-brand/10 text-high'
                      : 'border-md-outline-variant text-normal hover:bg-secondary'
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
