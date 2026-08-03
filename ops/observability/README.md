# Observability dashboards para Grafana

JSON de dashboards versionados junto al producto y provisionados en el stack
central de observabilidad de mdevel (Grafana + Prometheus + Loki).

## Dashboards

| Archivo                          | UID                    | Título                    | Para qué sirve                                                                                                    |
|----------------------------------|------------------------|---------------------------|-------------------------------------------------------------------------------------------------------------------|
| `dashboards/vibe-kanban-flota.json`   | `vibe-kanban-flota`    | vibe-kanban — Flota       | Vista de una pantalla de toda la flota. Un socio ve si todas las instancias están sanas y qué instancia mirar.    |
| `dashboards/vibe-kanban-cliente.json` | `vibe-kanban-cliente`  | vibe-kanban — Cliente     | Drill-down por instancia: semáforo, métricas de producto, recursos del contenedor y logs. Variables `cliente`, `instancia`. |

El dashboard de flota linkea a `vibe-kanban-cliente` en la columna Cliente y
Instancia de la tabla "Salud por instancia" — un click abre el detalle con las
variables ya cargadas. El de cliente tiene un link de vuelta a la flota arriba.

## Datos que consumen

Los dashboards asumen los datasources del stack central (Prometheus con los
samples pusheados por remote_write y Loki con los logs pusheados por
`loki.source.docker`). Cada dashboard tiene dos variables tipo `datasource`
(`datasource_prom`, `datasource_loki`) que resuelven al datasource
correspondiente sin necesidad de hardcodear UIDs.

Las queries filtran por `proyecto="vibekanban"` para no mezclar con otros
proyectos que compartan el mismo Prometheus/Loki. Los labels externos que
espera son los que ya emite el Alloy de cada instancia:

- `proyecto` (siempre `vibekanban`)
- `cliente`
- `instancia`
- `version`

Además de las métricas de producto de `/api/metrics`
(`vibe_kanban_build_info`, `vibe_kanban_worker_tasks`,
`vibe_kanban_agents_running`, `vibe_kanban_execution_processes_failed_total`,
`plan_cap_hits_total`, `plan_concurrent_agents_limit`), los dashboards leen
métricas de `node-exporter` (`node_filesystem_avail_bytes`,
`node_filesystem_size_bytes`) y `cadvisor` (`container_memory_usage_bytes`,
`container_cpu_usage_seconds_total`) para las gráficas de disco, memoria y CPU.

Ver `ops/alloy/config.alloy` y `docs/self-hosting/observability-metrics.mdx`
para el detalle de qué se scrapea y qué labels lleva cada métrica.

## Aplicación en el VPS (tarea de infra)

Los workers de la fábrica **no** tienen acceso al VPS de observabilidad. La
aplicación de estos dashboards la hace un socio por SSH o Claude en sesión
sobre `/docker/observability/`. Pasos idempotentes:

1. Copiar los dos JSON al provisioning de Grafana en el VPS:

   ```bash
   scp ops/observability/dashboards/*.json \
       vps:/docker/observability/config/grafana/dashboards/
   ```

   La carpeta destino ya está configurada como `dashboard provider` en
   `/docker/observability/config/grafana/provisioning/dashboards/*.yaml` del
   stack central — no hace falta tocar el provisioning si sólo se agregan
   archivos.

2. Grafana con `foldersFromFilesStructure: true` los recarga solo dentro de
   `dashboardsSettings.updateIntervalSeconds` (por defecto 10s). Si querés
   forzar el refresco:

   ```bash
   docker exec observability-grafana kill -HUP 1
   ```

3. Abrir Grafana y confirmar que aparecen los dos dashboards con los UIDs
   `vibe-kanban-flota` y `vibe-kanban-cliente`. Al primer render, elegí el
   datasource de Prometheus y Loki en las variables del tope; Grafana
   recuerda la elección.

Si el stack central usa otros UIDs de datasources y querés hardcodearlos en
vez de resolverlos por variable, ajustá las dos variables `datasource_prom` y
`datasource_loki` (o cambialas por `datasource` fijo en los paneles) — es una
decisión de infra, no del producto.

## Cambios sobre estos JSON

Los JSON se editan **en este repo** (no en la UI de Grafana). Flujo:

1. Editá el JSON acá o exportalo desde Grafana (Share → Export → *Export for
   sharing externally* NO — usa el crudo del panel).
2. Antes de commitear, corré `python3 -m json.tool <archivo>.json` para
   validar que el JSON parsea.
3. Abrí PR; infra rearplica al VPS con el paso 1 de arriba.

No agregues `id`, `iteration` o `version` grande al exportar — dejamos `id:
null` y `version: 1` para que Grafana los reasigne al importar y así no haya
conflictos entre entornos.
