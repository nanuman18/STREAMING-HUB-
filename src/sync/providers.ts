import { normalizeProviderName, type PlatformDef } from '../config/platforms.js';
import type { Store } from '../db/store.js';
import type { TmdbApi, TmdbProvider } from '../tmdb/types.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('providers');

export interface ResolvedPlatform {
  platform: PlatformDef;
  providerIds: number[];
  providerNames: string[];
}

/** Empareja las plataformas configuradas con la lista real de proveedores de TMDB (sin ID inventados). */
export function matchPlatforms(platforms: PlatformDef[], providers: TmdbProvider[]): Map<string, ResolvedPlatform> {
  const byName = new Map<string, TmdbProvider[]>();
  for (const p of providers) {
    const k = normalizeProviderName(p.provider_name);
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const knownIds = new Map(providers.map((p) => [p.provider_id, p.provider_name.trim()]));
  const out = new Map<string, ResolvedPlatform>();
  for (const platform of platforms) {
    const ids = new Map<number, string>();
    for (const m of platform.match) {
      for (const p of byName.get(normalizeProviderName(m)) ?? []) ids.set(p.provider_id, p.provider_name.trim());
    }
    for (const id of platform.providerIds ?? []) {
      // Un ID fijado a mano solo se usa si TMDB lo lista en la región.
      const name = knownIds.get(id);
      if (name) ids.set(id, name);
    }
    if (ids.size) out.set(platform.key, { platform, providerIds: [...ids.keys()].sort((a, b) => a - b), providerNames: [...ids.values()] });
  }
  return out;
}

/**
 * Descarga la lista de proveedores de la región (películas y series), la guarda y resuelve cada plataforma.
 * Si TMDB no responde, reutiliza la última resolución guardada.
 */
export async function resolvePlatforms(
  tmdb: TmdbApi,
  store: Store,
  platforms: PlatformDef[],
  region: string,
  language: string,
  now: number,
): Promise<{ resolved: Map<string, ResolvedPlatform>; fromCache: boolean }> {
  try {
    const [movie, tv] = await Promise.all([tmdb.watchProviders('movie', region, language), tmdb.watchProviders('tv', region, language)]);
    store.replaceProviders(region, 'movie', movie, now);
    store.replaceProviders(region, 'tv', tv, now);
    const union = new Map<number, TmdbProvider>();
    for (const p of [...movie, ...tv]) union.set(p.provider_id, p);
    const resolved = matchPlatforms(platforms, [...union.values()]);
    for (const p of platforms) {
      const r = resolved.get(p.key);
      if (r) {
        store.setPlatformProviders(region, p.key, r.providerIds, r.providerNames, now);
        log.info(`Plataforma ${p.name} (${region}) → TMDB ${r.providerIds.join('|')}`, { names: r.providerNames });
      } else {
        log.warn(`Plataforma ${p.name} no aparece entre los proveedores de TMDB para ${region}; se omite`, { match: p.match });
      }
    }
    return { resolved, fromCache: false };
  } catch (err) {
    log.error('No se pudo obtener la lista de proveedores de TMDB; se usa la última resolución guardada', { region, error: (err as Error).message });
    const cached = store.platformProviders(region);
    const resolved = new Map<string, ResolvedPlatform>();
    for (const p of platforms) {
      const c = cached.get(p.key);
      if (c) resolved.set(p.key, { platform: p, providerIds: c.ids, providerNames: c.names });
    }
    return { resolved, fromCache: true };
  }
}
