//! Prompt templates used to dispatch quick-action follow-ups to a workspace
//! agent (Address PR comments, Fix CI, Fix merge conflicts) and to dispatch
//! reviewer tasks. Centralised here so the copy stays consistent across the
//! agent-driven path (`worker_orchestrator`) and the UI-driven path
//! (`server::routes::workspaces::pr`).
//!
//! Placeholders are plain `{name}` tokens replaced with `.replace(...)` — no
//! templating engine.

/// Dispatched by the "Fix merge conflicts" quick action / when `pr_monitor`
/// detects a PR whose mergeable state flipped to `conflicting`. Needs
/// `{target_branch}`.
pub const RESOLVE_MERGE_CONFLICTS_PROMPT: &str = r#"Tu PR tiene conflictos de merge con {target_branch}. Resolvelos ahora:

1. git fetch origin && git merge origin/{target_branch}
   (merge REAL con ancestría — nunca resuelvas copiando contenido a mano
   en un commit normal, y nunca uses squash para esto).
2. Criterio de resolución: {target_branch} manda para todo lo que otros
   mergearon (design system, features ajenas); tu rama manda para TU
   feature. Ante solapamiento directo, combiná ambos lados — no pierdas
   ninguno. En los locales de i18n conservá los dos grupos de keys y
   validá que el JSON quede bien formado.
3. Verificá el build/typecheck que corresponda (pnpm run check) antes de
   pushear.
4. Pusheá a ESTA misma rama (actualiza el PR existente). NO crees un PR
   nuevo. Verificá el push con git log origin/<rama>.
5. Mirá el CI del PR con gh pr checks --watch y arreglá lo que falle."#;

/// Dispatched by the "Address PR comments" quick action. Needs `{pr_number}`
/// and `{pr_url}`.
pub const ADDRESS_PR_COMMENTS_PROMPT: &str = r#"Tu PR #{pr_number} ({pr_url}) tiene comentarios de review pendientes. Encaralos ahora:

1. Leé la conversación completa con `gh pr view {pr_number} --comments` y los
   comentarios inline con `gh api repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments`
   (reemplazá owner/repo por los reales o usá el URL directo).
2. Agrupá los comentarios por archivo/tema. Diferenciá pedidos accionables
   de simples preguntas: los accionables se implementan; a las preguntas
   respondelas en el PR (`gh pr comment {pr_number} -b '<respuesta>'`) sin
   tocar código si no hace falta.
3. Aplicá los cambios en tu rama, corré el build/typecheck (`pnpm run check`
   o `cargo check` según corresponda) y ejecutá los tests que toquen las
   zonas modificadas.
4. Pusheá a ESTA misma rama (actualiza el PR existente). NO crees un PR
   nuevo. Verificá el push con `git log origin/<rama>`.
5. Cuando termines, dejá un comentario resumen en el PR listando qué
   pedidos atendiste y cuáles quedaron abiertos con su razón, para que el
   reviewer pueda re-revisar rápido."#;

/// Dispatched by the "Fix CI" quick action. Needs `{pr_number}` and
/// `{pr_url}`.
pub const FIX_CI_PROMPT: &str = r#"El CI del PR #{pr_number} ({pr_url}) está fallando. Arreglá los checks:

1. Mirá el estado con `gh pr checks {pr_number}`. Para cada check que
   falle, abrí el log completo con `gh run view --log-failed --job <job_id>`
   (o `gh run view <run_id> --log-failed` si venís del run) e identificá
   el error real — no adivines por el nombre del step.
2. Diagnosticá la causa raíz antes de tocar código: ¿es un test flaky, un
   error de tipos, lint, build, migración de DB, formato? Fijá la
   hipótesis y solo después editá archivos.
3. Reproducí localmente lo que corre el CI cuando sea posible
   (`pnpm run check`, `pnpm run lint`, `cargo check`, `cargo test`, etc.)
   para validar el fix antes de pushear.
4. Pusheá a ESTA misma rama (actualiza el PR existente). NO crees un PR
   nuevo. Verificá el push con `git log origin/<rama>`.
5. Después del push, seguí el CI con `gh pr checks {pr_number} --watch`.
   Si vuelve a fallar, iterá — no reportes la tarea como terminada hasta
   que los checks queden en verde."#;

/// Dispatched by `worker_orchestrator::dispatch_review_task` when handing a
/// PR to a reviewer worker. Needs `{pr_number}`.
pub fn format_review_pr_prompt(pr_number: i64) -> String {
    format!(
        "Revisá el PR #{pr_number} según tu checklist. \
         Usá `gh pr view {pr_number}`, `gh pr diff {pr_number}` y \
         `gh pr checkout {pr_number}` para examinar los cambios. \
         Cuando termines: si aprobás, ejecutá \
         `gh pr review {pr_number} --approve`; si pedís cambios, ejecutá \
         `gh pr review {pr_number} --request-changes -b '<razón>'`."
    )
}

/// Substitute `{target_branch}` into [`RESOLVE_MERGE_CONFLICTS_PROMPT`].
pub fn format_resolve_merge_conflicts_prompt(target_branch: &str) -> String {
    RESOLVE_MERGE_CONFLICTS_PROMPT.replace("{target_branch}", target_branch)
}

/// Substitute `{pr_number}` and `{pr_url}` into [`ADDRESS_PR_COMMENTS_PROMPT`].
pub fn format_address_pr_comments_prompt(pr_number: i64, pr_url: &str) -> String {
    ADDRESS_PR_COMMENTS_PROMPT
        .replace("{pr_number}", &pr_number.to_string())
        .replace("{pr_url}", pr_url)
}

/// Substitute `{pr_number}` and `{pr_url}` into [`FIX_CI_PROMPT`].
pub fn format_fix_ci_prompt(pr_number: i64, pr_url: &str) -> String {
    FIX_CI_PROMPT
        .replace("{pr_number}", &pr_number.to_string())
        .replace("{pr_url}", pr_url)
}
