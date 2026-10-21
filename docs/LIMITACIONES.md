# Estrategia de datos y limitaciones técnicas

Este documento explica de dónde salen los catálogos, qué cubren y qué no. Resume lo que se comprobó contra la API real de TMDB el 21-10-2026.

## 1. Origen de los datos

TMDB no tiene un endpoint de «catálogo completo de una plataforma». Los datos de disponibilidad por país los aporta **JustWatch** a TMDB y se consultan con dos endpoints:

| Endpoint | Uso en Streaming Hub | Limitación |
|---|---|---|
| `GET /watch/providers/{movie,tv}?watch_region=ES` | Lista real de proveedores de la región. Con ella se resuelven los ID de cada plataforma **por nombre**, sin ID escritos en el código. | Los nombres cambian: Apple TV+ aparece como «Apple TV» y RTVE Play como «rtve»; «Movistar Plus+ Ficción Total » llega con un espacio final. |
| `GET /discover/{movie,tv}?with_watch_providers=…&watch_region=ES` | Recogida paginada del catálogo. | **Máximo de 500 páginas** (10.000 resultados, 20 por página). TMDB responde `400 Invalid page` a partir de la 501. |
| `GET /{movie,tv}/{id}/watch/providers` | Verificación individual antes de dar de baja un título. | Una petición por título. |
| `GET /{movie,tv}/{id}/external_ids` | IMDb ID. | Una petición por título; algunos títulos no tienen IMDb ID. |

### Volumen medido en España (monetización `flatrate|free|ads`)

| Plataforma | Películas | Series |
|---|---:|---:|
| Netflix | 6.746 | 3.140 |
| Prime Video | 8.462 | 1.607 |
| Filmin | **11.676** | 375 |
| Movistar Plus+ | 6.173 | 2.154 |
| Rakuten TV | 5.984 | 126 |
| Disney+ | 2.440 | 1.036 |
| RTVE Play | 1.097 | 295 |
| HBO Max | 905 | 1.268 |
| SkyShowtime | 518 | 386 |
| Atresplayer | 374 | 700 |
| Apple TV+ | 119 | 223 |
| Crunchyroll | 102 | 1.409 |

Las cifras de Netflix o Movistar+ son más altas que las que suelen publicar las plataformas. Discover devuelve lo que JustWatch tiene registrado, y ahí puede haber entradas desfasadas. Streaming Hub **no puede corregir la fuente**.

## 2. Recogida completa (diaria)

1. Se pide la página 1 ordenando por fecha de estreno ascendente (`primary_release_date.asc` / `first_air_date.asc`).
2. Si `total_pages ≤ 500`, se piden todas las páginas.
3. Si supera 500 páginas (hoy solo **Filmin, películas**), se **divide por rangos de fecha** de forma recursiva hasta que cada rango cabe en 500 páginas.
4. Cada título recogido se guarda y se marca como visto (`last_seen_at`).

**Resultado medido (21-10-2026, las 12 plataformas en España):** 23 de los 24 catálogos se recogieron al 100 % (ID únicos = `total_results`). En Filmin películas, el único particionado, se recogieron 11.647 de 11.676: faltan 29 títulos (0,25 %), los que no tienen fecha de estreno. Las 24 recogidas tardaron unos 2 minutos.

**Títulos que pueden quedar fuera:**

- **Sin fecha de estreno** en catálogos particionados: el filtro de fechas los excluye. Solo afecta a catálogos de más de 10.000 títulos. El informe de sincronización y `/api/status` muestran `recogidos / total TMDB` para cuantificarlo.
- Un **día concreto con más de 10.000 títulos** se truncaría (no ocurre en la práctica). Se registra como recogida incompleta.
- Títulos que TMDB/JustWatch no asocia a la plataforma, aunque estén en ella. Es un límite de la fuente.
- Contenido para adultos (`include_adult=false`).

## 3. Recogida incremental (cada 6 h)

Lee las primeras `SYNC_INCREMENTAL_PAGES` páginas (5 por defecto) de cada catálogo en dos órdenes: popularidad y estreno más reciente. Así detecta pronto lo nuevo y lo popular. **Nunca da de baja títulos**. Un título antiguo y poco popular que se incorpore a una plataforma se detecta en la siguiente revisión completa diaria.

## 4. Altas, retiradas y «Novedades detectadas»

- **Carga inicial (baseline):** la primera recogida completa de cada catálogo no cuenta como novedad. Si no, todo el catálogo aparecería como «nuevo».
- **Alta:** un título que aparece después de la carga inicial genera un evento `added` y se ordena primero en el modo «Novedades detectadas».
- **Retirada:** que un título no aparezca en una respuesta **no** se interpreta como retirada. El proceso es:
  1. Solo se evalúa tras una recogida completa **sin errores de página**. Si falló alguna página, no se evalúa nada.
  2. Los títulos activos no vistos en esa recogida son **candidatos**.
  3. Cada candidato se comprueba con `/{type}/{id}/watch/providers`. Solo si la plataforma ya no figura en la región, o el título ya no existe en TMDB (404), se marca como `removed`. Si sigue figurando, se mantiene y se anota como verificado.
  4. Si la verificación falla (error de red), el título se mantiene.
- **Reincorporación:** un título retirado que vuelve se reactiva con un evento `readded`.
- Se guardan `first_seen_at`, `last_seen_at`, `last_verified_at` y `removed_at` por título, plataforma y país.

## 5. Compatibilidad con addons de reproducción

- Los catálogos publican **solo títulos con IMDb ID** (`tt…`) obtenido de `external_ids`. Los ID se validan con `^tt\d{7,}$` y nunca se fabrican ni se sustituyen por ID de TMDB.
- **Títulos sin IMDb ID:** se guardan, pero **no se publican**, porque una ficha con ID de TMDB no la reconocerían Cinemeta ni la mayoría de addons de streams. Se vuelven a consultar cada `IMDB_RETRY_DAYS` días, porque TMDB suele completar el dato más tarde. `/api/status` muestra cuántos hay por catálogo. Medido con las 12 plataformas (21-10-2026): de 57.286 entradas activas, **3.392 (5,9 %) no tienen IMDb ID** y no se muestran. La proporción depende mucho del tipo de contenido:

  | Catálogo | Sin IMDb ID |
  |---|---:|
  | RTVE Play — Series | 19,7 % |
  | Rakuten TV — Series | 19,0 % |
  | Atresplayer — Series | 18,3 % |
  | Filmin — Series | 17,3 % |
  | Prime Video — Series | 10,6 % |
  | Movistar Plus+ / HBO Max — Series | 9,9 % |
  | Netflix — Películas / Series | 3,5 % / 4,3 % |
  | Apple TV+ | < 1 % |

  La producción española y local (series de RTVE, Atresplayer…) es la más afectada. Esos títulos **faltan en Stremio** mientras TMDB no tenga su IMDb ID.
- El addon declara únicamente el recurso `catalog`: **no hay stream handler ni meta handler**. Al abrir una ficha, Stremio pide los metadatos a Cinemeta y los streams a los addons instalados por el usuario. Las pruebas de integración lo comprueban consultando Cinemeta con los ID publicados.
- Si dos fichas de TMDB comparten el mismo IMDb ID, se muestra una sola.

## 6. Limitaciones de la interfaz de Stremio

- Stremio no admite controles personalizados. El único filtro que el SDK documenta para catálogos es `genre` (con `options`), junto con `skip` para paginar y `search`.
- Por eso **el orden** (popularidad, novedades, estreno, valoración) se elige en la página de configuración y se aplica a todos los catálogos de esa instalación. No es un desplegable dentro de Stremio.
- **Tamaño del manifiesto:** el SDK rechaza manifiestos de más de 8 KB (límite de la API de colecciones de Stremio). Con las 12 plataformas × 2 tipos **no caben todos los géneros**: el addon recorta cada catálogo a sus géneros más frecuentes y la página de configuración lo avisa. Medido con los datos reales: con 12 plataformas, el manifiesto ocupa 7.888 caracteres, las series muestran sus 16 géneros y las películas 17 de 19 (en Netflix faltan «Bélica» y «Western», los menos frecuentes). Con menos plataformas activas caben todos. Un género que no aparece en el desplegable sigue funcionando por URL.
- Stremio pagina con `skip` y entiende que el catálogo terminó cuando recibe menos de 100 elementos. El addon devuelve páginas de 100.
- El nombre del catálogo («Netflix — Películas») lo muestra Stremio tal cual. Según la versión de la app, puede añadir el tipo junto al nombre.

## 7. Idioma y países

- Títulos, sinopsis y géneros se guardan en un único idioma (`TMDB_LANGUAGE`, `es-ES` por defecto). TMDB no traduce algunos géneros de series («Sci-Fi & Fantasy», «Kids»…), así que se traducen en el addon. Los títulos sin traducción en TMDB aparecen con su nombre original.
- Solo se ofrecen en la configuración los países incluidos en `SYNC_REGIONS`. Cada país añadido multiplica las peticiones de sincronización.

## 8. Ritmo de peticiones y coste

- Límite propio: `TMDB_MAX_RPS` (30/s) y `TMDB_CONCURRENCY` (12). TMDB admite unas 50/s por IP.
- Reintentos con backoff exponencial y *jitter* ante errores de red, 408, 429 (respetando `Retry-After`, que pausa todas las peticiones) y 5xx. Los errores 4xx no se reintentan.
- **Coste medido:** una recogida completa de las 12 plataformas son 2.875 páginas de Discover (~2 minutos). La primera sincronización resolvió además 43.352 IMDb ID: 46.233 peticiones en total, 35 minutos y 0 errores; la base de datos ocupa ~41 MB. Las siguientes completas solo piden Discover, los títulos nuevos y los candidatos a retirada (~2–3 minutos). Las incrementales son ~250 peticiones.
- Los catálogos se sirven **siempre desde la base de datos local**. Una petición de Stremio nunca llama a TMDB.

## 9. Disponibilidad del servicio

- Si TMDB no responde, la sincronización falla o queda parcial, pero **los últimos datos válidos siguen sirviéndose**. Las escrituras son transaccionales y nada se borra por un fallo.
- Si falla la lista de proveedores, se usa la última resolución guardada.
- Un bloqueo con caducidad en la base de datos impide dos sincronizaciones simultáneas, también entre procesos (servidor y `npm run sync`).
- Tras un fallo, el planificador espera 30 minutos antes de reintentar.
- `/health` responde `degraded` si la última sincronización correcta tiene más de 48 h, pero sigue devolviendo 200 porque el servicio funciona.
