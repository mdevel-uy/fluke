# Consola con orquestador: especificación de producto

Estado: dirección acordada; implementación inicial autorizada. Los comportamientos
pendientes se validarán mediante incrementos concretos.
Fecha: 2026-10-07.
Nombre de trabajo: Fluke Console. El nombre definitivo sigue abierto.

## Intención confirmada

Crear una experiencia de consola con un orquestador que siga el trabajo,
mantenga una vista global y ayude a medida que aparecen necesidades de
análisis, nuevos workers y cambios de repositorio.

Definir los comportamientos mediante SDD antes de elegir componentes de la
implementación existente de Fluke. Los tres mockups de Fluke sobre Herdr son
la dirección visual confirmada: [VISUAL-DIRECTION.md](VISUAL-DIRECTION.md).
Los ejemplos de datos y funciones se adaptan a las decisiones vigentes.
Herdr se investiga como referencia y fuente potencial de código reutilizable.
La interfaz y el runtime inicial serán propios; no se requiere su servidor.

## Decisiones de la primera conversación

- D01. Confirmada: un proyecto es un repositorio, con sus tareas y sesiones.
  La vista global puede reunir proyectos. La coordinación entre proyectos y
  el alcance de sus decisiones siguen abiertos.
- D02. Confirmada: tras acordar objetivo, alcance y presupuesto, el orquestador
  puede organizar el trabajo, iniciar workers y resolver dudas técnicas dentro
  de esos límites. Consulta cambios de alcance y decisiones de producto.
  El límite inicial de ejecución se define en D09; los permisos de publicación
  y merge se definen en D07.
- D03. Confirmada: la entrada principal es el orquestador; el usuario también
  puede entrar a cualquier worker y hablarle directamente.

## Decisiones de la segunda conversación

- D04. Actualizada: uso personal con repos y workers locales. Desarrollar y
  validar primero en Windows nativo, manteniendo Linux/WSL como destino.
  Compilar un binario para cada plataforma y validar PTY, procesos, rutas y Git
  en ambas. La distribución Linux y el comportamiento al apagar WSL siguen abiertos.
- D05. Confirmada: el trabajo ingresa por conversación con el orquestador y se
  conserva como spec/plan en el repo. GitHub Issues y PRs se integran cuando
  hacen falta; no son obligatorios para registrar cada encargo.

## Decisiones de finalización, aislamiento y límites

- D07. Confirmada: el trabajo queda listo para revisar cuando cumple los
  criterios de aceptación, tiene sus verificaciones ejecutadas y presenta los
  cambios. El worker puede crear commits y abrir PRs. El merge lo decide el
  usuario. Trabajo listo para revisar y cambios integrados son hitos distintos.
- D08. Confirmada: un worktree y una rama por tarea. El orquestador ordena
  dependencias y coordina la integración de resultados.
- D09. Confirmada: máximo configurable de workers ejecutando simultáneamente,
  considerando la carga de CPU de la máquina. El límite es global a la
  ejecución local, para que varios proyectos compartan la misma capacidad.
  Las tareas esperan cuando no hay capacidad y respetan sus dependencias.
  El conteo de workers es el control inicial; procesos de build, tests o
  servidores también consumen recursos y se deberán contemplar al validar
  el comportamiento real. No se acordó un límite monetario ni temporal.
- D10. Confirmada: el usuario puede pausar una tarea o todo un proyecto.
  La semántica técnica de pausa y reanudación se especificará antes de implementar.
- D11. Confirmada: priorizar una aplicación liviana, rápida y estable. El
  consumo y la latencia se medirán con procesos reales; no se presuponen resultados.
- D12. Confirmada: interfaz propia siguiendo los tres mockups. Herdr no es una
  dependencia obligatoria; se puede inspeccionar y reutilizar su código cuando
  resuelva una necesidad concreta, conservando licencia y atribución.

## Modelo de ejecución confirmado

Cada tarea tiene un worker responsable que analiza, planifica, implementa y
verifica según la spec/plan y sus criterios de aceptación. Ese worker puede
recorrer todas las etapas de la tarea.

Varios workers pueden trabajar en paralelo en tareas distintas, dentro del
alcance y máximo de concurrencia acordados. El orquestador
coordina las dependencias, los bloqueos y la intervención directa del usuario.
Cada tarea trabaja en su worktree y rama; sus resultados se integran tras la
decisión humana correspondiente.

La creación de ayuda puntual o una segunda revisión es una propuesta para
validar cuando exista una necesidad concreta.

Otra sesión puede aportar una segunda mirada, pero no garantiza independencia
ni éxito. La aceptación debe apoyarse en evidencia del resultado. El formato
de comprobación y los disparadores para pedir ayuda siguen abiertos.

## Comportamientos confirmados

- R01. Una intervención directa que cambia el encargo llega al orquestador y
  actualiza el plan para evitar instrucciones contradictorias.
- R02. Tras una interrupción se recupera y consulta el estado real antes de
  reenviar trabajo. No se duplican encargos por asumir que una orden falló.
- R03. El usuario puede corregir el plan y las decisiones guardadas.
- R04. Cada tarea muestra qué está haciendo, qué la bloquea y qué evidencia
  aporta para considerarse completa.

## Hipótesis de comportamiento para validar

- H01. El seguimiento de un proyecto continúa al cambiar el foco a otro proyecto.
- H02. El orquestador conserva objetivos, decisiones y dependencias con su fuente.
- H03. Cada encargo tiene objetivo, alcance, contexto y criterio de finalización.
- H04. Los bloqueos se explican con contexto y una propuesta de siguiente paso.
- H05. La ausencia de actividad del worker no basta para declarar éxito.
- H07. La recuperación distingue cerrar el cliente, reiniciar el servicio y
  perder conexión. No afirma que un proceso siga vivo si fue interrumpido.
- H08. La atención del usuario se reserva para cambios relevantes y decisiones;
  el nivel de autonomía se define explícitamente.

Estas hipótesis no son requisitos aprobados ni describen funciones implementadas.

## Escenario inicial propuesto

Una persona pide una funcionalidad para un repositorio. El orquestador
prepara una spec/plan en el repo, obtiene las autorizaciones que correspondan y
asigna un worker responsable a cada tarea. Las tareas que pueden avanzar sin
esperar a otras se ejecutan en paralelo, dentro de los límites acordados.
Un worker necesita una definición de otro encargo del proyecto. El
orquestador consulta decisiones previas y resuelve lo que esté dentro de su
autoridad; si falta una decisión, presenta la pregunta y sus alternativas.
Después de una interrupción se reconstruye el estado real y se continúa sin
duplicar encargos.

## Primer recorrido a especificar

Detalle funcional y criterios de validación: [FIRST-FLOW-SPEC.md](FIRST-FLOW-SPEC.md).

1. El usuario pide un cambio; el orquestador acuerda alcance y aceptación y
   registra la spec/plan en el repo.
2. El orquestador divide el trabajo en tareas y dependencias. Cada tarea recibe
   un worker responsable, un worktree y una rama cuando puede comenzar.
3. Las tareas habilitadas avanzan hasta el máximo global de workers configurado;
   el resto espera. El usuario puede pausar una tarea o el proyecto.
4. Cada worker analiza, planifica, implementa y verifica su tarea. El usuario
   puede intervenir directamente; los cambios de encargo llegan al orquestador.
5. El orquestador resuelve dudas dentro de su autoridad y consulta decisiones
   de producto o cambios de alcance. Los bloqueos y sus motivos quedan visibles.
6. El worker presenta cambios y evidencia de aceptación. Puede crear commits
   y abrir un PR cuando corresponde. El orquestador informa que está listo para revisar.
7. El usuario decide el merge; el orquestador coordina las dependencias afectadas
   y la integración de resultados.
8. Ante desconexión o reinicio se reconcilia el estado antes de continuar.

El escenario debe respetar D02 y D03. El trabajo entre repositorios se
evaluará como una capacidad adicional, sin incluirlo por defecto en la primera entrega.

## Criterios de aceptación candidatos

- CA01. Cada tarea, sesión y decisión conserva una asociación inequívoca con
  su contexto de trabajo, aunque cambie el foco de la interfaz.
- CA02. Una pregunta resuelta previamente se responde citando la decisión
  aplicable; una contradicción se muestra en lugar de ocultarse.
- CA03. La creación de un worker respeta la autorización y los límites acordados.
- CA04. Una tarea solo se declara completa al satisfacer su criterio de
  aceptación, con evidencia identificable. Quedar lista para revisar no implica
  que sus cambios estén integrados; el merge requiere decisión humana.
- CA05. Tras reconectar se consulta el estado real; ante una orden con resultado
  incierto se reconcilia antes de repetirla.
- CA06. El usuario puede identificar qué espera su decisión, por qué y qué
  ocurrirá si elige cada alternativa.
- CA07. Cada tarea identifica su worker responsable y puede recorrer todas sus
  etapas con él. Varias tareas pueden avanzar en paralelo con workers distintos,
  conservando la asociación entre encargo, contexto y resultados.
- CA08. El total de workers ejecutando respeta el máximo global configurado,
  incluso si las tareas pertenecen a proyectos diferentes. Los encargos sin
  capacidad quedan pendientes, sin perder contexto.
- CA09. Dos tareas del mismo repo tienen worktrees y ramas distintos.
- CA10. El usuario puede pausar tareas o proyectos, editar el plan y corregir
  decisiones. La interfaz refleja el estado real y los cambios de encargo.

## Temas para las siguientes conversaciones

- Detalles del entorno Linux/WSL: distribución, ubicación de repos y recuperación.
- Organización y actualización de las specs y planes guardados en el repo.
- Flujo de una tarea y ciclo de vida de su worker; ayuda y revisión puntuales.
- Detalles de persistencia, recuperación y pausa/reanudación.
- Ejecución: agentes/modelos, integración de worktrees y contabilización de workers.
- Verificaciones, evidencia de aceptación, revisión e integración de resultados.
- Memoria: alcance, fuentes, edición, caducidad y corrección de decisiones.
- Primera entrega: recorrido mínimo que justifica usar la herramienta.

## Separación de producto y tecnología

La spec no presupone GitHub, kanban, workers permanentes, contenedores, backend
web ni el esquema de datos de Fluke. Cada elección necesita un requisito.

La evaluación de Herdr registrará versión, fuentes, límites y pruebas pendientes.
La reutilización de Fluke se evaluará después de acordar los comportamientos.

## Primer incremento técnico

La base activa está en [tools/fluke-console-go](../../tools/fluke-console-go/README.md),
en Go, con interfaz, ventanas y runtime de sesiones propios de Fluke. Herdr y
Tuios son referencias técnicas; no se embeben sus aplicaciones ni se depende
de ellas. El prototipo [Rust](../../tools/fluke-console/README.md) se conserva
como referencia de comportamiento.

El README de Go delimita lo implementado, la verificación y lo pendiente.
Este incremento construye la interfaz y el control manual de sesiones; no
declara cumplido el recorrido autónomo de FIRST-FLOW-SPEC.md. La orquestación
autónoma y la integración de eventos de agentes son pasos posteriores.
