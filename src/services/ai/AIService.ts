// AIService — manages AI provider configurations, connection testing, and
// chat completions. Supports three provider types:
//  1. Cloudflare Workers AI (account ID + API token)
//  2. OpenAI-compatible APIs (base URL + API key — works with any compatible endpoint)
//  3. llama.cpp local server (Qwen and other GGUF models running offline)
//
// API keys/tokens are stored in IndexedDB locally. In the desktop (Electron/Tauri)
// build they would be moved to the secure backend keychain.

import type {
  AIProviderConfig,
  AIConnectionTestResult,
  AIChatRequest,
  AIChatResponse,
  AIUsageStats,
} from '@/types/ai';
import { idbGet, idbSet } from '@/services/idbStore';

const AI_CONFIG_KEY = 'film-baz:ai-providers';
const AI_USAGE_KEY = 'film-baz:ai-usage';

const DEFAULT_PROVIDERS: AIProviderConfig[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    type: 'cloudflare',
    enabled: false,
    accountId: '',
    apiToken: '',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    priority: 1,
  },
  {
    id: 'openai-compatible',
    name: 'API سازگار با OpenAI',
    type: 'openai-compatible',
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    priority: 2,
  },
  {
    id: 'llama-cpp',
    name: 'مدل آفلاین (llama.cpp / Qwen)',
    type: 'llama-cpp',
    enabled: false,
    localModelPath: 'E:\\Ai\\qwen2.5-3b-instruct-q2_k.gguf',
    localPort: 1234,
    model: 'qwen2.5-3b-instruct-q2_k.gguf',
    priority: 3,
  },
];

class AIService {
  private configs: AIProviderConfig[] = [];
  private usage: AIUsageStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalTokensUsed: 0,
  };
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    const [configs, usage] = await Promise.all([
      idbGet<AIProviderConfig[]>(AI_CONFIG_KEY),
      idbGet<AIUsageStats>(AI_USAGE_KEY),
    ]);
    this.configs = configs ?? DEFAULT_PROVIDERS;
    // Migrate only the previous built-in llama.cpp defaults. Keep user-customized
    // endpoints, model names, ports, and non-empty paths intact.
    const local = this.configs.find((provider) => provider.id === 'llama-cpp');
    if (local) {
      let changed = false;
      if (!local.localModelPath?.trim()) {
        local.localModelPath = 'E:\\Ai\\qwen2.5-3b-instruct-q2_k.gguf';
        changed = true;
      }
      if (!local.localPort || local.localPort === 8080) {
        local.localPort = 1234;
        changed = true;
      }
      if (!local.model?.trim() || local.model === 'qwen2.5-7b-instruct') {
        local.model = 'qwen2.5-3b-instruct-q2_k.gguf';
        changed = true;
      }
      if (changed) await idbSet(AI_CONFIG_KEY, this.configs);
    }
    // Migrate only the known retired built-in Cloudflare model; preserve custom models.
    const cloudflare = this.configs.find((provider) => provider.id === 'cloudflare');
    if (cloudflare && ['@cf/qwen/qwen1.5-14b-chat-awq', '@cf/meta/llama-3.1-8b-instruct', 'llama-3.1-8b-instruct', '@cf/meta/infire-llama-3.1-8b-instruct'].includes(cloudflare.model || '')) {
      cloudflare.model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      await idbSet(AI_CONFIG_KEY, this.configs);
    }
    this.usage = usage ?? this.usage;
    this.loaded = true;
    const localProvider = this.configs.find((provider) => provider.id === 'llama-cpp');
    if (localProvider?.enabled && localProvider.localServerPath && localProvider.localModelPath
      && typeof window !== 'undefined' && window.filmBazDesktop?.isDesktop) {
      void this.startLocalProvider();
    }
  }

  private async persistConfigs(): Promise<void> {
    await idbSet(AI_CONFIG_KEY, this.configs);
  }

  private async persistUsage(): Promise<void> {
    await idbSet(AI_USAGE_KEY, this.usage);
  }

  private async startLocalProvider(): Promise<{ success: boolean; message: string }> {
    const config = this.configs.find((provider) => provider.id === 'llama-cpp');
    if (!config) return { success: false, message: 'تنظیمات مدل آفلاین پیدا نشد.' };
    if (typeof window === 'undefined' || !window.filmBazDesktop?.isDesktop) {
      return { success: false, message: 'اجرای خودکار فقط در نسخه ویندوز برنامه در دسترس است.' };
    }
    if (!config.localServerPath || !config.localModelPath) {
      return { success: false, message: 'ابتدا مسیر llama-server.exe و فایل مدل GGUF را انتخاب کن.' };
    }
    return window.filmBazDesktop.startLocalAi(
      config.localServerPath,
      config.localModelPath,
      config.localPort || 1234,
    );
  }

  async startLocalModel(): Promise<{ success: boolean; message: string }> {
    await this.load();
    return this.startLocalProvider();
  }

  async stopLocalModel(): Promise<void> {
    if (typeof window !== 'undefined' && window.filmBazDesktop?.isDesktop) {
      await window.filmBazDesktop.stopLocalAi();
    }
  }

  getProviders(): AIProviderConfig[] {
    return [...this.configs].sort((a, b) => a.priority - b.priority);
  }

  getProvider(id: string): AIProviderConfig | undefined {
    return this.configs.find((p) => p.id === id);
  }

  async updateProvider(id: string, updates: Partial<AIProviderConfig>): Promise<void> {
    await this.load();
    const idx = this.configs.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.configs[idx] = { ...this.configs[idx], ...updates };
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

  getUsage(): AIUsageStats {
    return { ...this.usage };
  }

  private getActiveProvider(): AIProviderConfig | undefined {
    return this.configs
      .filter((c) => c.enabled)
      .sort((a, b) => a.priority - b.priority)[0];
  }

  isConfigured(): boolean {
    return this.configs.some((c) => c.enabled && this.hasCredentials(c));
  }

  private hasCredentials(c: AIProviderConfig): boolean {
    if (c.type === 'cloudflare') return !!(c.accountId?.trim() && c.apiToken?.trim() && c.model?.trim());
    if (c.type === 'openai-compatible') return !!(c.baseUrl && c.apiKey);
    if (c.type === 'llama-cpp') return !!c.localPort;
    return false;
  }

  /**
   * Use only the enabled local llama.cpp provider to recover an uncertain filename.
   * Returns null on any failure so normal scanning and user review remain available.
   */
  async identifyFilename(fileName: string): Promise<{
    mediaType: 'movie' | 'series' | 'episode';
    title: string;
    year?: number;
    season?: number;
    episode?: number;
    language?: string;
  } | null> {
    await this.load();
    const config = this.configs.find((provider) => provider.id === 'llama-cpp' && provider.enabled);
    if (!config || !this.hasCredentials(config)) return null;

    if (window.filmBazDesktop?.isDesktop) {
      const started = await this.startLocalProvider();
      if (!started.success) return null;
    }
    const port = config.localPort || 1234;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    this.usage.totalRequests += 1;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model || 'qwen2.5-3b-instruct-q2_k.gguf',
          messages: [
            {
              role: 'system',
              content: 'You identify movie and TV episode filenames. Return only one valid JSON object with keys mediaType,title,year,season,episode,language. mediaType must be movie, series, or episode. title must be the clean original title, not a translation or invented title. Use null for unknown numeric values. Do not guess missing years or episode numbers. Ignore release tags, codecs, resolutions, uploader names and website names.',
            },
            {
              role: 'user',
              content: `Identify this video filename: ${fileName}\nReturn JSON only. Example: {"mediaType":"movie","title":"The Matrix","year":1999,"season":null,"episode":null,"language":null}`,
            },
          ],
          temperature: 0.1,
          max_tokens: 180,
        }),
      });
      if (!response.ok) throw new Error(`llama.cpp HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw = payload.choices?.[0]?.message?.content?.trim() || '';
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      const mediaType = parsed.mediaType;
      if (!title || title.length > 160 || !['movie', 'series', 'episode'].includes(String(mediaType))) {
        throw new Error('Invalid filename identification response');
      }
      const validNumber = (value: unknown, min: number, max: number): number | undefined =>
        typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
      this.usage.successfulRequests += 1;
      this.usage.lastUsedAt = Date.now();
      await this.persistUsage();
      return {
        mediaType: mediaType as 'movie' | 'series' | 'episode',
        title,
        year: validNumber(parsed.year, 1950, 2039),
        season: validNumber(parsed.season, 1, 99),
        episode: validNumber(parsed.episode, 1, 999),
        language: typeof parsed.language === 'string' && parsed.language.length <= 8 ? parsed.language : undefined,
      };
    } catch {
      this.usage.failedRequests += 1;
      await this.persistUsage();
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Test connection to a provider by sending a minimal completion request. */
  async testConnection(providerId: string): Promise<AIConnectionTestResult> {
    await this.load();
    const config = this.configs.find((p) => p.id === providerId);
    if (!config) return { success: false, message: 'ارائه‌دهنده یافت نشد' };

    if (!this.hasCredentials(config)) {
      if (config.type === 'cloudflare') {
        const missing = [!config.accountId?.trim() && 'Account ID', !config.apiToken?.trim() && 'API Token', !config.model?.trim() && 'نام مدل'].filter(Boolean);
        return { success: false, message: `اطلاعات ناقص است: ${missing.join('، ')}` };
      }
      return { success: false, message: 'اطلاعات اتصال ناقص است؛ آدرس و کلید API را بررسی کنید.' };
    }

    if (config.type === 'llama-cpp' && window.filmBazDesktop?.isDesktop) {
      const started = await this.startLocalProvider();
      if (!started.success) return { success: false, message: started.message };
    }

    const start = performance.now();
    try {
      const url = this.buildChatUrl(config);
      const headers = this.buildHeaders(config);
      const body = this.buildTestBody(config);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      let res: Response;
      try {
        res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const latencyMs = Math.round(performance.now() - start);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          success: false,
          message: `خطای سرور (${res.status}): ${text.slice(0, 200) || res.statusText}`,
          latencyMs,
        };
      }

      const data = await res.json();
      const modelInfo = data?.model || config.model || 'نامشخص';

      return {
        success: true,
        message: 'اتصال موفقیت‌آمیز بود',
        latencyMs,
        modelInfo,
      };
    } catch (e) {
      const latencyMs = Math.round(performance.now() - start);
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { success: false, message: 'پاسخ در زمان مشخص دریافت نشد (_timeout)', latencyMs };
      }
      return {
        success: false,
        message: e instanceof Error ? e.message : 'خطا در اتصال',
        latencyMs,
      };
    }
  }

  /** Send a chat completion request to the active provider. */
  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    await this.load();
    const config = this.getActiveProvider();
    if (!config) {
      throw new Error('هیچ ارائه‌دهنده هوش مصنوعی فعالی پیکربندی نشده است. به تنظیمات > هوش مصنوعی بروید.');
    }
    if (!this.hasCredentials(config)) {
      throw new Error('ارائه‌دهنده فعال اطلاعات ناقص دارد. کلید و آدرس API را بررسی کنید.');
    }

    if (config.type === 'llama-cpp' && window.filmBazDesktop?.isDesktop) {
      const started = await this.startLocalProvider();
      if (!started.success) throw new Error(started.message);
    }

    const start = performance.now();
    this.usage.totalRequests++;

    try {
      const url = this.buildChatUrl(config);
      const headers = this.buildHeaders(config);
      const body = this.buildChatBody(config, request);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      let res: Response;
      try {
        res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`خطای سرور (${res.status}): ${text.slice(0, 300) || res.statusText}`);
      }

      const data = await res.json();
      const content = this.extractContent(data);
      const latencyMs = Math.round(performance.now() - start);

      this.usage.successfulRequests++;
      this.usage.lastUsedAt = Date.now();
      if (data?.usage?.total_tokens) {
        this.usage.totalTokensUsed += data.usage.total_tokens;
      }
      await this.persistUsage();

      return {
        content,
        model: data?.model || config.model || 'نامشخص',
        latencyMs,
        tokensUsed: data?.usage?.total_tokens,
      };
    } catch (e) {
      this.usage.failedRequests++;
      await this.persistUsage();
      throw e;
    }
  }

  // --- URL / headers / body builders ---

  private buildChatUrl(config: AIProviderConfig): string {
    if (config.type === 'cloudflare') {
      const accountId = encodeURIComponent((config.accountId || '').trim());
      return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    }
    if (config.type === 'openai-compatible') {
      const base = (config.baseUrl || '').replace(/\/$/, '');
      return `${base}/chat/completions`;
    }
    // llama.cpp server (OpenAI-compatible endpoint)
    const port = config.localPort || 1234;
    return `http://127.0.0.1:${port}/v1/chat/completions`;
  }

  private buildHeaders(config: AIProviderConfig): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.type === 'cloudflare') {
      headers['Authorization'] = `Bearer ${config.apiToken}`;
    } else if (config.type === 'openai-compatible') {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    // llama.cpp local server typically needs no auth
    return headers;
  }

  private buildTestBody(config: AIProviderConfig): Record<string, unknown> {
    return {
      model: config.model || 'test',
      messages: [{ role: 'user', content: 'پینگ' }],
      max_tokens: 5,
    };
  }

  private buildChatBody(config: AIProviderConfig, request: AIChatRequest): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.userPrompt });
    return {
      model: config.model || 'default',
      messages,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.7,
    };
  }

  // --- Translation ---

  /** Translate English text to Persian using the active AI provider. */
  async translate(text: string, _signal?: AbortSignal): Promise<string> {
    await this.load();
    const config = this.getActiveProvider();
    if (!config) {
      return text; // no provider configured, return original
    }
    if (!this.hasCredentials(config)) {
      return text;
    }

    try {
      const response = await this.chat({
        systemPrompt: 'You are a professional translator. Translate the following English text to Persian (Farsi). Return only the translation, no explanations.',
        userPrompt: text,
        maxTokens: 1024,
        temperature: 0.3,
      });
      return response.content.trim() || text;
    } catch {
      return text; // fallback to original on error
    }
  }

  private extractContent(data: Record<string, unknown>): string {
    const choices = data?.choices as Array<{ message?: { content?: string } }> | undefined;
    if (choices?.[0]?.message?.content) {
      return choices[0].message.content;
    }
    const result = data?.result as { response?: string } | string | undefined;
    if (typeof result === 'object' && result?.response) {
      return result.response;
    }
    if (typeof result === 'string') {
      return result;
    }
    return '';
  }
}

let instance: AIService | null = null;

export function getAIService(): AIService {
  if (!instance) instance = new AIService();
  return instance;
}
