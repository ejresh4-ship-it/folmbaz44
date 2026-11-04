// AI provider types for FILM BAZ — supports Cloudflare Workers AI, OpenAI-compatible APIs,
// and local offline models via llama.cpp (Qwen).

export type AIProviderType = 'cloudflare' | 'openai-compatible' | 'llama-cpp';

export type AIProviderStatus = 'idle' | 'connecting' | 'connected' | 'failed';

/** Configuration for a single AI provider. */
export interface AIProviderConfig {
  id: string;
  name: string;
  type: AIProviderType;
  enabled: boolean;
  // Cloudflare
  accountId?: string;
  apiToken?: string;
  // OpenAI-compatible (and Cloudflare gateway)
  baseUrl?: string;
  apiKey?: string;
  // Model name (e.g. "@cf/qwen/qwen1.5-14b-chat-awq", "qwen2.5-3b-instruct-q2_k.gguf")
  model?: string;
  // llama.cpp local
  localModelPath?: string;
  localServerPath?: string;
  localPort?: number;
  // priority for fallback
  priority: number;
}

/** Result of an AI connection test. */
export interface AIConnectionTestResult {
  success: boolean;
  message: string;
  latencyMs?: number;
  modelInfo?: string;
}

/** A chat completion request. */
export interface AIChatRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

/** A chat completion response. */
export interface AIChatResponse {
  content: string;
  model: string;
  latencyMs: number;
  tokensUsed?: number;
}

/** AI usage statistics tracked locally. */
export interface AIUsageStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokensUsed: number;
  lastUsedAt?: number;
}
