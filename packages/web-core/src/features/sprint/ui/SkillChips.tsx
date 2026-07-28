import { cn } from '@/shared/lib/utils';

interface SkillChipsProps {
  skills: readonly string[];
  className?: string;
}

/**
 * Compact chip row rendering the skill names attached to a worker task.
 * Silent when the list is empty so callers can drop it in unconditionally.
 */
export function SkillChips({ skills, className }: SkillChipsProps) {
  if (!skills || skills.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {skills.map((name) => (
        <span
          key={name}
          title={`/${name}`}
          className="inline-flex items-center rounded-full border border-border/60 bg-secondary px-1.5 py-px font-mono text-[10px] leading-4 text-normal"
        >
          /{name}
        </span>
      ))}
    </div>
  );
}
