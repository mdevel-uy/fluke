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

No verificado: un turno real con modelo, el comportamiento de permisos de
OpenCode en un repo real, y la recuperación tras reiniciar la consola (un worker
ACP vuelve a empezar y se apoya en los archivos del worktree, como pide el prompt).

Siguiente: el consumo (`usage_update`) en la ficha de conexión, tarjetas de
herramientas estructuradas en F2 y, al final, el orquestador por ACP.
