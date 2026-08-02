import type {
  PilotReportData,
  PilotReportMergedPr,
  PilotReportTask,
} from './usePilotReport';

/**
 * Client-side CSV export. Kept off the server because it saves a Rust
 * dep and lets the browser download without leaving the page.
 */

function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Quote anything with a comma, quote, newline, or leading/trailing space.
  if (/[",\n\r]|^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows: (string | number | null | undefined)[][]): string {
  return (
    rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n'
  );
}

function taskRows(tasks: PilotReportTask[]): (string | number | null)[][] {
  const header = [
    'Type',
    'Status',
    'Title',
    'Issue',
    'Worker ID',
    'Completed at (UTC)',
  ];
  const rows: (string | number | null)[][] = [header];
  for (const t of tasks) {
    rows.push([
      'task',
      t.status,
      t.title,
      t.issue_number,
      t.worker_id,
      t.completed_at,
    ]);
  }
  return rows;
}

function prRows(prs: PilotReportMergedPr[]): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  for (const p of prs) {
    rows.push([
      'pr',
      'merged',
      `PR #${p.pr_number}`,
      p.pr_number,
      p.target_branch_name,
      p.merged_at,
      p.pr_url,
    ]);
  }
  return rows;
}

/**
 * Build a single CSV containing both worker tasks and merged PRs from
 * the window — one file per pilot period, ordered newest-first.
 */
export function buildPilotReportCsv(data: PilotReportData): string {
  const tasks = taskRows(data.completed_tasks);
  const prs = prRows(data.merged_prs);
  const allRows = [...tasks, ...prs];
  return toCsv(allRows);
}

/** Convenience filename: `pilot-report-YYYY-MM-DD_YYYY-MM-DD.csv`. */
export function buildPilotReportFilename(from: Date, to: Date): string {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return `pilot-report-${iso(from)}_${iso(to)}.csv`;
}

/**
 * Trigger a download of the CSV in the browser. Wrapped so the page
 * doesn't juggle DOM plumbing itself.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
