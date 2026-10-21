import { describe, expect, it } from 'vitest';
import { ConfigError, decodeConfig, defaultConfig, encodeConfig, normalizeConfig, type ConfigLimits } from '../../src/addon/userConfig.js';
import { parsePlatforms } from '../../src/config/platforms.js';

const limits: ConfigLimits = { platformKeys: ['netflix', 'disney', 'prime'], regions: ['ES', 'PT'], languages: ['es-ES'] };

describe('configuración de usuario', () => {
  it('valores por defecto: todas las plataformas, ambos tipos, España, español', () => {
    expect(defaultConfig(limits)).toEqual({
      platforms: ['netflix', 'disney', 'prime'], types: ['movie', 'series'], region: 'ES', language: 'es-ES', sort: 'popularity', layout: 'platform',
    });
  });

  it('codifica y decodifica sin pérdida (base64url apto para URL)', () => {
    const cfg = { platforms: ['prime', 'netflix'], types: ['series' as const], region: 'PT', language: 'es-ES', sort: 'new' as const, layout: 'type' as const };
    const enc = encodeConfig(cfg);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeConfig(enc, limits)).toEqual(cfg);
  });

  it('descarta plataformas desconocidas y duplicadas, conservando el orden', () => {
    expect(normalizeConfig({ platforms: ['disney', 'xyz', 'disney', 'netflix'] }, limits).platforms).toEqual(['disney', 'netflix']);
  });

  it('rechaza configuraciones vacías o fuera de lo disponible', () => {
    expect(() => normalizeConfig({ platforms: [] }, limits)).toThrow(ConfigError);
    expect(() => normalizeConfig({ types: [] }, limits)).toThrow(/películas, series/);
    expect(() => normalizeConfig({ region: 'US' }, limits)).toThrow(/País/);
    expect(() => normalizeConfig({ language: 'en-US' }, limits)).toThrow(/Idioma/);
    expect(() => decodeConfig('%%%', limits)).toThrow(ConfigError);
  });

  it('orden y agrupación inválidos vuelven al valor por defecto', () => {
    const c = normalizeConfig({ sort: 'raro' as never, layout: 'otro' as never }, limits);
    expect(c.sort).toBe('popularity');
    expect(c.layout).toBe('platform');
  });
});

describe('platforms.json', () => {
  it('acepta plataformas nuevas sin tocar código', () => {
    const p = parsePlatforms({ platforms: [{ key: 'mubi', name: 'MUBI', match: ['MUBI'] }, { key: 'pluto', name: 'Pluto TV', match: [], providerIds: [300], monetization: ['free', 'ads'] }] });
    expect(p.map((x) => x.key)).toEqual(['mubi', 'pluto']);
    expect(p[1]).toMatchObject({ providerIds: [300], monetization: ['free', 'ads'] });
  });

  it('valida claves y campos', () => {
    expect(() => parsePlatforms({ platforms: [{ key: 'Mal Clave', name: 'x', match: ['x'] }] })).toThrow(/key/);
    expect(() => parsePlatforms({ platforms: [{ key: 'a', name: 'x', match: ['x'] }, { key: 'a', name: 'y', match: ['y'] }] })).toThrow(/duplicada/);
    expect(() => parsePlatforms({ platforms: [{ key: 'a', name: 'x', match: [] }] })).toThrow(/match/);
  });
});
