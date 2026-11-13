# Primer recorrido: pedido, ejecución y revisión

Estado: borrador funcional para validar. No describe una implementación existente.
Fecha: 2026-10-07.
Base: [PRODUCT-SPEC.md](PRODUCT-SPEC.md), decisiones D01–D05 y D07–D10.

## Objetivo

Una persona pide un cambio para un repo. El orquestador conserva la spec/plan,
coordina workers responsables de tareas, muestra avances y bloqueos, y presenta
resultados verificables para revisión. El usuario decide integrar los cambios.

## Escenario de referencia

Ejemplo ficticio: agregar exportación JSON a una herramienta de consola.
Aceptación: el comando exporta datos válidos, maneja errores de escritura y tiene
documentación de uso. El usuario acuerda alcance y criterios con el orquestador.

El plan contiene tres tareas:

- T1. Implementar exportación y sus verificaciones.
- T2. Preparar documentación siguiendo el contrato acordado. Puede avanzar en
  paralelo con T1 y se verifica de nuevo contra el resultado implementado.
- T3. Agregar un ejemplo de uso ejecutable. Depende de los cambios de T1.

Para este escenario el máximo global es dos workers. Es un valor de ejemplo,
no un default del producto. Cada tarea tiene un worker, worktree y rama propios.

## Recorrido observable

### F01. Registrar el pedido

El orquestador confirma repo, objetivo, alcance y aceptación. Pregunta por
ambigüedades que afecten producto o alcance. Guarda spec y plan en el repo.
La ubicación concreta y el formato de esos documentos siguen abiertos.

Salida observable: el usuario puede leer y corregir lo acordado. Las tareas
apuntan a la revisión del plan que las autorizó.

### F02. Preparar y asignar

El orquestador identifica tareas y dependencias y asigna un worker responsable
cuando hay capacidad. Prepara el worktree y la rama antes de encargar cambios.
Un fallo al preparar o iniciar queda visible y no se presenta como trabajo activo.

T1 y T2 pueden comenzar. T3 espera su dependencia. Cambiar el foco a otro
proyecto conserva este seguimiento y comparte el mismo máximo global.

Salida observable: tarea, repo, worker, sesión y checkout quedan asociados.
Cada worker conoce su alcance, aceptación y revisión del plan.

### F03. Ejecutar y observar

El mismo worker analiza, planifica, implementa y verifica su tarea. El orquestador
observa el trabajo y coordina dependencias sin exigir agentes distintos por etapa.
El usuario ve estado, actividad relevante, motivo de espera y próximas decisiones.

La sesión de terminal es una fuente de observación. Su estado idle/done no
constituye evidencia suficiente de aceptación ni integración.

### F04. Resolver dudas e intervenciones

Una duda técnica dentro del alcance se resuelve usando el repo, spec, plan y
decisiones aplicables. Se conserva la respuesta y su fuente. Una decisión de
producto o cambio de alcance se presenta al usuario con opciones y consecuencias.

El usuario puede hablar directamente al worker. Si cambia el encargo, el cambio
se registra y llega al orquestador antes de emitir órdenes incompatibles o
continuar trabajo dependiente. Una edición directa de la spec/plan también se
detecta y reconcilia. La implementación Go comprueba los briefs y la spec de objetivo; una edición
pausa el worker y conserva archivos. Cambiar el objetivo también pausa el alcance
anterior; adoptar una tarea requiere una orden humana explícita. La reconciliación
semántica automática de nuevos planes sigue pendiente.

### F05. Pausar y continuar

Requisito aprobado: pausa por tarea o proyecto. La interfaz debe distinguir una
pausa solicitada de una pausa efectivamente alcanzada, y reflejar lo que sigue vivo.

Propuesta técnica pendiente: bloquear nuevos despachos inmediatamente y solicitar
que el trabajo activo se detenga en un punto seguro. Conservar cambios y contexto.
Reanudar respeta el máximo global y vuelve a comprobar dependencias y plan.

Hay que validar interrupción del agente y sus subprocesos, en particular builds,
tests y servidores. No se asume una suspensión uniforme entre CLIs. Cómo se
contabilizan workers bloqueados, pausados o con procesos vivos sigue abierto.

### F06. Presentar el resultado

El worker entrega cambios y evidencia por criterio de aceptación. Se identifica
qué se ejecutó, su resultado, qué no pudo comprobarse y la revisión de código
correspondiente. Puede crear commits y abrir un PR cuando ese flujo aplica.

El orquestador contrasta la entrega con lo acordado y distingue trabajo listo
para revisar, trabajo incompleto y verificaciones fallidas. Una afirmación del
worker sin evidencia no basta para declarar aceptación.

Si el código cambia después de verificarse, la evidencia previa no se presenta
como validación del nuevo resultado. La verificación pertinente debe actualizarse.

### F07. Integrar y habilitar dependencias

El usuario decide el merge. El orquestador ejecuta o coordina la integración
autorizada y comprueba su resultado. Un conflicto o rechazo queda visible.

T3 empieza cuando el cambio del que depende está integrado en su base. La base
Go comprueba la ascendencia Git y el snapshot aceptado. Un worktree dependiente
viejo, limpio y sin commits propios puede avanzar al destino verificado antes
del arranque; la intención se registra para recuperar una interrupción. Trabajo
propio, divergencias o colisiones requieren intervención manual. Compartir
commits antes del merge sería un flujo adicional.
T2 se contrasta con el contrato final antes de presentarse como completo.

No se elimina un worktree con cambios pendientes como efecto de terminar una
sesión. La limpieza de checkouts y ramas se definirá por separado.

### F08. Recuperar una interrupción

Cerrar el cliente, perder conexión y reiniciar el servidor se tratan como casos
distintos. Al volver se consulta el estado real de sesiones, checkouts, cambios,
encargos y resultados; se reconstruye la asociación con cada tarea.

Una orden con timeout puede haber llegado. Se reconcilia antes de reenviar.
Si no es posible determinarlo, se muestra la incertidumbre en vez de iniciar
otro worker para el mismo encargo. Recuperar una conversación no demuestra que
la ejecución haya continuado ni que haya terminado.

## Aceptación del recorrido

- AF01. El usuario lee y corrige spec/plan en el repo antes y durante el trabajo.
- AF02. T1 y T2 tienen workers, ramas y worktrees distintos; pueden avanzar en paralelo.
- AF03. Con el máximo en dos, una tercera tarea habilitada espera capacidad.
  La prueba incluye tareas de otro proyecto para verificar el límite global.
- AF04. Un cambio directo de encargo o de spec llega al orquestador y se refleja
  en las tareas afectadas; no se continúa usando silenciosamente el plan anterior.
- AF05. Una pregunta de producto espera decisión; una respuesta ya documentada
  puede reutilizarse con su fuente cuando sigue siendo aplicable.
- AF06. La pausa muestra qué se solicitó y qué está efectivamente detenido.
  Reanudar conserva contexto y respeta la concurrencia.
- AF07. Un resultado con verificación fallida o pendiente se presenta como tal.
  No se convierte en éxito por observar una terminal idle/done.
- AF08. Estar listo para revisar no integra cambios. Se requiere decisión humana
  de merge y confirmación del resultado.
- AF09. Una tarea dependiente usa los cambios requeridos en su base antes de ejecutar.
- AF10. Desconexión, pérdida de eventos y reinicio no generan encargos duplicados
  ni ocultan incertidumbre sobre los procesos originales.

## Validación técnica del runtime

Investigación estática disponible en [HERDR-RESEARCH.md](HERDR-RESEARCH.md).
La dirección actual usa runtime e interfaz propios, con Linux/Omarchy como
entorno de destino y Windows para validar el desarrollo.
El avance y la evidencia de Windows se registran en
[QA de la consola Go](../../tools/fluke-console-go/QA-2026-10-07.md).
Este listado describe el recorrido de aceptación; no implica que todos sus
casos estén completos. La ejecución nativa debe repetirse en Linux/WSL y macOS.

1. Crear dos worktrees/sesiones y comprobar correspondencia con tareas.
2. Iniciar un agente compatible, enviar un encargo y correlacionar su resultado.
3. Intervenir desde su terminal y comprobar cómo llega el cambio al orquestador.
4. Probar el panel propio del orquestador y navegación desde cualquier worker.
5. Interrumpir y reanudar agente/subprocesos, registrando qué se conserva.
6. Reconectar y reconstruir estado; repetir después de reiniciar la consola
   y, si se incorpora un daemon posteriormente, después de reiniciarlo.
7. Medir carga con dos workers y verificaciones activas. Determinar si limitar
   workers resulta suficiente para el uso esperado de la máquina.

En la inspección inicial del 2026-10-07, `wsl.exe --list --verbose` informó que
WSL no está instalado en esta máquina. No se instaló WSL ni Herdr. Luego se
compiló y probó la consola propia en Windows, incluyendo sesiones reales de
Codex y Claude. Se consultaron metadatos de Herdr 0.9.3 como referencia.

## Validaciones y decisiones técnicas pendientes

- Reconciliación del plan/spec cuando una intervención directa cambia el encargo.
- Checkpoints internos de las herramientas y recuperación de historial PTY entre cierres.
- Squash/cherry-pick, worktrees dependientes con trabajo propio y tareas sin cambios de archivos.
- Publicación real de PRs y sincronización de estados de GitHub.
- Evidencia de aceptación por tipo de tarea y estabilidad bajo carga prolongada.
- Validación nativa de PTYs/procesos en Linux/WSL y macOS.

La base activa `tools/fluke-console-go` implementa conversación propia,
aprobación de objetivos, descomposición del plan, cola global, worktrees,
reportes y preguntas de workers, revisión y aceptación humana. El recorrido
objetivo → tarea → resultado → aviso al humano pasó con un Codex orquestador y
un Codex worker, verificando el archivo resultante fuera del relato del modelo.
La pausa por proyecto y tarea conserva worktrees y respeta el cupo. Pedir cambios
desde la revisión devuelve el encargo al mismo worker y registra el comentario
para el orquestador; una nueva entrega confirma qué revisión incorporó.
F7 muestra el diff, guarda el snapshot aceptado y prepara commit/merge local
con confirmación humana. Se verifican ramas y archivos antes de mutar Git;
conflictos previstos dejan el destino intacto y cambios de hooks requieren
revisión. El resultado se comprueba antes de habilitar dependencias. La intención
persistida permite reconciliar un merge tras interrupción sin repetirlo.
F7 también prepara un PR con título/descripcion editables: una confirmación
humana publica la rama propia y crea un borrador o actualiza su PR abierto.
Se probó desde el ejecutable Windows con GitHub simulado, incluyendo cancelación,
fallos de escritura y rechazo de cambios concurrentes; no se publicó un PR real.
Se verificó con Codex y Claude reales cerrar/reabrir la consola y recuperar el
UUID nativo exacto, un contrato nuevo y respuestas anteriores sin repetir la
pregunta. Claude también completó la corrección del mismo worker.
Job Objects controla la vida de subprocesos en Windows. Esto no completa
todavía todos los criterios AF: siguen pendientes la reconciliación de
intervenciones directas, checkpoints y la validación nativa en otros sistemas.

Estas decisiones se resolverán contra el recorrido y sus pruebas, sin copiar
por defecto la arquitectura de Fluke ni exigir un fork de Herdr.
