# Observability para Grafana

Dashboards y alertas versionados junto al producto y provisionados en el
stack central de observabilidad de mdevel (Grafana + Prometheus + Loki).

- Dashboards: `dashboards/` — ver detalle abajo.
- Alertas salientes a Telegram / email (Grafana Alerting, sin Alertmanager):
  ver [`alerting/README.md`](./alerting/README.md).

## Dashboards

| Archivo                          | UID                    | Título                    | Para qué sirve                                                                                                    |
|----------------------------------|------------------------|---------------------------|-------------------------------------------------------------------------------------------------------------------|
| `dashboards/fluke-flota.json`   | `fluke-flota`    | Fluke — Flota           | Vista de una pantalla de toda la flota. Un socio ve si todas las instancias están sanas y qué instancia mirar.    |
| `dashboards/fluke-cliente.json` | `fluke-cliente`  | Fluke — Cliente         | Drill-down por instancia: semáforo, métricas de producto, recursos del contenedor y logs. Variables `cliente`, `instancia`. |

El dashboard de flota linkea a `fluke-cliente` en la columna Cliente y
Instancia de la tabla "Salud por instancia" — un click abre el detalle con las
variables ya cargadas. El de cliente tiene un link de vuelta a la flota arriba.

## Datos que consumen

Los dashboards asumen los datasources del stack central (Prometheus con los
samples pusheados por remote_write y Loki con los logs pusheados por
`loki.source.docker`). Cada dashboard tiene dos variables tipo `datasource`
(`datasource_prom`, `datasource_loki`) que resuelven al datasource
correspondiente sin necesidad de hardcodear UIDs.

Las queries filtran por `proyecto="fluke"` para no mezclar con otros
proyectos que compartan el mismo Prometheus/Loki. Los labels externos que
espera son los que ya emite el Alloy de cada instancia:

- `proyecto` (siempre `fluke`)
- `cliente`
- `instancia`
- `version`

Además de las métricas de producto de `/api/metrics`
(`fluke_build_info`, `fluke_worker_tasks`,
`fluke_agents_running`, `fluke_execution_processes_failed_total`,
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
   `fluke-flota` y `fluke-cliente`. Al primer render, elegí el
   datasource de Prometheus y Loki en las variables del tope; Grafana
   recuerda la elección.

Si el stack central usa otros UIDs de datasources y querés hardcodearlos en
vez de resolverlos por variable, ajustá las dos variables `datasource_prom` y
`datasource_loki` (o cambialas por `datasource` fijo en los paneles) — es una
decisión de infra, no del producto.

## Rollout del rename de métricas `mkanban` → `fluke` (issue #574)

El binario nuevo exporta `fluke_*` y el Alloy nuevo etiqueta
`proyecto="fluke"` / `job="fluke"`. Las alertas y los dashboards nuevos sólo
miran esos nombres. Una instancia con binario o Alloy viejo **desaparece en
silencio** de las alertas nuevas: `vk-instance-not-reporting` agrupa por
instancia sobre `fluke_build_info`, así que una instancia que nunca emitió esa
serie no dispara nada. Por eso el cambio se aplica en bloque:

1. Antes de tocar la flota: copiar `fluke-flota.json` y `fluke-cliente.json`
   al provisioning de Grafana **sin borrar** los `mkanban-*.json` viejos
   (UIDs distintos, conviven). Así las instancias aún no migradas se siguen
   viendo en los dashboards viejos.
2. En la misma ventana, en **todas** las instancias: actualizar la imagen
   (binario con `fluke_*`) **y** `ops/alloy/config.alloy`, y reiniciar ambos
   contenedores. Nunca uno sin el otro.
3. Inmediatamente después, re-aplicar `alerting/alert-rules.yaml` y la
   notification policy con `proyecto = fluke` (ver
   [`alerting/README.md`](./alerting/README.md)). Mientras queden reglas
   viejas mirando las métricas con prefijo `mkanban`, van a disparar
   `vk-instance-not-reporting` por
   las instancias migradas: es esperable y se silencia al aplicar las nuevas.
4. Verificar en Prometheus que
   `count by (instancia) (fluke_build_info{proyecto="fluke"})` lista todas
   las instancias de la flota. Si falta alguna, quedó con binario o Alloy
   viejo: volver al paso 2 para esa instancia.
5. Recién con el paso 4 completo, borrar los `mkanban-*.json` del
   provisioning y la carpeta de alertas `mkanban` vacía en Grafana.

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
