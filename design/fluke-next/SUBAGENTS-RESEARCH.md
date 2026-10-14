# Gentle Shell: subagentes y base de ejecución para Fluke Next

Investigación del 13 de octubre de 2026. Se leyó código real y el paquete publicado; no se instalaron dependencias ni se ejecutaron builds, linters o pruebas. **Verificado** describe implementación observada; **propuesta** identifica decisiones para Fluke, todavía no capacidades implementadas.

Referencias fijadas:

- Gentle Shell `bedba1f12b4f5626e05129f7e4bc3693ce9cd829`, paquete `gentle-pi` 4.2.0, MIT, Node >=22.19.0. [package.json](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/package.json).
- Pi `@earendil-works/pi-coding-agent` **1.2.0**, MIT, Node >=22.19.0. Se descargó y extrajo su tarball npm para contrastar `dist/*.d.ts` con implementación; tag `v1.2.0` corresponde a `06a466935536f8c9bcacb2d5efc0fc021be1bdff`. [Metadatos npm de esa versión](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/1.2.0), [fuente versionada](https://github.com/earendil-works/pi/tree/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent).
- Integridad npm observada: `sha512-h/4WaVWv1VlCaY8x8qEN5U+7jbF/e7+Ck6moPeEOFn5juMTWwNAXjwgYM7gRgbBYh8Zppwt6qWvJDzNTf4GNEQ==`. Esto identifica el artefacto consultado; no reemplaza el lockfile futuro.

## Conclusión de arquitectura

Gentle Shell es un harness sobre Pi. El orquestador es una sesión Pi con extensiones, herramientas y políticas; cada subagente es otro proceso Pi, con su propio contexto y sesión. No se necesita reconstruir el streaming de proveedores, OAuth, almacenamiento conversacional ni terminal desde cero para tener una experiencia similar.

**Propuesta:** Fluke Next empieza como paquete/extensión Pi propio. Pi aporta conversación interactiva, proveedores, autenticación, selección de modelos, contexto y sesiones; Fluke aporta brief, desglose, dependencias, asignación de agentes, límites, seguimiento y verificación de entregables. El diseño neón puede venir después. Evitar arrastrar todos los sistemas ODD/review/telemetría y compatibilidad histórica de Gentle a esta primera base.

Una extensión con hijos RPC mantiene la misma frontera que Gentle, deja cambiar después la UI y aísla bloqueos o caídas de workers. Una aplicación SDK también es válida, pero obliga a construir antes más interacción y presentación. La elección propuesta no es un fork completo de Gentle ni un reemplazo de su marca.

## Cómo crea y controla los hijos

**Verificado:** `TaskRunner` mantiene una cola, un mapa de procesos vivos y promesas de finalización. `run()` crea el registro y reserva superficies de escritura sincrónicamente, antes de encolar; `pump()` admite mientras `live.size < maxConcurrency`. El valor por defecto es cinco procesos, con cuatro minutos de inactividad y treinta minutos de silencio mientras una herramienta está en vuelo. Son presupuestos renovables de silencio, no un máximo total de duración. [Cola y admisión](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L378-L523), [valores por defecto](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-config.ts#L107-L110).

El proceso recibe `--mode rpc --session-dir ...`, `--session ...` para continuaciones, modelo/razonamiento, herramientas y prompt de rol. Instrucciones de más de 1.000 bytes se transportan en archivo temporal para no exceder límites de argumentos. Se ejecuta sin shell, con `cwd` elegido, pipes e IPC; ventanas ocultas en Windows y grupo de procesos separado en POSIX. Después envía `get_state` y `prompt` por JSONL. [Argumentos](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L310-L331), [lanzamiento](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L527-L658).

Las definiciones de agentes son Markdown con frontmatter: nombre, descripción, instrucciones, modelo, razonamiento, modo y herramientas. La configuración global/proyecto define concurrencia y perfiles. Los parámetros efectivos se resuelven antes de encolar, de modo que cambiar un perfil no cambia silenciosamente tareas ya admitidas. [Definiciones](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-config.ts#L40-L75), [resolución congelada por lanzamiento](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1665-L1758).

Los hijos reciben una marca de proceso y la extensión reconoce ese contexto: registra mensajería al padre y retorna, sin registrar el orquestador completo. Esto impide reproducir recursivamente todo el sistema de delegación desde cada hijo. El launcher transmite explícitamente qué extensiones deben cargarse; no supone que las extensiones inyectadas en el padre aparecen automáticamente en los hijos. [Modo hijo](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L502-L512), [inyección de paquetes](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/child-package-injection.ts#L1-L65).

**Límite:** proceso y sesión separados no son un sandbox del sistema operativo. Las herramientas autorizadas y el `cwd` determinan el comportamiento, pero una herramienta de shell conserva los permisos del usuario.

## RPC: aceptar una orden no significa terminar el trabajo

**Verificado:** RPC usa un objeto JSON por línea, LF como separador y CRLF permitido. Las respuestas se correlacionan por `id`; eventos conversacionales no necesariamente tienen ese identificador. Hay que suscribirse antes de enviar el prompt y consumir stdout continuamente. No dividir por separadores Unicode dentro de cadenas JSON. [Contrato Pi RPC](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/rpc.md#L21-L89).

Tres momentos diferentes:

1. `response` con `success: true` de `prompt`: aceptado, encolado o manejado por una extensión.
2. `agent_end`: terminó un ciclo interno; puede seguir retry, compactación, recuperación de contexto, steering o follow-up.
3. `agent_settled`: no continuará automáticamente; recién aquí se decide éxito o fallo de la tarea.

`prompt.data.disposition === "handled"` no inicia una ejecución y puede no emitir `agent_settled`. Un cliente que siempre espera ese evento queda colgado hasta su timeout. [Contrato del prompt](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/rpc-commands.md#L7-L42).

Gentle normaliza texto, pensamiento, herramientas, uso, preguntas y estados. Guarda la respuesta final candidata desde `agent_end`, pero sólo decide completar en `agent_settled`; si no tiene reporte final, falla explícitamente. Un exit 0 anticipado tampoco se considera prueba suficiente de éxito. [Normalización](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-protocol.ts#L309-L355), [finalización](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L826-L892), [exit prematuro](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L1032-L1056).

**Propuesta Fluke:** registrar por separado estado del trabajo, último evento, reporte candidato, resultado definitivo y diagnóstico. Hacer idempotente finalizar una tarea. Preservar evidencia de fallos intermedios aunque un retry termine exitosamente.

## Mensajería, preguntas y entrega de resultados

Gentle usa dos canales con propósitos distintos:

- RPC JSONL para prompt, steering, abort, eventos y solicitudes de UI.
- IPC de Node propiedad del padre para mensajes del hijo: notificaciones, consultas y respuestas correlacionadas. No confía en que texto del modelo afirme ser un mensaje autorizado.

**Verificado:** mensajes de hasta 8 KiB, ocho notificaciones en vuelo, cuatro consultas; ACK de notificación con timeout de dos segundos y consulta de treinta segundos. El padre verifica que el destinatario sea un hijo vivo y que la sesión propietaria siga activa. El ACK significa aceptación, no que el modelo ya leyó o resolvió el pedido. [Frames y límites](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-messaging.ts#L1-L90), [respuesta y propiedad](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L469-L482).

El padre ocupado recibe resultados por `steer` antes de la siguiente llamada al modelo. `followUp` los demoraría hasta que el orquestador termine toda la cadena de herramientas. Si está compactando sin un run activo, Gentle retiene mensajes. Si está inactivo, persiste contenido y agrupa una única señal de continuación; maneja carreras entre un wake y un prompt del usuario. [Router del padre](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L886-L989), [entrega y reintentos](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1050-L1095), [fronteras de ejecución](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1192-L1237).

Modo `task` espera resultado o primera consulta; modo `background` devuelve ID inmediatamente y promete push al terminar. Las herramientas incluyen listar, resultado, cancelar, enviar mensaje, responder y continuar. Continuar crea una tarea nueva usando la sesión del hijo anterior; requiere estado terminal y archivo de sesión. [Modos](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1782-L1852), [continuaciones](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L2201-L2238).

**Propuesta Fluke:** primera implementación con batches paralelos acotados y resultado consolidado al orquestador es menor y más verificable que copiar inmediatamente el router completo de background. Si se ofrece background, no sustituir push por polling ni mostrar una promesa de continuación que el runtime no cumple.

## Cancelación, limpieza y recuperación

**Verificado:** cancelar una tarea en cola finaliza sin crear proceso. Cancelar una viva envía `abort`, termina el proceso/grupo, escala a SIGKILL a los 250 ms y confirma salida. Después de un segundo sin confirmación, marca fallo y pone la capacidad en cuarentena: no libera el slot ni las superficies de escritura mientras el proceso podría seguir trabajando. [Cancelación](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L485-L506), [limpieza y cuarentena](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L913-L1084).

El propio código reconoce una diferencia crítica: POSIX puede terminar el grupo de procesos; en Windows `ChildProcess.kill()` no ofrece la misma garantía sobre descendientes. No presentar cancelación del árbol completo como resuelta en Windows por copiar este runner. Para una garantía fuerte hace falta un supervisor con Job Objects u otro mecanismo verificado; `taskkill /T` puede servir para una primera implementación acotada, pero tampoco equivale a pertenencia persistente a un Job Object.

Historial: un JSON por tarea finalizada, escritura a temporal y rename, más el JSONL de sesión Pi del hijo. Al recuperar historial se muestran tareas terminadas; no se encontró en estos componentes un scheduler durable que retome automáticamente procesos vivos después de un crash del host. La continuación explícita usa el archivo de sesión anterior. [Persistencia](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-history.ts#L5-L79), [restauración](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1461-L1485).

**Propuesta Fluke:** al reiniciar, todo `running` que no pueda asociarse a un proceso supervisado debe pasar a `interrupted/unknown`, conservar su sesión y exigir una reanudación explícita. Nunca relanzar automáticamente escritura porque faltó el mensaje de éxito. El presupuesto y la reserva de archivos deben sobrevivir a esa incertidumbre.

## Worktrees y escritura concurrente

**Verificado:** el runner recibe un directorio existente. Valida su raíz real y `git-common-dir`, registra el worktree sólo después de que el proceso arranca y evita atribuir lanzamientos fallidos a cambios reales. `workspace_root` apunta a un worktree del mismo clone; otro repositorio usa una ruta distinta y autorización de la sesión interactiva. [Validación Git](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/session-worktree-registry.ts#L21-L40), [registro](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/session-worktree-registry.ts#L147-L181), [admisión del destino](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1639-L1664).

No hay en esta ruta un `git worktree add` automático por cada subagente, ni un merge o borrado automático al finalizar. El registro de worktrees no es su gestor de ciclo de vida. Gentle también permite varios agentes en un worktree y usa reservas de superficies de escritura para evitar superposición entre ciertos escritores acotados. Esto es coordinación del harness, no aislamiento físico ni protección general contra comandos de shell.

**Propuesta Fluke:** investigación paralela sin escritura y un solo escritor por checkout son un inicio seguro y pequeño. Para escritura paralela independiente, crear worktrees gestionados y conservar branch/commit base, propietario, cambios y estado de integración. La integración debe ser una fase explícita del orquestador con revisión de conflictos, y la limpieza debe preservar trabajo no integrado.

## Uso y costos de los hijos

**Verificado:** desde `message_end` de respuestas assistant, Gentle suma `usage.totalTokens` y `usage.cost.total` al registro de tarea. Esta cuenta no es una factura de suscripción ni una consulta de cuota de cuenta. Los metadatos opcionales de observación incluso declaran cobertura parcial: respuestas finales assistant, sin herramientas, compactación, retries ocultos del proveedor ni replay de historial. Distinguen modelo seleccionado de metadatos reportados por la respuesta. [Extracción del uso](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-protocol.ts#L330-L338), [cobertura declarada](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/agents-runner.ts#L86-L99).

**Propuesta Fluke:** mantener separados tokens reportados, costo estimado por catálogo, consumo de plan y gasto facturado. `0` o ausencia de precio no deben mostrarse como “gratis”. El padre y cada hijo consumen contexto y solicitudes: el desglose de tareas debe permitir elegir concurrencia y modelos por rol antes de lanzar trabajo costoso. Los límites de gasto estimado son controles locales, no garantías de límite exacto de facturación.

## APIs Pi 1.2.0 comprobadas para implementar

### Extensión nativa recomendada

Exportar por defecto una función que recibe `ExtensionAPI`. Registrar herramientas con schema TypeBox y `execute(toolCallId, params, signal, onUpdate, ctx)`. `ctx` expone sesión, modelo, registro de modelos, directorio, abort e información de idle. `pi.appendEntry` guarda estado propio sin enviarlo automáticamente al modelo; `pi.sendMessage` entrega mensajes custom con `deliverAs: steer | followUp | nextTurn` y `triggerTurn`. [Tipos extension](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/extensions/types.ts#L1671-L1778).

Para Fluke: herramientas propias de brief/plan/dispatch/result, estado versionado en entradas custom y un launcher que carga explícitamente sólo la extensión deseada. Una allowlist de herramientas no debe confundirse con un sandbox: herramientas deferred/codemode tienen reglas de exposición propias.

### SDK si la UI propia pasa a ser necesaria

`createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel, tools, excludeTools, customTools, resourceLoader, sessionManager, settingsManager })` devuelve `{ session, extensionsResult, modelFallbackMessage }`. En **1.2.0** `tools` es `string[]`, no un array de instancias Tool; auth/catálogo se coordinan mediante `ModelRuntime`. No usar ejemplos viejos con `authStorage` o `modelRegistry` como opciones de creación. [Contrato real](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/sdk.ts#L48-L110).

`session.subscribe`, `session.prompt`, `session.steer`, `session.followUp`, `session.abort` y `session.dispose` proveen el ciclo de vida. `SessionManager.create/open/continueRecent/inMemory/forkFrom` controla persistencia. Para reanudar, pasar `SessionManager.open(path)`; el ejemplo `continueSession: true` que aún aparece en un comentario del SDK no coincide con la interfaz actual. [Manager versionado](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/session-manager.ts#L1755-L1793).

### Cliente RPC exportado: útil, con límites

Existe `RpcClient`, con `start`, `onEvent`, `prompt`, `steer`, `abort`, `getState`, `getSessionStats`, `waitForIdle` y `promptAndWait`. Pero su implementación 1.2.0 usa `spawn("node")`, no oculta ventanas ni crea grupos, acumula stderr sin límite y lo copia al terminal. `stop()` puede resolver después del timeout de SIGKILL sin confirmar exit; los waits de eventos esperan `agent_settled` o timeout. Un wrapper no puede corregir limpiamente todos esos detalles porque el handle del proceso es privado. [Spawn y stop](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/modes/rpc/rpc-client.ts#L77-L169), [espera de eventos](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/modes/rpc/rpc-client.ts#L471-L521).

**Propuesta:** un cliente JSONL Fluke pequeño con `process.execPath`, entrypoint absoluto resuelto desde el paquete fijado, `windowsHide: true`, IDs, límites de buffers, errores de streams, plazo inicial, timeout de actividad y finalización confirmada. No construir un SDK alternativo: sólo adaptar el contrato RPC que Pi ya soporta. Cerrar stdin solicita shutdown ordenado; no existe necesidad de inventar un comando RPC `shutdown`.

Argumentos iniciales de hijos controlados: `--mode rpc --no-extensions --no-skills --no-prompt-templates --session-dir ... --tools ... --provider ... --model ...`, más `--extension <child-extension>` sólo si hace falta mensajería propia. `--no-extensions` permite cargar extensiones explícitas; desactiva descubrimiento/configuración. [CLI versionado](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/cli.md#L190-L207).

## Dependencias, licencia y validación pendiente

Dependencias mínimas propuestas: `@earendil-works/pi-coding-agent: 1.2.0`; `typebox: 1.3.27` si Fluke importa sus schemas directamente. Declarar `@earendil-works/pi-ai: 1.2.0` o `pi-tui: 1.2.0` sólo cuando se importen realmente. Usar Node >=22.19.0 y un lockfile al instalar; el paquete Pi usa rangos `^1.2.0` para varios componentes internos, así que fijar únicamente el top-level no congela todo el árbol.

Gentle y Pi usan MIT: se pueden estudiar/adaptar y distribuir cambios conservando los avisos de licencia correspondientes al código copiado. Esta investigación no copia sus implementaciones al producto ni implica disponibilidad contractual de cualquier proveedor.

Antes de afirmar que funciona: validar en Windows lanzamiento oculto, paths con espacios, cierre de streams, cancelación con descendientes, prompts `handled`, error de autenticación, retry entre `agent_end` y `agent_settled`, cambio de sesión mientras un hijo trabaja, fallos de disco y duplicación de finalización. La primera entrega puede incluir pruebas de estos contratos sin ejecutarlas en la sesión del agente, respetando AGENTS.md. Las pruebas reales con proveedores consumen sus credenciales y cuota; no se realizaron durante esta investigación.
