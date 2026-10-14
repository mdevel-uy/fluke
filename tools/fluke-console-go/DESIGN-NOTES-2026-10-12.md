# Extensión de la consola Fluke — 2026-10-12

## Overview

Esta entrega extiende la TUI de `tools/fluke-console-go` sobre la
[dirección BBS de los 90 confirmada el 2026-10-07](../../design/fluke-herdr/VISUAL-DIRECTION.md).
La conversación con Fluke sigue siendo el punto de entrada: el centro de control
presenta su último mensaje, acceso al chat y al plan, y luego el balance del
proyecto seleccionado. La atención global continúa accesible con Tab.

No se encontraron `PRODUCT.md` ni `DESIGN.md` en la raíz, `tools/` o esta carpeta.
La dirección citada y la implementación son el contexto aplicable; estas notas
registran el incremento sin reemplazar las especificaciones existentes ni crear
una identidad visual nueva. `design/DESIGN-DIRECTION.md` está deprecado y describe
la interfaz web, por lo que no aporta tokens a esta consola.

## Colors

Se conserva la paleta definida en `ui.go`: fondo violeta casi negro `#0b0619`,
texto `#eeeafa`, cian estructural `#20e9ef`, magenta de foco `#f00ed5`, verde
`#6ff566`, ámbar `#f5d547` y texto secundario `#9298bd`. El foco y los estados
mantienen texto y bordes además del color; el balance reutiliza estos recursos.

## Typography

Se mantiene la tipografía monoespaciada y la alineación por celdas del terminal.
La fuente de la sesión depende del terminal anfitrión. Las PNG de evidencia usan
el renderizador existente `render_captures.py`: Consolas regular y negrita a
16 px, sobre celdas de 10 × 20 px. Esto describe las imágenes, no impone una
fuente nueva al usuario.

## Layout

El centro de control conserva una jerarquía de proyecto, mensaje de Fluke,
acciones, balance y atención. En la portada, desde 92 columnas se distribuyen
proyectos y centro de control en dos paneles (40 % a la izquierda). Por debajo
se muestra un panel y `i` alterna proyectos/balance; Tab abre la atención global.
El resumen conversacional se acorta según el espacio y conserva acceso al chat.

Las capturas inspeccionadas muestran tres tamaños en columnas × filas:

- [44 × 24](../../artifacts/console-2026-10-12/captures/go-mission-44.png):
  panel único, pestañas F1–F7 abreviadas, mensaje resumido y balance compacto.
- [80 × 30](../../artifacts/console-2026-10-12/captures/go-mission-80.png):
  panel único de balance, mensaje completo del fixture y pie de atajos compacto.
- [140 × 40](../../artifacts/console-2026-10-12/captures/go-mission-140.png):
  proyectos a la izquierda y Fluke con el balance a la derecha.

## Shapes

Se conservan marcos rectos, separadores de terminal y superficies planas.
La extensión no añade sombras, fuentes, animaciones ni un renderizador gráfico
a la TUI.

## Components

### Balance del proyecto

`metrics.go` separa tareas aceptadas, integradas, pendientes de trabajo, en revisión
y bloqueadas. Integrada exige un commit de integración registrado. El tiempo es
trabajo observado por esta consola: excluye pausas, inactividad y lapsos sin
observación; no equivale a horas facturadas ni a una estimación restante.

La aceptación sin correcciones utiliza tareas aceptadas con historial de entregas
medido. Los datos antiguos sin ese historial no se convierten en éxitos medidos.
Tokens y USD son reportados por ejecución, acompañados de la cobertura sobre
ejecuciones registradas. La ausencia se muestra como «no disponibles», no como
costo cero. La validación exige números válidos y un archivo de evidencia local;
esto no certifica una factura del proveedor ni la veracidad de su contenido.

En el plan, `i` alterna el balance del proyecto y de la tarea seleccionada con el
plan habitual. Las flechas permiten cambiar la selección. Las ayudas conservan
`C` para chat, Enter para abrir el plan/worker según contexto y Tab para panel/foco.

### Sesiones, zoom y foco

En modo ventanas, `z` o el control `[+]` del título maximiza la sesión enfocada;
`[-]` restaura sus límites guardados. El zoom sigue el foco. Tab/Shift+Tab cambian
sesión y `t` alterna el mosaico; Enter entra al terminal. El título identifica la
sesión visible con su posición cuando se muestra una sola.

El mosaico pasa a una sesión visible si hay menos de 64 columnas o cada fila de
ventanas quedaría por debajo de ocho líneas. Esto conserva acceso a las demás
sesiones mediante foco. La rueda recorre historial; no se habilita arrastre o
redimensionado de ventanas mientras se muestra una sola.

## Do's and Don'ts

- Conservar a Fluke antes de las métricas y mantener visibles los accesos relevantes.
- Distinguir datos observados, reportados y ausentes; no convertirlos en promesas
  de productividad, calidad total o facturación.
- Mantener paleta, fuentes del anfitrión, bordes y navegación existentes al extender
  otras pantallas.
- Tratar las tres PNG como evidencia de composición de la TUI con datos sintéticos.
  `TestMissionControlCaptures` construye tareas y conversación de prueba y captura
  las celdas del render real de la vista; no demuestra una conversación con IA en vivo.
- El zoom y los atajos se contrastaron con el código y el test existente
  `TestNativeZoomRestoresFloatingBoundsAndSmallWindowFocus`; estas capturas de portada
  no prueban esas interacciones. Esta revisión documental no ejecutó tests ni builds.
- Las dimensiones pequeñas no certifican uso táctil, hardware móvil, Linux,
  lectores de pantalla ni compatibilidad entre emuladores de terminal. Tampoco
  cubren todas las alturas, traducciones o estados de contenido.
