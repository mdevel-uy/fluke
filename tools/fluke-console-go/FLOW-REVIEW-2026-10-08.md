# Revisión del flujo de consola contra Fluke Desktop

Referencia: código de Desktop en este checkout, especialmente
`crates/services/src/services/director.rs` (brief y coordinación),
`crates/server/src/routes/director.rs` (aprobación y entrega al Analyst),
`packages/web-core/src/features/director/ui/QuickReplies.tsx` (respuestas en chat)
y `packages/web-core/src/features/director/lib/missionSteps.ts` (etapas).

El recorrido de Desktop es entender → brief → despiece → plan → ejecución.
La consola simplifica roles e interfaz, pero debe conservar requisitos durables,
aprobaciones concretas, continuidad de las respuestas y revisión de entregas.

| Parte central | Antes de esta revisión | Resultado en consola |
| --- | --- | --- |
| Capturar hechos mientras se conversa | Conversación durable, pero sin borrador independiente antes de proponer alcance | `draft_goal` guarda requisitos parciales, criterios y dudas; F2 los muestra y el contexto permite recuperarlos |
| Acordar alcance | Propuesta durable, aprobación escondida en F4 | Propuesta revisable y respondible en F2; F4 conserva una vista alternativa |
| Preguntas y respuestas | Responder en chat no resolvía la decisión registrada | Ctrl+D selecciona una decisión en el chat; Enter guarda la respuesta y notifica a Fluke/worker; nuevas preguntas no cambian el destino seleccionado |
| Despiece | `create_task` creaba y encolaba implementación inmediatamente | Aprobar alcance permite crear tareas con criterios y dependencias; quedan `awaiting_execution` sin arrancar workers |
| Autorizar ejecución | Quedaba mezclado con acordar alcance | «ejecutar plan» autoriza tareas actuales de ese objetivo; iniciar/encolar una tarea autoriza esa tarea. El agente no puede encolar tareas que esperan autorización |
| Correcciones de alcance | Objetivos y specs vinculados a tareas | Se conservan las pausas de alcance anterior y la vinculación por `goal_id`; las tareas futuras no heredan autorización de ejecución |
| Workers aislados y cupo | Worktrees, cola y dependencias | Se conservan; dependientes esperan aceptación e integración de sus bases |
| Preguntas de workers | Decisiones durables con continuación | Respuesta desde F2 utiliza la misma continuación; las respuestas inciertas no se reenvían a ciegas |
| Entrega y aceptación | `awaiting_review` separado de aceptación humana | Se conserva; un reporte del agente no acepta la entrega ni certifica integración |
| Integración/publicación | Previsualización y confirmación humanas | Se conservan los flujos existentes de F7; esta revisión no agrega merge/publicación automáticos |
| Reinicio/errores | JSON durable y recuperación de sesiones | Se guardan borradores, respuestas, aprobación y permisos de ejecución; un fallo al guardar mantiene el texto sin autorizar trabajo |

## Simplificaciones y límites que siguen presentes

- Desktop tiene misiones con ítems tipados y validación de completitud, brief
  versionado, preferencias persistentes y perfiles para Analyst, TDD, arquitectura,
  diseño y revisiones. La consola tiene un borrador por repositorio, un objetivo
  y tareas de workers generales. Todavía no reproduce ese catálogo ni la
  validación de todos los campos de Desktop.
- El modelo debe usar `draft_goal` y `create_task`: tener el protocolo disponible
  no garantiza que cualquier proveedor cumpla las instrucciones. La UI distingue
  borrador, propuesta, objetivo acordado y plan pendiente de ejecución para que
  el estado real sea verificable.
- F4 y F7 siguen siendo vistas útiles. Responder preguntas/aprobar alcance no
  necesita abandonar F2; la revisión de diffs y las confirmaciones de integración
  siguen usando F7.
- Los permisos ya existentes en estados antiguos se conservan. El nuevo bloqueo
  de ejecución se aplica a tareas nuevas creadas por el orquestador.
- La preparación del plan puede ser incremental: ejecutar plan autoriza solo las
  tareas presentes. Una tarea agregada después requiere otra autorización.

## Validación

Regresiones para aprobación en F2, respuestas libres, selección estable de la
pregunta, consentimiento explícito, errores de persistencia, borrador recuperable,
separación de brief/ejecución, rechazo del bypass del agente y tareas posteriores.
La suite completa pasó (196,489 s), incluyendo alcance, dependencias,
aceptación, integración, publicación, pausas y recuperación. Las pruebas
específicas del flujo se repitieron después del ajuste de reanudación del agente.
Una prueba con la aplicación en una PTY aislada confirmó que escribir apruebo
en F2 guarda el objetivo y la respuesta sin cambiar de sección (salida limpia 0).
F8 / Ctrl+F maximiza y restaura el panel con foco (plan, chat, agentes,
proyectos y decisiones); en F3 amplía la terminal seleccionada. Pasaron pruebas
de conservación del borrador/foco, un panel con diez agentes, cambio de tamaño
de terminal, geometría en mosaico/flotante y tamaño real de PTY. También pasó
una prueba de Ctrl+F con la aplicación abierta en una PTY aislada.

## Vista de brief dentro de Fluke

F4 muestra requisitos en borrador, dudas pendientes, alcance propuesto y alcance
acordado a partir del estado durable. Tiene lectura con scroll y un panel de
decisiones/historial. El chat duplicado de F4 se retiró: C vuelve a F2 y Ctrl+D
lleva una decisión pendiente a esa conversación. «ver brief» en F2 abre F4.
El contrato indica esta vista, evitando mandar al usuario a abrir brief.md.
Las pruebas cubren lectura larga, navegación, conservación del borrador del
chat, ausencia de otro chat en F4, render sin mutar estado y respuestas con
el destino de la decisión conservado.
