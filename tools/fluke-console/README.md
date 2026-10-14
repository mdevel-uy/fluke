# Fluke Console — prototipo Rust de referencia

La [base activa está en Go](../fluke-console-go/README.md). Este prototipo se
conserva como referencia de comportamiento y validación; el desarrollo nuevo
continúa en Go con interfaz, ventanas y sesiones propias de Fluke.

Aplicación nativa en Rust, con interfaz propia de terminal. Independiente del
workspace y backend web actuales de Fluke. Herdr sirve como referencia técnica,
sin dependencia de su ejecutable, servidor o interfaz.

Estado: compilado y probado en Windows el 2026-10-07. El usuario autorizó
expresamente abrir consolas y probar este incremento. Las pruebas usan repos
temporales y PowerShell; no realizan llamadas a modelos ni modifican los repos
de trabajo del usuario. Linux/WSL y las conversaciones con agentes siguen
pendientes. La estabilidad prolongada y el consumo de recursos deben medirse.

## Alcance implementado en el código

- Cuatro vistas: Fluke, Proyecto, Sesiones y Decisiones; paleta y composición
  basadas en las referencias de design/fluke-herdr.
- Terminales PTY locales con pantalla VT100, colores y entrada por teclado.
- Un worker por tarea, con worktree y rama propios; sesiones en paralelo.
- Límite global configurable, compartido por los repos registrados en el mismo
  directorio de estado. Una apertura en curso reserva su plaza. Un segundo
  proceso con ese estado se rechaza mediante bloqueo de archivo.
- Registro manual de tareas con aceptación y brief en el repo.
- Cambio de repo sin detener las sesiones existentes.
- Registro local de preguntas y respuestas.
- Configuración global del orquestador en F5: Codex, Claude o CLI personalizada,
  ejecutable, modelo, argumentos y máximo de workers. Aparece en el primer arranque.
  Cambiarla afecta a sesiones nuevas y conserva las existentes.
- Arranque con la configuración guardada; Codex y Claude reciben el brief como
  prompt inicial. El orquestador recibe un snapshot de tareas y decisiones.
- Resolución de ejecutables y wrappers npm .cmd/.ps1 en Windows, con argumentos
  literales; respuestas a consultas básicas de cursor, estado y tamaño del terminal.
- Guardado mediante reemplazo atómico. Estado inválido se conserva y se informa.
  Una tarea cuyo proceso terminó queda interrumpida, nunca aceptada por inferencia.

## Ejecutar

Desde la raíz del repo, con Rust y Git disponibles:

~~~powershell
cargo +stable build --manifest-path tools/fluke-console/Cargo.toml --release --target-dir tools/fluke-console/target
tools/fluke-console/target/release/fluke-console.exe --repo "D:\ruta\repo"
~~~

Linux usa el mismo manifest, compilando en Linux; el binario resultante está en
tools/fluke-console/target/release/fluke-console. Linux/WSL sigue sin validación.

El estado se guarda en LOCALAPPDATA/fluke-console en Windows y en
XDG_STATE_HOME/fluke-console o HOME/.local/state/fluke-console en Linux.
Se puede elegir otra ubicación con --state-dir. Usar directorios distintos
crea instancias independientes y, por tanto, límites independientes.

## Recorrido manual

F1–F4 cambian de vista. F5 abre la configuración desde cualquier vista fuera
del modo de entrada directa al worker. Tab cambia de campo; en CLI, las flechas
izquierda/derecha cambian de proveedor. Escribir y Backspace editan valores;
Ctrl+S guarda y Esc cancela. Un modelo vacío usa el predeterminado de la CLI.
Autenticación y disponibilidad de modelos dependen de la CLI instalada.
Los argumentos son una lista JSON, por ejemplo ["--no-alt-screen"].
Para CLI personalizada, el token {model} señala dónde insertar el modelo.

Las flechas seleccionan tareas o sesiones.
Los comandos se escriben en la entrada inferior:

~~~text
:task Exportar JSON | El archivo tiene JSON válido y errores legibles
:limit 2
:start ID_DE_LA_TAREA
:fluke
:config
:repo "D:\otro repo"
:decision ¿La exportación debe incluir campos internos?
:answer 1 Solo campos públicos
~~~

Enter en Fluke inicia el agente configurado o entra al existente del proyecto.
Enter en Proyecto inicia la tarea seleccionada con esa misma configuración.
:fluke ejecutable y :start ID ejecutable siguen disponibles para terminales
manuales sin argumentos ni prompt. En Windows se puede usar powershell.exe
y en Linux /bin/bash. La configuración de cada sesión queda fija al arrancar.
El snapshot de contexto no restaura la conversación anterior ni se sincroniza
en vivo con las decisiones posteriores.

En F3, Enter entra en la sesión elegida y Ctrl+X vuelve a Fluke.
En las sesiones manuales, iniciar el agente y pedirle que lea .fluke-task.md.
Los worktrees parten de HEAD; no incluyen modificaciones sin commit del checkout.
El brief inicial se conserva también en .fluke/specs/ID.md del repo principal.
Editar ese archivo todavía no actualiza automáticamente el registro ni el worker.

Ctrl+Q fuera de la terminal solicita salir; una segunda pulsación confirma
si existen sesiones activas. Salir intenta terminar los procesos. En Windows
se solicita terminar el árbol mediante taskkill, comprobado en las pruebas.
:stop ID termina un worker; :stop fluke termina el orquestador del proyecto actual.
Esto no equivale a pausar ni a reanudar una conversación.
:close N libera la pantalla de una sesión ya terminada (posición en F3, desde 1).
Los worktrees y sus cambios se conservan; no hay limpieza automática.

## Límites de este incremento

La sesión llamada Fluke inicia un agente con contexto, **todavía no controla
workers automáticamente**. Quedan pendientes el protocolo de eventos y encargos,
el plan con dependencias, despacho automático, pausa, memoria compartida,
sincronización de intervenciones directas y evidencia de aceptación.
No se implementaron perfiles.

Las sesiones viven con la consola. No hay daemon, detach, restauración de
conversaciones ni certificación de ausencia de procesos huérfanos después de
un cierre forzado. Reiniciar marca tareas como interrumpidas y exige revisar
antes de iniciar otro proceso; nunca vuelve a enviar trabajo automáticamente.

El parser cubre una terminal VT100 con scrollback acotado y consultas CSI básicas,
sin protocolo de imágenes, mouse, consultas OSC de colores ni reflow completo.
Hay que verificar su compatibilidad con las CLI elegidas antes de adoptar
esta capa para ejecución de agentes. Los procesos externos no están aislados
ni tienen un límite de CPU; el control actual cuenta sesiones de tarea.

## Validación

La suite pasó en Windows: configuración y persistencia, bloqueo exclusivo,
recuperación, entrada, ConPTY, literalidad de argumentos, dos worktrees con
límite de workers y prueba del ejecutable completo mediante teclado.
La integración reutiliza el transporte PTY y repite dos de sus pruebas.
Se puede ejecutar con:

~~~text
cargo +stable test --manifest-path tools/fluke-console/Cargo.toml
~~~

Pendiente: agentes autenticados con modelos reales, intervención concurrente
entre repos, cierre forzado y detección de procesos huérfanos.
Medir CPU/memoria en reposo y con agentes reales; revisar procesos descendientes.
Capturar las cuatro vistas a 140×40 y 80×24 y compararlas con los mockups.

## Procedencia

Código nuevo, sin fragmentos copiados de Herdr en este incremento.
Se revisaron su backend PTY y su ciclo de sesiones como referencia:
herdrdev/herdr, commit 4f296c295b4a758af8589e46d2d7afb3743a709a.
Si se incorpora código literal, se conservarán avisos y atribución del origen.
La aplicación usa ratatui, crossterm, portable-pty y vt100 directamente.
