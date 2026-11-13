# GitHub: primer flujo

El proyecto sigue siendo un repositorio local. GitHub es una fuente opcional
de encargos, no un requisito para trabajar ni un reemplazo de la spec local.

- F6 abre la conexión y las issues abiertas del `origin` en github.com.
- F5 incorpora una sección GitHub: estado/usuario, conectar por código OAuth,
  abrir el navegador, cancelar, actualizar y desconectar con confirmación.
  Se tomó como referencia `GitHubSettingsSection.tsx` y `routes/github.rs` de
  Fluke original. Se usa el mismo device flow de la aplicación pública de gh.
- Las credenciales se entregan a `gh` por stdin; no se guardan en el JSON de
  Fluke ni aparecen en argv o errores. El login pendiente se cancela al cerrar.
  Una cuenta provista por variables de entorno se identifica y no se sobrescribe.
  La desconexión afecta la cuenta compartida de gh, indicado al confirmar.
- Sin CLI se muestra cómo instalarla. PAT e instalación automática no forman
  parte de este incremento; el login disponible usa OAuth desde la configuración.
- Las consultas se ejecutan en segundo plano con timeout. El resultado queda
  asociado al repo consultado aunque se cambie de proyecto durante la consulta.
- La vista permite elegir una issue y leer su descripción. Importarla requiere
  escribir un criterio de aceptación; no inicia un worker automáticamente.
- La tarea guarda el enlace y una copia de la descripción para su brief. Repetir
  la importación de la misma issue en el mismo repo no duplica la tarea.
- Este incremento solo lee GitHub y escribe tareas locales. Publicar PRs,
  comentar/cerrar issues y sincronizar estados pertenecen a próximos flujos.
- Validación: remotos HTTPS/SSH, fallos de conexión, aislamiento entre repos,
  importación y duplicados, guardado fallido y prueba real de lectura con `gh`.
