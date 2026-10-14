# Tuios: referencia para ventanas y protocolos de agentes

Revisión estática del 2026-10-07. Upstream Gaurav-Gosain/tuios,
commit af79c927113e69ae6188666fc2d872566c60abf7.
Copia temporal fuera de Fluke; no se instaló ni ejecutó Tuios.

## Evidencia revisada

- go.mod: aplicación Go, Bubble Tea v2 y Lipgloss v2. El usuario confirmó Go
  como base de Fluke Console; esto no implica incorporar Tuios como dependencia.
- LICENSE: MIT, copyright Gaurav Gosain. Si se copia o adapta código sustancial,
  conservar los avisos del origen.
- pkg/tuios/tuios.go y docs/LIBRARY.md: biblioteca embebible en aplicaciones
  Bubble Tea, con tamaño, tema, bordes, workspaces y animaciones configurables.
  Se revisó como evidencia técnica. El usuario aclaró que Fluke debe tener
  implementación propia: esta biblioteca no se embebe.
- internal/input/border_resize.go: distingue bordes de contenido y chrome,
  evita redimensionar divisiones ocultas bajo ventanas flotantes y separa
  el ajuste visual de la aplicación del tamaño al PTY.
- internal/input/alt_drag_test.go y ctrl_drag_test.go: escenarios de arrastre,
  umbral de movimiento, fin del gesto y coordinación con el modo de terminal.
- internal/layout/bsp.go: árbol de divisiones para distribuir ventanas.
- internal/agentproto/codex.go y events.go: cliente de app-server con eventos
  de texto, herramientas, turnos y solicitudes de aprobación. Es relevante
  para que la interfaz de conversación sea propia, sin interpretar texto de
  pantalla como eventos fiables.
- internal/ptyspawn/spawn_windows.go: ruta específica de Windows; el código
  configura los hijos mediante ConPTY. Su conducta necesita pruebas locales.

## Aplicación a Fluke

Conservar las vistas Fluke, Proyecto, Sesiones y Decisiones de los mockups.
Evaluar paneles que puedan moverse, redimensionarse y maximizarse, manteniendo
la asociación tarea/sesión aunque cambie su posición. Separar entrada del
worker y gestión de ventanas; el mouse sobre un borde no debe escribir en el PTY.
Go fue elegido como base; Tuios sigue siendo una referencia de código, sin
dependencia de su aplicación o biblioteca. Herdr cumple el mismo papel para
estudiar respuestas y estado de agentes.

La base activa en [Go](../../tools/fluke-console-go/README.md) implementa las
ventanas y el runtime de sesiones de Fluke. Comprobar el movimiento y resize
con terminales reales; medir consumo en reposo, durante salida intensa y al
arrastrar/redimensionar. Validar cierre de procesos y ejecución en Windows,
Linux y macOS. Estas mediciones siguen pendientes. Si se adapta código
sustancial de una referencia, conservar su licencia y atribución.

## Fuentes

- [Código revisado](https://github.com/Gaurav-Gosain/tuios/tree/af79c927113e69ae6188666fc2d872566c60abf7).
- [Biblioteca](https://github.com/Gaurav-Gosain/tuios/blob/af79c927113e69ae6188666fc2d872566c60abf7/docs/LIBRARY.md).
- [Bordes y resize](https://github.com/Gaurav-Gosain/tuios/blob/af79c927113e69ae6188666fc2d872566c60abf7/internal/input/border_resize.go).
- [Protocolo de agentes](https://github.com/Gaurav-Gosain/tuios/blob/af79c927113e69ae6188666fc2d872566c60abf7/internal/agentproto/codex.go).
