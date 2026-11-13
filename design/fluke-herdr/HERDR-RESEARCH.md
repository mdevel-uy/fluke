# Herdr: evidencia técnica para la especificación

Fecha: 2026-10-07. Investigación estática, sin validación de runtime.
Código revisado: upstream master, commit
`4f296c295b4a758af8589e46d2d7afb3743a709a`.

## Conclusión provisional

API y plugins ofrecían una base plausible para sesiones y control de agentes.
La dirección posterior del usuario prioriza interfaz propia y ejecución directa,
con Herdr como referencia y fuente potencial de código. No se incorpora su
servidor ni se crea un fork en el primer incremento.

D04 se actualizó: Windows nativo primero; Linux/WSL sigue como destino. Ambos
necesitan validación de PTY, rutas, procesos y recuperación.

Se inspeccionó src/pty/backend.rs para el arranque con portable-pty y el código
vendorizado de terminación de procesos. El primer incremento usa portable-pty
directamente, sin copiar ese backend. Herdr incluye modificaciones de ConPTY
y una capa Ghostty; no se asume que la biblioteca sin esas modificaciones tenga
el mismo comportamiento. La compatibilidad con CLI reales queda pendiente.

## Capacidades y límites relevantes

- Control de workspaces, panes, agentes y worktrees mediante CLI/API, corroborado
  en docs y código. Los nombres de agentes son aliases de procesos vivos, no
  identidades durables de tareas.
- `done` significa idle no visto. `agent prompt --wait` no correlaciona turnos
  individualmente y puede terminar por el turno previo si el agente ya trabajaba.
  El producto necesita correlación de encargos y criterios de aceptación propios.
- Eventos en vivo sin replay durable. La pérdida de eventos exige reconectar y
  reconciliar snapshots/lecturas. Un timeout al enviar un prompt no certifica que
  no fue enviado; repetirlo a ciegas puede duplicar trabajo.
- Detach conserva procesos; reiniciar el servidor los termina y recupera layout.
  La reanudación de conversaciones depende del agente/integración. No prueba
  que el encargo haya continuado ni que haya finalizado.
- Plugins permiten una TUI en pane, split, tab, overlay o popup. No se encontró
  una API pública para insertar widgets arbitrarios permanentes en el chrome.
  Reemplazar el shell podría requerir upstream/fork; es una inferencia pendiente.
- Los hooks son comandos ejecutables; el runtime limita a 32 comandos en vuelo.
  La coordinación permanente necesita controlar instancia única y su cola.
- Windows nativo figura como GA en docs; plugins siguen preview/best-effort.
  Portabilidad del IPC, PowerShell y launchers requiere pruebas en el entorno real.

## Pruebas futuras para resolver incertidumbres

1. Iniciar un worker, enviar un encargo, atender un bloqueo y correlacionar su
   resultado. Incluir el caso de enviar un prompt mientras ya trabaja.
2. Dos tareas en paralelo dentro de un proyecto/repo, cada una con su worker
   responsable, worktree y rama. Intervenir directamente y verificar que el
   orquestador lo registra. Comprobar dependencias e integración con merge humano.
3. Cambiar el foco a otro proyecto y comprobar que el monitor conserva el seguimiento.
4. Perder conexión/eventos y reconstruir estado sin duplicar órdenes ni workers.
5. Reiniciar servidor y reconciliar conversaciones resumidas con encargos pendientes.
6. Abrir el panel del orquestador, navegar desde workers y verificar terminales
   pequeñas. Determinar si los puntos de extensión alcanzan para la UX aprobada.
7. Doble arranque y ráfagas de eventos: instancia única, cola y límites de ejecución.
8. Aplicar el máximo global de workers entre proyectos, comprobar espera por
   capacidad y medir la carga real cuando ejecutan verificaciones. Probar pausa
   por tarea/proyecto y reanudación según la semántica que se acuerde.

En Linux/WSL se distinguirán cierre del cliente, reinicio del servidor y apagado
de WSL/host. También se comprobará el comportamiento de rutas y worktrees según
la ubicación de los repos que el usuario defina.

No se instalaron dependencias ni se iniciaron servidores o agentes.
Se consultaron versión, ayuda y esquema de la instalación local de Herdr 0.9.3.
La lectura de código se hizo en una copia temporal fuera de Fluke.

Comprobación de entorno del 2026-10-07: `wsl.exe --list --verbose` informó que
WSL no está instalado en esta máquina. La validación runtime Linux/WSL sigue
pendiente. El recorrido a validar está en [FIRST-FLOW-SPEC.md](FIRST-FLOW-SPEC.md).

## Fuentes

- [Automatización](https://herdr.dev/docs/agent-automation/).
- [API, plugins y eventos](https://herdr.dev/docs/socket-api/).
- [Persistencia y restauración](https://herdr.dev/docs/session-state/).
- [Windows](https://herdr.dev/docs/windows-beta/).
- [Validación de prompts](https://github.com/herdrdev/herdr/blob/4f296c295b4a758af8589e46d2d7afb3743a709a/src/app/api/agents.rs#L139).
- [Espera y correlación](https://github.com/herdrdev/herdr/blob/4f296c295b4a758af8589e46d2d7afb3743a709a/src/api/wait.rs#L211).
- [Pérdida de eventos](https://github.com/herdrdev/herdr/blob/4f296c295b4a758af8589e46d2d7afb3743a709a/src/api/subscriptions.rs#L325).
- [Paneles de plugins](https://github.com/herdrdev/herdr/blob/4f296c295b4a758af8589e46d2d7afb3743a709a/src/app/api/plugins/panes.rs).
- [Runtime de plugins](https://github.com/herdrdev/herdr/blob/4f296c295b4a758af8589e46d2d7afb3743a709a/src/app/api/plugins/runtime.rs#L161).


## Aplicación en la base Go: estado del agente

Se revisaron los manifiestos `src/detect/manifests/codex.toml` y `claude.toml`
y `src/integration/assets/codex/herdr-agent-state.sh` del snapshot citado.
Herdr combina hooks de inicio/prompt/Stop/Interrupt con títulos OSC y detección
de aprobaciones. Su `done` es disponibilidad del turno, no aceptación de tarea.

Fluke incorpora inicialmente señales OSC y un subconjunto de bloqueos visibles,
sin dependencia de Herdr ni sus sockets/scripts. Un contrato generado por
arranque pide reportar preguntas y entregas mediante JSON secuenciado. La
identidad de ejecución evita aceptar reportes de un arranque anterior. Queda
pendiente incorporar hooks nativos y verificar CLIs reales; un prompt por sí
solo no prueba la finalización ni garantiza reportes.
