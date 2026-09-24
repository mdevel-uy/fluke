# Hardening de red — Docker sobre cualquier VPS

Piezas reutilizables para cerrar los puertos "crudos" que Docker publica
en `0.0.0.0` a espaldas de ufw. Aplicable en cualquier proveedor
(Hostinger, AWS, Azure, DigitalOcean, VPS propia): la lógica vive en la
chain iptables `DOCKER-USER` que Docker respeta oficialmente.

## Por qué

Docker Engine, cuando publica un puerto (`ports: - "5432:5432"` en un
compose, o `-p 5432:5432` en la CLI), inserta reglas en la tabla `nat` de
iptables (chain `DOCKER`) que se evalúan **antes** que las reglas de ufw.
Resultado: el puerto queda accesible desde internet aunque `ufw status`
muestre "5432/tcp deny". La única manera portable de filtrar tráfico
hacia contenedores es la chain `DOCKER-USER`, que Docker crea al arrancar
y expone exactamente para este uso.

Los firewalls de los proveedores (Hostinger Firewall, AWS SG, Azure NSG,
DO Firewall) son defensa en profundidad opcional, pero no la barrera
única: cambiar de cloud dejaría al host desnudo.

## Qué hace el script

`docker-firewall.sh` aplica una allowlist en `DOCKER-USER`:

1. Conexiones `RELATED,ESTABLISHED` (respuestas al tráfico saliente de
   contenedores).
2. Loopback (permite un reverse proxy en el host llegando a contenedores
   publicados en `127.0.0.1:PORT`).
3. Interfaces de administración (por defecto `tailscale0`; sólo se agregan
   las presentes en `/sys/class/net`).
4. Puertos TCP públicos (por defecto `80,443` — el reverse proxy del
   stack).
5. Puertos UDP públicos (vacío por defecto).
6. Todo lo demás → `DROP`.

Se aplica a IPv4 y, si `ip6tables` está disponible, a IPv6 también. Es
idempotente: correrlo N veces produce el mismo estado (flush + add).

## Puertos del host

El script filtra el tráfico **FORWARD-eado hacia contenedores**. El
tráfico dirigido al host mismo (SSH, un Traefik nativo del host, etc.) va
por la chain `INPUT` y sigue siendo responsabilidad de ufw / iptables
estándar. Los puertos del host que deben quedar públicos en la factory
actual son:

| Puerto      | Protocolo | Uso                                    |
|-------------|-----------|----------------------------------------|
| 22          | TCP       | SSH (deploy vía GitHub Actions)        |
| 80, 443     | TCP       | Reverse proxy público (Traefik)        |
| 41641       | UDP       | Tailscale directo (fallback DERP)      |

En instancias nuevas normalmente Traefik corre en un contenedor y publica
80/443 — para eso están las reglas del script. Si Traefik es nativo del
host, sólo hace falta ufw allow 80/443 y el tráfico ni siquiera llega a
`DOCKER-USER`.

## Instalación (una vez, por instancia)

Los tres archivos van al host — típicamente los deja el cloud-init de
mkanban-control, pero también sirven para aplicar a mano en la factory
actual desde una sesión SSH:

```bash
sudo install -m 0755 docker-firewall.sh /usr/local/sbin/docker-firewall.sh
sudo install -m 0644 docker-firewall.service /etc/systemd/system/docker-firewall.service
sudo mkdir -p /etc/fluke
sudo install -m 0644 docker-firewall.conf.example /etc/fluke/docker-firewall.conf
# editar /etc/fluke/docker-firewall.conf si hace falta

sudo systemctl daemon-reload
sudo systemctl enable --now docker-firewall.service
```

Verificación:

```bash
sudo systemctl status docker-firewall.service
sudo iptables -n -L DOCKER-USER
sudo ip6tables -n -L DOCKER-USER   # si hay IPv6
```

La chain `DOCKER-USER` debería mostrar la allowlist arriba y un `DROP`
final. `journalctl -u docker-firewall.service -n 50` muestra el log de la
última ejecución.

## Reaplicar reglas

Editar `/etc/fluke/docker-firewall.conf` y:

```bash
sudo systemctl reload docker-firewall.service
```

El servicio también se dispara solo cada vez que Docker se reinicia
(`PartOf=docker.service`), así que no hace falta acordarse tras un
`systemctl restart docker`.

## Test / verificación

Desde otra máquina en internet (no la mesh privada), intentar acceder a
un puerto que **no** esté en la allowlist. Por ejemplo, si hay un
Postgres publicado en `0.0.0.0:5432`:

```bash
nc -vz <IP_DEL_HOST> 5432
# esperado: connection refused / timeout
```

Desde dentro de la mesh (por ejemplo por Tailscale) el mismo comando
debería conectar — eso confirma que la allowlist funciona.

## Inventario previo — checklist antes de aplicar

Correr en el host **antes** de habilitar el servicio, para saber qué se
va a cortar:

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
sudo ss -tlnp
```

Si algún puerto publicado en `0.0.0.0` legítimamente debe seguir siendo
público (más allá de 80/443/tailscale), agregarlo a
`/etc/fluke/docker-firewall.conf` (`PUBLIC_TCP_PORTS` /
`PUBLIC_UDP_PORTS`) antes de correr `systemctl enable --now`. Al revés:
si un servicio quedó expuesto por error, la fix correcta es rebindearlo
en el compose (`127.0.0.1:PORT:PORT`) — el firewall es la segunda
barrera, no la primera.
