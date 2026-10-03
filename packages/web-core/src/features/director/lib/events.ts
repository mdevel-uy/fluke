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

/**
 * Every message to Fluke starts with a `<fluke-context>` block (screen and
 * app status for that turn, J0.1): written by the app, never shown.
 */
const CONTEXT_BLOCK = /^\s*<fluke-context>[\s\S]*?<\/fluke-context>\s*/;

export const stripFlukeContext = (content: string) =>
  content.replace(CONTEXT_BLOCK, '');
