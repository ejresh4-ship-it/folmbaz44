// MetadataService — orchestrates metadata lookup, matching, caching, and
// offline storage. Manages provider configurations and priority-based fallback.
//
// SECURITY: API keys are stored in IndexedDB (browser test mode) and would be
// moved to the Electron main process / secure backend in the desktop build.
// They are never embedded in the bundled frontend code.
//
// All fetched metadata is cached locally so it remains available offline.
// Manually corrected metadata is never overwritten by automatic lookups.

import type {
  MatchCandidate,
  MovieMetadata,
  ProviderConfig,
  ConnectionTestResult,
  LookupMode,
  CachedMetadataEntry,
  MetadataExportPreview,
  ExportFileEntry,
} from '@/types/metadata';
import type { MediaItem } from '@/types/media-library';
import { idbGet, idbSet } from '@/services/idbStore';
import { TMDbProvider } from './TMDbProvider';
import { OMDbProvider } from './OMDbProvider';
import { WikidataProvider } from './WikidataProvider';
import { MediaWikiProvider } from './MediaWikiProvider';
import { TVmazeProvider } from './TVmazeProvider';
import type { MetadataProvider } from './MetadataProvider';
import { getAIService } from '@/services/ai/AIService';

const META_CACHE_KEY = 'film-baz:metadata-cache';
const PROVIDER_CONFIG_KEY = 'film-baz:provider-configs';
const LOOKUP_MODE_KEY = 'film-baz:lookup-mode';

const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'tmdb',
    name: 'TMDb (The Movie Database)',
    type: 'tmdb',
    enabled: true,
    apiKey: undefined,
    priority: 1,
    supportsMovies: true,
    supportsSeries: true,
    supportsImages: true,
    supportsPersianTitles: false,
  },
  {
    id: 'omdb',
    name: 'OMDb (IMDb)',
    type: 'omdb',
    enabled: false,
    apiKey: undefined,
    priority: 2,
    supportsMovies: true,
    supportsSeries: true,
    supportsImages: false,
    supportsPersianTitles: false,
  },
  {
    id: 'wikidata', name: 'Wikidata', type: 'wikidata', enabled: true, priority: 3,
    supportsMovies: true, supportsSeries: true, supportsImages: true, supportsPersianTitles: true,
  },
  {
    id: 'mediawiki', name: 'Wikipedia / MediaWiki', type: 'mediawiki', enabled: true, priority: 4,
    supportsMovies: true, supportsSeries: true, supportsImages: true, supportsPersianTitles: true,
  },
  {
    id: 'tvmaze', name: 'TVmaze', type: 'tvmaze', enabled: true, priority: 5,
    supportsMovies: false, supportsSeries: true, supportsImages: true, supportsPersianTitles: false,
  },
];

class MetadataService {
  private providers = new Map<string, MetadataProvider>();
  private configs: ProviderConfig[] = [];
  private cache = new Map<string, MovieMetadata>(); // keyed by metadata.id
  private itemToMetadata = new Map<string, string>(); // itemId -> metadata.id
  private lookupMode: LookupMode = 'combined';
  private loaded = false;

  constructor() {
    // Register built-in providers
    this.providers.set('tmdb', new TMDbProvider());
    this.providers.set('omdb', new OMDbProvider());
    this.providers.set('wikidata', new WikidataProvider());
    this.providers.set('mediawiki', new MediaWikiProvider());
    this.providers.set('tvmaze', new TVmazeProvider());
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const [configs, mode, cacheEntries] = await Promise.all([
      idbGet<ProviderConfig[]>(PROVIDER_CONFIG_KEY),
      idbGet<LookupMode>(LOOKUP_MODE_KEY),
      idbGet<CachedMetadataEntry[]>(META_CACHE_KEY),
    ]);
    const saved = configs ?? [];
    this.configs = [...saved, ...BUILTIN_PROVIDERS.filter((builtin) => !saved.some((item) => item.id === builtin.id))];
    this.lookupMode = mode ?? 'combined';
    if (cacheEntries) {
      for (const entry of cacheEntries) {
        const metadata = entry.metadata;
        this.cache.set(metadata.id, metadata);
        const itemId = entry.itemId || metadata.matchedItemId;
        if (itemId) this.itemToMetadata.set(itemId, metadata.id);
      }
    }
    this.loaded = true;
  }

  private async persistConfigs(): Promise<void> {
    await idbSet(PROVIDER_CONFIG_KEY, this.configs);
  }

  private async persistCache(): Promise<void> {
    const metadataToItem = new Map<string, string>();
    for (const [itemId, metadataId] of this.itemToMetadata) {
      metadataToItem.set(metadataId, itemId);
    }
    const entries: CachedMetadataEntry[] = [];
    for (const [id, metadata] of this.cache) {
      const itemId = metadataToItem.get(id) || metadata.matchedItemId;
      entries.push({ metadata, cachedAt: metadata.cachedAt ?? Date.now(), itemId });
    }
    await idbSet(META_CACHE_KEY, entries);
  }

  private async persistMode(): Promise<void> {
    await idbSet(LOOKUP_MODE_KEY, this.lookupMode);
  }

  // --- Provider config ---

  getProviders(): ProviderConfig[] {
    return [...this.configs].sort((a, b) => a.priority - b.priority);
  }

  async setProviderConfig(id: string, updates: Partial<ProviderConfig>): Promise<void> {
    await this.load();
    const idx = this.configs.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.configs[idx] = { ...this.configs[idx], ...updates };
    await this.persistConfigs();
  }

  async addCustomProvider(name: string, baseUrl: string): Promise<ProviderConfig> {
    await this.load();
    const config: ProviderConfig = {
      id: `custom-${Date.now()}`,
      name,
      type: 'custom',
      enabled: false,
      priority: this.configs.length + 1,
      baseUrl,
      supportsMovies: true,
      supportsSeries: false,
      supportsImages: false,
      supportsPersianTitles: false,
    };
    this.configs.push(config);
    await this.persistConfigs();
    return config;
  }

  async removeProvider(id: string): Promise<void> {
    await this.load();
    this.configs = this.configs.filter((p) => p.id !== id);
    await this.persistConfigs();
  }

  async setProviderPriority(id: string, priority: number): Promise<void> {
    await this.load();
    const config = this.configs.find((p) => p.id === id);
    if (config) {
      config.priority = priority;
      await this.persistConfigs();
    }
  }

  /** Persist a complete provider order in one write, avoiding partial swaps. */
  async setProviderOrder(providerIds: string[]): Promise<void> {
    await this.load();
    const positions = new Map(providerIds.map((id, index) => [id, index + 1]));
    this.configs = this.configs.map((config) => ({
      ...config,
      priority: positions.get(config.id) ?? config.priority,
    }));
    await this.persistConfigs();
  }

  getLookupMode(): LookupMode {
    return this.lookupMode;
  }

  async setLookupMode(mode: LookupMode): Promise<void> {
    await this.load();
    this.lookupMode = mode;
    await this.persistMode();
  }

  private getEnabledProviders(): Array<{ provider: MetadataProvider; config: ProviderConfig }> {
    return this.configs
      .filter((c) => c.enabled)
      .sort((a, b) => a.priority - b.priority)
      .map((c) => {
        const provider = this.providers.get(c.id);
        return provider ? { provider, config: c } : null;
      })
      .filter((x): x is { provider: MetadataProvider; config: ProviderConfig } => !!x);
  }

  // --- Lookup ---

  /** Search all enabled providers for match candidates. */
  async searchCandidates(
    item: MediaItem,
    signal?: AbortSignal,
  ): Promise<MatchCandidate[]> {
    await this.load();
    const query = item.titleGuess || stripExtension(item.fileName);
    const mediaType = item.mediaType === 'episode' ? 'series' : item.mediaType === 'unknown' ? 'movie' : item.mediaType;
    const providers = this.getEnabledProviders();

    if (providers.length === 0) {
      throw new Error('هیچ ارائه‌دهنده فعالی پیکربندی نشده است. به تنظیمات > منابع اطلاعات فیلم بروید.');
    }

    // Query providers sequentially in configured priority order. This makes
    // the arrows meaningful while still collecting results from every source.
    const all: MatchCandidate[] = [];
    for (const { provider, config } of providers) {
      if (signal?.aborted) throw new DOMException('لغو شد', 'AbortError');
      try {
        const candidates = await provider.search(query, item.yearGuess, mediaType, config, signal);
        all.push(...candidates.sort((a, b) => b.matchScore - a.matchScore));
      } catch {
        // A failing source must not block lower-priority fallback sources.
      }
    }

    // Deduplicate by (providerName, externalId)
    const seen = new Set<string>();
    const deduped = all.filter((c) => {
      const key = `${c.providerName}|${c.externalId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Preserve provider priority across sources; rank only within each source.
    const providerOrder = new Map(providers.map(({ config }, index) => [config.id, index]));
    return deduped.sort((a, b) => {
      const priorityDifference =
        (providerOrder.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) -
        (providerOrder.get(b.providerId) ?? Number.MAX_SAFE_INTEGER);
      return priorityDifference || b.matchScore - a.matchScore;
    });
  }

  /** Fetch full metadata for a chosen candidate and cache it. */
  async fetchAndCache(
    candidate: MatchCandidate,
    itemId: string,
    signal?: AbortSignal,
  ): Promise<MovieMetadata | null> {
    await this.load();
    // Find the provider config whose name matches the candidate's providerName,
    // then resolve the registered adapter instance by its config id.
    const config = this.configs.find((c) => c.id === candidate.providerId)
      || this.configs.find((c) => c.id === candidate.providerName.toLowerCase())
      || this.configs.find((c) => candidate.providerName.toLowerCase().includes(c.id.toLowerCase()))
      || this.configs.find((c) => c.name.toLowerCase().startsWith(candidate.providerName.toLowerCase()));
    const providerInstance = config ? this.providers.get(config.id) : undefined;

    if (!providerInstance || !config) {
      throw new Error(`ارائه‌دهنده «${candidate.providerName}» یافت نشد`);
    }

    const existing = this.getMetadataForItem(itemId);
    if (existing?.manuallyCorrected) return existing;

    const metadata = await providerInstance.fetchDetails(candidate.externalId, candidate.mediaType, config, signal);
    if (!metadata) return null;

    metadata.matchedItemId = itemId;
    metadata.cachedAt = Date.now();
    if (metadata.rating > 0 && !metadata.ratingSource) metadata.ratingSource = metadata.providerName;

    // Auto-translate title to Persian if AI is configured and no Persian title yet
    if (!metadata.persianTitle) {
      try {
        const ai = getAIService();
        if (ai.isConfigured()) {
          const translated = await ai.translate(metadata.title);
          if (translated && translated !== metadata.title) {
            metadata.persianTitle = translated;
          }
        }
      } catch {
        // translation failure is non-fatal
      }
    }

    if (metadata.overview && metadata.overviewLanguage !== 'fa') {
      try {
        const ai = getAIService();
        if (ai.isConfigured()) {
          const translatedOverview = await ai.translate(metadata.overview);
          if (translatedOverview && translatedOverview !== metadata.overview) {
            metadata.overview = translatedOverview;
            metadata.overviewLanguage = 'fa';
          }
        }
      } catch {
        // Keep the original synopsis if translation is unavailable.
      }
    }

    this.cache.set(metadata.id, metadata);
    this.itemToMetadata.set(itemId, metadata.id);
    await this.persistCache();

    return metadata;
  }


  /**
   * Automatically enrich a library item from all enabled compatible providers.
   * Low-confidence matches are never accepted. Existing manual corrections are preserved.
   */
  async enrichItem(item: MediaItem, signal?: AbortSignal): Promise<MovieMetadata | null> {
    await this.load();
    const existing = this.getMetadataForItem(item.id);
    if (existing?.manuallyCorrected) return existing;
    const candidates = await this.searchCandidates(item, signal);
    const ranked = candidates.filter((candidate) => candidate.matchScore >= 65);
    const providerSeen = new Set<string>();
    const uniqueRanked = ranked.filter((candidate) => {
      const key = candidate.providerName.toLowerCase();
      if (providerSeen.has(key)) return false;
      providerSeen.add(key);
      return true;
    });
    if (!uniqueRanked.length) return null;

    const fetched: MovieMetadata[] = [];
    for (const candidate of uniqueRanked.slice(0, 4)) {
      if (signal?.aborted) throw new DOMException('لغو شد', 'AbortError');
      try {
        const metadata = await this.fetchAndCache(candidate, item.id, signal);
        if (metadata) fetched.push(metadata);
      } catch {
        // A provider failure must not prevent fallback to the next source.
      }
      if (fetched.length >= 4) break;
    }
    if (!fetched.length) return null;
    const primary = fetched[0];
    const merged: MovieMetadata = { ...primary, cast: [...primary.cast], genres: [...primary.genres] };
    for (const extra of fetched.slice(1)) {
      if (extra.rating > 0 && (!(merged.rating > 0) || (extra.voteCount ?? 0) > (merged.voteCount ?? 0))) {
        merged.rating = extra.rating;
        merged.voteCount = extra.voteCount;
        merged.ratingSource = extra.providerName;
      }
      if (extra.overview && (!merged.overview || (extra.overviewLanguage === 'fa' && merged.overviewLanguage !== 'fa'))) {
        merged.overview = extra.overview;
        merged.overviewLanguage = extra.overviewLanguage;
      }
      if (!merged.persianTitle && extra.persianTitle) merged.persianTitle = extra.persianTitle;
      if (!merged.director && extra.director) merged.director = extra.director;
      if (!merged.posterUrl && extra.posterUrl) merged.posterUrl = extra.posterUrl;
      if (!merged.backdropUrl && extra.backdropUrl) merged.backdropUrl = extra.backdropUrl;
      merged.genres = [...new Set([...merged.genres, ...extra.genres])];
      const known = new Set(merged.cast.map((person) => person.name.toLowerCase()));
      merged.cast.push(...extra.cast.filter((person) => !known.has(person.name.toLowerCase())));
      if (!merged.seasons?.length && extra.seasons?.length) merged.seasons = extra.seasons;
      if (!merged.episodes?.length && extra.episodes?.length) merged.episodes = extra.episodes;
      if (!merged.numberOfSeasons && extra.numberOfSeasons) merged.numberOfSeasons = extra.numberOfSeasons;
      if (!merged.numberOfEpisodes && extra.numberOfEpisodes) merged.numberOfEpisodes = extra.numberOfEpisodes;
    }
    merged.cast = merged.cast.slice(0, 10);
    merged.matchedItemId = item.id;
    merged.cachedAt = Date.now();
    this.cache.set(merged.id, merged);
    this.itemToMetadata.set(item.id, merged.id);
    await this.persistCache();
    return merged;
  }

  /** Process a list sequentially to respect public API rate limits. */
  async enrichItems(
    items: MediaItem[],
    onProgress?: (progress: { completed: number; total: number; current: string; succeeded: number; failed: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ succeeded: string[]; failed: Array<{ itemId: string; fileName: string; reason: string }> }> {
    const succeeded: string[] = [];
    const failed: Array<{ itemId: string; fileName: string; reason: string }> = [];
    for (let index = 0; index < items.length; index += 1) {
      if (signal?.aborted) break;
      const item = items[index];
      try {
        const result = await this.enrichItem(item, signal);
        if (result) succeeded.push(item.id);
        else failed.push({ itemId: item.id, fileName: item.fileName, reason: 'تطابق مطمئن پیدا نشد' });
      } catch (error) {
        failed.push({ itemId: item.id, fileName: item.fileName, reason: error instanceof Error ? error.message : 'خطای نامشخص' });
      }
      onProgress?.({ completed: index + 1, total: items.length, current: item.fileName, succeeded: succeeded.length, failed: failed.length });
    }
    return { succeeded, failed };
  }

  // --- Cache access ---

  getMetadataForItem(itemId: string): MovieMetadata | undefined {
    const metaId = this.itemToMetadata.get(itemId);
    if (!metaId) return undefined;
    return this.cache.get(metaId);
  }

  getCachedMetadata(): MovieMetadata[] {
    return Array.from(this.cache.values());
  }

  /** Save user-corrected metadata. Marks it as manually corrected so it won't be overwritten. */
  async saveManualCorrection(itemId: string, metadata: MovieMetadata): Promise<void> {
    await this.load();
    metadata.manuallyCorrected = true;
    metadata.matchedItemId = itemId;
    metadata.cachedAt = Date.now();
    this.cache.set(metadata.id, metadata);
    this.itemToMetadata.set(itemId, metadata.id);
    await this.persistCache();
  }

  /** Remove cached metadata for an item. */
  async clearMetadataForItem(itemId: string): Promise<void> {
    await this.load();
    const metaId = this.itemToMetadata.get(itemId);
    if (metaId) {
      this.cache.delete(metaId);
      this.itemToMetadata.delete(itemId);
      await this.persistCache();
    }
  }

  // --- Connection testing ---

  async testProvider(providerId: string): Promise<ConnectionTestResult> {
    await this.load();
    const config = this.configs.find((p) => p.id === providerId);
    const provider = this.providers.get(providerId);
    if (!provider || !config) {
      return { success: false, message: 'ارائه‌دهنده یافت نشد' };
    }
    return provider.testConnection(config);
  }

  // --- Export preview ---

  /** Build a preview of files that would be exported for offline use. */
  buildExportPreview(item: MediaItem, destFolderPath: string): MetadataExportPreview {
    const metadata = this.getMetadataForItem(item.id);
    const files: ExportFileEntry[] = [];

    files.push({
      fileName: 'movie_info.json',
      type: 'json',
      size: metadata ? JSON.stringify(metadata).length : 0,
      alreadyExists: false,
    });

    if (metadata?.posterUrl) {
      files.push({
        fileName: 'poster.jpg',
        type: 'poster',
        url: metadata.posterUrl,
        alreadyExists: false,
      });
    }

    if (metadata?.backdropUrl) {
      files.push({
        fileName: 'backdrop.jpg',
        type: 'backdrop',
        url: metadata.backdropUrl,
        alreadyExists: false,
      });
    }

    const actorsWithPhotos = metadata?.cast.filter((c) => c.photoUrl) ?? [];
    for (const actor of actorsWithPhotos) {
      const safeName = actor.name.replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
      files.push({
        fileName: `actors/${safeName}.jpg`,
        type: 'actor',
        url: actor.photoUrl,
        alreadyExists: false,
      });
    }

    return {
      itemId: item.id,
      folderPath: destFolderPath,
      files,
      totalSize: files.reduce((sum, f) => sum + (f.size ?? 50000), 0),
    };
  }

  /** Check whether any enabled provider has a real API key configured. */
  isMockMode(): boolean {
    return !this.configs.some((c) => c.enabled && (['wikidata', 'mediawiki', 'tvmaze'].includes(c.id) || (c.apiKey && c.apiKey.trim().length > 0)));
  }
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(0, dot) : fileName;
}

let instance: MetadataService | null = null;

export function getMetadataService(): MetadataService {
  if (!instance) instance = new MetadataService();
  return instance;
}
