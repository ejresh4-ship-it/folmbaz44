import { useState, useEffect, useCallback } from 'react';
import {
  Database,
  Plus,
  Trash2,
  Check,
  X,
  Loader2,
  ArrowUp,
  ArrowDown,
  Key,
  Zap,
  AlertTriangle,
  Info,
} from 'lucide-react';
import type { ProviderConfig, ConnectionTestResult, LookupMode } from '@/types/metadata';
import { getMetadataService } from '@/services/metadata/MetadataService';

export default function MetadataSourcesPanel() {
  const service = getMetadataService();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [lookupMode, setLookupMode] = useState<LookupMode>('combined');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [showAddCustom, setShowAddCustom] = useState(false);

  const load = useCallback(async () => {
    await service.load();
    setProviders(service.getProviders());
    setLookupMode(service.getLookupMode());
  }, [service]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggle(id: string, enabled: boolean) {
    await service.setProviderConfig(id, { enabled });
    setProviders(service.getProviders());
  }

  async function handlePriority(id: string, direction: 'up' | 'down') {
    const sorted = [...providers].sort((a, b) => a.priority - b.priority);
    const idx = sorted.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
    await service.setProviderOrder(sorted.map((provider) => provider.id));
    setProviders(service.getProviders());
  }

  async function handleSaveKey(id: string) {
    await service.setProviderConfig(id, { apiKey: apiKeyInput.trim() || undefined });
    setProviders(service.getProviders());
    setEditingKey(null);
    setApiKeyInput('');
  }

  async function handleTest(id: string) {
    setTestingId(id);
    const result = await service.testProvider(id);
    setTestResults((prev) => ({ ...prev, [id]: result }));
    setTestingId(null);
  }

  async function handleAddCustom() {
    if (!customName.trim()) return;
    await service.addCustomProvider(customName.trim(), customUrl.trim());
    setProviders(service.getProviders());
    setCustomName('');
    setCustomUrl('');
    setShowAddCustom(false);
  }

  async function handleRemove(id: string) {
    await service.removeProvider(id);
    setProviders(service.getProviders());
  }

  async function handleModeChange(mode: LookupMode) {
    await service.setLookupMode(mode);
    setLookupMode(mode);
  }

  const sorted = [...providers].sort((a, b) => a.priority - b.priority);
  const isMock = service.isMockMode();

  return (
    <div>
      <h2 className="text-xl font-bold text-white">منابع اطلاعات فیلم</h2>
      <p className="mt-1 text-sm text-text-muted">
        مدیریت ارائه‌دهندگان داده، اولویت‌دهی و تست اتصال
      </p>

      {/* Mock mode notice */}
      {isMock && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-ember/20 bg-ember/5 p-3.5">
          <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-ember" />
          <div>
            <p className="text-sm font-medium text-white">حالت نمایشی</p>
            <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
              ارائه‌دهندگان در حالت نمایشی فعال هستند و داده‌های نمونه برمی‌گردانند. اتصال واقعی پس از
              وارد کردن کلید API و اتصال Electron (یا بک‌اند امن) فعال خواهد شد.
            </p>
          </div>
        </div>
      )}

      {/* Lookup mode */}
      <div className="mt-5">
        <p className="mb-2 text-sm font-medium text-text-secondary">حالت جستجو</p>
        <div className="flex flex-wrap gap-2">
          {([
            { id: 'automatic', label: 'خودکار', desc: 'جستجوی خودکار با بهترین تطابق' },
            { id: 'manual', label: 'دستی', desc: 'انتخاب دستی از بین نتایج' },
            { id: 'combined', label: 'ترکیبی', desc: 'پیشنهاد خودکار با امکان تأیید دستی' },
          ] as const).map((m) => (
            <button
              key={m.id}
              onClick={() => handleModeChange(m.id)}
              className={`flex flex-col items-start gap-0.5 rounded-lg border-2 p-3 text-right transition-all ${
                lookupMode === m.id
                  ? 'border-gold bg-gold/5'
                  : 'border-white/10 hover:border-white/20'
              }`}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-white">
                {lookupMode === m.id && <Check size={14} className="text-gold-bright" />}
                {m.label}
              </span>
              <span className="text-xs text-text-muted">{m.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Provider list */}
      <div className="mt-5 space-y-3">
        {sorted.map((provider, index) => (
          <div
            key={provider.id}
            className={`rounded-xl border p-4 transition-colors ${
              provider.enabled
                ? 'border-white/10 bg-surface-2'
                : 'border-white/5 bg-surface/50'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div
                  className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${
                    provider.enabled ? 'bg-gold/10' : 'bg-white/5'
                  }`}
                >
                  <Database size={20} className={provider.enabled ? 'text-gold-bright' : 'text-text-muted'} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-white">{provider.name}</h3>
                    {provider.type === 'custom' && (
                      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-text-secondary">سفارشی</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-muted">
                    <span>اولویت: {index + 1}</span>
                    {provider.supportsMovies && <span>فیلم</span>}
                    {provider.supportsSeries && <span>سریال</span>}
                    {provider.supportsImages ? <span>تصویر</span> : <span>بدون تصویر</span>}
                    {provider.supportsPersianTitles && <span>عنوان فارسی</span>}
                  </div>
                </div>
              </div>

              {/* Enable toggle */}
              <button
                onClick={() => handleToggle(provider.id, !provider.enabled)}
                className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                  provider.enabled ? 'bg-gold' : 'bg-white/10'
                }`}
                aria-label={provider.enabled ? 'غیرفعال‌کردن' : 'فعال‌کردن'}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    provider.enabled ? 'left-0.5' : 'right-0.5'
                  }`}
                />
              </button>
            </div>

            {/* Controls */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* Priority */}
              <button
                onClick={() => handlePriority(provider.id, 'up')}
                disabled={index === 0}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-text-secondary transition-colors hover:border-gold/30 hover:text-gold-bright disabled:opacity-30"
                title="افزایش اولویت"
              >
                <ArrowUp size={14} />
              </button>
              <button
                onClick={() => handlePriority(provider.id, 'down')}
                disabled={index === sorted.length - 1}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-text-secondary transition-colors hover:border-gold/30 hover:text-gold-bright disabled:opacity-30"
                title="کاهش اولویت"
              >
                <ArrowDown size={14} />
              </button>

              {/* API Key */}
              {editingKey === provider.id ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="کلید API"
                    dir="ltr"
                    className="w-40 rounded-lg border border-white/10 bg-base px-2.5 py-1.5 text-xs text-white placeholder:text-text-muted focus:border-gold/40 focus:outline-none"
                    autoFocus
                  />
                  <button
                    onClick={() => handleSaveKey(provider.id)}
                    className="rounded-lg bg-gold/20 p-1.5 text-gold-bright hover:bg-gold/30"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => { setEditingKey(null); setApiKeyInput(''); }}
                    className="rounded-lg bg-white/5 p-1.5 text-text-muted hover:text-white"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => { setEditingKey(provider.id); setApiKeyInput(''); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:border-gold/30 hover:text-gold-bright"
                >
                  <Key size={13} />
                  {provider.apiKey ? 'کلید ثبت‌شده' : 'کلید API'}
                </button>
              )}

              {/* Test connection */}
              <button
                onClick={() => handleTest(provider.id)}
                disabled={testingId === provider.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:border-gold/30 hover:text-gold-bright disabled:opacity-50"
              >
                {testingId === provider.id ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Zap size={13} />
                )}
                تست اتصال
              </button>

              {/* Remove (custom only) */}
              {provider.type === 'custom' && (
                <button
                  onClick={() => handleRemove(provider.id)}
                  className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-text-muted transition-colors hover:border-red-500/40 hover:text-red-400"
                  title="حذف ارائه‌دهنده"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            {/* Test result */}
            {testResults[provider.id] && (
              <div
                className={`mt-3 flex items-start gap-2 rounded-lg border p-2.5 text-xs ${
                  testResults[provider.id].success
                    ? 'border-green-500/20 bg-green-500/5 text-green-300'
                    : 'border-red-500/30 bg-red-500/10 text-red-300'
                }`}
              >
                {testResults[provider.id].success ? (
                  <Check size={14} className="mt-0.5 flex-shrink-0" />
                ) : (
                  <X size={14} className="mt-0.5 flex-shrink-0" />
                )}
                <div>
                  <p>{testResults[provider.id].message}</p>
                  {testResults[provider.id].latencyMs !== undefined && (
                    <p className="mt-0.5 text-text-muted">
                      زمان پاسخ: {testResults[provider.id].latencyMs} میلی‌ثانیه
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add custom provider */}
      <div className="mt-4">
        {showAddCustom ? (
          <div className="rounded-xl border border-white/10 bg-surface-2 p-4 fade-in">
            <h3 className="mb-3 text-sm font-bold text-white">افزودن ارائه‌دهنده سفارشی</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-text-muted">نام ارائه‌دهنده</label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="نام منبع"
                  className="w-full rounded-lg border border-white/10 bg-base px-3 py-2 text-sm text-white placeholder:text-text-muted focus:border-gold/40 focus:outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-text-muted">آدرس پایه (اختیاری)</label>
                <input
                  type="text"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  dir="ltr"
                  className="w-full rounded-lg border border-white/10 bg-base px-3 py-2 text-sm text-white placeholder:text-text-muted focus:border-gold/40 focus:outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button onClick={handleAddCustom} className="btn-primary text-sm">
                  افزودن
                </button>
                <button
                  onClick={() => setShowAddCustom(false)}
                  className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
                >
                  انصراف
                </button>
              </div>
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/5 bg-base/50 p-2.5">
              <Info size={14} className="mt-0.5 flex-shrink-0 text-text-muted" />
              <p className="text-xs leading-relaxed text-text-muted">
                ارائه‌دهنده سفارشی برای پشتیبانی کامل نیاز به کد آداپتور اختصاصی دارد.
                اگر ساختار پاسخ ارائه‌دهنده با TMDb یا OMDb سازگار نباشد، تنها URL کافی نیست
                و نیاز به توسعه آداپتور جداگانه خواهد بود.
              </p>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddCustom(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-2.5 text-sm text-text-secondary transition-colors hover:border-gold/40 hover:text-gold-bright"
          >
            <Plus size={16} />
            افزودن ارائه‌دهنده سفارشی
          </button>
        )}
      </div>

      {/* Security note */}
      <div className="mt-5 flex items-start gap-3 rounded-lg border border-gold/15 bg-gold/5 p-3.5">
        <Key size={16} className="mt-0.5 flex-shrink-0 text-gold-bright" />
        <div>
          <p className="text-xs font-medium text-white">امنیت کلیدهای API</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
            کلیدهای API به‌صورت محلی در مرورگر ذخیره می‌شوند و برای اتصال واقعی به TMDb و OMDb استفاده می‌گردند.
            در نسخه دسکتاپ Electron، کلیدها در فرآیند اصلی ذخیره می‌شوند و از کد عمومی مرورگر جدا остаются.
            بدون کلید API، ارائه‌دهنده‌ها در حالت نمایشی با داده‌های نمونه کار می‌کنند.
          </p>
        </div>
      </div>
    </div>
  );
}
