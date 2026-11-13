# Adaptador ACP para workers de Fluke

Estado al 2026-10-14. `tools/fluke-console-go`. Describe lo implementado, lo
verificado y las costuras que faltan para que un worker corra por ACP.

## Qué es y por qué

El Agent Client Protocol (ACP) es JSON-RPC 2.0 por stdio con un objeto JSON por
línea. Un agente que lo habla entrega eventos estructurados (fragmentos de
mensaje, llamadas a herramientas, plan, pedidos de permiso) en lugar de una
terminal que hay que interpretar. Con eso Fluke puede:

- Mostrar tarjetas de herramientas y streaming reales.
- Reportar tokens y costo del orquestador y de los workers cuando el agente los
  informa (`usage_update`).
- Delegar a modelos de otras plataformas usando agentes que ya los soportan
  (por ejemplo OpenCode), sin que Fluke gestione claves ni OAuth.

## Implementado

[acp.go](../../tools/fluke-console-go/acp.go) es el cliente:

- Transporte: líneas JSON, un lector, correlación por `id`, límite de 8 MiB por
  mensaje, líneas que no son JSON-RPC se ignoran (avisos de npm, banners).
- Llamadas: `initialize`, `session/new`, `session/prompt`, `session/cancel`.
- Eventos entrantes: `message`, `thought`, `tool`, `tool_update`, `plan`,
  `usage`, `other`. Un callback `OnEvent` que no debe bloquear.
- Permisos: `session/request_permission` pasa por `OnPermission`. Sin política,
  elige una opción `reject_*`; si no hay, cancela. Nunca aprueba por su cuenta.
- Capacidades: Fluke **no** anuncia `fs` ni `terminal`; el agente usa sus propias
  herramientas. Cualquier otro pedido del agente recibe `-32601`.
- Cierre: el stdin se cierra primero; si el proceso no sale en 2 s se mata.
- `--acp-check "<comando>"`: arranca el agente, hace solo el `initialize` (sin
  sesión ni modelo, sin tokens) e imprime lo que ofrece.

[acp_test.go](../../tools/fluke-console-go/acp_test.go) usa un agente falso por
pipes: handshake y turno con eventos en orden, política de permisos (permite,
cancela, rechaza por defecto), pedidos no soportados, error y ruido, salida del
agente sin colgar, y cancelación del turno.

## Verificado contra un agente real

`fluke-console --acp-check "opencode acp"` en Windows, con OpenCode 1.18.34:
protocolo 1, `loadSession` sí, imágenes sí, audio no, método de auth
«Login with opencode». Es el único adaptador instalado en esta máquina; no se
probó Codex ni Claude por ACP (no hay `codex-acp` ni `claude-code-acp` en PATH).
No se hizo ningún turno con modelo: gastaría la cuota de quien lo corra.

Pendiente de verificar con agentes reales: forma exacta de `usage_update` y de
`tool_call_update`, `session/load` para retomar, el flujo `authenticate` y el
comportamiento de permisos con cada agente.

## Workers por ACP (OpenCode): cómo quedó

Decisiones tomadas con el usuario el 2026-10-14: el worker por ACP **sigue
reportando con evidencia explícita** (mismo contrato de archivos que un worker
PTY) y **todo permiso de herramienta se pregunta**, sin lista de permitidos.

Solución: Fluke ya aloja terminales, así que el agente ACP corre detrás de un
front-end de terminal que es este mismo binario (`--acp-worker opencode`,
[acp_worker.go](../../tools/fluke-console-go/acp_worker.go)). Eso deja intactos el
worktree, el contrato, `update.json`, el editor de mensajes, la revisión y la
recuperación.

| Pieza | Cómo funciona |
|---|---|
| Arranque | `launchArgv` para el proveedor `opencode` devuelve `[fluke-console, --acp-worker, opencode, --, <prompt>]`; el prompt es el mismo de un worker PTY |
| Estado | el front-end fija el título de la ventana a `fluke-acp:working`, `:blocked` o `:idle`; `detectAgentState("opencode", …)` lo lee |
| Permisos | `session/request_permission` se imprime con opciones numeradas, el título pasa a `blocked` (Fluke lo muestra en Atención) y nada se aprueba hasta que la persona responde; Enter vacío rechaza |
| Mensajes | pegado con bracketed paste = un solo prompt; el editor de mensajes de Fluke funciona como con Codex/Claude |
| Cancelar | Ctrl+C durante un turno envía `session/cancel` |
| Modelo | no se puede elegir por tarea: se define en la configuración de OpenCode; `:agent ID \| opencode \| modelo` lo rechaza |
| Asignación | `:agent ID \| opencode \| ` en una tarea detenida y pendiente |

Verificado: pruebas con agente falso (turno, estado por título, permiso que
espera a la persona, rechazo con Enter vacío, pegado, cancelación, argv) y un
arranque real contra OpenCode 1.18.34 (handshake y sesión, sin turno de modelo).

Verificado con un turno real (2026-10-14, OpenCode 1.18.34, repo temporal):
el turno responde y termina en `end_turn`, la herramienta `write` crea el
archivo, el título pasa por `starting`, `idle`, `working`, `blocked` y `idle`, y
al cerrar la entrada el proceso sale con código 0. Con el permiso respondido
`1` la escritura se completa; con Enter vacío se rechaza, el archivo no se crea
y el turno termina sin colgarse.

Hallazgo: OpenCode, con su configuración por defecto, **no pide permiso** para
escribir archivos ni para ejecutar comandos. Para que «preguntar siempre» sea
real, el front-end arranca OpenCode con
`OPENCODE_CONFIG_CONTENT={"permission":{"edit":"ask","bash":"ask"}}`, salvo que
la persona ya haya definido esa variable o que Fluke autónomo esté activo. Las
claves `edit` y `bash` son las verificadas; otras herramientas (`webfetch`,
MCP) siguen su configuración.

## Tarea completa de punta a punta (2026-10-14)

`TestLiveACPWorkerEndToEnd` (`live_acp_worker_windows_test.go`, solo con
`FLUKE_LIVE_ACP_BIN`) corre una tarea real: Fluke crea el worktree y el
contrato, lanza un worker de OpenCode por ACP, el worker lee el contrato, crea
`NOTAS.md`, lo verifica y reporta con evidencia por el canal de archivos de
Fluke; la tarea llega a `awaiting_review` con el reporte y la evidencia, el
contenido es exacto, el checkout principal queda intacto y la revisión muestra
el cambio.

Resultado: 6 corridas reales, 5 completas en 28–42 s y 1 que quedó 5 minutos en
«trabajando» sin llegar a reportar (la última pantalla era una herramienta
completada; no se pudo determinar si fue latencia del proveedor o un cuelgue).
Por eso el front-end avisa «sin novedades hace N s» cada minuto de silencio.

Hallazgos que cambiaron el diseño:

- El contrato pide escribir un archivo temporal y renombrarlo; el agente lo
  hacía con `write` y un `Move-Item` por shell, lo que costaba hasta 8 permisos
  por tarea trivial. Ahora: las escrituras dentro de `<worktree>/.fluke-worker/`
  (el canal propio de Fluke) se conceden sin preguntar y el prompt de un agente
  ACP pide escribir el reporte directamente en su ruta final. Cualquier otra
  ruta y todo comando de shell se siguen preguntando.
- Resultado: una tarea sencilla queda en un solo permiso (el archivo de código).

No verificado: la recuperación tras reiniciar la consola (un worker ACP vuelve
a empezar y se apoya en los archivos del worktree, como pide el prompt), el
orquestador de Fluke sobre OpenCode con su prompt real y varias tareas en
paralelo.

## Orquestador por ACP

El mismo front-end sirve al orquestador: en F5 → Agente se elige el proveedor
`opencode` (sin modelo ni argumentos) y `startSession` lo lanza con el contrato y
el prompt de siempre (`contract.md`, órdenes por archivo). Los mensajes del chat
entran por `dispatchChats` como a cualquier worker, y el estado sale del título
de la ventana.

- **Permisos:** igual que en los workers, se preguntan siempre. Con «Fluke
  autónomo» activado (Ctrl+A en F5 o `--autonomous`) el front-end recibe
  `--auto-approve` y concede cada pedido una vez (`allow_once`), nunca
  `allow_always`. Es el mismo todo-o-nada de Codex y Claude, y sin ese modo el
  orquestador se bloquea en cada escritura de archivo (con OpenCode, porque
el front-end lo arranca pidiendo permiso para editar y ejecutar).
- **Sesión:** no hay retoma nativa; tras reiniciar, el orquestador arranca de
  nuevo y se reconcilia con el contexto local, como pide su prompt.
- **Conexión:** el estado de OpenCode es el del handshake `initialize`; la cuenta
  y el modelo viven en la configuración de OpenCode (`opencode auth login`
  desde Ctrl+L).
- **Primer arranque:** el asistente de configuración inicial sigue ofreciendo solo
  Codex y Claude; OpenCode se elige después desde F5.

Verificado con pruebas: lanzamiento del orquestador (argv y prompt con el
contrato), `--auto-approve` solo en modo autónomo, argumentos rechazados fuera de
esa lista, política de aprobación una vez, selección del proveedor y sondeo sin
CLI. Verificado de punta a punta con modelo real (`TestLiveACPOrchestratorEndToEnd`,
opt-in): el orquestador sobre OpenCode lee su contrato, crea la única tarea del
objetivo acordado, Fluke inicia un worker de OpenCode, el worker entrega
(`result.txt` exacto, checkout principal intacto), el orquestador es despertado
y pide la revisión humana. 3 corridas, 3 completas en 103–168 s.

Permisos: la primera corrida pidió 13 respuestas, 11 del orquestador. Causas:
el contrato manda escribir `update.json.tmp` y renombrarlo (5 pedidos, con
`Move-Item` por shell) y el agente exploraba con comandos de shell. Ahora el
directorio del contrato del orquestador se pasa al front-end como canal
(`--channel=<dir>`, escrituras concedidas sin preguntar) y el prompt de los
agentes ACP pide escribir directo y leer con sus herramientas de lectura. La
siguiente corrida pidió **4**, todas del worker (una escritura de código y tres
comandos de verificación) y ninguna del orquestador.

Siguiente: el consumo (`usage_update`) en la ficha de conexión y tarjetas de
herramientas estructuradas en F2, para lo que el front-end tendría que dejar de
ser un terminal y entregar los eventos a Fluke.
