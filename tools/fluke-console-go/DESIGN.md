---
name: Fluke Console
description: Consola limpia de inspiración noventera con seis paletas seleccionables.
colors:
  neon-background: "#15151e"
  neon-foreground: "#e2e0ec"
  neon-structure: "#a5b9dd"
  neon-focus: "#b6a1ed"
  neon-success: "#a5c4a0"
  neon-warning: "#dfbe86"
  neon-muted: "#9493a7"
  amber-background: "#171008"
  amber-foreground: "#ffe6bb"
  amber-structure: "#ffc16a"
  amber-focus: "#fff0b3"
  amber-success: "#c6db8a"
  amber-warning: "#ffab70"
  amber-muted: "#b6a082"
  phosphor-background: "#07140d"
  phosphor-foreground: "#dcf5df"
  phosphor-structure: "#83e6a0"
  phosphor-focus: "#c7f58a"
  phosphor-success: "#70e3aa"
  phosphor-warning: "#ead184"
  phosphor-muted: "#8aaf96"
  midnight-background: "#0b1526"
  midnight-foreground: "#e2eaf7"
  midnight-structure: "#83b9fa"
  midnight-focus: "#c7adfa"
  midnight-success: "#8ddbb7"
  midnight-warning: "#f2cc87"
  midnight-muted: "#93a6c3"
  gentle-background: "#080b12"
  gentle-foreground: "#edf0f5"
  gentle-structure: "#93b9cd"
  gentle-focus: "#d49aac"
  gentle-success: "#b9cc91"
  gentle-warning: "#dfc18e"
  gentle-muted: "#939dad"
  paper-background: "#f4efe4"
  paper-foreground: "#292d35"
  paper-structure: "#245d78"
  paper-focus: "#81436b"
  paper-success: "#286443"
  paper-warning: "#835016"
  paper-muted: "#656268"
---

# Design System: Fluke Console

## Overview

**Creative North Star: "El trabajo primero; Fluke siempre presente"**

Este documento aplica únicamente a `tools/fluke-console-go`. Refina la
[dirección visual original](../../design/fluke-herdr/VISUAL-DIRECTION.md), tomando
la sobriedad de TUIOS como referencia:
conversación con Fluke, plan y terminales conviven en paneles de celdas con
jerarquía clara y atajos visibles. Los temas amplían la elección de colores;
mantienen la composición, los controles y el acceso al orquestador.

La extensión inspirada en Gentle Shell incorpora descubrimiento de acciones,
ajustes por secciones y un sexto tema opcional. La
[investigación de referencia](../../design/fluke-herdr/GENTLE-SHELL-RESEARCH.md)
documenta su alcance; se conserva la identidad de Fluke y su runtime existente.
Esta actualización describe cambios de código: las capturas anteriores no
representan el incremento y no hay validación visual nueva. No se ejecutaron
compilaciones, pruebas, lints ni instalaciones en esta sesión, según AGENTS.md.

**Key Characteristics:**

- Tipografía monoespaciada del terminal anfitrión.
- Paneles planos, separadores finos y foco identificado por `›` y color.
- Cabecera de tres filas con marca pequeña, proyecto, actividad y navegación.
- Fondo grafito, texto claro y acentos suaves; el contenido domina la pantalla.
- Seis paletas con los mismos roles semánticos; Gentle es opcional.
- Vista previa inmediata y elección persistente independiente de los agentes.

## Colors

Los valores del frontmatter reflejan `consoleThemes` en `themes.go`, fuente de
implementación. Sus prefijos son los identificadores persistidos:

- **Fluke (`neon`):** grafito, azul suave y lavanda. Conserva el ID persistido.
- **Amber CRT (`amber`):** fósforo cálido sobre fondo oscuro.
- **Phosphor (`phosphor`):** verdes con acentos contenidos.
- **Midnight (`midnight`):** azul profundo, estructura azul y foco lavanda.
- **Gentle (`gentle`):** tinta oscura, azul suave y rosa; adaptación de Gentle Shell.
- **Paper (`paper`):** papel cálido con tinta oscura; variante clara.

`background` cubre la superficie; `foreground` es el texto principal;
`structure` identifica acciones y navegación; `focus` marca selección y
revisión; `success` comunica actividad o resultados satisfactorios; `warning`
señala espera y atención; `muted` corresponde al texto secundario. Los nombres
históricos `cyan`, `pink`, `lime` y `amber` en Go representan esos roles y cambian
con la paleta. Las etiquetas y los bordes acompañan al color.

**The Default Palette Rule.** Un tema ausente o desconocido se muestra como
Fluke. El identificador histórico `neon` sigue siendo válido.

## Typography

La fuente y su tamaño los determina el terminal anfitrión. La interfaz utiliza
celdas monoespaciadas, negrita puntual y texto ajustado por palabras. La conversación
usa etiquetas Fluke/Vos; no fuerza mayúsculas ni añade barras de color al historial.
Elegir tema no cambia tipografía, densidad ni medidas. Las fuentes y dimensiones
en píxeles del renderizador de capturas son recursos de evidencia, no preferencias
impuestas a la consola.

**F5 → Texto** ofrece una guía informativa para ajustar fuente y tamaño en
Windows Terminal (Configuración → Perfil → Apariencia) o en los ajustes del
terminal de Linux/macOS. La muestra `Aa 01 Il ─ │ ┌ ┐` permite comprobar
legibilidad y soporte Unicode; el contenido se abrevia en terminales pequeños.
La guía no modifica perfiles del anfitrión. Cambiar su tamaño de fuente cambia
las celdas disponibles y puede activar otra distribución de Fluke.

## Layout

Se conserva la jerarquía vigente de conversación, proyecto, plan, sesiones y
decisiones. En espacios pequeños se alternan paneles mediante teclado; cambiar
colores no modifica los umbrales ni la distribución. La portada y las ventanas
mantienen las adaptaciones registradas en
[las notas del incremento](DESIGN-NOTES-2026-10-12.md).

### Shell (desde 100 × 24 celdas)

Con al menos 100 columnas y 24 filas, la consola usa una cabecera de **una fila**
(marca, proyecto, F1–F7 y `[Alt+K]`, y a la derecha workers y decisiones
pendientes) y un pie de dos filas (aviso y atajos). En F2 la conversación es la
superficie principal y un **rail** angosto sin bordes muestra siempre
Proyectos, Plan (con el detalle de la tarea seleccionada) y Atención. Sobre el
editor, la tarjeta **Workers** lista cada tarea con su estado, proveedor/modelo,
tokens y costo reportados y tiempo observado. Un dato que el worker no reportó
se muestra «—», nunca cero. Las columnas caen en este orden: modelo, tokens y
costo, tiempo.

El rail es una sola vista con foco: Tab alterna entre editor y rail, ↑/↓ elige
tarea y los atajos de tarea (Enter, `v`, `p`, `q`, `a`, `m`, `i`) son los mismos
que antes. El clic cambia de tarea, de proyecto o abre una alerta. Debajo de 100
columnas o 24 filas, o con el chat flotante abierto, se conserva el espacio de
proyecto de paneles alternados descrito más abajo.

La navegación acorta sus etiquetas según el ancho disponible y conserva los
atajos F1–F7 y el acceso `[Chat]`. Las ventanas se desplazan y redimensionan por
celdas dentro del área de trabajo; el chat flotante acompaña el cambio de sección.

## Elevation & Depth

Superficies planas y separadores de terminal. El foco se expresa con el rol
`focus` y el marcador `›`; no incorpora sombras ni un renderizador
gráfico. Las variantes de color conservan esa misma jerarquía.
Las terminales fijadas quedan por encima de las demás terminales; el chat flotante
se superpone al contenido de la sección. Visibilidad y foco son independientes.

## Shapes

Marcos rectos de caracteres, esquinas de terminal y alineación por celdas.
`panelFrame` conserva las coordenadas de título y contenido para el mouse. Los
paneles acoplados llevan un separador; solo las ventanas flotantes y los workers
llevan contorno. Los bordes usan una mezcla 75% fondo / 25% texto secundario; la
ventana de worker enfocada usa lavanda. Los temas mantienen esta jerarquía.

## Components

### Navegación

La pestaña activa sigue el panel visible: Review corresponde a F7, configuración
a F5 y la lista de issues de GitHub a F6. La conexión de GitHub dentro de
configuración conserva F5. El fondo `focus`, la negrita y la etiqueta identifican
la selección; los clics usan las mismas etiquetas adaptadas y acciones que F1–F7.

La cabecera agrega proveedor/modelo efectivo en proyectos abiertos desde 100
celdas de ancho, siempre que quepa junto al proyecto y al estado. Usa la
configuración de la sesión activa; si no hay sesión, usa la configuración
guardada. El borrador de ajustes no sustituye esa identidad.

### Descubrimiento de vistas y ajustes

**Alt+K** abre una búsqueda de destinos con categoría y descripción. Reutiliza
el selector rápido: flechas o Tab recorren resultados, Enter o clic abre el
destino, la rueda desplaza y Esc cancela. Abrir o cancelar conserva los
borradores; entrar a otra sección de configuración reutiliza el borrador abierto.
Los resultados navegan a vistas y ajustes; no inician ni detienen trabajo.

**Ctrl+P** conserva la búsqueda de proyectos/workers y **Ctrl+K** conserva el
editor de comandos para revisar antes de ejecutar. Alternar los buscadores
reinicia la consulta del selector abierto.

### Configuración y conexión

F5 agrupa **Agente, Conexión, GitHub, Tema y Texto** (Agent, Connection, GitHub,
Theme, Text). El clic y **Ctrl+←/→** recorren ese orden; las etiquetas se
abrevian cuando falta ancho. La sección activa usa negrita y el rol `focus`.
Agente contiene proveedor, ejecutable y modelo; Conexión reúne comprobación e
inicio de sesión; GitHub conserva su flujo de cuenta independiente.

Conexión distingue **CLI disponible** de **cuenta autenticada**. Una cuenta sin
evidencia se muestra «sin verificar»; una consulta pendiente muestra la
comprobación en curso. **Ctrl+L** abre el login nativo y **Ctrl+R** vuelve a
comprobar. Las credenciales siguen administradas por la CLI del proveedor.

La configuración **guardada para nuevas sesiones** y **Fluke actual** se
presentan por separado en el detalle de Agente; Conexión también las muestra
cuando su panel tiene al menos 24 filas. Sin sesión se indica esa ausencia.
Guardar cambios y aplicarlos a Fluke son acciones distintas. Las vistas
informativas no editan campos de agente ocultos al pegar texto.

### Chat flotante

**Ctrl+F o `[Chat]`** abre la conversación del proyecto, recupera el foco de una
ventana abierta o cierra la que ya tiene foco. El marco conserva
un contorno fino, señala el foco en el título y muestra `[x]` para cerrar. El título permite
arrastrar, los bordes redimensionar y la rueda recorrer el historial. El editor
comparte borrador y envío con la conversación principal. **Esc o Tab** libera el
foco sin cerrar; cambiar de sección conserva la ventana visible.

La apertura y los límites se guardan en `State.ChatWindow`. Al reabrir la consola,
la ventana se restaura cuando hay un proyecto abierto, sin tomar el foco. Sus
límites se ajustan al terminal anfitrión. Los diálogos de proyecto, configuración
inicial y acciones modales conservan prioridad sobre el chat.

### Espacio de proyecto y edición

La conversación es el punto de entrada de F2 y ocupa el 60% izquierdo en anchos
de al menos 92 celdas. Plan/Workers/Balance comparten el detalle derecho; en
terminales estrechos se muestra una vista con selector nombrado. `>Chat<` y el
marcador `›` identifican el foco sin depender solo del color. Una conversación
flotante sustituye la acoplada: no se muestran dos copias en F2.

El editor tiene hasta tres filas visibles, caret editable y navegación por
filas ajustadas al ancho. Conserva párrafos al pegar. Envío, sesión y fijación
se agrupan debajo; estado y recuperación quedan junto al editor. El mismo
renderer y normalización sirven a las dos presentaciones.

Aplicación de UI/UX Pro Max: foco visible, orden de navegación, feedback y
controles consistentes. Aplicación de Power Design: un foco principal, agrupación
por proximidad y jerarquía; no se trasladan tamaños, márgenes ni cuotas de espacio
en blanco propios de diapositivas a una terminal. Se conservan las cinco paletas
originales y se suma Gentle como opción.

### Selector de apariencia

Desde **F5 → Tema** (o **Ctrl+T**), las flechas o Tab/Shift+Tab recorren las seis
paletas, con vuelta al comienzo o al final. La selección previsualiza inmediatamente la
superficie visible; `>` identifica la fila seleccionada y «guardado» identifica
la preferencia persistida. La descripción y los ejemplos En curso, En espera y
Revisar permiten comparar los roles.

**Enter o Ctrl+S** guarda el identificador en `State.Theme` (`theme` en el JSON del
directorio de estado) y vuelve a configuración. **Esc** descarta la vista previa
y restaura la elección guardada; pasar a otra sección también descarta la vista
previa. Una escritura fallida mantiene abierto el selector y conserva la
preferencia anterior. Cambiar tema no guarda los campos
pendientes de configuración ni reinicia workers u orquestadores. La elección se
recupera al volver a abrir la consola con el mismo directorio de estado.

### Terminales embebidas

El texto y fondo predeterminados del emulador VT siguen la paleta de la consola.
Los colores ANSI explícitos enviados por las CLIs conservan sus valores. El tema
es compartido por la consola; no hay una paleta independiente por worker.

En F3, el título permite arrastrar y los bordes redimensionar incluso durante la
entrada al terminal. `[p]` fija una ventana por encima de las otras y `[*]` indica
que está fijada; **p** alterna ese estado en modo ventanas. `[+]` maximiza y `[-]`
restaura. **Ctrl+B** libera la captura para seleccionar texto con el terminal
anfitrión; repetirlo devuelve los controles de mouse a la consola.

**The Explicit ANSI Rule.** Cambiar apariencia solo sustituye los colores
predeterminados del VT; no recolorea la salida que ya declara su propio color.

## Do's and Don'ts

- **Do** conservar atajos visibles, jerarquía contenida y acceso a Fluke en cada tema.
- **Do** reservar el logo grande para la bienvenida; usar la marca pequeña al trabajar.
- **Do** usar los mismos roles para texto, estructura, foco y estados.
- **Do** distinguir la selección en vista previa de la preferencia guardada.
- **Don't** reiniciar agentes o guardar ajustes de proveedor al elegir colores.
- **Don't** sustituir los colores ANSI explícitos de las CLIs.
- **Don't** convertir las dimensiones de las capturas en requisitos del anfitrión.
