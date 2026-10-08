# Fluke Console — base activa en Go

[English quick start / Linux and Omarchy](GETTING-STARTED.md)

Aplicación nativa de terminal con interfaz, ventanas y sesiones propias de
Fluke. Herdr y Tuios son referencias para estudiar el estado de los agentes,
el movimiento de ventanas y el mouse en consola; no son dependencias ni
aplicaciones embebidas. La dirección visual sigue los mockups de
[`design/fluke-herdr`](../../design/fluke-herdr/VISUAL-DIRECTION.md).

Esta base usa Bubble Tea y Lipgloss para la interfaz, PTYs locales y un emulador
VT. El [prototipo Rust](../fluke-console/README.md) se conserva como referencia.
El ejecutable Windows ocupa aproximadamente 9 MiB.
Este tamaño no constituye una medición de consumo, velocidad o estabilidad.

## Compilar y ejecutar

Requiere Go 1.26.6 y Git con `merge-tree --write-tree` para la integración guiada.
Desde esta carpeta, en Windows:

```powershell
go build -trimpath -ldflags "-s -w" -o fluke-console.exe .
.\fluke-console.exe --repo "D:\ruta\repositorio"
```

`--state-dir` permite elegir un directorio de estado independiente. El valor
por defecto usa `LOCALAPPDATA/fluke-console` en Windows, `XDG_STATE_HOME` cuando
está definido, o `~/.local/state/fluke-console`.

Go permite generar ejecutables para Linux y macOS. Las rutas de procesos y
reemplazo de archivos tienen implementaciones por plataforma; la ejecución
real de esta aplicación en Linux/macOS todavía requiere validación.
Se verificó la compilación sin CGO para Linux amd64 y macOS arm64 el 2026-10-08.

## Uso

- En Windows, `open-fluke.cmd` abre la aplicación en Windows Terminal. Acepta
  `-Repo ruta`, `-StateDir ruta`, `-Setup` y `-Language en/es`; `open-fluke.ps1 -Here` usa la consola actual.
  El launcher usa un comando codificado para conservar rutas con espacios.
- F1: conversación con Fluke y vista global. F2: objetivo, plan y workers.
  F3: sesiones. F4: decisiones de producto/alcance. F5: configuración.
  Funcionan también desde configuración, GitHub y revisión. Alt+1–Alt+7 son
  alternativas cuando el equipo reserva las teclas de función.
- F2 → `m`, o Ctrl+X → `m` en F3, abre el editor de mensaje directo al worker.
  Enter guarda la instrucción para el worker y el orquestador antes de enviarla;
  Shift+Enter agrega una línea y Esc cierra sin enviar. Los borradores sobreviven
  al cambio de panel. `:tell ID | mensaje` es la alternativa por comando.
  Una respuesta guardada se corrige con F4 → Enter o `:amend N respuesta`:
  conserva el original y agrega su reemplazo con fuente. El worker confirma
  la nueva instrucción antes de entregar; no se inicia solo si estaba detenido.
- F1 → Tab al panel de atención → flechas/Enter abre el proyecto, tarea o sesión
  correspondiente, incluyendo entregas y permisos de orquestadores sin foco.
- Los PR publicados se consultan en segundo plano: una consulta a la vez y
  como máximo una automática por PR por minuto. F2/F7 muestran checks, revisiones
  y estado remoto; Ctrl+R reintenta. Se conserva el último estado verificado ante
  errores. Un merge remoto no certifica integración local ni libera dependencias.
- F7: revisar el diff de la tarea seleccionada. PgUp/PgDn leen, `r` actualiza
  y Esc vuelve. Incluye commits del worker y archivos nuevos.
  En una entrega lista, `a` prepara la aceptación y Enter la confirma: libera
  el worker y guarda el snapshot de los archivos aceptados. Después, `m` muestra
  una vista previa de integración: rama de destino, cambios y commit cuando falta.
  Enter confirma el commit/merge local; Esc cancela sin cambiar Git. Archivos o
  ramas que cambiaron desde la aceptación/vista previa requieren nueva revisión.
  Los conflictos detectados antes del merge dejan el destino intacto. Un fallo
  durante el merge conserva el estado de Git para resolverlo manualmente.
  Los hooks del repositorio se ejecutan; cambios adicionales quedan pendientes
  de revisión y bloquean dependencias. Las ramas/worktrees se mantienen;
  publicar cambios remotos es otro paso explícito.
- En una entrega aceptada, F7 → `p` prepara un PR: muestra repositorio, rama,
  destino, título y descripción. `e` edita; Tab cambia de campo y Ctrl+S vuelve
  a la vista previa. Enter autoriza el commit pendiente, push de la rama propia
  y creación de un PR borrador. Esc cancela. Si ya existe un PR abierto para
  esa rama, se actualiza conservando su estado borrador/listo para revisión.
  Se verifican archivos, referencias y contenido antes de escribir; cambios
  concurrentes requieren preparar otra vista previa. No se fuerza el push ni
  se publica la rama principal. Si falta localmente la base remota, primero
  hay que traerla con `git fetch origin`.
- Dentro de F5, Ctrl+G abre GitHub y Ctrl+O vuelve al orquestador. GitHub muestra
  disponibilidad y cuenta; Tab/Enter eligen Conectar, Actualizar o Desconectar.
  Conectar muestra un código OAuth: `o` abre el navegador para autorizarlo;
  Esc cancela. Desconectar pide confirmar porque afecta la cuenta compartida
  de `gh`. Los tokens se entregan por stdin a `gh`, sin guardarse en el JSON
  de Fluke. Las credenciales del entorno se identifican y no se sobrescriben.
- F6: GitHub. Consulta el `origin` de github.com con la sesión de GitHub CLI
  (`gh auth login`), sin guardar tokens en Fluke. Flechas eligen una issue,
  PgUp/PgDn desplazan la descripción, Enter prepara su importación y `r`
  actualiza. En terminales pequeñas, Tab alterna lista y descripción.
- En Fluke, Proyecto y Decisiones, Tab cambia de panel. La conversación conserva
  un borrador por repositorio; Enter abre la sesión o envía el mensaje al CLI activo.
  PgUp/PgDn o flechas permiten leer el historial. Ctrl+Y copia la conversación,
  la sesión, la issue o la revisión actual. Fuera del modo de mover ventanas,
  el mouse pertenece al terminal: seleccioná texto y usá su atajo de copia.
- El primer arranque guía detección de harnesses, modelo, GitHub, repositorio y
  cupo. El inglés es predeterminado; Ctrl+L elige español en el inicio y F5 →
  Ctrl+E cambia el idioma después. `--setup` reabre el recorrido y `--lang es`
  selecciona español. Enter inicia la configuración inmediatamente. Los títulos
  y bordes tienen corrupción e interferencia breves; opciones, campos y códigos
  de autorización se mantienen legibles. La detección usa
  PATH, sesión y catálogo locales, sin instalar CLIs ni consumir inferencia.
  Reconoce 24 comandos; por ahora Codex y Claude tienen adaptadores funcionales.
  La recomendación usa la instalación y el default compatible de Omarchy;
  no fija proveedor ni versiones de modelos. Fuera de un repo se abre el selector.
- F5 contiene: proveedor/CLI, ejecutable,
  modelo, argumentos y máximo global de workers. Enter/Ctrl+S guarda; Ctrl+U
  limpia el campo. Flechas eligen proveedor/modelo; cambiar proveedor limpia
  sus argumentos y modelo para evitar pasar flags incompatibles a otra CLI.
  Ctrl+R comprueba ejecutable y sesión local sin usar inferencias. El modelo
  predeterminado y las sugerencias del caché local se pueden seleccionar.
  Ctrl+Enter reinicia el orquestador actual con el modelo elegido y conserva
  objetivo, conversación y workers existentes. Las sesiones de workers nuevas
  usan la configuración guardada. Se muestra el modelo efectivo del orquestador.
  Una CLI autenticada no garantiza acceso remoto a cada modelo.
  Ctrl+L cede temporalmente la consola al login nativo de Codex/Claude y vuelve
  a Fluke al terminar; Fluke no almacena las credenciales del proveedor.
- En Windows, las instalaciones npm reconocidas de Codex/Claude se abren por
  su entrada real, conservando prompts multilínea, comillas y Unicode. Un
  wrapper desconocido que no puede preservar esos argumentos pide configurar
  el ejecutable nativo en F5.
- En F2, `q` alterna la cola de la tarea, `v` revisa y `p` pausa/retoma la tarea.
  Space pausa/retoma el proyecto. La pausa bloquea despachos y detiene sus
  workers conservando worktrees; Fluke sigue disponible para conversar.
  Retomar vuelve a encolar tareas pausadas pendientes/interrumpidas.
  Un fallo al cerrar un proceso mantiene ocupado su cupo y queda visible.
  Retomar un proyecto conserva las pausas individuales que pediste antes.
- En sesiones, Ctrl+X vuelve a la gestión de ventanas.
  En gestión, Enter entra al terminal, Tab cambia el foco y `t` ordena en mosaico.
  El mouse sobre el título mueve una ventana; sus bordes permiten redimensionarla.
- En gestión, PgUp/PgDn y Home/End leen el historial de la PTY. Dentro del
  terminal, Shift+PgUp/PgDn y Shift+Home/End permiten leerlo sin quitarle esas
  teclas a la CLI. Esc/End vuelve a la salida en vivo; escribir también vuelve
  al presente. Ctrl+Y copia la vista visible. El historial conserva colores y
  tiene un límite de 4096 filas/128K celdas de texto por sesión; vive en memoria
  y no se conserva al cerrar Fluke.
- Ctrl+Q pide confirmación de salida con `s`/`n`.
- Ctrl+K abre la entrada de comandos desde cualquier panel; `:` también lo hace
  fuera de la conversación. Esc cancela y Enter ejecuta.

Comandos disponibles:

```text
:repo ruta
:goal objetivo y alcance | criterio de aceptación
:task título | criterio de aceptación
:depends ID | ID1 ID2
:pause
:pause ID
:continue
:continue ID
:accept ID
:integrate ID
:pr ID
:rework ID | cambios pedidos
:start ID
:fresh ID
:fresh fluke
:queue ID
:unqueue ID
:review ID
:resume ID
:fluke
:stop ID
:stop fluke
:decision pregunta
:answer N texto
:amend N respuesta corregida
:tell ID | mensaje
:approve N
:reject N
:limit N
:github
:issue 123 | criterio de aceptación
```

Una tarea recibe un worker, un worktree y la rama `codex/fluke/ID`. El brief
queda en `.fluke/specs/ID.md` dentro del repositorio y en `.fluke-task.md` dentro
del worktree. El límite global contempla los workers de todos los repos y
las aperturas en preparación. El orquestador conserva una sesión por repo;
su contexto incluye el objetivo acordado, las tareas, decisiones y capacidad
global; sigue recibiendo novedades al cambiar de proyecto. La CLI `custom`
sirve para procesos de workers; el chat/orquestador requiere Codex o Claude.

Importar una issue conserva enlace y descripción en la tarea y en el brief;
no duplica una issue ya vinculada ni inicia su worker. Las consultas tienen
timeout de 20 segundos, se cancelan al cerrar y conservan el último resultado
si falla una actualización. F7 permite publicar/actualizar PRs; sincronizar
comentarios/estados de issues queda pendiente. Se verificó el acceso real
a `mdevel-uy/fluke` y la vista nativa con 23 issues abiertas el 2026-10-07.

## Estado y recuperación

El estado JSON mantiene la versión 1 e incorpora objetivo, conversación,
aceptación y pausa. No se debe abrir su estado extendido con el prototipo Rust.
Un bloqueo de
archivo impide abrir dos instancias sobre el mismo directorio de estado y
el guardado reemplaza el archivo de forma atómica. Al recuperar el estado,
las tareas `running` pasan a `interrupted`; no se relanzan automáticamente.
Cerrar una sesión conserva su worktree. La salida de un proceso no prueba
que la tarea haya satisfecho su aceptación ni autoriza un merge.

Codex y Claude conservan un UUID nativo por tarea/orquestador cuando se pudo
establecer su identidad. Al iniciar otra vez se usa ese UUID exacto y un contrato
nuevo, conservando la ejecución inicial que lo vinculó a Fluke. El contexto del
worker incluye decisiones/respuestas anteriores para reconciliar archivos antes
de repetir acciones. Nunca se usa `--last` ni un selector de sesiones ajenas.
Si el historial nativo falta o no se puede validar, la recuperación se bloquea;
`:fresh ID` o `:fresh fluke` permite iniciar otra sesión con el contexto/archivos
guardados. Claude recibe un UUID propio al arrancar. Codex reporta su variable
local de identidad; Fluke comprueba el UUID, worktree y primer prompt en el
transcript exacto. Ese formato interno puede cambiar y la validación falla de
forma conservadora. No se instalan hooks globales ni se copian credenciales.

Antes de abrir el proceso se guardan worktree, base, contrato y UUID nativo.
Un fallo de guardado impide arrancarlo. El primer mensaje humano también se
guarda como pendiente antes del arranque; un envío incierto tras un cierre
requiere revisión y no se repite automáticamente.

La publicación guarda la autorización antes de hacer push o escribir el PR.
La rama subida y el PR completamente verificado son estados distintos: una
respuesta fallida de GitHub no se presenta como publicación completa. Consultar
otra vez reconcilia el resultado remoto antes de reintentar; conserva el título
y descripción revisados. El cuerpo propuesto incluye resumen de cambios y
revisión humana, sin conversaciones completas ni rutas locales absolutas.

La integración guarda la intención antes de ejecutar Git. Si la consola se
cierra después del merge y antes del guardado final, F7 → `m` comprueba la
ascendencia y el árbol de archivos previsto antes de registrar el resultado
sin repetirlo. Si hubo otro commit de destino antes de esa reconciliación,
requiere revisión manual. Una operación Git pendiente o conflictos bloquean
nuevas integraciones hasta resolverlos. El commit requiere identidad Git y
configuración normal del repositorio; un fallo conserva los archivos.

## Estado de agentes y contrato inicial

La detección toma como referencia los manifiestos de Codex/Claude de Herdr:
lee el título OSC y algunos diálogos de aprobación en las últimas doce líneas de contenido. Las pantallas iniciales de confianza y
revisión de hooks se reconocen aparte.
Distingue trabajando, bloqueo, listo para entrada y turno terminado. Una CLI
personalizada queda sin clasificación automática. La inactividad y la salida
de un proceso nunca convierten una tarea en terminada. Esta primera detección
es conservadora y parcial; no instala los hooks nativos que también usa Herdr.

Cada arranque genera `.fluke-worker-contract.md` con una identidad nueva y un
prompt que pide leerlo. El archivo se excluye de Git mediante `info/exclude`.
El worker reporta JSON dentro de `.fluke-worker/`, también excluida de Git: versión, ejecución,
secuencia, estado y mensaje. Puede pedir una decisión (`needs_response`),
reportar un bloqueo (`blocked`) o entregar (`ready`). Fluke consulta esos
archivos una vez por segundo mientras hay workers activos, sin servidor nuevo.

Las preguntas aparecen en F4 asociadas al repo, tarea y ejecución. `:answer`
guarda y entrega la respuesta. Fluke espera a que la CLI quede disponible y
la reactiva automáticamente para leer el archivo y continuar. No envía avisos
a diálogos de permisos ni mezcla sus mensajes con un borrador humano.
Una escritura de continuación que queda incierta tras un fallo/reinicio se
revisa en la sesión; `:resume ID` autoriza reintentar. Repetir `:answer` no
reemplaza ni reenvía una decisión ya respondida. Las respuestas de otra
ejecución se conservan sin entregarse a la nueva.

Una entrega requiere un resumen y rutas de evidencia a archivos existentes
ubicados dentro del worktree. Esto valida el formato y los archivos, no la
veracidad del resumen ni el cumplimiento de la aceptación: requiere revisión
humana. Una entrega ocupa un cupo mientras su CLI sigue abierta. Reportes de
otra ejecución, secuencias repetidas y archivos inválidos no cambian la tarea.
El prompt guía al modelo; no garantiza que siga todas sus instrucciones.

## Objetivo, plan y coordinación

El recorrido principal empieza por la conversación: escribí lo que querés
lograr y presioná Enter. Ese primer mensaje viaja al abrir el orquestador.
Fluke propone el objetivo, alcance y aceptación en F4. `:approve N` acuerda
esa propuesta; `:reject N` la rechaza. Enter prepara la aprobación de una
propuesta y `r` su rechazo, para confirmar mediante la entrada de comandos.
El objetivo se conserva en el estado y como spec JSON en `.fluke/specs/`.

Dentro del objetivo aprobado, el orquestador puede crear tareas, encolarlas
y detener workers. Cada orden identifica su ejecución y secuencia; Fluke
contesta con un ack y evita repetir acciones. Crear tareas requiere el ID del
objetivo actual. El contrato obliga al modelo a mantenerlas dentro del alcance;
la correspondencia semántica la decide el agente, no un validador de texto.
Los nuevos alcances y decisiones de producto pasan por aprobación humana.

El canal local `.fluke/orchestrator/RUN/` contiene contrato, contexto, orden
y confirmación. No hay servidor adicional. La cola inicia tareas al liberar
cupo global; un inicio fallido se retira para revisar, sin bucles de reintento.

Una tarea puede declarar `depends_on` al crearse, o mediante `:depends ID | ID1 ID2`
antes de su primera ejecución. El despacho espera entregas aceptadas, sin cambios
pendientes de commit, cuyos commits estén integrados en el HEAD del proyecto y
en la base del worktree dependiente. Una revisión aprobada por sí sola no habilita
la dependencia. La cola conserva esas tareas y deja avanzar las independientes.
Un worktree dependiente viejo puede avanzar automáticamente al HEAD verificado
del proyecto antes del arranque, únicamente si sigue limpio, pertenece a Fluke
y no tiene commits propios desde su base. Un registro local en Git permite
reconciliar una interrupción entre ese avance y el guardado del estado. Cambios
propios, divergencias y archivos que colisionarían con el avance quedan intactos
y requieren intervención manual; no se hace reset ni rebase.
La comprobación corre fuera de la interfaz y se repite cada cinco segundos;
se valida de nuevo al preparar el worker. Integración/commit siguen siendo
acciones humanas. Por ahora se reconoce integración por ascendencia Git, no
por squash/cherry-pick equivalente. Una tarea sin cambios necesita otro criterio
antes de funcionar como dependencia.

F7 permite `[a]` aceptar la entrega y `[c]` escribir cambios pedidos para ese
mismo worker. El comentario se guarda antes de enviarse y también llega al
contexto del orquestador. Se usa el canal existente de respuestas; la CLI espera
a estar disponible. Una entrega anterior no vuelve a revisión: el nuevo reporte
debe confirmar `review_feedback_seq`, además de aportar nueva secuencia y evidencia.
Si la sesión se cerró, la corrección vuelve a la cola con el mismo worktree y
comentario en el encargo de arranque. Pausas y cupo global se conservan. Esto no
edita automáticamente el objetivo/spec cuando el comentario cambia el alcance.

La vista propia limita los mensajes de agentes a seis líneas/1200 caracteres
Unicode. Los reportes originales y sesiones completas permanecen disponibles;
los mensajes humanos no se recortan en su almacenamiento. Tras Enter, un mensaje
se guarda en la cola antes de liberar el compositor para un nuevo borrador.
Desencolar durante la preparación cancela su arranque. Los reportes, respuestas
y entregas actualizan el contexto y notifican al orquestador cuando su CLI
está disponible. Un ack que no puede escribirse se reintenta sin repetir la orden.

La conversación principal guarda mensajes `VOS` y `FLUKE`; el orquestador
entrega respuestas resumidas por `update.json`. El contrato pide únicamente
cambios relevantes, bloqueos, decisiones y próximo paso, sin trazas ni comandos.
Las respuestas idénticas consecutivas no agregan ruido. La terminal completa
sigue en F3. Los mensajes humanos esperan cuando la CLI está ocupada o muestra
un diálogo de permisos; se conserva el mensaje en el historial y no se mezcla con entrada
directa de la terminal. Un envío pendiente al reiniciar se vuelve incierto y
no se repite automáticamente. El historial conserva los últimos 100 mensajes
por repo; el objetivo y las decisiones se guardan por separado.

El flujo visual es objetivo → plan → ejecución → revisión humana. Las sesiones
y los comandos son accesos al trabajo concreto. Los resultados permanecen
`awaiting_review`; ni la inactividad ni el reporte del modelo autorizan un merge.

## Verificación

Las pruebas nativas Windows usan repositorios temporales y procesos locales,
sin llamadas a APIs de modelos por defecto. Primero compilar; después indicar la ruta
absoluta al ejecutable:

```powershell
$env:FLUKE_CONSOLE_TEST_BINARY = (Resolve-Path .\fluke-console.exe).Path
$env:FLUKE_CONSOLE_TEST_LAUNCHER = '1'
$env:FLUKE_CONSOLE_TEST_PR = '1'
go test -v -timeout 10m ./...
```

La suite regular pasó en Windows, incluyendo dos repos con capacidad
compartida, errores de guardado y configuración en una terminal baja. El
[informe de QA](QA-2026-10-07.md) separa resultados, correcciones y faltantes.
Se corrigió el caso de hijos que sobreviven al worker. En Windows cada sesión
se crea suspendida y se asigna a un Job Object antes de ejecutar código; salir
del padre o detener la sesión termina el grupo. El cupo se libera cuando el
job no tiene procesos activos. El job también termina al morir Fluke. Las
regresiones de salida del padre, cierre manual y cierre abrupto son regulares.
`FLUKE_GITHUB_LIVE_REPO` habilita además una prueba opcional de lectura real
y la captura GitHub en la prueba nativa; sin esa variable las pruebas de
GitHub usan un CLI de prueba, sin credenciales ni red.
`FLUKE_CONSOLE_TEST_PR=1` recorre edición, cancelación y publicación desde la
interfaz nativa con un GitHub simulado: comprueba el commit local y el contenido
publicado sin escribir en GitHub real.
El device flow se prueba con un servidor local y un CLI de prueba: pendiente,
autorizado, cancelación y entrega del token por stdin. La sesión real existente
se verificó desde F5; no se cerró ni se inició un login real en las pruebas.

Una muestra de 5,29 segundos con dos PTYs en reposo registró 20,5 MiB de working
set del proceso Fluke y 93,8 ms de CPU (1,77% de un núcleo). No incluye la memoria
de los workers ni demuestra estabilidad prolongada o rendimiento bajo carga.
Se puede repetir con `FLUKE_CONSOLE_MEASURE=1` en la prueba nativa.

## Validación con agentes reales en Windows

Se probó el contrato con Codex CLI 0.160.1 y Claude Code 2.1.220, usando sus
logins existentes. Cada prueba crea un repo/worktree temporal y abre la CLI
interactiva mediante el runtime ConPTY de Fluke. El modelo pregunta compact o
pretty, recibe pretty por el archivo de respuesta, crea result.json y verifica
su contenido. Se comprueba la entrega, el cupo y la conservación después de cerrar.

La prueba es opcional y consume uso real del modelo:

```powershell
$env:FLUKE_LIVE_PROVIDER = 'codex' # o 'claude'
go test -run '^TestLiveAgentContract$' -v -count=1 -timeout 7m
Remove-Item Env:FLUKE_LIVE_PROVIDER
```

Codex usa sandbox workspace-write, sin el daemon compartido; la prueba salta
la revisión de hooks nuevos sin confiarlos. Claude usa acceptEdits, Chrome
apagado y herramientas Bash/Read/Write/Edit permitidas para esa invocación.
La prueba acepta la confianza solamente del repo temporal que acaba de crear.
Los argumentos son de la prueba: la configuración personal de Fluke no se cambia.
El harness ejecuta la continuación automática del producto; no envía por su
cuenta la respuesta al teclado del worker. También hay una prueba opcional
`FLUKE_LIVE_ORCHESTRATOR=codex`: objetivo acordado → creación autónoma de tarea
→ worktree/worker → resultado verificado → aviso al orquestador → respuesta
resumida en la conversación de Fluke. Usa modelos reales y consumo de la cuenta.
`FLUKE_LIVE_REWORK=1`, junto a `FLUKE_LIVE_PROVIDER`, agrega corrección humana →
continuación del mismo worker → archivo corregido verificado externamente.
`FLUKE_LIVE_RECOVERY=1` agrega cierre/reapertura de la consola → recuperación del
UUID exacto → contrato nuevo → resultado verificado sin repetir la pregunta.
El recorrido de recuperación y corrección pasó también con Claude real el
2026-10-08: conserva el mismo UUID, la decisión anterior y el archivo corregido.

La ejecución real encontró y corrigió la separación de argumentos y prompt
ante opciones variádicas, Enter/Escape de Windows y la separación entre pegar
un mensaje y enviarlo. El contrato pide preguntas en archivo y mensaje final,
sin diálogos AskUserQuestion. Una pregunta válida puede omitir un resumen
redundante; las entregas siguen requiriendo resumen y archivos de evidencia.

## Pendiente

Cambiar el objetivo pausa tareas del alcance anterior antes de detener workers;
`:adopt ID` autoriza su encargo bajo el objetivo actual, sin iniciarlo solo. Los
briefs y la spec del objetivo se comprueban durante el seguimiento y antes de
continuar, aceptar o publicar. Editarlos conserva archivos y pausa la ejecución;
no se sobrescribe ni interpreta automáticamente una nueva intención.

Faltan reconciliación semántica de planes editados, recuperación de checkpoints internos
y compatibilidad VT avanzada. Squash/cherry-pick equivalentes, dependencias sin
cambios y worktrees dependientes con trabajo propio requieren intervención
manual. La pausa conserva archivos y detiene procesos;
no garantiza un checkpoint interno de cada herramienta. Selección nativa y
copia están implementadas; queda comprobarlas manualmente en el terminal del usuario.
GitHub permite configurar la conexión, leer/importar issues y publicar/actualizar
PRs; queda validar una publicación real y sincronizar estados. La ejecución en Linux/macOS, las tareas
largas y las mediciones bajo carga siguen pendientes. Compilar esos binarios
no sustituye probar sus PTYs y procesos en esos sistemas.
