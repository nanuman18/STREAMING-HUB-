# Publicar gratis en GitHub Pages (sin servidor)

En este modo no hay ningún servidor encendido. **GitHub Actions** sincroniza con TMDB cada 6 horas, genera todas las respuestas del addon como archivos JSON y las publica en **GitHub Pages** con HTTPS. Solo hace falta una cuenta gratuita de GitHub.

```
GitHub Actions (cada 6 h)                                   GitHub Pages (HTTPS)
  npm run sync      →  SQLite (guardada en la caché)  →  site/  →  https://usuario.github.io/repo/
  npm run export                                                     ├─ index.html          (instalar)
                                                                     ├─ manifest.json        (un único addon)
                                                                     ├─ catalog/other/plataformas.json
                                                                     ├─ meta/other/shub-netflix.json
                                                                     └─ catalog/movie/netflix.movie/genre=Todo.json …
```

## Cómo se ve en Stremio

1. **Inicio:** una fila **«Plataformas»** con el icono de cada una (logos oficiales que publica TMDB).
2. **Al pulsar un icono** se abre la ficha de la plataforma, con los enlaces **«Películas de …»** y **«Series de …»**.
3. Cada enlace abre su catálogo en **Descubrir**, ordenado **del estreno más reciente al más antiguo** (sin estrenos futuros). Arriba se puede filtrar por género.

Por qué son dos pulsaciones y no una: en Stremio, pulsar un elemento de un catálogo siempre abre su ficha. Lo que sí admite es poner en la ficha enlaces internos (`stremio:///discover/…`), que es lo que usa Cinemeta para sus géneros.

Para que los catálogos de cada plataforma no llenen Inicio con 24 filas, llevan el filtro `genre` como obligatorio, con «Todo» como primera opción. Stremio no muestra en Inicio los catálogos con filtros obligatorios, pero sí en Descubrir.

## Diferencias con el modo servidor

| | Servidor (Docker/VPS) | GitHub Pages |
|---|---|---|
| Coste | VPS o PC encendido | 0 € |
| Inicio de Stremio | Una fila por plataforma y tipo | Una fila con los iconos de las plataformas |
| Orden de títulos | Configurable (popularidad, novedades, estreno, valoración) | Fecha de estreno, de la más reciente a la más antigua |
| Profundidad | Todo el catálogo | Hasta **2.000 títulos** por catálogo y por género (`STATIC_MAX_PAGES=20`) |
| Géneros | Todos los que caben en 8 KB | Los 14 más frecuentes de cada catálogo (límite de 8 KB del manifiesto) |
| Vista previa | Con imagen de fondo y sinopsis completa | Sin fondo y sinopsis de 300 caracteres (la ficha completa la da Cinemeta) |

Medido con las 12 plataformas en España: 1.473 archivos y 57 MB. GitHub Pages admite sitios de hasta 1 GB.

## Puesta en marcha (una sola vez)

1. **Crea un repositorio público vacío** en <https://github.com/new>, por ejemplo `streaming-hub`, sin README ni licencia. GitHub Pages solo es gratis en repositorios públicos. El código es público, pero el token de TMDB no lo es: va guardado como *secret*.
2. **Sube el código** (`git push`). En Windows, la primera vez se abre el navegador para iniciar sesión en GitHub.
3. **Guarda el token de TMDB:** repositorio → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*. Nombre: `TMDB_ACCESS_TOKEN`; valor: tu «API Read Access Token».
4. **Activa Pages:** *Settings* → *Pages* → *Build and deployment* → *Source*: **GitHub Actions**.
5. **Primera ejecución:** pestaña *Actions* → *Actualizar catálogos* → *Run workflow*. La primera tarda unos 40 minutos (resuelve más de 40.000 IMDb ID); las siguientes, unos 5.
6. Abre `https://TU-USUARIO.github.io/streaming-hub/` y pulsa **Instalar en Stremio**.

A partir de ahí se actualiza solo cada 6 horas, con una revisión completa diaria.

## Mantenimiento

- **Ver si funciona:** pestaña *Actions*. Cada ejecución muestra el resumen por catálogo (recogidos, altas, bajas). La página principal muestra la fecha de la última actualización.
- **Si una ejecución falla** (TMDB caído, etc.), sigue publicada la última versión válida y la siguiente ejecución lo reintenta.
- **Inactividad:** GitHub desactiva los flujos programados de repositorios públicos tras 60 días sin actividad. El propio flujo se vuelve a habilitar por la API en cada ejecución para reiniciar ese plazo. Si aun así se desactivara, GitHub avisa por correo y basta con pulsar *Enable workflow* en *Actions*.
- **Caché de la base de datos:** si GitHub la borrase (cachés sin uso durante 7 días), la siguiente ejecución la reconstruye desde cero (~40 min). Los títulos se recuperan igual, pero se pierde el historial de novedades.
- **Añadir plataformas:** edita `config/platforms.json`, haz commit y lanza el flujo a mano.
- **Ajustes:** *Settings* → *Secrets and variables* → *Actions* → pestaña *Variables*: `STATIC_MAX_PAGES` (páginas de 100 por catálogo, 20 por defecto) y `STATIC_DESCRIPTION_MAX` (300).

## Probar en local

```bash
npm run export
npm run serve:static
```

Abre <http://127.0.0.1:7100/>. Stremio para escritorio puede instalar `http://127.0.0.1:7100/manifest.json` en el mismo equipo. Los enlaces de las fichas apuntan a `STATIC_BASE_URL` (por defecto `http://127.0.0.1:7100/`), que debe coincidir con la URL desde la que se instala el addon.
