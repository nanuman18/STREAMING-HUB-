# Despliegue y mantenimiento

Stremio solo instala addons remotos por **HTTPS**. Esta guía cubre el despliegue con Docker en un servidor propio, con certificado automático, y las tareas de mantenimiento.

## Requisitos del servidor

- 1 vCPU y 512 MB de RAM bastan. La base de datos ocupa unos 41 MB con las 12 plataformas en España.
- **Disco persistente** para `/data`. Sin él, cada reinicio repetiría la primera carga completa.
- Un dominio o subdominio apuntando a la IP del servidor (registro A/AAAA), con los puertos 80 y 443 abiertos.
- Docker y Docker Compose.

## Opción A — Docker Compose con HTTPS automático (recomendada)

```bash
git clone <tu-repositorio> streaming-hub && cd streaming-hub
cp .env.example .env
nano .env                       # TMDB_ACCESS_TOKEN=… y PUBLIC_URL=https://hub.midominio.com
DOMAIN=hub.midominio.com docker compose --profile https up -d --build
docker compose logs -f streaming-hub
```

Caddy obtiene y renueva el certificado de Let's Encrypt y reenvía el tráfico al contenedor. La primera sincronización empieza sola a los pocos segundos.

- Página de configuración: `https://hub.midominio.com/configure`
- **URL para instalar en Stremio:** `https://hub.midominio.com/manifest.json` (configuración por defecto) o la que genera la página de configuración (`https://hub.midominio.com/<config>/manifest.json`).

Sin el perfil `https` (`docker compose up -d --build`), el addon escucha solo en el puerto 7000. Sirve si ya tienes un proxy inverso (Nginx, Traefik, Cloudflare Tunnel…) que termina el HTTPS. En ese caso, reenvía todo el host al puerto 7000. El addon confía en `X-Forwarded-*`.

### Nginx como alternativa a Caddy

```nginx
server {
    server_name hub.midominio.com;
    listen 443 ssl http2;
    # ssl_certificate … (certbot --nginx)
    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## Opción B — Sin Docker (Linux con systemd)

```bash
npm ci && npm run build
sudo tee /etc/systemd/system/streaming-hub.service >/dev/null <<'EOF'
[Unit]
Description=Streaming Hub (addon de Stremio)
After=network-online.target

[Service]
WorkingDirectory=/opt/streaming-hub
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=streaminghub
EnvironmentFile=/opt/streaming-hub/.env

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now streaming-hub
```

Delante, un proxy con HTTPS (Caddy: `hub.midominio.com { reverse_proxy 127.0.0.1:7000 }`).

## Opción C — Plataformas gestionadas (Render, Railway, Fly.io…)

Funcionan con el `Dockerfile` incluido si cumplen dos condiciones:

1. **Volumen persistente** montado en `/data`. Sin él, los datos se pierden en cada despliegue.
2. **Proceso siempre encendido.** Los planes que «duermen» el servicio detienen la sincronización programada.

Variables: las de `.env.example`, con `TMDB_ACCESS_TOKEN` como *secret*. Health check: `GET /health`.

## Probar en local desde otro dispositivo (sin dominio)

Stremio no acepta `http://` salvo en `127.0.0.1`. Para probar desde la tele o el móvil sin desplegar, usa un túnel HTTPS temporal:

```bash
cloudflared tunnel --url http://localhost:7000
```

y abre `https://<subdominio>.trycloudflare.com/configure`. La URL cambia en cada arranque, así que habría que reinstalar el addon.

## Health check y monitorización

- `GET /health` → `{"status":"ok"|"degraded","db":"ok","lastSync":"…","syncing":false}`.
  - `degraded`: la última sincronización correcta tiene más de 48 h. El addon sigue sirviendo los últimos datos.
  - HTTP 503: la base de datos no responde.
- El `HEALTHCHECK` del Dockerfile usa este endpoint.
- `GET /api/status`: recuentos por catálogo (visibles, sin IMDb, nuevos en 7 días, retirados), estado de la última revisión completa y errores recientes.
- Registros: una línea por catálogo y sincronización con `recogidos/total`, altas, bajas y si la recogida fue completa.

## Mantenimiento

| Tarea | Cómo |
|---|---|
| Forzar una sincronización | `docker compose exec streaming-hub node dist/sync/cli.js --full` (o `--incremental`). Si ya hay una en marcha, se rechaza. |
| Añadir una plataforma | Editar `config/platforms.json` (o montarlo como volumen: `PLATFORMS_FILE`) y reiniciar. |
| Una plataforma deja de aparecer | Revisar el registro `Plataforma X no aparece entre los proveedores de TMDB`: TMDB habrá cambiado el nombre. Añade el nuevo a `match`. |
| Copia de seguridad | `docker compose exec streaming-hub node -e "new (require('node:sqlite').DatabaseSync)('/data/streaming-hub.db').exec(\"VACUUM INTO '/data/backup.db'\")"` y copia `backup.db`. Si se pierde, basta con volver a sincronizar. |
| Actualizar | `git pull && docker compose up -d --build`. Las migraciones del esquema se aplican solas al arrancar. |
| Reiniciar desde cero | Parar, borrar el volumen `hub-data` y arrancar: se repite la carga inicial. |
| Rotar el token de TMDB | Cambiar `.env` y `docker compose up -d`. El token no está en ninguna URL instalada, así que los usuarios no tienen que reinstalar. |

## Escalado y migración a PostgreSQL

- Un solo proceso atiende con holgura muchas peticiones: los catálogos se sirven desde SQLite con índices y caché en memoria.
- Para varias réplicas detrás de un balanceador hace falta una base de datos compartida. Todo el SQL vive en [`src/db/store.ts`](../src/db/store.ts) y el esquema en [`src/db/database.ts`](../src/db/database.ts). Solo usan SQL estándar (`ON CONFLICT … DO UPDATE`, sin funciones JSON), así que portar a PostgreSQL consiste en:
  1. Traducir el esquema (`INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL`, `REAL` → `DOUBLE PRECISION`).
  2. Implementar los métodos de `Store` con `pg` (consultas asíncronas) y cambiar `INSERT OR IGNORE` por `ON CONFLICT DO NOTHING`.
  3. Sustituir `GROUP BY imdb_id` con columnas no agregadas por `DISTINCT ON (imdb_id)`.
  4. El bloqueo de sincronización (`locks`) funciona igual en una tabla compartida, o se puede usar `pg_advisory_lock`.

  **Esta migración no está implementada.** Hoy el proyecto funciona solo con SQLite.
- En varias réplicas, conviene que solo una tenga `SYNC_ENABLED=true`. El bloqueo en la base de datos evita igualmente sincronizaciones simultáneas.
