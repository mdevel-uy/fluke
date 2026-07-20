/**
 * Converts SCREAMING_SNAKE_CASE to "Pretty Case"
 * @param value - The string to convert
 * @returns Formatted string with proper capitalization
 */
export const toPrettyCase = (value: string): string => {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Generates a pretty project name from a file path
 * Converts directory names like "my-awesome-project" to "My Awesome Project"
 * @param path - The file path to extract name from
 * @returns Formatted project name
 */
export const generateProjectNameFromPath = (path: string): string => {
  const dirName = path.split('/').filter(Boolean).pop() || '';
  return dirName.replace(/[-_]/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
};

/**
 * Removes a single trailing newline sequence from a string.
 * Handles CRLF/CR/LF endings while leaving other trailing whitespace intact.
 */
export const stripLineEnding = (value: string): string => {
  return value.replace(/(?:\r\n|\r|\n)$/, '');
};

/**
 * Splits a string by newlines and returns an array of lines.
 * Handles CRLF, CR, and LF line endings.
 */
export const splitLines = (value: string): string[] => {
  return value.split(/\r\n|\r|\n/);
};

const SYSTEM_PREAMBLE_START = '[SYSTEM BASE INSTRUCTIONS';
const WORKER_SOUL_MARKER = '[WORKER SOUL]';
const SECTION_SEPARATOR = '\n---\n';
const FINAL_INSTRUCTION_PREFIX = '\n\n---\n\nWhen you finish the work above';

/**
 * Strips the system-injected preamble (base instructions + worker soul) from a
 * prompt, returning only the actual task content. If no preamble is detected the
 * message is returned unchanged.
 */
export function stripSystemPreamble(message: string): string {
  if (!message.startsWith(SYSTEM_PREAMBLE_START)) {
    return message;
  }

  const soulIdx = message.indexOf(WORKER_SOUL_MARKER);
  if (soulIdx === -1) {
    return message;
  }

  const separatorAfterSoul = message.indexOf(
    SECTION_SEPARATOR,
    soulIdx + WORKER_SOUL_MARKER.length
  );
  if (separatorAfterSoul === -1) {
    return message;
  }

  let taskContent = message
    .slice(separatorAfterSoul + SECTION_SEPARATOR.length)
    .trim();

  // Strip the final automation instruction appended after the task prompt
  const finalIdx = taskContent.indexOf(FINAL_INSTRUCTION_PREFIX);
  if (finalIdx !== -1) {
    taskContent = taskContent.slice(0, finalIdx).trim();
  }

  return taskContent;
}

/**
 * Splits a message into title (max 100 chars) and description.
 * - First line becomes the title (truncated at word boundary if > 100 chars)
 * - Overflow from first line + remaining lines become description
 */
export function splitMessageToTitleDescription(message: string): {
  title: string;
  description: string | null;
} {
  const trimmed = message.trim();
  const lines = trimmed.split('\n');
  const firstLine = lines[0];
  const restOfLines = lines.slice(1).join('\n').trim();

  if (firstLine.length <= 100) {
    return {
      title: firstLine,
      description: restOfLines || null,
    };
  }

  // Find word boundary in first 100 chars
  const truncated = firstLine.substring(0, 100);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > 50) {
    // Split at word boundary (if at least half the title is preserved)
    const title = truncated.substring(0, lastSpace);
    const overflow = firstLine.substring(lastSpace + 1);
    return {
      title,
      description: restOfLines ? `${overflow}\n\n${restOfLines}` : overflow,
    };
  }

  // Fall back to character split
  const overflow = firstLine.substring(100);
  return {
    title: truncated,
    description: restOfLines ? `${overflow}\n\n${restOfLines}` : overflow,
  };
}
