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
   nuevo. Si tu rama local tiene un nombre distinto al de la rama del PR,
   git te lo va a decir al pushear: usá `git push origin HEAD:<rama-del-PR>`
   (la rama del PR es el upstream de tu rama). Verificá el push con
   git log origin/<rama-del-PR>.
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
   nuevo. Si tu rama local tiene un nombre distinto al de la rama del PR,
   usá `git push origin HEAD:<rama-del-PR>` (la rama del PR es el upstream
   de tu rama). Verificá el push con `git log origin/<rama-del-PR>`.
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
   nuevo. Si tu rama local tiene un nombre distinto al de la rama del PR,
   usá `git push origin HEAD:<rama-del-PR>` (la rama del PR es el upstream
   de tu rama). Verificá el push con `git log origin/<rama-del-PR>`.
5. Después del push, seguí el CI con `gh pr checks {pr_number} --watch`.
   Si vuelve a fallar, iterá — no reportes la tarea como terminada hasta
   que los checks queden en verde."#;

/// Dispatched by `worker_orchestrator::dispatch_review_task` when handing a
/// PR to a reviewer worker. Needs `{pr_number}` and `{head_sha}` — the SHA
/// pinned at dispatch time, which is the commit the eventual server-side
/// submission will tie its verdict to.
///
/// Reviewer contract (REVIEW-LOOP-SPEC §A1/A2):
/// - The agent must NOT run `gh pr review`, `gh pr checkout`, `gh pr diff`
///   or any other GitHub-network command; the server owns those.
/// - The system already materialized the worktree anchored on the pinned
///   `head_sha` — NOT the current tip of `pull/N/head` — via
///   `LocalContainerService::with_pr_head_starting_points`, which pulls the
///   pinned SHA out of the `ReviewRound` bound to this task and passes it to
///   `GitService::fetch_pr_head`. The invariant is enforced at the git
///   layer (`fetch_pr_head` errors if the pinned SHA is unreachable after
///   the fetch) so an author push between dispatch and materialization
///   cannot silently desync the reviewed commit from the commit the
///   verdict is submitted against.
/// - Verdict goes to `.vk/review.json` at the worktree root; the
///   orchestrator parses, validates, and submits the review via the GitHub
///   API using the reviewer worker's PAT.
/// - Invalid or missing JSON → task fails, ronda no cuenta.
pub fn format_review_pr_prompt(pr_number: i64, head_sha: &str) -> String {
    format!(
        "Revisá el PR #{pr_number} (commit `{head_sha}`) según tu checklist.\n\
         \n\
         1. Tu worktree ya está posicionado sobre `{head_sha}` — el sistema \
            hizo el fetch y el checkout por vos al materializar el workspace, \
            así que trabajás sobre exactamente el commit que el sistema va a \
            usar para someter el veredicto. NO uses `gh pr checkout`, \
            `gh pr view`, `gh pr diff` ni `gh pr review`: todo va por git \
            local; el sistema somete la review por vos.\n\
         2. Mirá el diff contra la rama base con \
            `git diff $(git merge-base HEAD {head_sha}) {head_sha}` \
            (o directamente `git log --stat {head_sha}` para el resumen).\n\
         3. Escribí tu veredicto en `.vk/review.json` con este esquema exacto:\n\
         \n\
         ```json\n\
         {{\n\
           \"verdict\": \"approve\" | \"request_changes\",\n\
           \"summary\": \"resumen del veredicto (2-5 líneas, va al body de la review)\",\n\
           \"items\": [\n\
             {{\n\
               \"path\": \"crates/services/src/foo.rs\",  // opcional; sin path/line va al body\n\
               \"line\": 42,                              // opcional; requiere path\n\
               \"severity\": \"blocker|major|minor|nit\", // opcional\n\
               \"comment\": \"texto del comentario\"\n\
             }}\n\
           ]\n\
         }}\n\
         ```\n\
         \n\
         Reglas del schema:\n\
         - `items` es opcional con `approve` y obligatorio (≥1) con `request_changes`.\n\
         - Cada item que apunte a una línea debe traer `path`; sin `path` el comentario \
           va al body de la review (no inline).\n\
         - `line` sólo sirve si esa línea aparece en el diff del PR (líneas nuevas o \
           de contexto de los hunks). GitHub rechaza comments inline fuera del diff, \
           así que si tu comentario refiere a código que el PR no toca (otro archivo, \
           una línea vieja), omití `line` — o directamente `path` — y explicá la \
           ubicación en el texto del comentario: irá al body de la review.\n\
         - Escribí el archivo en la raíz del worktree (donde vive `.git`), \
           no en un subdirectorio.\n\
         - JSON inválido o `.vk/review.json` ausente = task fallada, la ronda no cuenta.\n\
         \n\
         Terminá dejando SOLO ese archivo escrito — nada de commits, pushes ni PRs. \
         El sistema toma el archivo, valida el schema, arma la review y la somete a \
         GitHub con tu identidad. Si aprobás, la última actividad del PR queda tu \
         APPROVED; si pedís cambios, el sistema despacha la remediación al autor \
         automáticamente."
    )
}

/// Composed by the design-handoff endpoint when a designer's deliverable is
/// handed to an analyst. The contract is reference + fetch recipe — the
/// design content is NEVER embedded (prompts freeze at enqueue time and can
/// wait in queue; the agent fetches fresh content when it starts).
pub fn format_design_handoff_prompt(
    origin_title: &str,
    issue_number: Option<i64>,
    deliverable_ref: Option<&str>,
    summary: Option<&str>,
    note: Option<&str>,
) -> String {
    let mut prompt = match issue_number {
        Some(n) => format!("Un designer produjo un diseño para el pedido #{n}: {origin_title}."),
        None => format!("Un designer produjo un diseño para: {origin_title}."),
    };

    if let Some(summary) = summary.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str(&format!("\n\nResumen del designer:\n«{summary}»"));
    }

    if let Some(ref_name) = deliverable_ref {
        prompt.push_str(&format!(
            "\n\nEl diseño está en la ref remota `{ref_name}`:\n\
             1. Traelo con `git fetch origin {ref_name}`.\n\
             2. Mirá qué contiene con `git diff --stat $(git merge-base HEAD FETCH_HEAD) FETCH_HEAD` \
             y revisá los archivos que agregó (los diseños suelen vivir en `design/`); \
             traé lo que necesites a tu worktree con `git checkout FETCH_HEAD -- <ruta>`."
        ));
    }

    prompt.push_str(
        "\n\nConvertí el diseño en issues de GitHub implementables y bien \
         delimitados, siguiendo tu criterio habitual de tickets asignables.",
    );
    if let Some(ref_name) = deliverable_ref {
        prompt.push_str(&format!(
            " Cada issue debe referenciar la ref `{ref_name}` y la parte del \
             diseño que cubre."
        ));
    }

    if let Some(note) = note.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str(&format!("\n\nIndicaciones del PM:\n{note}"));
    }

    prompt
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
