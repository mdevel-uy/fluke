// Cleanup scripts se ocultan de la UI: el lint corre en CI y el follow-up
// lo maneja el loop de agentes. El backend queda intacto (upstream); para
// re-habilitar la feature alcanza con poner este flag en true.
export const CLEANUP_SCRIPT_UI = false;
