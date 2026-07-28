import { PuzzlePieceIcon, XIcon } from '@phosphor-icons/react';
import {
  MultiSelectDropdown,
  type MultiSelectDropdownOption,
} from '@vibe/ui/components/MultiSelectDropdown';
import type { SkillInfo } from '@/shared/lib/api';

export interface SkillsPickerProps {
  installed: SkillInfo[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  triggerLabel: string;
  emptyHint: string;
}

/**
 * Multi-select for skills to attach to a worker task. Renders a dropdown
 * trigger with the count of selected skills and a chip row of the currently
 * selected names (with quick-remove). Selected names outside the installed
 * list (typically pulled from `skill:` GitHub labels) are still preserved so
 * the user does not silently lose the ticket-authored intent.
 */
export function SkillsPicker({
  installed,
  selected,
  onChange,
  disabled,
  triggerLabel,
  emptyHint,
}: SkillsPickerProps) {
  // Options include installed skills plus any selected-but-not-installed
  // names so the checkbox state stays consistent with the chip row.
  const installedNames = new Set(installed.map((s) => s.name));
  const options: MultiSelectDropdownOption[] = [
    ...installed.map((s) => ({ value: s.name, label: `/${s.name}` })),
    ...selected
      .filter((name) => !installedNames.has(name))
      .map((name) => ({ value: name, label: `/${name}` })),
  ];

  const removeSkill = (name: string) => {
    onChange(selected.filter((s) => s !== name));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <MultiSelectDropdown
          values={selected}
          options={options}
          onChange={onChange}
          icon={PuzzlePieceIcon}
          label={triggerLabel}
          disabled={disabled}
        />
        {installed.length === 0 && (
          <span className="text-xs text-low">{emptyHint}</span>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-secondary px-2 py-0.5 text-xs font-mono text-normal"
            >
              /{name}
              <button
                type="button"
                onClick={() => removeSkill(name)}
                disabled={disabled}
                aria-label={`Remove ${name}`}
                className="rounded-full p-0.5 text-low hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
              >
                <XIcon className="h-3 w-3" weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
