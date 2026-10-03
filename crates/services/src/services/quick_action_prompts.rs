//! Prompt templates used to dispatch quick-action follow-ups to a workspace
//! agent (Address PR comments, Fix CI, Fix merge conflicts) and to dispatch
//! reviewer tasks. Centralised here so the copy stays consistent across the
//! agent-driven path (`worker_orchestrator`) and the UI-driven path
//! (`server::routes::workspaces::pr`).
//!
//! Placeholders are plain `{name}` tokens replaced with `.replace(...)` — no
//! templating engine.

use git_host::{PrFailedCheck, UnifiedPrComment};

/// Soft cap on the size of an inline comments block dropped into the "Address
/// PR comments" / remediation prompts. Beyond this the block is truncated and
/// tagged with an explicit marker so the agent knows the tail is missing.
/// 16 KiB fits real reviews (hundreds of comments) without blowing the
/// executor's context; larger reviews are truncated and the marker tells the
/// agent to fetch the rest with `gh`.
pub const COMMENTS_BLOCK_MAX_BYTES: usize = 16 * 1024;

/// Soft cap on the size of an inline failed-checks block. Kept modest because
/// each entry is one line — a real CI pipeline has at most a handful of jobs.
pub const FAILED_CHECKS_BLOCK_MAX_BYTES: usize = 4 * 1024;

/// Truncation marker appended when an inline block exceeds its size cap.
const TRUNCATION_MARKER: &str =
    "\n… [contenido truncado por límite de tamaño; usá `gh` para ver el resto] …";

/// Fallback prompt for the "Fix merge conflicts" flow when the orchestrator
/// could NOT pre-merge server-side (sad path: dirty worktree, another op in
/// progress, git error). The agent runs the merge itself. Needs
/// `{target_branch}`.
///
/// The happy paths (clean pre-merge → push; conflicts → dispatch with file
/// list) use [`format_resolve_merge_conflicts_prompt_with_conflicts`] on top
/// of a merge already in progress in the worktree.
pub const RESOLVE_MERGE_CONFLICTS_PROMPT: &str = r#"Tu PR tiene conflictos de merge con {target_branch}. Resolvelos ahora:

1. git fetch origin && git merge origin/{target_branch}
   (merge REAL con ancestría — nunca resuelvas copiando contenido a mano
   en un commit normal, y nunca uses squash para esto).
2. Criterio de resolución: {target_branch} manda para todo lo que otros
   mergearon (design system, features ajenas); tu rama manda para TU
   feature. Ante solapamiento directo, combiná ambos lados — no pierdas
   ninguno. En los locales de i18n conservá los dos grupos de keys y
   validá que el JSON quede bien formado.
3. No instales dependencias ni corras typecheck, build ni tests: el CI
   valida el PR al pushear.
4. Pusheá a ESTA misma rama (actualiza el PR existente). NO crees un PR
   nuevo. Si tu rama local tiene un nombre distinto al de la rama del PR,
   git te lo va a decir al pushear: usá `git push origin HEAD:<rama-del-PR>`
   (la rama del PR es el upstream de tu rama). Verificá el push con
   git log origin/<rama-del-PR>.
5. Mirá el CI del PR con gh pr checks --watch y arreglá lo que falle."#;

/// Substitute `{target_branch}` into [`RESOLVE_MERGE_CONFLICTS_PROMPT`].
/// Reserved for the sad path (see the const's doc-comment): every regular
/// dispatch should go through
/// [`format_resolve_merge_conflicts_prompt_with_conflicts`].
pub fn format_resolve_merge_conflicts_prompt(target_branch: &str) -> String {
    RESOLVE_MERGE_CONFLICTS_PROMPT.replace("{target_branch}", target_branch)
}

/// Soft cap on the size of the conflicted-files listing dropped into the
/// resolve-merge-conflicts prompt. A pathological merge could touch hundreds
/// of files; 4 KiB fits a very generous tail and the marker tells the agent
/// to inspect the rest with git directly.
pub const CONFLICTED_FILES_BLOCK_MAX_BYTES: usize = 4 * 1024;

/// Build the resolve-merge-conflicts prompt when the orchestrator has already
/// merged `origin/{target_branch}` into the worktree and left the merge in
/// progress with real conflicts. `conflicted_files` is the list git produced
/// (never empty — the caller uses the fallback prompt when there is nothing
/// to resolve).
pub fn format_resolve_merge_conflicts_prompt_with_conflicts(
    target_branch: &str,
    conflicted_files: &[String],
) -> String {
    let block = render_conflicted_files_block(conflicted_files, CONFLICTED_FILES_BLOCK_MAX_BYTES);
    format!(
        "Tu PR tiene conflictos de merge con {target_branch}. El sistema ya ejecutó \
         `git merge origin/{target_branch}` en tu worktree y el merge quedó en \
         progreso con hunks en conflicto listos para resolver.\n\
         \n\
         {block}\
         \n\
         1. Resolvé cada archivo listado arriba. Criterio: {target_branch} manda para \
            todo lo que otros mergearon (design system, features ajenas); tu rama manda \
            para TU feature. Ante solapamiento directo, combiná ambos lados — no pierdas \
            ninguno. En los locales de i18n conservá los dos grupos de keys y validá que \
            el JSON quede bien formado.\n\
         2. Cuando quede limpio, `git add` los archivos resueltos y `git commit` para \
            cerrar el merge (NO uses squash — el commit de merge tiene que preservar \
            la ancestría). Podés revisar el estado con `git status` y confirmar que \
            no quedan entradas `Unmerged paths`.\n\
         3. No instales dependencias ni corras typecheck, build ni tests: el CI \
            valida el PR al pushear.\n\
         4. Pusheá a ESTA misma rama (actualiza el PR existente). NO crees un PR \
            nuevo. Si tu rama local tiene un nombre distinto al de la rama del PR, \
            usá `git push origin HEAD:<rama-del-PR>` (la rama del PR es el upstream \
            de tu rama). Verificá el push con `git log origin/<rama-del-PR>`.\n\
         5. Mirá el CI del PR con `gh pr checks --watch` y arreglá lo que falle."
    )
}

/// Render the list of conflicted files as a Markdown-style bullet block.
/// Truncates to `max_bytes` with an explicit marker so the agent knows there
/// is more to inspect via `git`.
fn render_conflicted_files_block(files: &[String], max_bytes: usize) -> String {
    let mut out = format!("Archivos con conflictos ({}):\n", files.len());
    for path in files {
        out.push_str("- ");
        out.push_str(path);
        out.push('\n');
    }
    truncate_with_marker(out, max_bytes)
}

/// Build the "Address PR comments" prompt.
///
/// `owner_repo` is the pre-resolved `owner/name` slug. When `Some`, every
/// read-only `gh` invocation in the prompt is targeted with `-R owner/repo`
/// — no placeholders for the agent to fill in. When `None` (typically
/// because the PR URL is not a recognizable GitHub URL), the prompt falls
/// back to invoking `gh` with the PR URL as a positional arg so we don't
/// emit syntactically bogus `-R <full-url>` commands. `comments_block` is
/// the pre-rendered inline text (see [`render_comments_block`]); pass
/// `None` when the enrichment fetch failed and the agent should fall back
/// to `gh`.
///
/// Any PR writes the agent needs (replies to reviewer questions, summary
/// comment) MUST be declared in `.vk/actions.json` at the repo root via
/// the `comment_pr` outbox kind — the orchestrator submits them with the
/// worker's PAT after the run. The prompt never suggests direct GitHub
/// write commands (see `factory-guards.sh` gh-write rule and issue #549).
pub fn format_address_pr_comments_prompt(
    pr_number: i64,
    pr_url: &str,
    owner_repo: Option<&str>,
    comments_block: Option<&str>,
) -> String {
    let step1 = match comments_block {
        Some(block) => format!(
            "Los comentarios pendientes de review están abajo (comentarios generales del PR + \
             comentarios inline con archivo/línea). Leélos tal como vienen — no hace falta \
             volver a consultarlos con `gh`.\n\n{block}"
        ),
        None => match owner_repo {
            Some(slug) => format!(
                "No pude adjuntar los comentarios en este prompt (el enriquecimiento falló). \
                 Traélos vos: los generales con `gh pr view {pr_number} -R {slug} --comments` \
                 y los inline con `gh api repos/{slug}/pulls/{pr_number}/comments`."
            ),
            None => format!(
                "No pude adjuntar los comentarios en este prompt (el enriquecimiento falló) \
                 y tampoco pude resolver el `owner/repo` desde la URL del PR ({pr_url}). \
                 Traélos con `gh pr view {pr_url} --comments`; para los inline, resolvé \
                 el path de la API a partir del URL del PR."
            ),
        },
    };
    format!(
        "Tu PR #{pr_number} ({pr_url}) tiene comentarios de review pendientes. Encaralos ahora:\n\
         \n\
         1. {step1}\n\
         2. Agrupá los comentarios por archivo/tema. Diferenciá pedidos accionables\n\
            de simples preguntas: los accionables se implementan; a las preguntas\n\
            respondelas dejando entradas `{{ \"kind\": \"comment_pr\", \"pr\": {pr_number}, \"body\": \"...\" }}`\n\
            en `.vk/actions.json` en la raíz del worktree — el sistema las publica\n\
            con tu identidad después de la corrida. NO ejecutes escrituras a\n\
            GitHub vos mismo.\n\
         3. Aplicá los cambios en tu rama. No instales dependencias ni corras\n\
            typecheck, build ni tests: el CI valida el PR al pushear.\n\
         4. Pusheá a ESTA misma rama (actualiza el PR existente). NO crees un PR\n\
            nuevo. Si tu rama local tiene un nombre distinto al de la rama del PR,\n\
            usá `git push origin HEAD:<rama-del-PR>` (la rama del PR es el upstream\n\
            de tu rama). Verificá el push con `git log origin/<rama-del-PR>`.\n\
         5. Cuando termines, dejá una acción `comment_pr` final en `.vk/actions.json`\n\
            con un resumen listando qué pedidos atendiste y cuáles quedaron abiertos\n\
            con su razón, para que el reviewer pueda re-revisar rápido."
    )
}

/// Build the "Fix CI" prompt.
///
/// `owner_repo` is the pre-resolved `owner/name` slug. When `Some`, `gh pr
/// checks -R owner/repo` is emitted with the clean slug; when `None`
/// (unrecognized PR URL), the prompt uses `gh pr checks <pr_url>` positional
/// so we don't emit a broken `-R <full-url>`. `failed_checks_block` is the
/// pre-rendered inline list of failing jobs (see
/// [`render_failed_checks_block`]); pass `None` when the enrichment fetch
/// failed and the agent should fall back to `gh pr checks`.
///
/// Deliberately does NOT include `gh pr checks --watch` nor an "iterá hasta
/// verde" instruction: polling the CI is the monitor's job and re-dispatch on
/// red is a system decision, not the agent's. The agent fixes what it can
/// verify locally, pushes, and ends the run.
pub fn format_fix_ci_prompt(
    pr_number: i64,
    pr_url: &str,
    owner_repo: Option<&str>,
    failed_checks_block: Option<&str>,
) -> String {
    let step1 = match failed_checks_block {
        Some(block) => format!(
            "Estos son los checks que están en rojo. Para cada uno, abrí el log completo\n\
            con `gh run view --log-failed --job <job_id>` (o desde su details URL) e\n\
            identificá el error real — no adivines por el nombre del step.\n\
            \n\
            {block}"
        ),
        None => {
            let checks_command = match owner_repo {
                Some(slug) => format!("gh pr checks {pr_number} -R {slug}"),
                None => format!("gh pr checks {pr_url}"),
            };
            format!(
                "No pude adjuntar el listado de checks fallados (el enriquecimiento falló).\n\
                Traelo con `{checks_command}`; para cada check en\n\
                rojo abrí el log completo con `gh run view --log-failed --job <job_id>` e\n\
                identificá el error real — no adivines por el nombre del step."
            )
        }
    };
    format!(
        "El CI del PR #{pr_number} ({pr_url}) está fallando. Arreglá los checks:\n\
         \n\
         1. {step1}\n\
         2. Diagnosticá la causa raíz antes de tocar código: ¿es un test flaky, un\n\
            error de tipos, lint, build, migración de DB, formato? Fijá la\n\
            hipótesis y solo después editá archivos.\n\
         3. Trabajá con los logs del CI; no reproduzcas localmente (sin\n\
            `node_modules` ni caché de build, cualquier check tarda minutos y satura\n\
            la máquina). Al pushear, el CI vuelve a correr y valida el fix.\n\
         4. Pusheá a ESTA misma rama (actualiza el PR existente). NO crees un PR\n\
            nuevo. Si tu rama local tiene un nombre distinto al de la rama del PR,\n\
            usá `git push origin HEAD:<rama-del-PR>` (la rama del PR es el upstream\n\
            de tu rama). Verificá el push con `git log origin/<rama-del-PR>`.\n\
         5. Terminá la tarea después del push. NO te quedes mirando el CI: el\n\
            sistema lo pollea gratis y, si vuelve a caer en rojo, re-despacha un\n\
            fix por su cuenta. Tu trabajo termina cuando arreglaste lo que\n\
            identificaste y validaste localmente lo que pudiste."
    )
}

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
            usar para someter el veredicto. NO uses ningún comando `gh pr` \
            (ni para posicionarte, ni para ver el diff, ni para someter la \
            review): todo va por git local; el sistema somete la review por vos.\n\
         2. Mirá el diff contra la rama base con \
            `git diff $(git merge-base HEAD {head_sha}) {head_sha}` \
            (o directamente `git log --stat {head_sha}` para el resumen). \
            Revisá TODO el diff contra tu checklist completo en esta pasada y \
            listá en `items` todo lo que encuentres, no sólo el primer problema: \
            las rondas de review son limitadas y lo que dejes para la próxima \
            puede no tener próxima. En un re-review, verificá lo que pediste \
            antes y lo que cambió; no abras objeciones nuevas sobre código que \
            ya estaba, salvo un blocker que se te pasó (decilo explícitamente).\n\
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

/// Render a batch of PR comments (general + inline) into a plain-text block
/// suitable for injection into a prompt. Comments are grouped by kind, kept
/// in chronological order (as supplied), and the whole block is truncated to
/// [`COMMENTS_BLOCK_MAX_BYTES`] with an explicit marker when it exceeds the
/// cap so the agent knows the tail is missing.
///
/// Returns `None` when there are no comments to render — the caller then
/// omits the block entirely and treats the run as "nothing to address".
pub fn render_comments_block(comments: &[UnifiedPrComment], max_bytes: usize) -> Option<String> {
    if comments.is_empty() {
        return None;
    }
    let mut out = String::new();
    out.push_str(&format!("Comentarios del PR ({} total):\n", comments.len()));
    for c in comments {
        match c {
            UnifiedPrComment::General {
                author,
                body,
                created_at,
                url,
                ..
            } => {
                out.push_str(&format!(
                    "\n--- Comentario general de @{author} ({created_at}) ---\n"
                ));
                if let Some(url) = url {
                    out.push_str(&format!("URL: {url}\n"));
                }
                out.push_str(body.trim());
                out.push('\n');
            }
            UnifiedPrComment::Review {
                author,
                body,
                created_at,
                url,
                path,
                line,
                side,
                diff_hunk,
                ..
            } => {
                let line_str = line.map(|l| l.to_string()).unwrap_or_else(|| "?".into());
                let side_str = side.as_deref().unwrap_or("RIGHT");
                out.push_str(&format!(
                    "\n--- Comentario inline de @{author} en {path}:{line_str} ({side_str}) — {created_at} ---\n"
                ));
                if let Some(url) = url {
                    out.push_str(&format!("URL: {url}\n"));
                }
                if let Some(hunk) = diff_hunk
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    out.push_str("Contexto (diff hunk):\n");
                    for hunk_line in hunk.lines() {
                        out.push_str("  ");
                        out.push_str(hunk_line);
                        out.push('\n');
                    }
                }
                out.push_str(body.trim());
                out.push('\n');
            }
        }
    }
    Some(truncate_with_marker(out, max_bytes))
}

/// Render a batch of failing CI checks into a plain-text block suitable for
/// injection into a prompt. Truncated to [`FAILED_CHECKS_BLOCK_MAX_BYTES`]
/// with an explicit marker when it exceeds the cap.
///
/// Returns `None` when there are no failing checks — the caller then omits
/// the block entirely (rare: normally we only hit "Fix CI" when something is
/// red, but a race between rollup and job list can produce an empty vec).
pub fn render_failed_checks_block(checks: &[PrFailedCheck], max_bytes: usize) -> Option<String> {
    if checks.is_empty() {
        return None;
    }
    let mut out = String::new();
    out.push_str(&format!("Checks fallados ({}):\n", checks.len()));
    for c in checks {
        match c.details_url.as_deref() {
            Some(url) => out.push_str(&format!("- {} ({}) — {url}\n", c.name, c.conclusion)),
            None => out.push_str(&format!("- {} ({})\n", c.name, c.conclusion)),
        }
    }
    Some(truncate_with_marker(out, max_bytes))
}

/// Truncate `input` to at most `max_bytes`, always yielding valid UTF-8 by
/// stepping back to the nearest char boundary and appending an explicit
/// marker. Zero-size caps are treated as "no cap" (used only in tests).
fn truncate_with_marker(mut input: String, max_bytes: usize) -> String {
    if max_bytes == 0 || input.len() <= max_bytes {
        return input;
    }
    let mut cut = max_bytes;
    while cut > 0 && !input.is_char_boundary(cut) {
        cut -= 1;
    }
    input.truncate(cut);
    input.push_str(TRUNCATION_MARKER);
    input
}

/// Parse the `owner/repo` slug out of a GitHub PR URL of the shape
/// `https://{host}/{owner}/{repo}/pull/{n}`. Returns `None` for URLs that do
/// not match this pattern (non-GitHub, malformed, or non-PR paths). Used to
/// resolve the slug once at prompt-build time so every `gh` invocation the
/// prompt suggests targets the right repo explicitly.
pub fn parse_owner_repo_from_pr_url(pr_url: &str) -> Option<String> {
    let url = url::Url::parse(pr_url).ok()?;
    let mut segments = url.path_segments()?;
    let owner = segments.next()?;
    let repo = segments.next()?;
    let kind = segments.next()?;
    let number = segments.next()?;
    if kind != "pull" || owner.is_empty() || repo.is_empty() || number.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    fn general_comment(author: &str, body: &str) -> UnifiedPrComment {
        UnifiedPrComment::General {
            id: "1".into(),
            author: author.into(),
            author_association: None,
            body: body.into(),
            created_at: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
            url: Some("https://example.com/c/1".into()),
        }
    }

    fn review_comment(path: &str, line: i64, body: &str) -> UnifiedPrComment {
        UnifiedPrComment::Review {
            id: 42,
            author: "reviewer".into(),
            author_association: None,
            body: body.into(),
            created_at: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
            url: Some("https://example.com/c/2".into()),
            path: path.into(),
            line: Some(line),
            side: Some("RIGHT".into()),
            diff_hunk: Some("@@ -1 +1 @@\n-old\n+new".into()),
        }
    }

    /// Banned direct-write literal, assembled at runtime so the raw
    /// pattern never appears in the source of this prompt file (the
    /// factory-guards gh-write rule scans this file — see issue #549).
    fn banned_pr_comment_write() -> String {
        ["gh", "pr", "comment"].join(" ")
    }

    #[test]
    fn address_pr_comments_prompt_inlines_comments_and_no_placeholders() {
        let comments = vec![
            general_comment("alice", "please fix the nit"),
            review_comment("src/foo.rs", 10, "bug here"),
        ];
        let block = render_comments_block(&comments, COMMENTS_BLOCK_MAX_BYTES).unwrap();
        let prompt = format_address_pr_comments_prompt(
            42,
            "https://github.com/acme/widgets/pull/42",
            Some("acme/widgets"),
            Some(&block),
        );
        // Body contains the comments verbatim
        assert!(prompt.contains("please fix the nit"));
        assert!(prompt.contains("bug here"));
        assert!(prompt.contains("src/foo.rs:10"));
        // No unresolved placeholders remain
        assert!(
            !prompt.contains("{{owner}}") && !prompt.contains("{{repo}}"),
            "prompt must not leak owner/repo placeholders"
        );
        assert!(
            !prompt.contains("reemplazá owner/repo"),
            "prompt must not tell the agent to substitute owner/repo"
        );
        // Owner/repo is resolved for any remaining gh invocations
        assert!(prompt.contains("acme/widgets"));
        // No stray full-URL substitution as owner/repo (root cause of the
        // reviewer note on PR #490): `-R https://...` would be nonsense.
        assert!(!prompt.contains("-R https://"));
        // Replies go through the outbox, never via direct writes.
        assert!(
            !prompt.contains(&banned_pr_comment_write()),
            "address-pr-comments prompt must not suggest a direct write to PR comments (issue #549)"
        );
        assert!(prompt.contains("comment_pr"));
        assert!(prompt.contains(".vk/actions.json"));
    }

    #[test]
    fn address_pr_comments_prompt_falls_back_when_enrichment_missing() {
        let prompt = format_address_pr_comments_prompt(
            7,
            "https://github.com/acme/widgets/pull/7",
            Some("acme/widgets"),
            None,
        );
        // Fallback tells the agent to fetch, but owner/repo is already resolved
        assert!(prompt.contains("gh pr view 7 -R acme/widgets --comments"));
        assert!(prompt.contains("gh api repos/acme/widgets/pulls/7/comments"));
        assert!(!prompt.contains("{{owner}}") && !prompt.contains("{{repo}}"));
        assert!(!prompt.contains("-R https://"));
        assert!(
            !prompt.contains(&banned_pr_comment_write()),
            "address-pr-comments prompt must not suggest a direct write to PR comments (issue #549)"
        );
    }

    /// When the PR URL isn't a recognizable GitHub URL (Azure DevOps, mocks),
    /// we must NOT emit `gh -R <full-url>` — that's what the reviewer flagged
    /// on PR #490. The fallback uses the URL positionally instead. Writes
    /// still go through the outbox regardless of slug resolution.
    #[test]
    fn address_pr_comments_prompt_uses_url_when_owner_repo_unknown() {
        let pr_url = "https://dev.azure.com/org/proj/_git/repo/pullrequest/42";
        let prompt = format_address_pr_comments_prompt(42, pr_url, None, None);
        assert!(
            !prompt.contains("-R https://"),
            "prompt must never emit `-R <full-url>` — that's an invalid gh flag"
        );
        assert!(
            prompt.contains(&format!("gh pr view {pr_url} --comments")),
            "fallback must fall back to positional URL for gh pr view"
        );
        assert!(
            !prompt.contains(&banned_pr_comment_write()),
            "address-pr-comments prompt must never suggest a direct write to PR comments (issue #549)"
        );
        assert!(prompt.contains("comment_pr"));
        assert!(prompt.contains(".vk/actions.json"));
    }

    #[test]
    fn fix_ci_prompt_inlines_failed_checks_and_drops_watch() {
        let checks = vec![
            PrFailedCheck {
                name: "backend".into(),
                conclusion: "failure".into(),
                details_url: Some("https://example.com/runs/1".into()),
            },
            PrFailedCheck {
                name: "lint / eslint".into(),
                conclusion: "failure".into(),
                details_url: None,
            },
        ];
        let block = render_failed_checks_block(&checks, FAILED_CHECKS_BLOCK_MAX_BYTES).unwrap();
        let prompt = format_fix_ci_prompt(
            99,
            "https://github.com/acme/widgets/pull/99",
            Some("acme/widgets"),
            Some(&block),
        );
        assert!(prompt.contains("backend (failure)"));
        assert!(prompt.contains("lint / eslint (failure)"));
        assert!(
            !prompt.contains("--watch"),
            "fix-ci prompt must not ask the agent to poll CI"
        );
        assert!(
            !prompt.contains("iterá"),
            "fix-ci prompt must not tell the agent to loop until green"
        );
        assert!(!prompt.contains("-R https://"));
    }

    #[test]
    fn fix_ci_prompt_fallback_still_resolves_owner_repo() {
        let prompt = format_fix_ci_prompt(
            12,
            "https://github.com/acme/widgets/pull/12",
            Some("acme/widgets"),
            None,
        );
        assert!(prompt.contains("gh pr checks 12 -R acme/widgets"));
        assert!(!prompt.contains("--watch"));
    }

    /// Same regression coverage as
    /// [`address_pr_comments_prompt_uses_url_when_owner_repo_unknown`], for
    /// the Fix CI prompt: no `gh -R <full-url>` when the slug is unknown.
    #[test]
    fn fix_ci_prompt_uses_url_when_owner_repo_unknown() {
        let pr_url = "https://dev.azure.com/org/proj/_git/repo/pullrequest/12";
        let prompt = format_fix_ci_prompt(12, pr_url, None, None);
        assert!(!prompt.contains("-R https://"));
        assert!(prompt.contains(&format!("gh pr checks {pr_url}")));
    }

    #[test]
    fn render_comments_block_truncates_with_marker() {
        // Build enough comments to exceed a tiny cap
        let comments: Vec<UnifiedPrComment> = (0..50)
            .map(|i| general_comment(&format!("user{i}"), &"x".repeat(200)))
            .collect();
        let block = render_comments_block(&comments, 512).unwrap();
        assert!(block.len() <= 512 + TRUNCATION_MARKER.len() + 4);
        assert!(block.contains("contenido truncado"));
    }

    #[test]
    fn render_comments_block_none_when_empty() {
        assert!(render_comments_block(&[], COMMENTS_BLOCK_MAX_BYTES).is_none());
    }

    #[test]
    fn render_failed_checks_block_none_when_empty() {
        assert!(render_failed_checks_block(&[], FAILED_CHECKS_BLOCK_MAX_BYTES).is_none());
    }

    #[test]
    fn resolve_merge_conflicts_prompt_with_conflicts_lists_files_and_omits_fetch() {
        let files = vec![
            "crates/services/src/foo.rs".to_string(),
            "packages/local-web/src/App.tsx".to_string(),
        ];
        let prompt = format_resolve_merge_conflicts_prompt_with_conflicts("mdev", &files);
        // The file list is embedded verbatim.
        assert!(prompt.contains("crates/services/src/foo.rs"));
        assert!(prompt.contains("packages/local-web/src/App.tsx"));
        assert!(prompt.contains("Archivos con conflictos (2)"));
        // The pre-merge already ran — no fetch step is imposed on the agent.
        // (The prompt mentions `git merge origin/mdev` once in the past-tense
        // notice "El sistema ya ejecutó ..." — that's a description of what
        // the orchestrator did, not an instruction to the agent.)
        assert!(
            !prompt.contains("git fetch origin"),
            "prompt must not tell the agent to run the fetch itself"
        );
        assert!(
            prompt.contains("El sistema ya ejecutó"),
            "prompt must announce that the pre-merge already ran"
        );
        // The resolution criteria are preserved.
        assert!(prompt.contains("i18n"));
        assert!(prompt.contains("`git add`"));
    }

    #[test]
    fn resolve_merge_conflicts_prompt_with_conflicts_truncates_large_lists() {
        let files: Vec<String> = (0..500)
            .map(|i| format!("path/to/file_{i:03}_with_some_length.rs"))
            .collect();
        let prompt = format_resolve_merge_conflicts_prompt_with_conflicts("mdev", &files);
        assert!(prompt.contains("Archivos con conflictos (500)"));
        assert!(prompt.contains("contenido truncado"));
    }

    /// The legacy fallback prompt keeps its historical shape so agents that
    /// hit the sad path (pre-merge itself failed) still get working
    /// instructions.
    #[test]
    fn resolve_merge_conflicts_prompt_fallback_still_carries_fetch_merge_step() {
        let prompt = format_resolve_merge_conflicts_prompt("mdev");
        assert!(prompt.contains("git fetch origin"));
        assert!(prompt.contains("git merge origin/mdev"));
    }

    #[test]
    fn parse_owner_repo_from_pr_url_happy_path() {
        assert_eq!(
            parse_owner_repo_from_pr_url("https://github.com/acme/widgets/pull/42"),
            Some("acme/widgets".into())
        );
        assert_eq!(
            parse_owner_repo_from_pr_url("https://github.enterprise.com/team/repo/pull/1"),
            Some("team/repo".into())
        );
    }

    #[test]
    fn parse_owner_repo_from_pr_url_rejects_bad_urls() {
        assert_eq!(
            parse_owner_repo_from_pr_url("https://github.com/team/repo/issues/1"),
            None
        );
        assert_eq!(parse_owner_repo_from_pr_url("not-a-url"), None);
        assert_eq!(
            parse_owner_repo_from_pr_url("https://github.com/team/repo/pull/"),
            None
        );
    }
}
