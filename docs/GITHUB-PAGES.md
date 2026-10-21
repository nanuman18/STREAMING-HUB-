# Publicar gratis en GitHub Pages (sin servidor)

En este modo no hay ningún servidor encendido. **GitHub Actions** sincroniza con TMDB cada 6 horas, genera todas las respuestas del addon como archivos JSON y las publica en **GitHub Pages** con HTTPS. Solo hace falta una cuenta gratuita de GitHub.

```
GitHub Actions (cada 6 h)                                   GitHub Pages (HTTPS)
  npm run sync      →  SQLite (guardada en la caché)  →  site/  →  https://usuario.github.io/streaming-hub/
  npm run export                                                     ├─ index.html         (instalar)
                                                                     ├─ netflix/popularity/manifest.json
                                                                     └─ netflix/popularity/catalog/movie/…
```

## Diferencias con el modo servidor

| | Servidor (Docker/VPS) | GitHub Pages |
|---|---|---|
| Coste | VPS o PC encendido | 0 € |
| Addons | Uno, con las plataformas y el orden que elijas | **Uno por plataforma** (instalas las que quieras) |
| Orden de títulos | Cualquiera, por configuración | 4 variantes ya generadas: popularidad, novedades, estreno, valoración |
| Profundidad | Todo el catálogo | Hasta **1.000 títulos** por catálogo y por género (`STATIC_MAX_PAGES=10`) |
| Vista previa | Con imagen de fondo y sinopsis completa | Sin fondo y sinopsis de 300 caracteres (la ficha completa la da Cinemeta) |
| Actualización | Cada 6 h | Cada 6 h, más unos 5 min de publicación |

Medido con las 12 plataformas en España: 48 addons, 5.045 archivos y 182 MB. GitHub Pages admite sitios de hasta 1 GB.

## Puesta en marcha (una sola vez)

1. **Crea un repositorio público vacío** en <https://github.com/new>, por ejemplo `streaming-hub`, sin README ni licencia. GitHub Pages solo es gratis en repositorios públicos. El código es público, pero el token de TMDB no lo es: va guardado como *secret*.
2. **Sube el código** (`git push`). En Windows, la primera vez se abre el navegador para iniciar sesión en GitHub.
3. **Guarda el token de TMDB:** repositorio → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*. Nombre: `TMDB_ACCESS_TOKEN`; valor: tu «API Read Access Token».
4. **Activa Pages:** *Settings* → *Pages* → *Build and deployment* → *Source*: **GitHub Actions**.
5. **Primera ejecución:** pestaña *Actions* → *Actualizar catálogos* → *Run workflow*. La primera tarda unos 40 minutos (resuelve más de 40.000 IMDb ID); las siguientes, unos 5.
6. Abre `https://TU-USUARIO.github.io/streaming-hub/` y pulsa **Instalar** en cada plataforma que quieras.

A partir de ahí se actualiza solo cada 6 horas, con una revisión completa diaria.

## Mantenimiento

- **Ver si funciona:** pestaña *Actions*. Cada ejecución muestra el resumen por catálogo (recogidos, altas, bajas). La página principal muestra la fecha de la última actualización.
- **Si una ejecución falla** (TMDB caído, etc.), sigue publicada la última versión válida y la siguiente ejecución lo reintenta.
- **Inactividad:** GitHub desactiva los flujos programados de repositorios públicos tras 60 días sin actividad. El propio flujo se vuelve a habilitar por la API en cada ejecución para reiniciar ese plazo. Si aun así se desactivara, GitHub avisa por correo y basta con pulsar *Enable workflow* en *Actions*.
- **Caché de la base de datos:** si GitHub la borrase (cachés sin uso durante 7 días), la siguiente ejecución la reconstruye desde cero (~40 min). Los títulos se recuperan igual, pero se pierde el historial de novedades.
- **Añadir plataformas:** edita `config/platforms.json`, haz commit y lanza el flujo a mano.
- **Ajustes:** *Settings* → *Secrets and variables* → *Actions* → pestaña *Variables*: `STATIC_MAX_PAGES` (páginas de 100 por catálogo, 10 por defecto), `STATIC_SORTS` (órdenes generados, por defecto `popularity,new,release,rating`) y `STATIC_DESCRIPTION_MAX` (300).

## Probar en local

```bash
npm run export
npm run serve:static
```

Abre <http://127.0.0.1:7100/>. Stremio para escritorio puede instalar `http://127.0.0.1:7100/netflix/popularity/manifest.json` en el mismo equipo.
