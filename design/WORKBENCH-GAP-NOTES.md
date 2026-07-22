# Workbench — Notas de gap (mockup aprobado vs app real)

> Comparación de Dani (21-jul-2026): screenshot de la app (light, `/workspaces/create`)
> vs el mockup del artifact. Lección: retokenizar no alcanza — hay que convertir la
> **estructura** de cada pantalla al patrón del mockup. Cada ítem marca su estado.

| # | Gap observado en la app | Patrón del mockup | Estado |
|---|---|---|---|
| 1 | Sidebar: título "Workspaces" grande, secciones ("Needs Attention", "Running", "Idle") en texto normal 15px+, filas lavadas (opacity-60) y sin selección visible (`bg-tertiary` era un color inexistente) | Título y secciones en caps 11px con chevron *leading*, filas densas de alto contraste, selección `bg-sel` + stripe azul | ✅ `CollapsibleSectionHeader`, `WorkspaceSummary`, `WorkspacesSidebar` |
| 2 | Top bar: título centrado ("Create Workspace"), sin tabs | Tabs Sprint · Issues · Workers a la izquierda (activa = fondo canvas + borde superior azul 1px), breadcrumbs al centro, utilidades a la derecha | ✅ `Navbar` (`sectionTabs`) + `NavbarContainer` |
| 3 | Board Sprint: columnas como cajas con fondo, header con badge azul relleno | Columnas transparentes separadas por hairline, header caps 11px + count pill *outlined* | ✅ `SprintColumn` |
| 4 | Header de página Sprint: h-16 con título azul 20px | Sin título protagonista (las tabs nombran la sección); barra compacta con acciones — título 15px neutro, h-12 | ✅ `SprintPage` |
| 5 | Rail: labels de sección ("LOCAL"), versión vertical al fondo, ítems sin stripe perceptible | Rail sin labels, separadores finos entre grupos, stripe azul 2px en activo, gear de Settings al fondo, versión solo en status bar | ✅ `AppBar` + `SharedAppLayout` |
| 6 | Hero "What would you like to work on?" en 4xl (~36px) | Escala máxima del sistema = heading 20px | ✅ `CreateChatBoxContainer` |
| 7 | Íconos fallback (círculos) por nombres no mapeados en el shim (`sync`, `light_mode`, `dark_mode`, `desktop_windows`, `search`, `edit`) | Ícono correcto de lucide | ✅ `MaterialIcon` |
| 8 | Pendiente: la vista Workers y el composer de create-workspace no se auditaron contra el mockup a pixel | — | ⏳ verificar con screenshots de Dani |

**Regla operativa para futuros cambios de UI:** al implementar un mockup aprobado,
verificar pantalla por pantalla contra la imagen (layout, densidad, jerarquía), no solo
los tokens. El compilador no ve estos gaps.
