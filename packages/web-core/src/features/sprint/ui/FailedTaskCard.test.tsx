import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerTask } from '@/features/sprint/types';
import { FailedTaskCard } from './FailedTaskCard';

// The card is rendered to static markup in the node environment (no DOM), so
// everything that needs providers or the network is stubbed out.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@vibe/ui/components/MaterialIcon', () => ({
  MaterialIcon: () => null,
}));
vi.mock('@vibe/ui/components/Button', () => ({
  Button: ({ children }: { children?: unknown }) => <button>{children as never}</button>,
}));
vi.mock('./AgentActionsSection', () => ({ AgentActionsSection: () => null }));
vi.mock('./SkillChips', () => ({ SkillChips: () => null }));

function failedTask(failureReason: string | null | undefined): WorkerTask {
  return {
    id: 'task-1',
    worker_id: 'worker-1',
    title: '#777 Implementar advanced settings colapsable en la tarjeta de provider',
    issue_number: 777,
    status: 'failed',
    skills: [],
    pr_url: null,
    failure_reason: failureReason,
  } as unknown as WorkerTask;
}

function render(task: WorkerTask): string {
  return renderToStaticMarkup(
    <FailedTaskCard
      task={task}
      isBusy={false}
      onRetry={() => {}}
      onDiscard={() => {}}
    />
  );
}

// Text a user can read on the card: markup without tags, so attribute values
// (tooltips) are not counted as visible text.
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('FailedTaskCard failure reason', () => {
  it('shows a short failure reason on the card, with the full text as tooltip', () => {
    const reason = 'El agente terminó con error: cargo test falló en provider_card';
    const html = render(failedTask(reason));

    expect(visibleText(html)).toContain(reason);
    expect(html).toContain(`title="${reason}"`);
  });

  it('bounds a long failure reason and keeps the full text reachable in the tooltip', () => {
    const reason = `Error: ${'a'.repeat(1200)} FINAL_MARKER`;
    const html = render(failedTask(reason));
    const text = visibleText(html);

    expect(text).toContain('Error: aaa');
    expect(text).not.toContain('FINAL_MARKER');
    expect(text.length).toBeLessThan(600);
    expect(html).toContain(reason);
  });

  it.each([null, undefined, '', '   \n  '])(
    'does not break or print placeholders when the reason is %j',
    (reason) => {
      const html = render(failedTask(reason));
      const text = visibleText(html);

      expect(text).toContain('Implementar advanced settings');
      expect(text).not.toMatch(/\b(null|undefined)\b/);
      expect(html).not.toMatch(/title="\s*"/);
    }
  );
});
