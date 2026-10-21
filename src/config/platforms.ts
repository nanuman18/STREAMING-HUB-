import { readFileSync } from 'node:fs';

export interface PlatformDef {
  /** Clave estable usada en la configuración del usuario y en los ID de catálogo. */
  key: string;
  /** Nombre visible en Stremio. */
  name: string;
  /** Nombres de proveedor de TMDB que corresponden a esta plataforma (comparación normalizada exacta). */
  match: string[];
  /** ID de proveedor de TMDB fijados a mano (opcional; se suman a los resueltos por nombre). */
  providerIds?: number[];
  /** Tipos de monetización a considerar; por defecto, los de SYNC_MONETIZATION. */
  monetization?: string[];
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MONETIZATION = new Set(['flatrate', 'free', 'ads', 'rent', 'buy']);

export function parsePlatforms(json: unknown): PlatformDef[] {
  const list = (json as { platforms?: unknown })?.platforms;
  if (!Array.isArray(list) || list.length === 0) throw new Error('platforms.json: falta la lista "platforms"');
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const p = raw as Partial<PlatformDef>;
    const where = `platforms.json[${i}]`;
    if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) throw new Error(`${where}: "key" inválida (minúsculas, números, - o _)`);
    if (seen.has(p.key)) throw new Error(`${where}: clave duplicada "${p.key}"`);
    seen.add(p.key);
    if (typeof p.name !== 'string' || !p.name.trim()) throw new Error(`${where}: falta "name"`);
    const match = Array.isArray(p.match) ? p.match.filter((m): m is string => typeof m === 'string' && m.trim() !== '') : [];
    const providerIds = Array.isArray(p.providerIds) ? p.providerIds.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    if (match.length === 0 && providerIds.length === 0) throw new Error(`${where}: indica "match" o "providerIds"`);
    const monetization = Array.isArray(p.monetization) ? p.monetization.filter((m) => MONETIZATION.has(m)) : undefined;
    return {
      key: p.key,
      name: p.name.trim(),
      match,
      ...(providerIds.length ? { providerIds } : {}),
      ...(monetization && monetization.length ? { monetization } : {}),
    };
  });
}

export function loadPlatforms(file: string): PlatformDef[] {
  return parsePlatforms(JSON.parse(readFileSync(file, 'utf8')));
}

/** Normaliza nombres de proveedor: TMDB a veces añade espacios finales o cambia mayúsculas. */
export function normalizeProviderName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
