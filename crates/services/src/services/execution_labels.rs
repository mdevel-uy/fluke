//! Convención de etiquetas del grafo de ejecución.
//!
//! Tres familias de labels de GitHub, con prefijo, describen cómo se puede
//! ejecutar un backlog sin que dos workers se pisen:
//!
//! - `feature:<slug>` — a qué feature pertenece el issue. Agrupa.
//! - `wave:<n>` — orden de ejecución **dentro de la feature**. Todos los
//!   issues de la misma feature y la misma wave pueden lanzarse en paralelo.
//! - `resource:<slug>` — recurso serializado global del repo (numeración de
//!   migraciones, lockfile, tipos generados). Cruza features: dos issues de
//!   features distintas que reclaman el mismo recurso no son paralelos aunque
//!   sus waves digan que sí.
//!
//! El contrato que el analista debe cumplir al etiquetar vive en
//! `ANALYST_EXECUTION_LABELS_CONTRACT` (worker_orchestrator). Este módulo es
//! sólo el parser y la paleta: la fuente de verdad de los datos son las
//! labels en GitHub, no una tabla local.
//!
//! El parseo se repite del lado del frontend (`executionLabels.ts`), que es
//! quien arma la vista agrupada. Los prefijos son tres constantes; si cambian
//! acá, cambian allá.

/// Familia a la que pertenece una label de la convención.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionLabelKind {
    Feature,
    Wave,
    Resource,
}

pub const FEATURE_PREFIX: &str = "feature:";
pub const WAVE_PREFIX: &str = "wave:";
pub const RESOURCE_PREFIX: &str = "resource:";

/// Colores por familia, para que el board sea legible de un vistazo y para
/// que `gh label create` no invente uno distinto por repo.
pub const FEATURE_COLOR: &str = "5319e7";
pub const WAVE_COLOR: &str = "1d76db";
pub const RESOURCE_COLOR: &str = "d93f0b";

/// Color de cualquier label fuera de la convención. Igual al que ya usa
/// `RepoIssuesService::add_label`, para no crear la misma etiqueta con dos
/// colores distintos según por dónde entró.
pub const DEFAULT_LABEL_COLOR: &str = "0075ca";

/// Prefijo de `name`, comparado sin distinguir mayúsculas: un analista que
/// escribe `Feature:` no debería producir una segunda familia fantasma.
///
/// Corta con `get(..)` y no con `split_at`: los nombres de label vienen de
/// GitHub y pueden empezar con caracteres multibyte (`área`, `日本語`), en
/// cuyo caso `prefix.len()` no cae en un límite de carácter y `split_at`
/// panica. `get` devuelve `None` en ese caso, que es justo la respuesta
/// correcta — una label así no pertenece a ninguna familia.
fn strip_prefix_ci<'a>(name: &'a str, prefix: &str) -> Option<&'a str> {
    let name = name.trim();
    let head = name.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        // El índice ya quedó validado como límite de carácter por `get`.
        Some(name[prefix.len()..].trim())
    } else {
        None
    }
}

/// Familia de `name`, o `None` si la label no pertenece a la convención.
pub fn classify(name: &str) -> Option<ExecutionLabelKind> {
    if strip_prefix_ci(name, FEATURE_PREFIX).is_some() {
        Some(ExecutionLabelKind::Feature)
    } else if strip_prefix_ci(name, WAVE_PREFIX).is_some() {
        Some(ExecutionLabelKind::Wave)
    } else if strip_prefix_ci(name, RESOURCE_PREFIX).is_some() {
        Some(ExecutionLabelKind::Resource)
    } else {
        None
    }
}

/// Slug de feature de `feature:<slug>`. `None` si no es de esa familia o si
/// el slug quedó vacío (`feature:` pelada no agrupa nada).
pub fn feature_slug(name: &str) -> Option<&str> {
    strip_prefix_ci(name, FEATURE_PREFIX).filter(|s| !s.is_empty())
}

/// Número de wave de `wave:<n>`. Sólo enteros no negativos: `wave:-1` y
/// `wave:temprana` no son órdenes, son typos, y tratarlos como wave 0
/// escondería el error detrás de un valor plausible.
pub fn wave_number(name: &str) -> Option<i64> {
    strip_prefix_ci(name, WAVE_PREFIX)
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|n| *n >= 0)
}

/// Slug de recurso de `resource:<slug>`.
pub fn resource_slug(name: &str) -> Option<&str> {
    strip_prefix_ci(name, RESOURCE_PREFIX).filter(|s| !s.is_empty())
}

/// Color con el que crear `name` en el repo. Las labels de la convención
/// tienen color fijo por familia; el resto cae al default.
pub fn color_for_label(name: &str) -> &'static str {
    match classify(name) {
        Some(ExecutionLabelKind::Feature) => FEATURE_COLOR,
        Some(ExecutionLabelKind::Wave) => WAVE_COLOR,
        Some(ExecutionLabelKind::Resource) => RESOURCE_COLOR,
        None => DEFAULT_LABEL_COLOR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_family() {
        assert_eq!(feature_slug("feature:rss-v1"), Some("rss-v1"));
        assert_eq!(wave_number("wave:2"), Some(2));
        assert_eq!(resource_slug("resource:db-migration"), Some("db-migration"));
    }

    #[test]
    fn prefix_match_is_case_insensitive_but_slug_keeps_case() {
        assert_eq!(feature_slug("Feature:RSS-v1"), Some("RSS-v1"));
        assert_eq!(wave_number("WAVE:3"), Some(3));
    }

    #[test]
    fn tolerates_whitespace_around_prefix_and_slug() {
        assert_eq!(feature_slug("  feature: rss-v1  "), Some("rss-v1"));
        assert_eq!(wave_number("wave: 4 "), Some(4));
    }

    #[test]
    fn rejects_empty_slugs_and_non_numeric_waves() {
        assert_eq!(feature_slug("feature:"), None);
        assert_eq!(resource_slug("resource:  "), None);
        assert_eq!(wave_number("wave:temprana"), None);
        assert_eq!(wave_number("wave:"), None);
    }

    /// Una wave negativa es un typo, no un orden. Devolver `Some(-1)` la
    /// ordenaría antes que la wave 0 y el error quedaría invisible.
    #[test]
    fn rejects_negative_waves() {
        assert_eq!(wave_number("wave:-1"), None);
    }

    /// Labels ajenas a la convención no deben caer en ninguna familia: el
    /// board ya usa `P0..P3` y labels de skills, y confundirlas rompería
    /// tanto la agrupación como el color.
    #[test]
    fn ignores_labels_outside_the_convention() {
        for name in ["P1", "backend", "featureish", "waved", "resources"] {
            assert_eq!(classify(name), None, "{name} should not classify");
        }
    }

    /// Regresión: los nombres de label vienen de GitHub y pueden ser
    /// multibyte. Cortar por bytes con `split_at` panicaba cuando
    /// `prefix.len()` caía en medio de un carácter — y el panic ocurriría
    /// adentro del drain, tumbando la ejecución de acciones del run entero.
    #[test]
    fn does_not_panic_on_multibyte_label_names() {
        for name in ["日本語ラベル", "área", "ñ", "🙂", "fëature:x"] {
            assert_eq!(classify(name), None, "{name} should not classify");
            assert_eq!(color_for_label(name), DEFAULT_LABEL_COLOR);
        }
    }

    /// Y el slug sí puede ser multibyte: sólo el prefijo es ASCII.
    #[test]
    fn accepts_multibyte_slugs_after_an_ascii_prefix() {
        assert_eq!(feature_slug("feature:área-de-pagos"), Some("área-de-pagos"));
        assert_eq!(resource_slug("resource:日本語"), Some("日本語"));
    }

    #[test]
    fn color_is_fixed_per_family_and_defaults_otherwise() {
        assert_eq!(color_for_label("feature:x"), FEATURE_COLOR);
        assert_eq!(color_for_label("wave:0"), WAVE_COLOR);
        assert_eq!(color_for_label("resource:x"), RESOURCE_COLOR);
        assert_eq!(color_for_label("P1"), DEFAULT_LABEL_COLOR);
    }

    /// `wave:abc` no es de la familia wave para `wave_number`, pero sí lo es
    /// para `classify`/`color_for_label`: la label existe y hay que pintarla,
    /// aunque no aporte un orden. Si no, se crearía con el color default y
    /// parecería una label cualquiera en vez de una wave mal escrita.
    #[test]
    fn malformed_wave_still_belongs_to_the_family() {
        assert_eq!(classify("wave:temprana"), Some(ExecutionLabelKind::Wave));
        assert_eq!(color_for_label("wave:temprana"), WAVE_COLOR);
        assert_eq!(wave_number("wave:temprana"), None);
    }
}
