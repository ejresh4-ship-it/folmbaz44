import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, Copy, Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { getLibraryService } from '@/services/LibraryService';
import { isDesktopRuntime } from '@/services/filesystemFactory';
import type { LanRoot, LanServerStatus } from '@/types/desktop';

export default function LanSharingPanel() {
  const [folders, setFolders] = useState<LanRoot[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<LanServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    const library = getLibraryService();
    await library.load();
    const available = library.getFolders().map((folder) => ({ id: folder.id, name: folder.label, path: folder.path }));
    setFolders(available);
    if (window.filmBazDesktop) {
      const current = await window.filmBazDesktop.getLanStatus();
      setStatus(current);
      if (current.running) setSelected(current.roots.map((root) => root.id));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = (id: string) => setSelected((old) => old.includes(id) ? old.filter((item) => item !== id) : [...old, id]);

  const apply = async () => {
    if (!window.filmBazDesktop) return;
    setBusy(true);
    setMessage('');
    try {
      const roots = folders.filter((folder) => selected.includes(folder.id));
      const result = await window.filmBazDesktop.configureLanSharing(roots);
      setMessage(result.message);
      if (result.status) setStatus(result.status);
      else setStatus(await window.filmBazDesktop.getLanStatus());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'تنظیم اتصال ناموفق بود');
    } finally { setBusy(false); }
  };

  const copyText = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMessage('کپی شد'); } catch { setMessage('کپی خودکار در دسترس نیست'); }
  };

  if (!isDesktopRuntime()) {
    return <div className="rounded-lg border border-white/10 bg-base/60 p-4 text-sm text-text-secondary">اتصال گوشی فقط در نسخه نصب‌شده ویندوز فعال است.</div>;
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-white/10 bg-base/60 p-4">
        <div className="flex items-center gap-2">
          {status?.running ? <Wifi className="text-emerald-400" size={20} /> : <WifiOff className="text-text-muted" size={20} />}
          <div>
            <p className="font-semibold text-white">{status?.running ? 'اتصال گوشی فعال است' : 'اتصال گوشی غیرفعال است'}</p>
            <p className="mt-1 text-xs text-text-muted">سرویس درون خود FILM BAZ اجرا می‌شود؛ پنجره یا ابزار جداگانه‌ای لازم نیست.</p>
          </div>
        </div>
        {status?.running && (
          <div className="mt-4 space-y-3 border-t border-white/10 pt-4 text-sm">
            <div>
              <p className="mb-1 text-xs text-text-muted">کد اتصال گوشی</p>
              <div className="flex items-center gap-2">
                <code className="rounded bg-white/10 px-3 py-2 text-lg tracking-[0.3em] text-gold-bright">{status.pin}</code>
                <button onClick={() => void copyText(status.pin)} className="rounded-lg border border-white/10 p-2 text-text-secondary hover:text-white" title="کپی کد"><Copy size={16} /></button>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-text-muted">آدرس‌های اتصال در شبکه Wi-Fi</p>
              {status.addresses.map((address) => (
                <div key={address} className="flex items-center gap-2">
                  <code dir="ltr" className="text-xs text-white">http://{address}:{status.port}</code>
                  <button onClick={() => void copyText(`http://${address}:${status.port}`)} className="text-text-muted hover:text-white" title="کپی آدرس"><Copy size={14} /></button>
                </div>
              ))}
            </div>
            <p className="text-xs text-text-muted">کامپیوتر و گوشی باید به یک شبکه Wi-Fi وصل باشند. برای امنیت، کد اتصال را فقط در اختیار دستگاه خودت بگذار.</p>
          </div>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-white">پوشه‌های قابل مشاهده در گوشی</h3>
            <p className="mt-1 text-xs text-text-muted">فقط پوشه‌های انتخاب‌شده به‌صورت فقط‌خواندنی در گوشی نمایش داده می‌شوند.</p>
          </div>
          <button onClick={() => void refresh()} className="rounded-lg border border-white/10 p-2 text-text-muted hover:text-white" title="بازخوانی"><RefreshCw size={16} /></button>
        </div>
        {folders.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/10 p-4 text-sm text-text-muted">ابتدا از بخش کتابخانه رسانه، پوشه فیلم‌ها را اضافه کن.</p>
        ) : (
          <div className="space-y-2">
            {folders.map((folder) => {
              const checked = selected.includes(folder.id);
              return (
                <button key={folder.id} onClick={() => toggle(folder.id)} className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-base/50 p-3 text-right hover:border-gold/30">
                  {checked ? <CheckCircle2 className="text-emerald-400" size={19} /> : <Circle className="text-text-muted" size={19} />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-white">{folder.name}</span>
                    <code dir="ltr" className="mt-1 block truncate text-left text-[11px] text-text-muted">{folder.path}</code>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => void apply()} disabled={busy || (selected.length > 0 && folders.length === 0)} className="btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
          {selected.length ? 'ذخیره و فعال‌سازی اتصال' : 'توقف اتصال'}
        </button>
        {message && <span className="text-xs text-text-secondary">{message}</span>}
      </div>
      <p className="text-xs leading-6 text-text-muted">بعد از یک‌بار فعال‌سازی، FILM BAZ در اجراهای بعدی سرویس را خودکار در پس‌زمینه راه‌اندازی می‌کند. فایل‌های فیلم و زیرنویس اصلی روی کامپیوتر می‌مانند و دانلود کامل لازم نیست.</p>
    </div>
  );
}
