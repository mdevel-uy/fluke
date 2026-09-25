# Fluke on-premises

Bundle de instalación para infra del cliente (VPS, EC2, servidor propio).
Contenido: `docker-compose.yml` (genérico, no se edita), `.env.example`
(config por-cliente) y `update.sh` (updater OTA con backup y rollback).

## Requisitos

- Linux x86_64 con Docker Engine + plugin compose (`apt install docker.io docker-compose-v2` o repo oficial de Docker CE). Sin licencias: Docker Desktop **no** se usa en servidores.
- Egress HTTPS hacia: `api.anthropic.com`, `github.com` / `api.github.com`, `registry.npmjs.org`, `ghcr.io` (+ `pkg-containers.githubusercontent.com`).
- Credenciales de pull de GHCR entregadas por mdevel (token solo-lectura).

## Instalación

```bash
sudo mkdir -p /opt/fluke && cd /opt/fluke
# copiar docker-compose.yml, .env.example y update.sh a este directorio
cp .env.example .env && chmod 600 .env && vi .env   # completar GHCR_TOKEN y plan
chmod +x update.sh
./update.sh          # primer pull + arranque (hace de instalador)
```

La UI queda en `http://<host>:3000` (o `FK_PORT`). Los datos persisten en los
volúmenes docker `fk-repos` (checkouts) y `fk-home` (DB sqlite, config,
credenciales de GitHub/agentes).

## Red — bind por defecto en loopback

`docker-compose.yml` publica los puertos en `127.0.0.1` (`FK_BIND_ADDR`).
El patrón esperado es un reverse proxy del host (Traefik, Caddy, Nginx)
que termina TLS y hace forward a estos puertos. Para exponer directo en
la interfaz pública, sobreescribir `FK_BIND_ADDR=0.0.0.0` en el `.env`
— pensarlo dos veces: Docker publica por iptables y bypassea ufw. Ver
`../hardening/README.md` para cerrar los puertos crudos que no deban ser
públicos.

## HTTPS dentro del tailnet (Tailscale Serve)

El navegador exige contexto seguro (HTTPS o localhost) para habilitar
`Notification`, instalación como PWA y otras APIs modernas. Con acceso
por IP de Tailscale sobre HTTP plano, `window.isSecureContext === false`
y Chrome no ofrece esas features.

`enable-tailscale-serve.sh` habilita HTTPS dentro del tailnet usando
[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve): el
`tailscaled` del host termina TLS en `https://<host>.<tailnet>.ts.net`
con un certificado válido de Let's Encrypt (provisto por Tailscale) y
forwardea a `http://127.0.0.1:${FK_PORT}`. Nada se expone a internet —
solo escucha dentro del tailnet, consistente con el modelo de acceso
solo-VPN. La renovación del cert la maneja Tailscale (no agregar cron
propio). El acceso HTTP por IP de tailnet sigue funcionando como fallback.

```bash
sudo ./enable-tailscale-serve.sh
# → https://<host>.<tailnet>.ts.net
```

Requisitos previos (una sola vez, en el admin console del tailnet):

- **MagicDNS** habilitado.
- **HTTPS Certificates** habilitado (DNS → HTTPS Certificates → Enable).

Sin ambos el script aborta con un mensaje explicando qué falta. Los
WebSockets (kanban en vivo, logs, terminal) pasan sin config extra:
Tailscale Serve los proxya nativo y el frontend detecta `wss://` desde
`window.location.protocol`.

Para desactivar:

```bash
sudo ./disable-tailscale-serve.sh
```

## Updates OTA

`update.sh` es idempotente: si no hay versión nueva en el canal, no hace nada.
Programarlo diario:

```bash
echo '17 4 * * * root /opt/fluke/update.sh >> /var/log/fluke-update.log 2>&1' \
  | sudo tee /etc/cron.d/fluke-update
```

Ante una versión nueva: backup del data dir → restart → espera healthcheck →
rollback automático (imagen anterior + restore del backup) si no levanta sano.
Los backups quedan en `./backups/` (últimos 10).

## Rollback manual

El backup de `update.sh` incluye los dos data dirs que existan (`fluke/` y el
legacy `mkanban/`, donde quedan los repos clonados desde la UI), por eso el
restore borra ambos antes de extraer. No usar un `.tgz` armado a mano con
sólo uno de los dos.

```bash
cd /opt/fluke
docker compose stop fluke
docker run --rm -v fk-home:/data -v "$PWD/backups:/backup:ro" alpine \
  sh -c 'rm -rf /data/.local/share/fluke /data/.local/share/mkanban && tar xzf /backup/<ARCHIVO>.tgz -C /data'
docker tag ghcr.io/mdevel-uy/fluke:previous ghcr.io/mdevel-uy/fluke:stable
docker compose up -d fluke
```

Nunca arrancar un binario viejo contra una DB migrada por uno nuevo: las
migraciones son forward-only (el binario viejo se niega a arrancar). El
restore del backup siempre acompaña al downgrade — `update.sh` ya lo hace.
