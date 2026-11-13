# Gentle Shell → Fluke

Investigación y aplicación: 2026-10-13. Superficie: `tools/fluke-console-go`.
Referencia: [Gentleman-Programming/gentle-shell](https://github.com/Gentleman-Programming/gentle-shell),
commit consultado `bedba1f12b4f5626e05129f7e4bc3693ce9cd829`.

Gentle Shell es un espacio de trabajo para agentes sobre Pi. Su valor como
referencia para Fluke está en cómo reúne conversación, herramientas, cambios,
agentes y ajustes. Fluke conserva su runtime Go, PTYs y adaptadores Codex/Claude.

Se consultaron README, referencia del shell, referencia técnica, tema Gentle,
paleta de comandos y personalización. La descarga de las capturas oficiales
no se completó; las observaciones visuales se apoyan en la documentación,
diagramas de terminal y código. No se identificó una fuente exacta a partir
de imágenes. Los enlaces a capturas permiten contrastar después la referencia.

## Vistas y organización del trabajo

La [referencia del shell](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/docs/gentle-shell.md)
describe una conversación central y un lateral de estado, cambios y TODO en
terminales amplios; a menor ancho reduce la composición. Los agentes tienen
un lugar próximo al editor. La cabecera muestra contexto efectivo y retira
información secundaria cuando falta espacio. También diferencia tarjetas
con contorno y superficies sin contorno.

Aplicación a Fluke:

- Conservar F2 como centro de conversación y trabajo, con plan/workers al lado.
  Evitar que conexiones, temas o navegación obliguen a buscar comandos de memoria.
- Mostrar proveedor/modelo efectivo en la cabecera cuando cabe. Ya incorporado
  en este incremento, utilizando el estado de sesión existente.
- Mantener F3 para observar terminales y F7 para revisar entregas. Las ventanas
  flotantes, fijación y mosaico de Fluke siguen teniendo un propósito propio.
- Como próximo incremento de vistas, estudiar un lateral con secciones
  plegables de plan, cambios y atención. Debe conservar foco, scroll y acceso
  por teclado al reducir el ancho. No está implementado en esta vuelta.
- No rellenar contexto, costos ni progreso con estimaciones de apariencia.
  Fluke conserva sus métricas observadas y la ausencia explícita de evidencia.

Capturas oficiales de referencia:
[workspace](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/docs/assets/features/gentle-shell.png),
[cambios](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/docs/assets/features/changes-view.png),
[agentes](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/docs/assets/features/agents-view.png).

## Letras, color y formas

El [tema Gentle](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/themes/Gentle.json)
define fondo muy oscuro, texto claro, azules suaves y roles diferenciados para
selección, estados y herramientas. Son colores y estilos del terminal;
ese archivo no declara una familia tipográfica.

Fluke incorpora **Gentle**, una adaptación propia con tinta oscura, azul y rosa,
como sexto tema opcional. El texto secundario se aclara respecto de la referencia;
la prueba existente de contraste incluye automáticamente la nueva paleta.
Se mantienen los cinco temas anteriores y la elección guardada del usuario.

Se conservan las celdas monoespaciadas, separadores finos y marcador de foco
existentes. El rosa distingue la selección; los estados siguen combinando
palabras y color. No se replica la flor ni se reemplaza la marca Fluke.

F5 → **Texto** explica cómo elegir fuente y tamaño en el terminal anfitrión y
ofrece una muestra de caracteres. Esa vista es informativa: no modifica perfiles
de Windows Terminal ni archivos de configuración del terminal de Linux/macOS.
El tamaño de la fuente cambia cuántas celdas caben y, por tanto, la composición
que puede mostrar Fluke.

## Encontrar y cambiar configuración

La [paleta de comandos](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/command-palette.ts)
y el [panel de personalización](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/visual-customize-view.ts)
son las referencias de interacción: búsqueda, categorías, selección por teclado,
descripción y aplicación explícita de la opción.

Incorporado en Fluke:

- **Alt+K** busca vistas y ajustes. Cada resultado identifica su categoría y
  destino. Flechas/Tab, Enter, clic, rueda y Escape usan el selector existente.
- **Ctrl+P** sigue buscando proyectos/workers; **Ctrl+K** conserva el editor
  de comandos. Pasar de un buscador al otro limpia la consulta de ese buscador.
- F5 tiene accesos visibles a **Agente, Conexión, GitHub, Tema y Texto**.
  Clic o **Ctrl+←/→** recorren las secciones en ese orden.
- Abrir la paleta o cancelarla conserva borradores. Entrar a un ajuste desde
  configuración reutiliza el borrador abierto. Elegir una vista no lanza workers.
- Cambiar tema conserva el circuito de previsualizar, guardar con Enter y
  descartar con Escape. Salir a otra sección también descarta esa previsualización.
- Pegar en una sección informativa no modifica campos de agente ocultos.

La personalización de Gentle también incluye densidad, posición de estado,
elementos visibles y perfiles visuales. Son candidatos para otra implementación;
no se agregaron preferencias sin un comportamiento conectado a ellas.

## Conexiones y modelos

La [referencia técnica](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/docs/readme-reference.md)
expone selección de modelos, asignación por roles, perfiles y reutilización de
sesiones/configuración de Pi. La documentación del producto también describe
login nativo y selección posterior del modelo. Es una referencia de flujo;
no implica que esos proveedores estén soportados por los adaptadores de Fluke.

Fluke aplica el flujo a sus capacidades actuales:

1. Elegir proveedor y ejecutable en Agente.
2. Abrir Conexión: separar disponibilidad de CLI y autenticación de cuenta.
3. **Ctrl+L** entrega el terminal al login nativo del proveedor; **Ctrl+R**
   vuelve a comprobar. Abrir la vista solo consulta estado.
4. Elegir modelo, guardar para nuevas sesiones o aplicar explícitamente a Fluke.
   La configuración guardada y la sesión efectiva se muestran por separado.
5. GitHub conserva su propia cuenta, código de dispositivo y cancelación.

Una comprobación pendiente no se presenta como conexión exitosa. Una cuenta
sin resultado verificable se muestra como «sin verificar». Las credenciales
siguen administradas por las CLIs, fuera del JSON de estado de Fluke.

Los perfiles por rol de Gentle son interesantes para configuraciones de equipo,
pero el producto actual de Fluke especifica un worker por tarea y configuración
por tarea, sin perfiles de workers. Se conserva ese contrato. Este incremento
tampoco añade SSH, servidores remotos, Pi ni proveedores API nuevos.

## Qué queda para una siguiente vuelta

- Lateral configurable y densidad de información, conservando navegación en
  pantallas pequeñas y distinción entre visibilidad y foco.
- Presentación de cambios por raíz/worktree y detalles de agentes con columnas
  alineadas, utilizando datos reales del runtime.
- Tarjetas de herramientas plegables: requieren eventos estructurados; ocultar
  líneas arbitrarias de la salida PTY puede esconder errores o permisos.
- Perfiles visuales y avisos sonoros opcionales, con previsualización y controles
  explícitos. No deben cambiar permisos, proveedores ni decisiones de producto.

## Validación de este incremento

Cambios de fuente y pruebas de regresión añadidas; no se compilaron ejecutables
ni se ejecutaron pruebas, lints o instalaciones, siguiendo AGENTS.md.
Las capturas/binaries anteriores no representan este incremento. La revisión
independiente se limita al código; queda pendiente validación visual y ejecución
por el post script o CI antes de distribuir un binario nuevo.

Las pruebas añadidas cubren navegación y cancelación, propagación del comando
asíncrono de conexión, borradores, pegado en vistas informativas, tamaños de
terminal, inglés/español y estado de autenticación. La prueba de temas existente
incluye Gentle en contraste y visibilidad.
