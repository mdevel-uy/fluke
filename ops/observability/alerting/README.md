# Alertas salientes para la flota mkanban

Reglas y contact points de Grafana Alerting (unified alerting) versionados
junto al producto. Se aplican en el Grafana del VPS central de observabilidad;
no requieren Alertmanager — Grafana 13 evalúa las reglas sobre Prometheus y
Loki y envía notificaciones nativas a Telegram y email.

## Archivos

| Archivo                                 | Qué provisiona                              | Impacto sobre otros proyectos |
|-----------------------------------------|---------------------------------------------|-------------------------------|
| `alert-rules.yaml`                      | Grupo de reglas `mkanban-fleet` en la carpeta `mkanban`. | Ninguno — idempotente por `uid`, no toca reglas ajenas. |
| `contact-points.yaml`                   | Receivers `vk-socios-telegram` y `vk-socios-email`. | Ninguno — idempotente por `uid`. |
| `notification-policy.example.yaml`      | Ruta anidada `proyecto = mkanban` → receivers de socios. | **Sí** si se copia tal cual: los provisioning files de policies REEMPLAZAN el árbol completo. Ver más abajo. |

## Reglas

Las tres reglas viven en el grupo `mkanban-fleet` (carpeta `mkanban`)
y se evalúan cada 1 minuto. Todas etiquetan `proyecto=mkanban` para que la
notification policy del stack pueda ruterlas al canal correcto.

| UID                          | Alcance                                                                          | Umbral                                     | `for` |
|------------------------------|----------------------------------------------------------------------------------|--------------------------------------------|-------|
| `vk-instance-not-reporting`  | Instancia (`cliente`, `instancia`) sin `mkanban_build_info` reciente.        | staleness > 300 s                          | 0 m   |
| `vk-disk-repos-high`         | Cualquier filesystem no efímero de la instancia por arriba del 80% de uso.       | uso > 0.80                                 | 5 m   |
| `vk-executor-error-rate`     | Tasa sostenida de fallos de execution processes.                                 | > 2 fallos/min (rate 10 m)                 | 10 m  |

Los runbooks cortos viven en la anotación `runbook` de cada regla —
Grafana los adjunta al mensaje que ve el socio en Telegram/email. Fuente de
verdad: [`alert-rules.yaml`](./alert-rules.yaml).

### `vk-instance-not-reporting`

**Qué mirar primero**

1. Estado del contenedor en la VPN del cliente:
   `docker compose -f docker-compose.local.yml ps`. Si `vibe-kanban` o `alloy`
   no están `Up`, ver logs con `docker compose logs --tail=200 <servicio>`.
2. Si los contenedores están arriba, `curl -sf http://vibe-kanban:3000/api/metrics | head`
   desde el contenedor `alloy` — un 5xx apunta a stall del backend.
3. Si la app responde pero Alloy no pushea: logs de `alloy` buscando
   `401 Unauthorized`, `context deadline exceeded` o errores TLS contra
   `PROM_PUSH_URL`.
4. Si la instancia está sana pero el Prometheus central no ve muestras:
   verificar el datasource `prometheus` en Grafana y consultar directamente
   `{proyecto="mkanban", instancia="X"}`.

### `vk-disk-repos-high`

**Qué mirar primero**

1. SSH a la instancia y `df -h` — identificar el mount lleno (típicamente el
   volumen que respalda `/repos`).
2. `du -sh /var/lib/docker/volumes/*/_data/repos/*` (ajustar path al volumen
   real) para ver el peso del árbol de repos.
3. Purgar workspaces obsoletos desde la UI o borrar clones huérfanos con la
   herramienta interna.
4. Si el mount lleno NO es el de `/repos` (p.ej. `/var/log`), investigar allí
   antes de tocar volúmenes de datos.
5. Redimensionar el volumen si el uso legítimo crece más rápido que la
   limpieza.

### `vk-executor-error-rate`

**Qué mirar primero**

1. Abrir el dashboard `mkanban-cliente` para la instancia afectada — el
   panel "Errores executor por instancia" muestra el desglose por `run_reason`.
2. Filtrar logs en Loki:
   `{proyecto="mkanban", cliente="X", instancia="Y"} |~ "(?i)error"` en el
   rango de los últimos 15 min.
3. Causas comunes por `run_reason`:
   - `codingagent`: credenciales/cuota del proveedor del agente
     (Anthropic/OpenAI/etc.) o límite de tokens.
   - `setupscript`: script de setup del proyecto roto (dependencia rota,
     permisos).
   - `cleanupscript`: workspace corrupto, ver logs del script en el mismo
     proceso.
4. Si toda la flota entra a la alerta a la vez, buscar una incidencia externa
   (proveedor del agente caído, GitHub down) antes de tocar código.

## Aplicación en el VPS (tarea de infra)

Los workers de la fábrica **no** tienen acceso al VPS de observabilidad. La
aplicación la hace un socio por SSH o Claude en sesión sobre
`/docker/observability/`. Todos los pasos son idempotentes.

### 1. Secretos del contact point

Antes del primer provisioning, exportar los tres env vars al contenedor de
Grafana (típicamente vía el `.env` del compose del stack central):

```env
VK_TELEGRAM_BOT_TOKEN=123456789:AAABBBcccDDDeeeFFFgggHHHiiiJJJkkkLLL
VK_TELEGRAM_CHAT_ID=-1001234567890
VK_ALERT_EMAIL_TO=socio1@mdevel.com,socio2@mdevel.com
```

El token del bot lo genera BotFather; el chat ID de un grupo se obtiene
enviando un mensaje en el grupo y consultando
`https://api.telegram.org/bot<TOKEN>/getUpdates`. El bot tiene que ser
miembro del grupo/canal.

Para email, el bloque `[smtp]` del `grafana.ini` del stack tiene que estar
configurado con un servidor SMTP alcanzable. Si el stack no tiene SMTP,
dejar `VK_ALERT_EMAIL_TO` vacío y quitar la ruta al `vk-socios-email` en la
notification policy (ver paso 4).

### 2. Copiar `alert-rules.yaml` y `contact-points.yaml`

```bash
scp ops/observability/alerting/alert-rules.yaml \
    ops/observability/alerting/contact-points.yaml \
    vps:/docker/observability/config/grafana/provisioning/alerting/
```

Ambos archivos son idempotentes por `uid` — no afectan alertas ni receivers
de otros proyectos que compartan el stack.

Si los datasource UIDs del stack central no son `prometheus` y `loki`
(pueden verse en la UI de Grafana → Connections → Data sources), editar
`alert-rules.yaml` una vez y ajustar los `datasourceUid` antes de copiar.

### 3. Recargar Grafana

Grafana relee el provisioning al recibir SIGHUP:

```bash
docker exec observability-grafana kill -HUP 1
```

O reiniciando el contenedor. Después de recargar, en la UI: Alerting → Alert
rules debería listar el grupo `mkanban-fleet` con tres reglas, y
Alerting → Contact points debería listar `vk-socios-telegram` y
`vk-socios-email`.

### 4. Integrar la ruta a la notification policy del stack

Grafana **reemplaza** el árbol completo de notification policies cuando
encuentra un archivo `notification-policies.yaml` en el provisioning — por
eso el archivo de este repo se llama
[`notification-policy.example.yaml`](./notification-policy.example.yaml) y
NO se copia tal cual.

En su lugar, editar el `notification-policies.yaml` que ya usa el stack
central y agregarle una ruta anidada bajo el root, del tipo:

```yaml
routes:
  - receiver: vk-socios-telegram
    matchers:
      - proyecto = mkanban
    group_by:
      - alertname
      - cliente
      - instancia
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    continue: true
    routes:
      - receiver: vk-socios-email
        matchers:
          - proyecto = mkanban
        group_wait: 30s
        group_interval: 5m
        repeat_interval: 12h
```

`continue: true` en la ruta padre asegura que Grafana también recorra la
ruta hija de email — el email es respaldo, se dispara siempre que se dispare
Telegram. El resto de las alertas (que no tienen `proyecto=mkanban`)
siguen cayendo al policy default del stack como hasta ahora.

Después de editar, un SIGHUP al contenedor de Grafana (paso 3) recarga la
policy sin reiniciar.

### 5. Probar el criterio de aceptación

Apagar una instancia de prueba (parar `vibe-kanban` y `alloy` con
`docker compose stop`) y esperar hasta 5 minutos + eval_interval (~6 min en
total). En Telegram tiene que llegar la notificación
`[FIRING · critical] instancia mkanban sin reportar métricas` con el
`cliente/instancia` afectados. Cuando la instancia vuelva y Alloy pushee
métricas, llegará el mensaje `[RESOLVED]`.

## Cambios sobre estos YAML

Los archivos se editan **en este repo** (no en la UI de Grafana). Flujo:

1. Editar el YAML aquí, con la validación mínima:

   ```bash
   python3 -c 'import yaml; yaml.safe_load(open("ops/observability/alerting/alert-rules.yaml"))'
   ```

   (repetir por cada archivo).
2. Abrir PR — infra reaplica al VPS con el paso 2 y 3 de arriba.

Cuando agregues una regla nueva, elegí un `uid` estable (`vk-<tema>-<detalle>`)
para que el reprovisioning idempotente funcione y no cree duplicados.
