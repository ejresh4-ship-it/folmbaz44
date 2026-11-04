import { useEffect, useState } from 'react';
import {
  Cloud,
  Bot,
  Cpu,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronUp,
  ChevronDown,
  Power,
  Zap,
  Activity,
} from 'lucide-react';
import { getAIService } from '@/services/ai/AIService';
import { toPersianDigits } from '@/lib/movieUtils';
import type { AIProviderConfig, AIConnectionTestResult, AIProviderType, AIUsageStats } from '@/types/ai';

const TYPE_META: Record<AIProviderType, { icon: typeof Cloud; label: string; desc: string }> = {
  'cloudflare': { icon: Cloud, label: 'Cloudflare Workers AI', desc: 'زیرساخت ابری Cloudflare Workers AI' },
  'openai-compatible': { icon: Bot, label: 'API سازگار با OpenAI', desc: 'هر سرویس سازگار با OpenAI' },
  'llama-cpp': { icon: Cpu, label: 'مدل آفلاین llama.cpp', desc: 'اجرای محلی Qwen بدون نیاز به اینترنت' },
};

export default function AISettingsPanel() {
  const service = getAIService();
  const [providers, setProviders] = useState<AIProviderConfig[]>([]);
  const [usage, setUsage] = useState<AIUsageStats | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AIConnectionTestResult>>({});
  const [localAiMessage, setLocalAiMessage] = useState('');
  const [localAiBusy, setLocalAiBusy] = useState(false);

  useEffect(() => {
    service.load().then(() => {
      setProviders(service.getProviders());
      setUsage(service.getUsage());
    });
  }, [service]);

  function refresh() {
    setProviders(service.getProviders());
    setUsage(service.getUsage());
  }

  async function handleToggle(id: string) {
    const provider = providers.find((p) => p.id === id);
    if (!provider) return;

    if (provider.type === 'llama-cpp' && window.filmBazDesktop?.isDesktop) {
      setLocalAiBusy(true);
      try {
        if (!provider.enabled) {
          const started = await service.startLocalModel();
          setLocalAiMessage(started.message);
          if (!started.success) return;
          await service.updateProvider(id, { enabled: true });
        } else {
          await service.updateProvider(id, { enabled: false });
          await service.stopLocalModel();
          setLocalAiMessage('ارائه‌دهنده آفلاین غیرفعال شد و سرور متوقف شد.');
        }
        refresh();
      } finally {
        setLocalAiBusy(false);
      }
      return;
    }

    await service.updateProvider(id, { enabled: !provider.enabled });
    refresh();
  }

  async function handleUpdate(id: string, updates: Partial<AIProviderConfig>) {
    await service.updateProvider(id, updates);
    refresh();
  }

  async function handlePriority(id: string, direction: 'up' | 'down') {
    const sorted = [...providers].sort((a, b) => a.priority - b.priority);
    const idx = sorted.findIndex((p) => p.id === id);
    if (direction === 'up' && idx > 0) {
      const tmp = sorted[idx].priority;
      sorted[idx].priority = sorted[idx - 1].priority;
      sorted[idx - 1].priority = tmp;
    } else if (direction === 'down' && idx < sorted.length - 1) {
      const tmp = sorted[idx].priority;
      sorted[idx].priority = sorted[idx + 1].priority;
      sorted[idx + 1].priority = tmp;
    }
    for (const p of sorted) {
      await service.updateProvider(p.id, { priority: p.priority });
    }
    refresh();
  }

  async function chooseAiFile(kind: 'server' | 'model') {
    if (!window.filmBazDesktop?.isDesktop) {
      setLocalAiMessage('انتخاب فایل و اجرای خودکار در نسخه ویندوز در دسترس است.');
      return;
    }
    const selected = kind === 'server'
      ? await window.filmBazDesktop.browseForAiServer()
      : await window.filmBazDesktop.browseForAiModel();
    if (selected) {
      await handleUpdate('llama-cpp', kind === 'server'
        ? { localServerPath: selected }
        : { localModelPath: selected });
    }
  }

  async function handleLocalAi(start: boolean) {
    setLocalAiBusy(true);
    setLocalAiMessage(start ? 'در حال اجرای مدل؛ بارگذاری ممکن است کمی طول بکشد…' : 'در حال توقف مدل…');
    try {
      if (start) {
        const result = await service.startLocalModel();
        setLocalAiMessage(result.message);
      } else {
        await service.stopLocalModel();
        setLocalAiMessage('سرور مدل متوقف شد.');
      }
    } catch (error) {
      setLocalAiMessage(error instanceof Error ? error.message : 'عملیات ناموفق بود.');
    } finally {
      setLocalAiBusy(false);
    }
  }

  async function handleTest(id: string) {
    setTestingId(id);
    setTestResults((prev) => ({ ...prev, [id]: { success: false, message: 'در حال آزمایش…' } }));
    try {
      const result = await service.testConnection(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } finally {
      setTestingId(null);
    }
  }

  const sorted = [...providers].sort((a, b) => a.priority - b.priority);

  return (
    <div>
      <h2 className="text-xl font-bold text-white">هوش مصنوعی</h2>
      <p className="mt-1 text-sm text-text-muted">
        پیکربندی ارائه‌دهندگان هوش مصنوعی برای تحلیل متن، ترجمه و دستیار هوشمند
      </p>

      {/* Usage stats */}
      {usage && usage.totalRequests > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <UsageCard icon={Activity} label="درخواست کل" value={toPersianDigits(usage.totalRequests)} />
          <UsageCard icon={CheckCircle2} label="موفق" value={toPersianDigits(usage.successfulRequests)} />
          <UsageCard icon={XCircle} label="ناموفق" value={toPersianDigits(usage.failedRequests)} />
          <UsageCard icon={Zap} label="توکن مصرفی" value={toPersianDigits(usage.totalTokensUsed)} />
        </div>
      )}

      {/* Provider list */}
      <div className="mt-5 space-y-3">
        {sorted.map((provider, index) => {
          const meta = TYPE_META[provider.type];
          const Icon = meta.icon;
          const isExpanded = expandedId === provider.id;
          const testResult = testResults[provider.id];
          const isTesting = testingId === provider.id;

          return (
            <div key={provider.id} className="rounded-xl border border-white/10 bg-surface-2 overflow-hidden">
              {/* Header row */}
              <div className="flex items-center gap-3 p-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gold/10">
                  <Icon size={20} className="text-gold-bright" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-white">{provider.name}</h3>
                    {provider.enabled && (
                      <span className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                        <Power size={9} /> فعال
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">{meta.desc}</p>
                </div>

                {/* Priority controls */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handlePriority(provider.id, 'up')}
                    disabled={index === 0}
                    className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-white disabled:opacity-30"
                    aria-label="افزایش اولویت"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    onClick={() => handlePriority(provider.id, 'down')}
                    disabled={index === sorted.length - 1}
                    className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-white disabled:opacity-30"
                    aria-label="کاهش اولویت"
                  >
                    <ChevronDown size={15} />
                  </button>
                </div>

                {/* Toggle */}
                <button
                  onClick={() => handleToggle(provider.id)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${provider.enabled ? 'bg-gold' : 'bg-white/10'}`}
                  aria-label={provider.enabled ? 'غیرفعال‌سازی' : 'فعال‌سازی'}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${provider.enabled ? 'right-0.5' : 'right-5'}`} />
                </button>
              </div>

              {/* Expand/collapse config */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : provider.id)}
                className="flex w-full items-center justify-between border-t border-white/5 px-4 py-2 text-xs text-text-secondary hover:bg-white/5"
              >
                <span>تنظیمات پیشرفته</span>
                <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
              </button>

              {isExpanded && (
                <div className="border-t border-white/5 p-4 space-y-3 fade-in">
                  {provider.type === 'cloudflare' && (
                    <>
                      <Field label="Account ID">
                        <input
                          type="text"
                          value={provider.accountId || ''}
                          onChange={(e) => handleUpdate(provider.id, { accountId: e.target.value })}
                          placeholder="Cloudflare Account ID"
                          dir="ltr"
                          className="input-field"
                        />
                      </Field>
                      <Field label="API Token">
                        <input
                          type="password"
                          value={provider.apiToken || ''}
                          onChange={(e) => handleUpdate(provider.id, { apiToken: e.target.value })}
                          placeholder="••••••••••••••••"
                          dir="ltr"
                          className="input-field"
                        />
                      </Field>
                    </>
                  )}

                  {provider.type === 'openai-compatible' && (
                    <>
                      <Field label="آدرس API (Base URL)">
                        <input
                          type="text"
                          value={provider.baseUrl || ''}
                          onChange={(e) => handleUpdate(provider.id, { baseUrl: e.target.value })}
                          placeholder="https://api.openai.com/v1"
                          dir="ltr"
                          className="input-field"
                        />
                      </Field>
                      <Field label="API Key">
                        <input
                          type="password"
                          value={provider.apiKey || ''}
                          onChange={(e) => handleUpdate(provider.id, { apiKey: e.target.value })}
                          placeholder="sk-••••••••••••••••"
                          dir="ltr"
                          className="input-field"
                        />
                      </Field>
                    </>
                  )}

                  {provider.type === 'llama-cpp' && (
                    <>
                      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs leading-relaxed text-text-secondary">
                        فایل سرور و مدل را یک‌بار انتخاب کن. نسخه ویندوز FILM BAZ آن‌ها را خودش اجرا می‌کند؛ در نسخه وب باید سرور را جداگانه اجرا کنی.
                      </div>
                      <Field label="پورت سرور محلی">
                        <input
                          type="number"
                          value={provider.localPort || 1234}
                          onChange={(e) => handleUpdate(provider.id, { localPort: parseInt(e.target.value) || 1234 })}
                          dir="ltr"
                          className="input-field"
                        />
                      </Field>
                      <Field label="مسیر llama-server.exe">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={provider.localServerPath || ''}
                            onChange={(e) => handleUpdate(provider.id, { localServerPath: e.target.value })}
                            placeholder="مسیر فایل llama-server.exe"
                            dir="ltr"
                            className="input-field"
                          />
                          <button type="button" onClick={() => chooseAiFile('server')} className="shrink-0 rounded-lg border border-white/15 px-3 text-xs text-white hover:bg-white/10">انتخاب</button>
                        </div>
                      </Field>
                      <Field label="مسیر فایل مدل GGUF">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={provider.localModelPath || ''}
                            onChange={(e) => handleUpdate(provider.id, { localModelPath: e.target.value })}
                            placeholder="مسیر فایل Qwen با پسوند gguf"
                            dir="ltr"
                            className="input-field"
                          />
                          <button type="button" onClick={() => chooseAiFile('model')} className="shrink-0 rounded-lg border border-white/15 px-3 text-xs text-white hover:bg-white/10">انتخاب</button>
                        </div>
                      </Field>
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => handleLocalAi(true)} disabled={localAiBusy || !provider.localServerPath || !provider.localModelPath} className="rounded-lg bg-gold/15 px-3 py-2 text-xs font-semibold text-gold-bright disabled:opacity-40">اجرای مدل</button>
                        <button type="button" onClick={() => handleLocalAi(false)} disabled={localAiBusy} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-white disabled:opacity-40">توقف مدل</button>
                        {localAiBusy && <Loader2 size={14} className="animate-spin text-gold-bright" />}
                      </div>
                      {localAiMessage && <p className="text-xs text-text-secondary">{localAiMessage}</p>}
                    </>
                  )}

                  {/* Model name — shown for all types */}
                  <Field label="نام مدل">
                    <input
                      type="text"
                      value={provider.model || ''}
                      onChange={(e) => handleUpdate(provider.id, { model: e.target.value })}
                      placeholder={provider.type === 'cloudflare' ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast' : 'qwen2.5-3b-instruct-q2_k.gguf'}
                      dir="ltr"
                      className="input-field"
                    />
                  </Field>

                  {/* Test button + result */}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => handleTest(provider.id)}
                      disabled={isTesting}
                      className="inline-flex items-center gap-2 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2 text-xs font-semibold text-gold-bright transition-colors hover:bg-gold/20 disabled:opacity-50"
                    >
                      {isTesting ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                      آزمایش اتصال
                    </button>
                    {testResult && !isTesting && (
                      <div className={`flex items-center gap-1.5 text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                        {testResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                        <span>{testResult.message}</span>
                        {testResult.latencyMs != null && (
                          <span className="text-text-muted">({toPersianDigits(testResult.latencyMs)}ms)</span>
                        )}
                        {testResult.modelInfo && (
                          <span className="text-text-muted" dir="ltr">— {testResult.modelInfo}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <style>{`
        .input-field {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(255,255,255,0.1);
          background: var(--color-base, #070a12);
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: white;
        }
        .input-field::placeholder { color: var(--color-text-muted, #6b7280); }
        .input-field:focus {
          outline: none;
          border-color: rgba(212, 175, 55, 0.4);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function UsageCard({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-surface p-3">
      <div className="flex items-center gap-2 text-text-muted">
        <Icon size={15} />
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-1.5 text-lg font-bold text-white">{value}</p>
    </div>
  );
}
