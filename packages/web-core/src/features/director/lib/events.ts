/**
 * Fluke's standing conversation (J0.3): the app writes batches of events
 * into it as user messages starting with `[EVENTS]`, and Fluke answers
 * `SILENT` when nothing deserves the user's attention. Same constants as
 * `services::director` in the backend.
 */
export const EVENTS_PREFIX = '[EVENTS]';
export const SILENT_REPLY = 'SILENT';

export const isEventsBatch = (content: string) =>
  content.startsWith(EVENTS_PREFIX);

export const isSilentReply = (content: string) =>
  content.trim() === SILENT_REPLY;

/** The event lines of a batch, without the header. */
export const eventLines = (content: string) =>
  content
    .slice(EVENTS_PREFIX.length)
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter(Boolean);
