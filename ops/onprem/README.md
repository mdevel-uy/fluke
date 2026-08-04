# mkanban on-premises

Bundle de instalación para infra del cliente (VPS, EC2, servidor propio).
Contenido: `docker-compose.yml` (genérico, no se edita), `.env.example`
(config por-cliente) y `update.sh` (updater OTA con backup y rollback).

## Requisitos

- Linux x86_64 con Docker Engine + plugin compose (`apt install docker.io docker-compose-v2` o repo oficial de Docker CE). Sin licencias: Docker Desktop **no** se usa en servidores.
- Egress HTTPS hacia: `api.anthropic.com`, `github.com` / `api.github.com`, `registry.npmjs.org`, `ghcr.io` (+ `pkg-containers.githubusercontent.com`).
- Credenciales de pull de GHCR entregadas por mdevel (token solo-lectura).

## Instalación

```bash
sudo mkdir -p /opt/mkanban && cd /opt/mkanban
# copiar docker-compose.yml, .env.example y update.sh a este directorio
cp .env.example .env && chmod 600 .env && vi .env   # completar GHCR_TOKEN y plan
chmod +x update.sh
./update.sh          # primer pull + arranque (hace de instalador)
```

La UI queda en `http://<host>:3000` (o `MK_PORT`). Los datos persisten en los
volúmenes docker `mk-repos` (checkouts) y `mk-home` (DB sqlite, config,
credenciales de GitHub/agentes).

## Updates OTA

`update.sh` es idempotente: si no hay versión nueva en el canal, no hace nada.
Programarlo diario:

```bash
echo '17 4 * * * root /opt/mkanban/update.sh >> /var/log/mkanban-update.log 2>&1' \
  | sudo tee /etc/cron.d/mkanban-update
```

Ante una versión nueva: backup del data dir → restart → espera healthcheck →
rollback automático (imagen anterior + restore del backup) si no levanta sano.
Los backups quedan en `./backups/` (últimos 10).

## Rollback manual

```bash
cd /opt/mkanban
docker compose stop mkanban
docker run --rm -v mk-home:/data -v "$PWD/backups:/backup:ro" alpine \
  sh -c 'rm -rf /data/.local/share/mkanban && tar xzf /backup/<ARCHIVO>.tgz -C /data'
docker tag ghcr.io/mdevel-uy/mkanban:previous ghcr.io/mdevel-uy/mkanban:stable
docker compose up -d mkanban
```

Nunca arrancar un binario viejo contra una DB migrada por uno nuevo: las
migraciones son forward-only (el binario viejo se niega a arrancar). El
restore del backup siempre acompaña al downgrade — `update.sh` ya lo hace.
