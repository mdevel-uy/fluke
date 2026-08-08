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

/**
 * Neutral schema so tasks and PRs share the same columns — Excel/Sheets
 * open the file as one aligned table, safe to hand to a CTO. Extra
 * fields (worker id / target branch, task with no URL) collapse into
 * the same `Extra` / `URL` slots rather than shifting row layout.
 */
const CSV_HEADER = [
  'Type',
  'Status',
  'Title',
  'Reference',
  'Extra',
  'Completed/Merged at (UTC)',
  'URL',
  'API cost (USD)',
  'Input tokens',
  'Output tokens',
  'Cache creation tokens',
  'Cache read tokens',
];

function taskRow(t: PilotReportTask): (string | number | null)[] {
  return [
    'task',
    t.status,
    t.title,
    t.issue_number,
    t.worker_id,
    t.completed_at,
    '',
    t.cost_usd,
    t.input_tokens,
    t.output_tokens,
    t.cache_creation_tokens,
    t.cache_read_tokens,
  ];
}

function prRow(p: PilotReportMergedPr): (string | number | null)[] {
  return [
    'pr',
    'merged',
    `PR #${p.pr_number}`,
    p.pr_number,
    p.target_branch_name,
    p.merged_at,
    p.pr_url,
    // PRs don't carry executor usage — leave the cost/token columns
    // blank so the row aligns with the task rows in the same table.
    null,
    null,
    null,
    null,
    null,
  ];
}

/**
 * Build a single CSV containing both worker tasks and merged PRs from
 * the window — one file per pilot period, ordered newest-first.
 */
export function buildPilotReportCsv(data: PilotReportData): string {
  const rows: (string | number | null)[][] = [CSV_HEADER];
  for (const t of data.completed_tasks) rows.push(taskRow(t));
  for (const p of data.merged_prs) rows.push(prRow(p));
  return toCsv(rows);
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
