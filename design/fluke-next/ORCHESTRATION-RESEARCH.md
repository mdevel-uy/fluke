# Orquestación de Gentle Shell y propuesta Fluke

Investigación: 2026-10-13. Fuente fijada: `Gentleman-Programming/gentle-shell`, commit `bedba1f12b4f5626e05129f7e4bc3693ce9cd829`. Se inspeccionaron fuentes descargadas desde GitHub, sin instalar ni ejecutar Gentle Shell. **Verificado** significa observado en código o contrato escrito; no significa probado con un proveedor real. **Propuesta** e **inferencia** están identificadas expresamente.

## Conclusión

**Propuesta:** usar Pi como motor de sesiones, modelos y herramientas; Fluke debe ser dueño del brief, los requisitos, las tareas, sus dependencias, las decisiones del usuario y la aceptación del resultado. Gentle Shell aporta patrones concretos de coordinación, pero su política ODD basada en prompts no sustituye ese estado de producto.

No propongo importar Gentle Shell completo ni trasladar su módulo `gentle-ai.ts` como núcleo. El primer corte necesita un orquestador Fluke, tres roles acotados y una sesión recuperable; diseño visual y lenguaje neón 90s se incorporan después sobre ese mismo estado.

## Qué es realmente Gentle Shell

**Verificado:** el paquete se llama `gentle-pi`, declara versión `4.2.0`, publica el ejecutable `gentle-shell`, y registra extensiones, temas, prompts y skills para Pi. Sus peers son `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` y `typebox`. Es una capa sobre un runtime existente, no un multiplexor independiente que implemente todos los proveedores. [package.json, líneas 1–8 y 59–104](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/package.json#L59-L104).

**Verificado:** el padre recibe el contrato de orquestación en `before_agent_start`. El código distingue agentes nombrados, procesos hijos y sesión primaria; solo esta última recibe el harness completo. La integración usa `appendSystemPromptOnce` sobre `systemPromptOptions`, porque el bridge Claude no conserva un reemplazo de `systemPrompt`. El contrato de revisión se agrega únicamente con CLI nativa presente y RDD no desactivado. [extensions/gentle-ai.ts, líneas 10097–10170](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-ai.ts#L10097-L10170).

**Inferencia:** separar el prompt del padre y los prompts de los hijos reduce expansión de instrucciones y delegación recursiva accidental. Fluke puede conservar esa separación sin adoptar la personalidad ni la política editorial Gentleman.

## ODD, SDD y brief

**Verificado:** ODD significa Organic Driven Development. El harness describe siete pasos: autorizar, explorar, resolver incertidumbre, clasificar, registrar, implementar y cerrar. Pide aclarar decisiones reales; no impone un cuestionario fijo. Trabajo pequeño se resuelve directamente; trabajo que no podría retomarse desde la solicitud y el diff recibe seguimiento durable. [extensions/gentle-ai.ts, líneas 1326–1335](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-ai.ts#L1326-L1335).

**Verificado:** en este commit SDD está retirado. `buildRequest` y `launch` rechazan agentes SDD; un documento de trabajo explica la eliminación de comandos, agentes y OpenSpec. Un video de una versión anterior puede mostrar un flujo que ya no existe aquí. No corresponde describir ODD y SDD como opciones actuales equivalentes. [extensions/gentle-agents.ts, líneas 1595–1599](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1595-L1599), [retiro de SDD, líneas 1–18](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/odd/tasks/remove-sdd-odd-only.md#L1-L18).

**Verificado:** la investigación previa busca problema, resultado, restricciones y evidencia. Preguntas de producto pertenecen al padre; los workers devuelven huecos de información. La investigación opcional se justifica por incertidumbres concretas. [assets/orchestrator-tracking.md, líneas 17–27](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/assets/orchestrator-tracking.md#L17-L27).

**Propuesta Fluke:** convertir ese comienzo conversacional en un brief explícito: resultado deseado, usuario destinatario, alcance incluido/excluido, restricciones, ejemplos originales, criterios de aceptación y preguntas pendientes. La IA propone; las decisiones del humano se registran como tales. No pedir una aprobación ritual para cada transición cuando el trabajo ya está autorizado. Pedir decisión cuando falte una elección de producto o cambie materialmente el alcance.

## Continuidad: qué guarda y qué no

**Verificado:** trabajo grande mantiene `odd/tasks/<feature>.md`, con requisitos `S#`, tareas estables `T#`, evidencia y un log que conserva la solicitud original. Engram recibe una copia de recuperación con identidad de proyecto y feature. El padre reconcilia; un worker no reemplaza el estado global. Cambios de requisitos reabren solo las tareas afectadas. Guardado local y mirror no son atómicos: si Engram falla, el archivo sigue siendo útil y el mirror queda pendiente. [assets/orchestrator-memory.md, líneas 5–20](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/assets/orchestrator-memory.md#L5-L20).

**Verificado:** `gentle_odd_phase` y la inferencia por llamadas de herramientas actualizan un indicador visual. El contrato dice expresamente que es una señal de UI y no una fuente de verdad. Leer puede mostrar exploración; editar, implementación; una prueba, checking. No prueba que se hayan satisfecho requisitos. [assets/orchestrator-tracking.md, líneas 35–37](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/assets/orchestrator-tracking.md#L35-L37).

**Verificado:** el estado publicado entre sesiones contiene objetivo, progreso, decisiones, bloqueos y clasificación de trabajo, pero marca `authority: "none"` y `ownerReply: false`. Las referencias de trabajo son descriptivas; no son destinos ni autorizaciones. [lib/orchestrator-state.ts, líneas 5–45](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/orchestrator-state.ts#L5-L45), [lib/orchestrator-work.ts, líneas 1–25](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/orchestrator-work.ts#L1-L25).

**Propuesta:** Fluke debe distinguir su registro validado de tareas, el transcript del modelo y las proyecciones para UI. Los tres tienen propósitos distintos. El transcript explica lo conversado; el registro decide qué está pendiente; la UI muestra ese registro. Una etiqueta o una frase del modelo nunca basta para cerrar una tarea.

## Subagentes y paralelismo

**Verificado:** el contrato define exploración, escritura y verificación independientes. La cantidad de archivos no decide delegación. La política favorece paralelismo cuando hay unidades independientes con superficies disjuntas y suficiente trabajo para justificar el arranque; también contempla límites de contexto. El padre conserva las decisiones y entrega una tarea acotada a cada hijo. [assets/orchestrator.md, líneas 35–50](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/assets/orchestrator.md#L35-L50).

**Verificado en implementación:** antes de crear `TaskRequest`, el runtime valida el scope del writer, resuelve una sola vez el perfil efectivo, conserva identidad de sesión/cwd y valida el repositorio. El request transporta modelo, thinking, contexto, sesión padre y workspace. Un writer declara superficies y raíz canónica durante toda su vida en cola y ejecución. Esto es más que pedirle verbalmente que no toque archivos ajenos. [extensions/gentle-agents.ts, líneas 1595–1636](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1595-L1636), [líneas 1730–1758](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1730-L1758).

**Verificado en contrato:** `agent_end` conserva una respuesta pero puede preceder retries o compactación; `agent_settled` representa el final estable. Los resultados de background llegan por mensaje, sin polling del modelo ni relanzar trabajo equivalente. [assets/orchestrator-delegation.md, líneas 124–134](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/assets/orchestrator-delegation.md#L124-L134).

**Propuesta:** empezar con roles `explorer`, `worker`, `verifier`. Un único padre Fluke crea y acepta tareas; los hijos no crean nietos en el primer corte. Un DAG mínimo habilita solo tareas cuyas dependencias terminaron y cuyas superficies no chocan. Un mensaje final de worker produce un resultado candidato; el padre valida evidencia antes de marcarlo aceptado. Evitar un enjambre autoorganizado y una taxonomía grande de agentes mientras no hagan falta.

## Perfiles: modelo, origen y límites al retomar

**Verificado:** perfiles pueden elegir modelo y thinking por rol, incluido orquestador. La selección de sesión prevalece sobre snapshot heredado; defaults se resuelven por pin local, declaración del repositorio y perfil global. Resolver el perfil una vez por lanzamiento evita que admisión y ejecución usen modelos distintos. [lib/session-profile-freeze.ts, líneas 3–20 y 173–184](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/session-profile-freeze.ts#L3-L20), [extensions/gentle-agents.ts, líneas 1611–1624](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-agents.ts#L1611-L1624).

**Límite verificado:** el freeze heredado vive en memoria del proceso; una sesión retomada vuelve a resolver defaults. Existe un codec `gentle-pi.session-profile/v1`, pero su documentación advierte que codec/replay solos no prueban persistencia ni aplican modelos. No confundir una estructura serializable con integración completa de recuperación. [lib/session-profile-freeze.ts, líneas 22–28](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/session-profile-freeze.ts#L22-L28), [docs/session-profile-format.md, líneas 3–5 y 23–39](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/docs/session-profile-format.md#L23-L39).

**Propuesta:** Fluke persiste la ruta efectiva de cada run: proveedor, modelo, esfuerzo, origen de selección e identificación de cuenta sin secretos. Cambiar defaults afecta próximos runs; cambiar uno activo debe ser una acción visible. Retomar un proyecto no debe reinterpretar silenciosamente lo ya ejecutado con otro perfil.

## Preguntas, permisos y recuperación

**Verificado:** `ask_user_question` registra una herramienta secuencial de una a cuatro preguntas con dos a cuatro opciones por pregunta, selección múltiple y salida a texto libre. Tiene UI TUI y fallback para host RPC interactivo. Cancelar el cuestionario no selecciona un valor implícito. `ask_user_choice` separa decisiones cerradas; solo habilita respuesta personalizada expresamente y prohíbe hacerlo en consentimientos con tokens opacos. [extensions/ask-user-question.ts, líneas 243–317](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/ask-user-question.ts#L243-L317), [extensions/ask-user-choice.ts, líneas 217–244](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/ask-user-choice.ts#L217-L244).

**Verificado:** hay Normal, Auto y YOLO. Auto agrega un clasificador independiente sobre el modelo de la sesión y puede sumar costo/latencia; no es un sandbox de sistema operativo. Las respuestas de UI tienen procedencia host; una respuesta reconstruida desde un transcript no equivale a autorización nueva. Los hijos no heredan automáticamente modos elevados. Fallos, cancelaciones y decisiones obsoletas no autorizan ejecutar. [docs/permission-modes.md, líneas 51–98](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/docs/permission-modes.md#L51-L98).

**Verificado en código:** los hijos instalan un guard sobre herramientas shell reconocidas; bloquea comandos destructivos reconocidos. Es un guard léxico por herramienta, no aislamiento universal de procesos ni demostración de que toda herramienta personalizada sea segura. [extensions/child-safety.ts, líneas 1–24](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/child-safety.ts#L1-L24).

**Propuesta:** brief y permisos son decisiones diferentes. Fluke presenta preguntas de producto donde corresponde y pausa solo ramas dependientes. Un consentimiento debe quedar vinculado a operación, proyecto, sesión y versión de la decisión; cancelar o expirar no equivale a aceptar. Primer corte: política explícita y controles de superficie/cwd; clasificador Auto queda para una etapa posterior porque requiere presupuesto y otro flujo de fallos.

## Gentle AI y revisión

**Verificado:** Gentle Shell consume una CLI Gentle AI para revisión y un contrato versionado reflejado en el paquete. Si el contrato está ausente o falla validación, no inventa instrucciones de lifecycle; si RDD está apagado, no inyecta su contrato. La autoridad de revisión es distinta del registro ODD y de la ejecución Pi. [extensions/gentle-ai.ts, líneas 1198–1252](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-ai.ts#L1198-L1252), [líneas 10152–10162](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-ai.ts#L10152-L10162).

**Verificado:** verificación independiente y revisión nativa son conceptos diferentes. El contrato pide evidencia funcional, contempla una corrección acotada y declara resultados bloqueados/parciales; no permite convertir una revisión de código en sustituto de comprobaciones aplicables. [assets/orchestrator-verification.md](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/assets/orchestrator-verification.md#L1-L35).

**Propuesta:** no hacer a Fluke dependiente de RDD, de recibos Gentle AI ni de Engram para su flujo inicial. Guardar evidencia y permitir verificadores es suficiente para el núcleo. Una integración futura puede adjuntar resultado de revisión externa a un run sin entregarle la autoridad sobre el brief o las tareas.

## Contrato mínimo de Fluke, desde cero

Todo este apartado es **propuesta**, no funcionalidad observada en Gentle Shell ni afirmación de implementación actual.

1. **Proyecto:** ID estable, raíz canónica y repositorio opcional. Crear un brief no obliga a crear un issue, PR o worktree.
2. **Brief versionado:** objetivo, alcance, restricciones, criterios de aceptación, referencias originales y preguntas abiertas. La versión enlaza tareas que quedarían afectadas por una modificación.
3. **Plan:** tareas con ID, criterio de aceptación enlazado, dependencias y superficies de edición. Estados `planned`, `ready`, `running`, `needs_input`, `verifying`, `done`, `failed`, `cancelled`. Una dependencia fallida no se trata como cumplida.
4. **Run:** una ejecución concreta de una tarea; ID distinto del task ID, perfil efectivo, session ID del runtime, cwd, intento, timestamps y resultado. Un retry crea otro run, conservando evidencia del anterior.
5. **Decisión:** pregunta, opciones exactas o dominio abierto, ramas bloqueadas, respuesta y procedencia humana. Una decisión de producto no concede por sí misma permisos externos.
6. **Evidencia:** resultado del worker, artefactos, checks observados y limitaciones. `done` requiere aceptación del padre basada en criterios, no solo proceso exit 0.
7. **Uso:** eventos por run y categoría de ejecución; costo reportado/estimado/desconocido y tokens disponibles. Uso ausente nunca es cero. El desglose distingue padre, workers y verificadores.

Flujo visible: conversación inicial → brief utilizable → desglose → ejecución de tareas listas → evidencia/verificación → resultado aceptado. Preguntas, fallos y pausas son estados recuperables durante el flujo, no reinicios de todo el proyecto.

Persistencia inicial recomendada: un registro local versionado y escrituras atómicas, con un único dueño de escritura por proyecto. No hace falta una plataforma distribuida ni una base de datos remota para demostrar este flujo. Antes de persistir, validar referencias, IDs, dependencias acíclicas y transiciones. El modelo solicita cambios mediante herramientas; el host valida y aplica. Una exportación Markdown sirve para lectura, sin competir como segunda fuente autoritativa.

La cola debe reservar superficie y cupo antes de lanzar. Al reconectar, primero consultar procesos/sesiones existentes; no duplicar un run por no haber recibido su mensaje final. Un resultado tardío conserva su run ID y se descarta como transición activa si ya fue cancelado o sustituido. La recuperación muestra qué se pudo verificar y qué necesita una decisión.

## Diferencia concreta con Fluke anterior

**Verificado local:** `crates/services/src/services/worker_orchestrator.rs:1–29` describe una máquina centrada en `worker_tasks`, workspaces y evolución de PRs: developer termina mediante review; analyst/reviewer puede terminar al producir entregables; designer tiene aprobación de artefacto. Su política de análisis ya modela paralelismo y recursos por labels (`wave`, `resource`), alrededor de issues y GitHub, en líneas 241–281.

**Propuesta:** conservar como aprendizaje esa separación entre ejecución y aceptación, sin usar la estructura previa como restricción. En Fluke nuevo el primer objeto es el trabajo del usuario y su brief; issues, PRs y worktrees son salidas o mecanismos opcionales. La experiencia se puede usar para una investigación, un prototipo o un proyecto local antes de conectarse a GitHub.

## Alcance de la verificación

Se leyeron fuentes y contratos en un SHA fijo y se contrastaron con puntos del código consumidor. No se ejecutaron pruebas, compilación, instalación ni sesiones reales, siguiendo las instrucciones del repositorio Fluke. No se auditó exhaustivamente cada guard, cada condición de carrera ni el código interno de Pi/Gentle AI. La adopción de Pi requiere además confirmar su API pública exacta y compatibilidad Windows en el corte de implementación; este informe justifica la separación de responsabilidades, no certifica esa integración.
