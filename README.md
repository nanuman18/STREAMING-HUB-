# Streaming Hub

Addon de **Stremio** que muestra catálogos de películas y series **organizados por plataforma de streaming** (Netflix, Disney+, Prime Video, HBO Max, Apple TV+, Movistar Plus+, SkyShowtime, Filmin, Atresplayer, RTVE Play, Crunchyroll y Rakuten TV) con la **disponibilidad en España**, a partir de datos de TMDB.

> **Streaming Hub no proporciona streams.** Solo publica catálogos con IMDb ID (`tt…`). Al abrir una ficha, Stremio usa Cinemeta para los metadatos y **tus addons de reproducción habituales** para los enlaces.

- Un catálogo de películas y otro de series por plataforma («Netflix — Películas», «Netflix — Series»…).
- Filtro por género y paginación nativos de Stremio.
- Orden configurable: popularidad, novedades detectadas, fecha de estreno o valoración.
- Sincronización automática: incremental cada 6 h y revisión completa diaria, con detección de altas y retiradas.
- Página de configuración web: plataformas, orden de catálogos, tipos, país e idioma, y estado de la última actualización.
- El token de TMDB se queda en el servidor y nunca aparece en manifiestos ni en URL.

Antes de usarlo en serio, lee **[docs/LIMITACIONES.md](docs/LIMITACIONES.md)**: explica qué cubre la API de TMDB y qué no.

### Dos formas de publicarlo

| | Cómo | Coste |
|---|---|---|
| **GitHub Pages** (recomendada) | GitHub Actions sincroniza cada 6 h y publica el addon como archivos estáticos. En Inicio, una fila con el icono de cada plataforma; al pulsarla, sus películas y series por fecha de estreno. Guía: **[docs/GITHUB-PAGES.md](docs/GITHUB-PAGES.md)** | 0 €, solo una cuenta de GitHub |
| **Servidor** | Node.js con Docker o en un VPS. Un único addon configurable. Guía: [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) | VPS o PC encendido |

---

## Índice

1. [Cómo funciona](#cómo-funciona)
2. [Instalación en Windows](#instalación-en-windows)
3. [Instalar el addon en Stremio](#instalar-el-addon-en-stremio)
4. [Configuración (.env)](#configuración-env)
5. [Scripts npm](#scripts-npm)
6. [Pruebas](#pruebas)
7. [Añadir otra plataforma](#añadir-otra-plataforma)
8. [API HTTP](#api-http)
9. [Estructura del proyecto](#estructura-del-proyecto)
10. [Despliegue en servidor](docs/DESPLIEGUE.md) · [Publicación gratuita en GitHub Pages](docs/GITHUB-PAGES.md)

---

## Cómo funciona

```
          ┌──────────── cada 6 h / 24 h ─────────────┐
          │                                          ▼
   TMDB API v3  ──►  Sincronización  ──►  SQLite (caché persistente)  ──►  Servidor HTTP  ──►  Stremio
  (JustWatch)        · proveedores por nombre        · títulos, IMDb ID             · /manifest.json
                     · Discover paginado/particionado · disponibilidad por país     · /catalog/…
                     · external_ids → IMDb ID         · altas / retiradas            · /configure
                     · verificación de retiradas      · ejecuciones                  · /health
```

- **Las peticiones de Stremio nunca llaman a TMDB.** Se sirven desde la base de datos local, con caché en memoria que se invalida tras cada sincronización. Si TMDB cae, el addon sigue sirviendo el último catálogo válido.
- **ID de plataforma reales.** En cada sincronización se descarga la lista de proveedores de TMDB para el país y cada plataforma se empareja por nombre ([config/platforms.json](config/platforms.json)). En España: Netflix = `8|1796` (con anuncios), Disney+ = `337`, Prime Video = `119|2100`, Apple TV+ = `350` («Apple TV»), Movistar Plus+ = `2241|149`, Filmin = `63|64`, RTVE Play = `541` («rtve»)…
- **Solo IMDb ID verdaderos.** Se obtienen de `external_ids` de TMDB. Los títulos sin IMDb ID no se publican (no serían compatibles con los addons de reproducción) y se vuelven a consultar cada 3 días.
- **Una retirada no se deduce de una ausencia.** Solo se evalúa tras una recogida completa sin errores, y cada candidato se verifica individualmente antes de darlo de baja.

## Instalación en Windows

### Requisitos

- **Node.js 24 LTS** (mínimo 22.13, porque se usa el módulo integrado `node:sqlite`). Descárgalo de <https://nodejs.org> o instálalo con:

  ```bash
  winget install OpenJS.NodeJS.LTS
  ```

- Una cuenta gratuita de **TMDB** y su token de API: <https://www.themoviedb.org/settings/api>. Copia el «API Read Access Token».

### Pasos (PowerShell)

```powershell
cd C:\ruta\a\streaming-hub
npm install
Copy-Item .env.example .env
notepad .env          # pega tu token en TMDB_ACCESS_TOKEN=
npm run sync -- --full   # primera carga (~35 min con las 12 plataformas)
npm run dev              # o: npm run build; npm start
```

Abre <http://127.0.0.1:7000/configure>.

> Durante la primera carga se puede arrancar el servidor (`npm run dev`) y los catálogos se irán llenando. El servidor también lanza la primera sincronización por sí mismo si la base de datos está vacía, así que el paso `npm run sync` es opcional.

Para una prueba rápida con dos plataformas y pocas páginas:

```powershell
$env:SYNC_PLATFORMS="netflix,disney"; $env:SYNC_MAX_PAGES="3"; npm run sync -- --full
```

## Instalar el addon en Stremio

1. Abre la página de configuración (`/configure`) de tu servidor.
2. Elige plataformas (arrastra o usa las flechas para ordenarlas), tipos, orden de los títulos, país e idioma.
3. Pulsa **Instalar en Stremio** (abre la app de escritorio) o **Abrir en Stremio Web**. También puedes **copiar la URL** del manifiesto y pegarla en Stremio → Addons → buscador.
4. Los catálogos aparecen en **Descubrir** y en el **Inicio**. Para cambiar la configuración, pulsa **Configurar** en el addon instalado: se abre la misma página con tu configuración cargada. Al reinstalar, la nueva configuración sustituye a la anterior.

> Stremio exige **HTTPS** para instalar addons remotos. `http://127.0.0.1:7000` solo funciona en el mismo equipo. Para usarlo en la tele, el móvil u otro dispositivo, despliégalo con HTTPS ([docs/DESPLIEGUE.md](docs/DESPLIEGUE.md)).

La URL final tiene la forma `https://tu-dominio/<configuración>/manifest.json`. `https://tu-dominio/manifest.json` instala la configuración por defecto (todas las plataformas, películas y series, España).

## Configuración (.env)

Todas las variables están comentadas en [.env.example](.env.example). Las principales:

| Variable | Por defecto | Descripción |
|---|---|---|
| `TMDB_ACCESS_TOKEN` / `TMDB_API_KEY` | — | Credencial de TMDB (una de las dos). |
| `PORT` | `7000` | Puerto HTTP. |
| `DB_PATH` | `./data/streaming-hub.db` | Base de datos SQLite. |
| `SYNC_REGIONS` | `ES` | Países a sincronizar (los únicos que ofrece la configuración). |
| `TMDB_LANGUAGE` | `es-ES` | Idioma de títulos, sinopsis y géneros. |
| `SYNC_INCREMENTAL_HOURS` / `SYNC_FULL_HOURS` | `6` / `24` | Calendario de sincronización. |
| `SYNC_MONETIZATION` | `flatrate,free,ads` | Qué cuenta como «está en la plataforma» (sin alquiler ni compra). |
| `TMDB_MAX_RPS` / `TMDB_CONCURRENCY` | `30` / `12` | Ritmo máximo hacia TMDB. |

## Scripts npm

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática (TypeScript directo). |
| `npm run build` | Compila a `dist/`. |
| `npm start` | Servidor de producción (`dist/index.js`). |
| `npm run sync -- --full` | Sincronización completa manual. `--incremental` para la rápida; sin argumento, la que toque. |
| `npm run sync:prod -- --full` | Igual, con el código compilado. |
| `npm test` | Pruebas unitarias (sin red). |
| `npm run test:integration` | Pruebas contra TMDB y Cinemeta reales (necesita el token en `.env`). |
| `npm run test:all` | Ambas. |
| `npm run typecheck` | Comprobación de tipos. |
| `npm run export` | Genera el sitio estático en `site/` desde la base de datos local. |
| `npm run serve:static` | Sirve `site/` en http://127.0.0.1:7100 para probarlo. |

## Pruebas

- **Unitarias** (`tests/unit`, 63 pruebas, sin red): usan un doble de TMDB en memoria que reproduce la paginación de 20, el límite de páginas y los filtros de Discover. Cubren manifiesto válido según el SDK oficial, catálogos de películas y series, IMDb ID, paginación, filtros por proveedor y género, órdenes, caché, sincronización incremental y completa, partición por fechas, altas, retiradas verificadas, falsos positivos de retirada, errores de TMDB (429, 5xx, red, 404), bloqueo de sincronizaciones simultáneas, calendario, configuración individual por URL, que el token nunca se expone y el sitio estático (rutas exactas que pide Stremio, límite de páginas, manifiestos válidos).
- **Integración** (`tests/integration`, 12 pruebas, con red): resuelven las 12 plataformas reales en España, comprueban IMDb ID de títulos conocidos y el límite de 500 páginas de Discover, sincronizan Netflix y Disney+ con datos reales, validan que los títulos devueltos figuran en la plataforma según su ficha individual de TMDB y que **sus fichas abren en Cinemeta**, y prueban el servidor HTTP con datos reales.

## Añadir otra plataforma

Edita [config/platforms.json](config/platforms.json) y reinicia. No hay que tocar código:

```json
{ "key": "mubi", "name": "MUBI", "match": ["MUBI"] }
```

- `key`: identificador estable (minúsculas). Se usa en las URL de configuración y en los ID de catálogo.
- `match`: nombres de proveedor tal como los lista TMDB en `/watch/providers` (sin distinguir mayúsculas ni espacios sobrantes).
- Opcional: `providerIds` (ID de TMDB fijados, solo si TMDB los lista en la región) y `monetization` (por ejemplo `["free", "ads"]` para servicios gratuitos).

Si el nombre no aparece en TMDB para el país, la plataforma se omite y se avisa en el registro. Para ver los nombres disponibles:

```bash
curl -H "Authorization: Bearer $TMDB_ACCESS_TOKEN" "https://api.themoviedb.org/3/watch/providers/movie?watch_region=ES"
```

## API HTTP

| Ruta | Descripción |
|---|---|
| `GET /manifest.json` | Manifiesto con la configuración por defecto. |
| `GET /{config}/manifest.json` | Manifiesto de una configuración concreta (base64url). |
| `GET /{config}/catalog/{type}/{id}.json` | Catálogo. Extra: `/genre=Drama&skip=100.json`. |
| `GET /configure`, `/{config}/configure` | Página de configuración. |
| `GET /api/options` | Plataformas, países, idiomas y órdenes disponibles. |
| `POST /api/config` | Valida una configuración y devuelve su URL. |
| `GET /api/status` | Recuentos por catálogo y últimas sincronizaciones. |
| `GET /health` | Estado del servicio (`ok` / `degraded`) y de la base de datos. |

No existen rutas `/stream` ni `/meta`.

## Estructura del proyecto

```
config/platforms.json     Plataformas (ampliable sin tocar código)
public/                   Página de configuración (HTML, CSS, JS sin dependencias)
src/
  index.ts                Arranque: servidor HTTP + planificador
  context.ts              Construcción de dependencias
  config/                 Variables de entorno y plataformas
  tmdb/                   Cliente TMDB (límite de ritmo, reintentos, backoff)
  db/                     Esquema SQLite, migraciones y Store (todo el SQL)
  sync/                   Resolución de proveedores, recogida, servicio, planificador, CLI
  addon/                  Configuración de usuario, manifiesto (SDK oficial) y catálogos
  server/                 Rutas HTTP (protocolo de addons, API, configuración, health)
tests/unit                Pruebas sin red
tests/integration         Pruebas con TMDB y Cinemeta reales
docs/                     Limitaciones, despliegue y mantenimiento
```

## Aviso

Este producto usa la API de TMDB, pero TMDB no lo avala ni lo certifica. La disponibilidad por plataforma procede de JustWatch a través de TMDB y puede no coincidir al 100 % con el catálogo real de cada servicio.
