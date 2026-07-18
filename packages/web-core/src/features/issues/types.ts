// TODO: reemplazar por el tipo generado en shared/types cuando el
// backend de issues esté mergeado.
export type IssueState = 'open' | 'closed';

export interface ProjectIssue {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  author: string;
  updated_at: string;
  synced_at: string;
}
