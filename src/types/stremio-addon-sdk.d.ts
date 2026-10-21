// Tipos mínimos del SDK oficial (v1.6.x no publica declaraciones TypeScript).
declare module 'stremio-addon-sdk' {
  export interface ManifestExtra {
    name: string;
    isRequired?: boolean;
    options?: string[];
    optionsLimit?: number;
  }

  export interface ManifestCatalog {
    type: string;
    id: string;
    name: string;
    extra?: ManifestExtra[];
  }

  export interface Manifest {
    id: string;
    version: string;
    name: string;
    description: string;
    resources: Array<string | { name: string; types: string[]; idPrefixes?: string[] }>;
    types: string[];
    catalogs: ManifestCatalog[];
    idPrefixes?: string[];
    logo?: string;
    background?: string;
    contactEmail?: string;
    behaviorHints?: {
      adult?: boolean;
      p2p?: boolean;
      configurable?: boolean;
      configurationRequired?: boolean;
    };
  }

  export interface CatalogArgs {
    type: string;
    id: string;
    extra: Record<string, string | undefined>;
    config: unknown;
  }

  export interface AddonInterface {
    manifest: Manifest;
    get(resource: string, type: string, id: string, extra?: Record<string, string>, config?: unknown): Promise<any>;
  }

  export class addonBuilder {
    constructor(manifest: Manifest);
    defineCatalogHandler(handler: (args: CatalogArgs) => Promise<any>): this;
    defineMetaHandler(handler: (args: CatalogArgs) => Promise<any>): this;
    defineStreamHandler(handler: (args: CatalogArgs) => Promise<any>): this;
    getInterface(): AddonInterface;
  }
}
