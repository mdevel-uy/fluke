# Runbook de operación — Fluke on-premises

Procedimientos operativos para la venta y soporte de instancias de cliente.
Dos partes, con la lógica de un manual de vuelo:

- **Parte 1 — Procedimientos normales**: rutina (alta, baja, publicar versión).
  Se ejecutan igual siempre; seguir la lista aunque parezca obvio.
- **Parte 2 — Procedimientos anormales (QRH)**: qué hacer cuando algo falla.
  Buscar el síntoma, ejecutar los pasos en orden, verificar al final.

Convenciones: `▸` paso a ejecutar · `✓` verificación que debe pasar antes de
seguir · 🔴 acción irreversible o visible para el cliente.

---

# Parte 1 — Procedimientos normales

## 1.1 Alta de cliente

Prerequisito: contrato firmado con los parámetros de facturación acordados
(horas por ticket y costo hora — ver [Términos](https://mkanban.dev/terms) cl. 7).

**A. Credenciales de registro (lado mdevel)**

- ▸ Crear cuenta de GitHub `mkanban-<cliente>` (machine user, cuenta gratuita).
- ▸ En el package `ghcr.io/mdevel-uy/fluke` → Package settings → Manage Actions
  access → agregar el machine user con rol **Read**. (Clientes instalados antes
  del rename: el cambio de imagen está en 1.5.)
- ▸ Con esa cuenta, generar un PAT clásico con **solo** el scope `read:packages`.
  Sin expiración o a 1 año; anotar la fecha.
- ▸ Registrar en el gestor de contraseñas: cliente, usuario, fecha de emisión.
- ✓ Verificar el token antes de entregarlo:
  `echo <TOKEN> | docker login ghcr.io -u mkanban-<cliente> --password-stdin && docker pull ghcr.io/mdevel-uy/fluke:stable`

**B. Preparación del servidor (lado cliente)**

- ▸ Confirmar requisitos: Linux x86_64, Docker + compose, 4+ vCPU / 8+ GB RAM / 60+ GB disco.
- ▸ Entregar la lista de dominios de egress (ver [README](README.md)) al equipo de
  redes **antes** de la instalación — es lo que más demora en empresas grandes.
- ✓ Desde el servidor: `curl -sI https://api.anthropic.com | head -1` y lo mismo
  para `github.com`, `registry.npmjs.org`, `ghcr.io`.

**C. Instalación**

- ▸ Copiar el bundle (`docker-compose.yml`, `.env.example`, `update.sh`) a `/opt/fluke`.
- ▸ `cp .env.example .env && chmod 600 .env`; completar `GHCR_USER` y `GHCR_TOKEN`.
- ▸ Decidir el bind de la UI. El default `FK_BIND_ADDR=127.0.0.1` asume
  reverse proxy del host (Traefik/Caddy/Nginx) que termina TLS y forwardea
  a `127.0.0.1:3000`. Sin reverse proxy, cambiar a `FK_BIND_ADDR=0.0.0.0`
  y aplicar el hardening de `../hardening/README.md` para no dejar puertos
  crudos abiertos.
- ▸ `chmod +x update.sh && ./update.sh`
- ✓ `docker inspect fluke --format '{{.State.Health.Status}}'` → `healthy`.
- ✓ Desde el servidor: `curl -sSf http://127.0.0.1:3000/ >/dev/null && echo OK`
  (con reverse proxy, verificar además el dominio público con `curl -sSfI https://<dominio>` → `200`).
- ▸ Si el cliente usa Tailscale como VPN de acceso (patrón por defecto en la
  factory), habilitar HTTPS dentro del tailnet: `sudo ./enable-tailscale-serve.sh`.
  Es requisito para PWA y notificaciones del browser (contexto seguro).
  Prerequisito una vez por tailnet: MagicDNS + HTTPS Certificates habilitados
  en el admin console (DNS → HTTPS Certificates → Enable). Ver README §HTTPS.
- ✓ Desde otro dispositivo del tailnet: `curl -sSfI https://<host>.<tailnet>.ts.net` → `200`
  y en el browser `window.isSecureContext === true`.
- ▸ Programar el cron de updates (ver README).

**D. Configuración con el cliente**

- ▸ Login de GitHub desde la UI (device flow) con la cuenta que va a usar la flota.
- ▸ Cargar la API key del proveedor de modelos en Ajustes.
- ▸ Dar de alta el primer proyecto y correr un ticket de prueba de punta a punta.
- ✓ El ticket llega a PR con review; el commit figura con la identidad del worker.

**E. Cierre**

- ▸ Registrar la instancia en el control de flota: cliente, servidor, versión,
  fecha de alta, parámetros de facturación.
- ▸ Enviar al cliente: accesos, canal de soporte, y qué esperar del reporte mensual.

## 1.2 Baja de cliente (offboarding)

- ▸ Confirmar por escrito la fecha de baja y emitir la última factura (mes vencido).
- ▸ 🔴 Revocar el PAT del machine user y quitarle el acceso al package.
  A partir de acá el cliente **no recibe más updates** (la instancia sigue corriendo).
- ▸ On-premises: instruir la desinstalación —`docker compose down`, borrar
  `/opt/fluke` y los volúmenes— y dejar constancia. Los datos son del cliente y
  quedan en su servidor (T&C cl. 13a).
- ▸ Administrado por mdevel: poner la exportación a disposición del cliente y
  mantenerla **30 días**; recién después 🔴 destruir instancia, volúmenes y respaldos (cl. 13b).
- ▸ Dar de baja la instancia del control de flota y de las alertas.

## 1.3 Publicar una versión

- ▸ Mergear a `mdev` todo lo que entra en la release.
- ▸ PR de bump de versión (package.json raíz, los 30 `Cargo.toml`, `Cargo.lock`,
  `tauri.conf.json`) → mergear a `mdev`.
- ▸ Mergear `mdev` → `main`. Esto dispara `publish-ghcr` (~40 min).
- ✓ La imagen `X.Y.Z` existe en GHCR y `stable` apunta a ella.
- ▸ Avisar a los clientes si la versión trae cambios visibles; el updater la
  instala esa madrugada sin intervención.

## 1.4 Emisión y renovación de licencias

> **Vía normal (automática)**: con `MKANBAN_CONTROL_PLANE_URL` y
> `MKANBAN_INGEST_TOKEN` en el `.env` del bundle, la instancia se auto-vincula
> al cliente en el panel (control.mkanban.dev/admin) y la licencia se renueva
> sola en cada heartbeat mientras el cliente esté al día. El alta del cliente
> en el panel entrega el token y un comando de bootstrap que deja todo
> configurado. La rutina manual de abajo queda para instalaciones sin salida a
> internet o como contingencia.

La herramienta es `fluke-license` (crate `crates/fluke-license`, interno —
no se distribuye al cliente). La clave privada se guarda **cifrada con
passphrase**; el archivo `.enc` en reposo no sirve sin ella.

**Setup por única vez (generar el par de claves)**

- ▸ En la máquina del operador (nunca en un servidor):
  `fluke-license keygen --out mkanban-signing.key.enc`
  Pide una passphrase y la repite; imprime la **clave pública** por stdout.
- ▸ 🔴 Guardar la clave pública: se embebe en el binario del producto (es la que
  usa el cliente para verificar). Va al código, no es secreta.
- ▸ 🔴 Resguardar `mkanban-signing.key.enc` en la bóveda (ver [LICENSING-SPEC](../../design/LICENSING-SPEC.md)).
  La passphrase va **por separado** del archivo. Si se pierde cualquiera de los
  dos, no se puede firmar → ver QRH 2.5.
- ▸ Registrar quién tiene acceso al archivo y a la passphrase, y desde cuándo.

**Emitir o renovar una licencia (rutina mensual, por cliente que paga)**

- ▸ Confirmar que el cliente está al día (es el acto de cobro: se firma porque pagó).
- ▸ Obtener el `instance_id` de la instancia del cliente (lo expone `GET /api/license`
  o el panel; es estable por instalación).
- ▸ Firmar:
  `fluke-license new --cliente <slug> --instance <instance_id> --dias 45 --out license.json`
  Pide la passphrase. `--dias 45` es el default de la etapa manual (ver spec).
- ✓ Verificar antes de entregar:
  `fluke-license inspect license.json --pubkey <clave_pública>` → firma válida
  y fecha de vencimiento correcta. (La herramienta ya verifica al emitir, pero el
  `inspect` explícito confirma que el archivo que vas a mandar es el bueno.)
- ▸ Entregar el `license.json` al cliente: se coloca en el data dir de la
  instancia (`~/.local/share/fluke/license.json`, dentro del volumen `fk-home`).
- ✓ Confirmar en el panel del cliente (o `GET /api/license`) que el estado quedó
  `valid` y con la nueva fecha.
- ▸ Registrar la emisión en el control de flota: cliente, fecha, vencimiento.

> Uso no interactivo (CI, o el control plane de la fase 5b que renueva solo):
> la passphrase se pasa por la variable `MKANBAN_LICENSE_PASSPHRASE` en vez del
> prompt. No usarla en un shell interactivo: quedaría en el historial.

## 1.5 Migración a Fluke (instancias instaladas como mkanban)

Una sola vez por instancia, al pasarla al bundle renombrado. Cambian: directorio
(`/opt/mkanban` → `/opt/fluke`), servicio/contenedor (`mkanban` → `fluke`),
volúmenes (`mk-repos`/`mk-home` → `fk-repos`/`fk-home`) y variables del `.env`
(`MK_*` → `FK_*`). Docker no renombra volúmenes: hay que copiar el contenido.
Si se salta este paso, compose crea `fk-*` vacíos y la instancia arranca sin
datos (siguen intactos en `mk-*`); `update.sh` lo detecta y aborta.

- ▸ Parar y borrar el contenedor viejo (libera los puertos; los volúmenes quedan):
  `cd /opt/mkanban && docker compose down`
- ▸ Mover el directorio y reemplazar el bundle por la versión nueva
  (`docker-compose.yml`, `update.sh`, scripts de Tailscale). El `.env` se conserva:
  `sudo mv /opt/mkanban /opt/fluke && cd /opt/fluke`
- ▸ Copiar los volúmenes (con la app parada):
  ```bash
  for v in repos home; do
    docker volume create "fk-$v"
    docker run --rm -v "mk-$v:/from:ro" -v "fk-$v:/to" alpine \
      sh -c 'cp -a /from/. /to/'
  done
  ```
- ▸ Opcional: renombrar en el `.env` las variables `MK_*` a `FK_*`. No es
  obligatorio — las `MK_*` siguen valiendo como fallback.
- ▸ 🔴 Imagen (obligatorio, aunque no se renombren las demás): la imagen pasó de
  `ghcr.io/mdevel-uy/mkanban` a `ghcr.io/mdevel-uy/fluke`. El package viejo se
  publica solo durante una release de transición; después, una instancia que
  siga apuntando ahí no recibiría más updates; el `update.sh` nuevo lo detecta y
  aborta con ERROR hasta que se cambie.
  - Precondición (lado mdevel): el machine user del cliente tiene Read en el
    package `ghcr.io/mdevel-uy/fluke` (Package settings → Manage Actions access).
  - En el `.env`: `FK_IMAGE=ghcr.io/mdevel-uy/fluke` y borrar `MK_IMAGE` si está
    (`FK_IMAGE` tiene precedencia, pero así no queda un valor viejo engañoso).
  - ✓ `set -a; . ./.env; set +a; echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin && docker pull "$FK_IMAGE:${FK_CHANNEL:-${MK_CHANNEL:-stable}}"`
    completa.
- ▸ Actualizar el cron: en `/etc/cron.d/mkanban-update` cambiar la ruta a
  `/opt/fluke/update.sh` y el log a `/var/log/fluke-update.log`; renombrar el
  archivo a `/etc/cron.d/fluke-update`.
- ▸ `docker compose up -d fluke`
- ✓ `docker inspect fluke --format '{{.State.Health.Status}}'` → `healthy`, y en
  la UI aparecen los proyectos y el historial de antes.
- ▸ Si usa Tailscale Serve, re-correr `sudo ./enable-tailscale-serve.sh` desde
  `/opt/fluke` (idempotente; el puerto no cambia).
- ▸ 🔴 Recién tras unos días de operación normal, borrar los viejos:
  `docker volume rm mk-repos mk-home`, y las imágenes con el nombre viejo
  (`docker image prune` no toca imágenes taggeadas):
  `docker rmi ghcr.io/mdevel-uy/mkanban:stable ghcr.io/mdevel-uy/mkanban:previous`
  (si el cliente usa otro canal, ese tag en lugar de `stable`). Los backups previos quedan en
  `backups/mk-data-*.tgz` y no entran en la rotación nueva (`fk-data-*`).

---

# Parte 2 — Procedimientos anormales (QRH)

## 2.1 El cliente no puede bajar la imagen

Síntoma: `unauthorized` o `denied` en `docker pull` / `update.sh`.

- ▸ Confirmar que el token no expiró ni fue revocado (GitHub → machine user → PAT).
- ▸ Confirmar que el machine user sigue con rol Read sobre el package.
- ▸ Probar desde el servidor del cliente:
  `echo $GHCR_TOKEN | docker login ghcr.io -u $GHCR_USER --password-stdin`
- ▸ Si el token está sano, verificar egress a `ghcr.io` **y** a
  `pkg-containers.githubusercontent.com` (el blob storage; se olvida seguido en
  firewalls corporativos y da el mismo error).
- ▸ Si hay que rotar el token: emitir uno nuevo, actualizar `GHCR_TOKEN` en el
  `.env` del cliente y volver a correr `./update.sh`.
- ✓ `docker pull ghcr.io/mdevel-uy/fluke:stable` completa.

**La instancia sigue funcionando durante todo esto**: sin acceso al registro solo
se pierden los updates, no el servicio.

## 2.2 El updater revirtió solo

Síntoma: en el log del updater, `ERROR: healthcheck no pasó … — rollback`.

Estado esperado tras el rollback: el cliente está corriendo la **versión
anterior**, sana, con sus datos restaurados del backup previo al intento.

- ✓ Confirmar primero que el cliente está operativo:
  `docker inspect fluke --format '{{.State.Health.Status}}'` → `healthy`.
- ▸ Recuperar el diagnóstico **antes** de reintentar:
  `docker compose logs fluke --tail=200` y el log del updater
  (`/var/log/fluke-update.log`).
- ▸ 🔴 No reintentar el update hasta entender la causa: el cron lo va a volver a
  intentar la madrugada siguiente y va a repetir el ciclo. Si hace falta ganar
  tiempo, comentar la línea del cron.
- ▸ Reproducir del lado nuestro con la misma imagen antes de publicar un fix.
- ▸ Publicar la corrección como versión nueva (nunca re-escribir un tag ya publicado).

## 2.3 La instancia dejó de reportar

Síntoma: alerta de instancia sin métricas, o el cliente reporta lentitud.

- ▸ Verificar que el contenedor esté arriba y healthy.
- ▸ Verificar disco: `df -h` — el volumen `fk-repos` es el que más crece
  (clones y workspaces de los agentes).
- ▸ Si el disco está lleno: purgar workspaces obsoletos desde la UI antes de
  tocar nada a mano.
- ▸ Revisar `docker compose logs fluke --tail=200` en busca de errores de
  executor o de la API del modelo.

## 2.4 Falta de pago → suspensión

Base contractual: [Términos](https://mkanban.dev/terms) cl. 9. El esquema es
**gradual y está comprometido por escrito**; respetarlo al pie.

- ▸ **Aviso**: notificar por los canales de contacto acordados. Registrar fecha.
- ▸ Esperar el período de gracia pactado — **nunca menor a 7 días** desde el aviso.
- ▸ 🔴 **Suspensión**: dejar de renovar la licencia (kill-switch pasivo).
- ✓ Verificar que el cliente **conserva acceso** a tablero, historial, repos y
  exportación. Si algo de eso quedó bloqueado, es un bug nuestro y es una
  violación del contrato: revertir de inmediato.
- ▸ Regularizado el pago: emitir licencia nueva; la funcionalidad vuelve sola.

> **Estado actual**: la licencia firmada todavía no está implementada
> (ver `design/LICENSING-SPEC.md`). Hasta entonces la suspensión es manual y
> requiere acceso al servidor del cliente — lo que en on-premises puro puede no
> existir. **No firmar un contrato on-prem sin esta pieza o sin una garantía
> comercial equivalente.**

## 2.5 Pérdida o filtración de la clave de firma

- **Pérdida**: ninguna instancia puede renovar licencia. Todas van a degradar al
  vencer. ▸ Generar par nuevo, publicar versión con la clave pública nueva
  embebida, y forzar el update en todos los clientes **antes** del vencimiento
  más próximo. Es una carrera contra reloj: atender de inmediato.
- **Filtración**: cualquiera puede auto-licenciarse. ▸ Mismo procedimiento, y
  además revisar si hubo instancias con licencias no emitidas por nosotros.
- ▸ En ambos casos: dejar registro del incidente y de la fecha de rotación.

## 2.6 El cliente pide sus datos / auditoría

- ▸ On-premises: los datos ya están en su servidor; indicar dónde
  (volúmenes `fk-home` y `fk-repos`) y cómo respaldarlos.
- ▸ Administrado: generar la exportación y entregarla por canal seguro.
- ▸ Para auditoría de "quién hizo qué": el historial de GitHub tiene la
  atribución por worker (cada uno con su propia identidad), más el historial de
  sesiones de agente en la instancia.

## 2.7 La URL HTTPS del tailnet no responde / cert inválido

Síntoma: `https://<host>.<tailnet>.ts.net` no responde, o el browser muestra
warning de certificado. El acceso por IP + HTTP sigue funcionando (el serve es
una vía adicional, no reemplaza el bind del contenedor).

- ▸ Confirmar que el nodo esté online: `tailscale status` en el host.
- ▸ Confirmar que el serve esté configurado: `tailscale serve status`. Debe
  listar `443 → http://127.0.0.1:${FK_PORT}`. Si está vacío, re-correr
  `sudo ./enable-tailscale-serve.sh`.
- ▸ Confirmar que el upstream esté vivo: `curl -sSfI http://127.0.0.1:${FK_PORT}/`
  desde el host → `200`. Si falla, el problema no es HTTPS: revisar el
  contenedor con `docker compose ps` y `docker compose logs fluke --tail=200`.
- ▸ Cert warning: emitir a mano `tailscale cert <host>.<tailnet>.ts.net`. Si
  falla, verificar que **HTTPS Certificates** esté habilitado en el admin
  console del tailnet (DNS → HTTPS Certificates → Enable). Es un prerequisito
  a nivel tailnet, no del nodo.
- ▸ Si `tailscale cert` funciona pero el serve sigue caído, `tailscale serve reset`
  y re-correr el enable — a veces queda un handler stale tras cambiar `FK_PORT`.
