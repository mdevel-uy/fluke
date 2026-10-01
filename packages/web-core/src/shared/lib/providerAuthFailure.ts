// Failure reasons that mean "the agent's provider is not usable": the
// orchestrator's start gate ("El proveedor X no está conectado", see
// worker_orchestrator.rs) and the CLI's auth errors (a revoked or invalid
// credential, e.g. Claude's 401 "OAuth access token has been revoked").
const PATTERNS = [
  'no está conectado',
  'not connected',
  'oauth token',
  'authentication_error',
  'authentication_failed',
  'invalid api key',
  'error de api (401)',
];

export function isProviderAuthFailure(
  reason: string | null | undefined
): boolean {
  const lowered = reason?.toLowerCase() ?? '';
  return PATTERNS.some((p) => lowered.includes(p));
}
