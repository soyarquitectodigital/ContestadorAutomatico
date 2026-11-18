# Despliegue en el VPS

Este directorio contiene el proxy Nginx y la página índice del despliegue con
6 instancias independientes del contestador.

## Arquitectura

```
Internet :80
   │
   ▼
contestador-proxy (nginx)
   ├── /cuenta-1/  →  contestador-1:3000  (BASE_PATH=/cuenta-1)
   ├── /cuenta-2/  →  contestador-2:3000  (BASE_PATH=/cuenta-2)
   ├── ...
   └── /cuenta-6/  →  contestador-6:3000  (BASE_PATH=/cuenta-6)
```

Cada instancia tiene su propio `env/cuenta-N.env` y su propio volumen
`data/cuenta-N` (sesiones de WhatsApp, configuración y contraseña maestra).

## Puesta en marcha

Desde la raíz del proyecto, en el VPS:

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

Comprobar estado y salud:

```bash
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs -f contestador-1
```

## Respaldo de Turso a SQLite (modo montado)

Para que una instancia use un archivo `.db` local en vez de conectarse a Turso:

1. Crear el respaldo (solo lectura de Turso):

```bash
mkdir -p /opt/contestador/app/sqlite/cuenta-1
cat > /tmp/turso-backup.env <<'EOF'
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
SQLITE_PATH=/backup/contestadorautomatico.db
EOF
chmod 600 /tmp/turso-backup.env
docker run --rm --entrypoint node --env-file /tmp/turso-backup.env \
  -v /opt/contestador/app/sqlite/cuenta-1:/backup \
  contestador-automatico:latest scripts/turso-to-sqlite.mjs
rm -f /tmp/turso-backup.env
chmod 600 /opt/contestador/app/sqlite/cuenta-1/contestadorautomatico.db
```

2. En `env/cuenta-N.env` usar el archivo, sin variables de Turso:

```bash
SQLITE_PATH=/app/db/contestadorautomatico.db
```

3. Montar la carpeta en `docker-compose.vps.yml`:

```yaml
volumes:
  - ./data/cuenta-N:/app/data
  - ./sqlite/cuenta-N:/app/db
```

4. Recrear la instancia:

```bash
docker compose -f docker-compose.vps.yml up -d --force-recreate contestador-N
```

El respaldo se puede repetir en cualquier momento; conviene hacerlo con el
servicio principal detenido para que las claves de WhatsApp estén frescas.

## Variables de cada instancia

Los archivos `env/cuenta-N.env` no se versionan (están en `.gitignore`). Para
crear uno nuevo:

```bash
PORT=3000
BASE_PATH=/cuenta-7
SESSION_SECRET=<openssl rand -hex 32>
DATA_DIR=/app/data
MASTER_KEY=<contraseña maestra>
```

`MASTER_KEY` fija la contraseña del panel por entorno. Si se omite, la APP pide
crearla en el primer acceso y la guarda cifrada en `data/cuenta-N/master.json`.
En modo SQLite la contraseña se lee de la fila `master` del propio `.db`.

`STANDBY=1` deja el panel en solo lectura (no conecta WhatsApp ni escribe en la
base). `ACCOUNT_REFERENCE=cliente@example.com` muestra el correo enmascarado en
las cards, sin guardarlo en la base de datos.

## Actualizar la aplicación

```bash
# volver a subir el proyecto a /opt/contestador/app
docker compose -f docker-compose.vps.yml up -d --build
```

Las sesiones de WhatsApp viven en `data/cuenta-N`, por lo que sobreviven a los
reinicios y a los rebuilds.

## HTTPS

- Certificado de Let's Encrypt para la IP `144.91.73.212` (perfil
  `shortlived`, válido ~6 días). No hace falta dominio.
- Certbot 5.8 instalado en `/opt/certbot`; renovación automática por cron dos
  veces al día (`/etc/cron.d/certbot-renew`), con recarga de Nginx mediante
  `--deploy-hook`.
- El reto ACME se sirve por HTTP en `/.well-known/acme-challenge/` desde
  `deploy/acme`; el resto del tráfico HTTP redirige a HTTPS.
- Certificados en `/etc/letsencrypt/live/144.91.73.212/` (montados en el
  contenedor proxy como solo lectura).
- Renovación manual: `/opt/certbot/bin/certbot renew`.

## Notas

- El proxy publica solo el puerto 80. Los contenedores de la app no exponen
  puertos al host (`expose: 3000`).
- `restart: unless-stopped` y Docker habilitado al arranque: todo vuelve solo
  tras reiniciar el VPS.
- Pendiente de seguridad: servir por HTTPS (dominio + Let's Encrypt/Caddy o
  Cloudflare Tunnel). Ahora mismo las contraseñas viajan por HTTP.
