# Dirección de diseño — "ProjectFlow" (Stitch, 19-jul-2026)

Fuente de verdad visual de la app. Sale del análisis de UI hecho con Stitch por Dani;
el mockup navegable de referencia está en [`stitch-mockup.html`](./stitch-mockup.html)
(abrilo en un browser). Ante cualquier conflicto entre lo que ya existe y este
documento, **este documento manda**. Los valores son tokens: van centralizados en la
config de Tailwind / variables CSS, nunca hardcodeados en componentes.

## Sistema de color (Material Design 3, light-first)

Roles MD3. El par `on-*` es SIEMPRE el color de contenido sobre su superficie.

### Núcleo
| Token | Hex | Uso |
|---|---|---|
| `primary` | `#004ac6` | Acciones primarias, links activos, FAB |
| `on-primary` | `#ffffff` | Contenido sobre primary |
| `primary-container` | `#2563eb` | Contenedores de énfasis primario |
| `on-primary-container` | `#eeefff` | Contenido sobre primary-container |
| `secondary` | `#505f76` | Acciones secundarias |
| `secondary-container` | `#d0e1fb` | **Item de nav activo**, chips seleccionados |
| `on-secondary-container` | `#54647a` | Contenido sobre secondary-container |
| `tertiary` | `#943700` | Acento cálido (badges de prioridad alta) |
| `tertiary-container` | `#bc4800` / `tertiary-fixed` `#ffdbcd` | Acentos terciarios |
| `error` | `#ba1a1a` · `error-container` `#ffdad6` · `on-error-container` `#93000a` | Errores, badge "bug" |

### Superficies (escala de elevación por color, no por sombra)

> ⚠️ **Corrección 20-jul (feedback del PM):** los hex de superficie del mockup original
> tenían saturación 90-100% y teñían la app entera de celeste. Los valores vigentes son
> los **desaturados** (sat. 16-30%, misma escala de luminosidad): `background/surface
> #fbfbfe`, `container-low #f5f6f9`, `container #eff0f5`, `container-high #e8eaf0`,
> `container-highest #e0e2ea`, `dim #dcdee5`, `outline-variant #ccced6`,
> `secondary-container #dae4f6`. Regla: **el azul es para acentos** (primary, nav activa,
> focus, chips seleccionados) — **nunca para superficies grandes**. La fuente de verdad
> ejecutable es `packages/web-core/src/app/styles/new/index.css`.
| Token | Hex | Uso |
|---|---|---|
| `background` / `surface` | `#faf8ff` | Fondo de la app |
| `surface-bright` | `#faf8ff` | Top bar |
| `surface-container-lowest` | `#ffffff` | **Cards** (fondo blanco puro) |
| `surface-container-low` | `#f2f3ff` | Inputs, bento cards, controles segmentados |
| `surface-container` | `#eaedff` | Hovers suaves |
| `surface-container-high` | `#e2e7ff` | Hover de nav |
| `surface-container-highest` | `#dae2fd` | Chips de filtro activos |
| `surface-dim` | `#d2d9f4` | Superficies atenuadas |
| `on-surface` | `#131b2e` | Texto principal |
| `on-surface-variant` | `#434655` | Texto secundario |
| `outline` | `#737686` | Bordes fuertes |
| `outline-variant` | `#c3c6d7` | **Bordes por defecto** (cards, dividers) |
| `inverse-surface` | `#283044` · `inverse-on-surface` `#eef0ff` · `inverse-primary` `#b4c5ff` | Base del dark mode |

Dark mode: se deriva con los mismos roles (los `dark:` del mockup muestran el patrón:
sidebar sobre `inverse-surface`, primary vira a `primary-fixed-dim` `#b4c5ff`, etc.).

## Tipografía

Dos familias, bundleadas (no CDN): **Hanken Grotesk** (display/títulos/cuerpo) y
**Geist** (labels uppercase y código).

| Rol | Familia | Tamaño/línea | Peso | Extra |
|---|---|---|---|---|
| `display-lg` | Hanken Grotesk | 30/38 | 700 | letter-spacing -0.02em |
| `headline-md` | Hanken Grotesk | 20/28 | 600 | -0.01em · títulos de página |
| `title-sm` | Hanken Grotesk | 16/24 | 600 | títulos de card/fila |
| `body-md` | Hanken Grotesk | 14/22 | 400 | cuerpo por defecto |
| `body-sm` | Hanken Grotesk | 13/18 | 400 | metadata, nav secundaria |
| `label-caps` | Geist | 11/16 | 600 | UPPERCASE, +0.05em · chips/labels |
| `code-sm` | Geist | 12/16 | 400 | ramas, hashes, código |

## Forma y espaciado

- **Radios CHICOS** (identidad clave, abandona el rounded-2xl):
  `DEFAULT 2px · lg 4px · xl 8px · full 12px`. Las **pills** (badges, chips de
  filtro, contadores) usan `rounded-full` real (9999px).
- Spacing tokens: `unit 4px · row-gap 8px · gutter 16px · container-padding 24px ·
  sidebar 240px`.
- Elevación: preferir **color de superficie** (escala surface-container-*) sobre
  sombras. Sombras solo sutiles en hover de cards y FAB.

## Iconografía

**Material Symbols Outlined** reemplaza a lucide-react en TODA la app (bundlear via
npm `material-symbols` o `@material-symbols/font-400`, subset woff2 — nada de CDN).
Opsz 24, weight 400, FILL 0 por defecto; FILL 1 para estados activos/seleccionados.

## Patrones de componentes (ver mockup)

- **Sidebar** 240px fija: header con nombre de app + subtítulo tenue; items con ícono
  + label `body-md`, item activo = pill `secondary-container` con `rounded-lg`; CTA
  primario full-width abajo; footer Settings/Help tras divider `outline-variant`.
  ⚠️ **La NAV del mockup es ilustrativa, NO copiarla literal.** Los items del mockup
  (Dashboard, Projects, Team, Analytics) son genéricos de Stitch. La nav real de esta
  app es: **Workers · Sprint · Issues** (+ Settings en el footer). "Projects" NO
  existe — es la entidad muerta de la nube de bloop (ver issue #23, demolición de sus
  rutas legacy). El CTA primario de abajo mapea a "Nueva tarea", no a "New Issue".
- **Top bar** 64px `surface-bright` + borde inferior: título de sección en primary,
  search con ícono embebido sobre `surface-container-low` sin borde (focus ring
  primary), tabs de filtro subrayadas (activa: border-b-2 primary + bold),
  **control segmentado** para repo picker + refresh, iconos de acción en botón
  circular con hover.
- **Filas/cards de lista**: fondo blanco, borde `outline-variant`, `rounded-lg` (4px),
  padding 16px; hover: sombra md + borde primary/30 + translateY(-2px) (transición
  200ms); número de issue en `on-surface-variant` antes del título; título
  `title-sm` que vira a primary en hover; metadata en `body-sm`; **labels como
  pills uppercase `label-caps`** con fondo tintado al tono del label y borde sutil;
  acción por fila como botón outlined primary con ícono.
- **Chips de estado/contador**: pill con contador embebido (ej. "Open" con badge
  numérico primary).
- **Bento cards** para stats: `surface-container-low`, `rounded-xl` (8px), con una
  card de acento en primary invertido.
- **FAB** primario circular abajo-derecha (shadow-2xl, hover scale).
- Micro-interacciones: `active:scale-95` en botones, transiciones 200ms ease-in-out.

## Reglas para tareas de UI

1. Tokens primero: cualquier color/tamaño/radio nuevo entra como token, no inline.
2. Contraste AA en light y dark para todo par superficie/contenido.
3. Los strings por i18n como siempre; los íconos por el set único Material Symbols.
4. Este doc y el mockup se referencian desde los issues de UI como "la dirección".
