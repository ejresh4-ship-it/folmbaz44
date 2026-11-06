import { useEffect, useState } from 'react';
import { Wifi, FolderPlus, Play, Square, ShieldCheck, RefreshCw, Copy, AlertTriangle } from 'lucide-react';

type HostResult = {
  success: boolean;
  message: string;
  port?: number;
  pin?: string;
  addresses?: string[];
};

export default function LanHostPanel() {
  const bridge = typeof window !== 'undefined' ? window.filmBazDesktop : undefined;
  const [folders, setFolders] = useState<string[]>([]);
  const [port, setPort] = useState('47821');
  const [running, setRunning] = useState(false);
  const [pin, setPin] = useState('');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    if (!bridge) return;
    try {
      const status = await bridge.getLanHostStatus();
      setRunning(status.running);
      setDevices(status.connectedDevices);
      if (!status.running) { setPin(''); setAddresses([]); }
    } catch { setMessage('وضعیت سرویس قابل دریافت نیست.'); }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const chooseFolders = async () => {
    if (!bridge) return;
    try {
      const selected = await bridge.chooseLanFolders();
      if (selected.length) setFolders((current) => [...new Set([...current, ...selected])]);
    } catch { setMessage('انتخاب پوشه‌ها ناموفق بود.'); }
  };

  const start = async () => {
    if (!bridge || !folders.length) { setMessage('ابتدا حداقل یک پوشه را انتخاب کن.'); return; }
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) {
      setMessage('شماره پورت باید بین ۱۰۲۴ تا ۶۵۵۳۵ باشد.'); return;
    }
    setBusy(true); setMessage('');
    try {
      const result: HostResult = await bridge.startLanHost(folders, portNumber);
      setMessage(result.message);
      if (result.success) {
        setRunning(true);
        setPin(result.pin || '');
        setAddresses(result.addresses || []);
        setDevices(0);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'راه‌اندازی سرویس ناموفق بود.');
    } finally { setBusy(false); }
  };

  const stop = async () => {
    if (!bridge) return;
    setBusy(true);
    try {
      await bridge.stopLanHost();
      setRunning(false); setPin(''); setAddresses([]); setDevices(0);
      setMessage('اشتراک‌گذاری متوقف شد و دسترسی گوشی‌های جفت‌شده لغو شد.');
    } catch { setMessage('توقف سرویس ناموفق بود.'); }
    finally { setBusy(false); }
  };

  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMessage('کپی شد.'); }
    catch { setMessage('کپی خودکار در دسترس نیست؛ متن را دستی انتخاب کن.'); }
  };

  return <section className="space-y-4 text-right" dir="rtl">
    <div className="flex items-center gap-2"><Wifi size={22} className="text-gold-bright"/><h2 className="text-xl font-bold text-white">اتصال گوشی از طریق وای‌فای</h2></div>
    <p className="text-sm leading-7 text-text-secondary">این سرویس داخل خود FILM BAZ اجرا می‌شود. گوشی و کامپیوتر باید به یک شبکه محلی وصل باشند؛ اینترنت لازم نیست و فیلم مستقیماً از هارد کامپیوتر پخش می‌شود.</p>
    {!bridge && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-100">این قابلیت در نسخه مرورگری فعال نیست؛ برنامه دسکتاپ FILM BAZ را اجرا کن.</div>}
    <div className="rounded-xl border border-white/10 bg-base/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-white">پوشه‌های قابل اشتراک</h3><button onClick={chooseFolders} disabled={!bridge || running || busy} className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm text-white disabled:opacity-40"><FolderPlus size={16}/> افزودن پوشه</button></div>
      {folders.length ? <ul className="space-y-2">{folders.map((folder) => <li key={folder} className="flex items-center gap-2 rounded-md bg-white/5 p-2 text-xs text-text-secondary"><span className="min-w-0 flex-1 truncate" dir="ltr">{folder}</span>{!running && <button onClick={() => setFolders((current) => current.filter((item) => item !== folder))} className="text-red-300">حذف</button>}</li>)}</ul> : <p className="text-sm text-text-muted">هنوز پوشه‌ای انتخاب نشده است. فقط پوشه‌هایی که اینجا انتخاب می‌کنی از گوشی قابل مشاهده‌اند.</p>}
      <label className="block text-sm text-text-secondary">درگاه شبکه
        <input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))} disabled={running} inputMode="numeric" dir="ltr" className="mt-1 w-full rounded-lg border border-white/15 bg-base p-2.5 text-white"/>
      </label>
      {!running ? <button onClick={start} disabled={!bridge || busy || !folders.length} className="btn-primary inline-flex items-center gap-2 disabled:opacity-40"><Play size={16}/> فعال‌سازی اشتراک‌گذاری</button> : <button onClick={stop} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-200"><Square size={16}/> توقف و لغو دسترسی گوشی‌ها</button>}
    </div>
    {running && <div className="space-y-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2 text-emerald-200"><ShieldCheck size={18}/><strong>سرویس محلی فعال است</strong></div>
      <p className="text-xs text-text-secondary">در برنامه اندروید، آدرس زیر را وارد کن و کد اتصال را ثبت کن.</p>
      {addresses.map((address) => <button key={address} onClick={() => void copy(`http://${address}:${port}`)} className="flex w-full items-center justify-between rounded-md bg-black/20 p-2 text-sm text-white"><span dir="ltr">http://{address}:{port}</span><Copy size={15}/></button>)}
      <div className="flex items-center justify-between rounded-md bg-black/20 p-3"><div><span className="block text-xs text-text-muted">کد اتصال شش‌رقمی</span><strong className="text-2xl tracking-[0.35em] text-white" dir="ltr">{pin}</strong></div><button onClick={() => void copy(pin)} className="text-text-secondary"><Copy size={18}/></button></div>
      <p className="text-xs text-text-secondary">دستگاه‌های جفت‌شده: {devices} — برای لغو همه دسترسی‌ها سرویس را متوقف کن.</p>
    </div>}
    {message && <p role="status" className="rounded-lg border border-white/10 bg-base/70 p-3 text-sm text-text-secondary">{message}</p>}
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-6 text-amber-100"><AlertTriangle size={16} className="mt-1 shrink-0"/>فقط در شبکه خصوصی و مورد اعتماد استفاده کن. پوشه‌های انتخاب‌نشده قابل دسترسی نیستند. اشتراک‌گذاری تا زمانی که سرویس فعال باشد روشن می‌ماند؛ با توقف سرویس، توکن‌های گوشی‌ها باطل می‌شوند. ممکن است ویندوز برای اولین اتصال، اجازه شبکه خصوصی در فایروال بخواهد.</div>
  </section>;
}
