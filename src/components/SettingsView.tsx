import { useEffect, useState } from 'react';
import {
  Palette,
  HardDrive,
  Database,
  MonitorPlay,
  CloudOff,
  Info,
  Check,
  ChevronLeft,
  Bot,
  Wifi,
} from 'lucide-react';
import MetadataSourcesPanel from '@/components/MetadataSourcesPanel';
import PlayerSettingsPanel from '@/components/PlayerSettingsPanel';
import AISettingsPanel from '@/components/AISettingsPanel';
import LanSharingPanel from '@/components/LanSharingPanel';

interface SettingsViewProps {
  onBack: () => void;
  onNavigateLibrary: () => void;
}

const sections = [
  {
    id: 'appearance',
    label: 'ظاهر برنامه',
    icon: Palette,
    implemented: true,
    description: 'پوسته برنامه و حالت نمایش',
  },
  {
    id: 'library',
    label: 'کتابخانه رسانه',
    icon: HardDrive,
    implemented: true,
    description: 'مسیر پوشه فیلم‌ها و اسکن کتابخانه',
  },
  {
    id: 'sources',
    label: 'منابع اطلاعات فیلم',
    icon: Database,
    implemented: true,
    description: 'مدیریت ارائه‌دهندگان داده و اولویت آن‌ها',
  },
  {
    id: 'lan',
    label: 'اتصال گوشی و کامپیوتر',
    icon: Wifi,
    implemented: true,
    description: 'پخش فیلم و زیرنویس از کامپیوتر روی گوشی در شبکه محلی',
  },
  {
    id: 'player',
    label: 'پخش‌کننده',
    icon: MonitorPlay,
    implemented: true,
    description: 'انتخاب پخش‌کننده ویدئو نصب‌شده روی ویندوز',
  },
  {
    id: 'ai',
    label: 'هوش مصنوعی',
    icon: Bot,
    implemented: true,
    description: 'پیکربندی ارائه‌دهندگان هوش مصنوعی و مدل آفلاین',
  },
  {
    id: 'offline',
    label: 'ذخیره‌سازی آفلاین',
    icon: CloudOff,
    implemented: true,
    description: 'دانلود و نگهداری داده برای استفاده بدون اتصال',
  },
  {
    id: 'about',
    label: 'درباره فیلم باز',
    icon: Info,
    implemented: true,
    description: 'نسخه و اطلاعات پروژه',
  },
] as const;

type SectionId = (typeof sections)[number]['id'];

export default function SettingsView({ onBack, onNavigateLibrary }: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('appearance');
  const [fontScale, setFontScale] = useState(() => localStorage.getItem('film-baz:font-scale') || '16');
  const [synopsisColor, setSynopsisColor] = useState(() => localStorage.getItem('film-baz:synopsis-color') || '#ffffff');
  const [typography, setTypography] = useState(() => {
    try { return { font: 'Vazirmatn', home: '16', headings: '30', details: '16', popup: '14', slideTitle: '52', slideBody: '16', slideInterval: '8', homeColor: '#f4f1ea', headingColor: '#ffffff', detailColor: '#f4f1ea', popupColor: '#f4f1ea', slideTitleColor: '#ffffff', slideBodyColor: '#ffffff', ...(JSON.parse(localStorage.getItem('film-baz:typography') || '{}')) }; }
    catch { return { font: 'Vazirmatn', home: '16', headings: '30', details: '16', popup: '14', slideTitle: '52', slideBody: '16', slideInterval: '8', homeColor: '#f4f1ea', headingColor: '#ffffff', detailColor: '#f4f1ea', popupColor: '#f4f1ea', slideTitleColor: '#ffffff', slideBodyColor: '#ffffff' }; }
  });
  const setType = (key: string, value: string) => setTypography((current: Record<string, string>) => ({ ...current, [key]: value }));
  const [theme, setTheme] = useState<'dark' | 'gold' | 'neon' | 'crimson'>(() => {
    const saved = localStorage.getItem('film-baz:theme');
    return saved === 'gold' || saved === 'neon' || saved === 'crimson' ? saved : 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('film-baz:theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontScale}px`);
    document.documentElement.style.setProperty('--synopsis-color', synopsisColor);
    localStorage.setItem('film-baz:font-scale', fontScale);
    localStorage.setItem('film-baz:synopsis-color', synopsisColor);
  }, [fontScale, synopsisColor]);

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 lg:px-8 fade-in">
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-gold-bright"
      >
        <ChevronLeft size={18} className="rotate-180" />
        بازگشت به خانه
      </button>

      <h1 className="mb-6 text-2xl font-extrabold text-white">تنظیمات</h1>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Section list */}
        <nav className="flex-shrink-0 lg:w-64" aria-label="بخش‌های تنظیمات">
          <ul className="flex gap-2 overflow-x-auto pb-2 scrollbar-hidden lg:flex-col lg:overflow-visible">
            {sections.map((s) => {
              const Icon = s.icon;
              const active = activeSection === s.id;
              return (
                <li key={s.id} className="flex-shrink-0">
                  <button
                    onClick={() => setActiveSection(s.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-right text-sm font-medium transition-colors ${
                      active
                        ? 'bg-white/10 text-gold-bright'
                        : 'text-text-secondary hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <Icon size={18} className="flex-shrink-0" />
                    <span className="whitespace-nowrap lg:whitespace-normal">{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content */}
        <div className="flex-1">
          <div className="rounded-xl border border-white/10 bg-surface-2 p-5 sm:p-6">
            {activeSection === 'appearance' && (
              <SettingsPanel title="ظاهر برنامه" desc="پوسته و حالت نمایش برنامه">
                <div>
                  <p className="mb-3 text-sm font-medium text-text-secondary">پوسته رنگی</p>
                  <div className="flex flex-wrap gap-3">
                    <ThemeOption
                      label="تاریک سینمایی"
                      active={theme === 'dark'}
                      onClick={() => setTheme('dark')}
                      swatch="linear-gradient(135deg, #070a12, #1a2338)"
                    />
                    <ThemeOption
                      label="طلایی گرم"
                      active={theme === 'gold'}
                      onClick={() => setTheme('gold')}
                      swatch="linear-gradient(135deg, #0d1320, #d4af37)"
                    />
                    <ThemeOption
                      label="Midnight Neon"
                      active={theme === 'neon'}
                      onClick={() => setTheme('neon')}
                      swatch="linear-gradient(135deg, #080b20 0%, #7028d8 55%, #08b9ff 100%)"
                    />
                    <ThemeOption
                      label="Crimson Glass"
                      active={theme === 'crimson'}
                      onClick={() => setTheme('crimson')}
                      swatch="linear-gradient(135deg, #080708 0%, #37101d 58%, #f04462 100%)"
                    />
                  </div>
                </div>
                <div className="mt-5 grid gap-4 border-t border-white/5 pt-5 sm:grid-cols-2">
                  <label className="block sm:col-span-2"><span className="mb-2 block text-sm font-medium text-text-secondary">خانواده فونت برنامه</span><select value={typography.font} onChange={e=>setType('font',e.target.value)} className="w-full rounded-lg border border-white/15 bg-base px-3 py-2.5 text-white"><option>Vazirmatn</option><option>Noto Sans Arabic</option><option>Cairo</option><option>Tahoma</option><option>Arial</option></select></label>
                  <StyleControl label="اندازه متن صفحه اصلی" value={typography.home} onChange={v=>setType('home',v)} color={typography.homeColor} onColor={v=>setType('homeColor',v)} />
                  <StyleControl label="اندازه تیترها" value={typography.headings} onChange={v=>setType('headings',v)} color={typography.headingColor} onColor={v=>setType('headingColor',v)} />
                  <StyleControl label="متن صفحات جزئیات" value={typography.details} onChange={v=>setType('details',v)} color={typography.detailColor} onColor={v=>setType('detailColor',v)} />
                  <StyleControl label="متن پاپ‌آپ‌ها" value={typography.popup} onChange={v=>setType('popup',v)} color={typography.popupColor} onColor={v=>setType('popupColor',v)} />
                  <StyleControl label="عنوان اسلایدها" value={typography.slideTitle} onChange={v=>setType('slideTitle',v)} color={typography.slideTitleColor} onColor={v=>setType('slideTitleColor',v)} />
                  <StyleControl label="توضیحات اسلایدها" value={typography.slideBody} onChange={v=>setType('slideBody',v)} color={typography.slideBodyColor} onColor={v=>setType('slideBodyColor',v)} />
                  <label className="block sm:col-span-2"><span className="mb-2 block text-sm font-medium text-text-secondary">سرعت تعویض اسلاید (ثانیه)</span><select value={typography.slideInterval} onChange={e=>setType('slideInterval',e.target.value)} className="w-full rounded-lg border border-white/15 bg-base px-3 py-2.5 text-white"><option value="4">۴ ثانیه</option><option value="6">۶ ثانیه</option><option value="8">۸ ثانیه</option><option value="10">۱۰ ثانیه</option><option value="15">۱۵ ثانیه</option><option value="0">فقط دستی</option></select></label>
                </div>
                <div className="mt-5 grid gap-5 border-t border-white/5 pt-5 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-text-secondary">اندازه متن برنامه</span>
                    <select value={fontScale} onChange={(e) => setFontScale(e.target.value)} className="w-full rounded-lg border border-white/15 bg-base px-3 py-2.5 text-white">
                      <option value="14">کوچک</option><option value="16">متوسط</option><option value="18">بزرگ</option><option value="20">خیلی بزرگ</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-text-secondary">رنگ خلاصه فیلم و سریال</span>
                    <select value={synopsisColor} onChange={(e) => setSynopsisColor(e.target.value)} className="w-full rounded-lg border border-white/15 bg-base px-3 py-2.5 text-white">
                      <option value="#ffffff">سفید</option><option value="#f4f1ea">سفید گرم</option><option value="#d1d5db">خاکستری روشن</option><option value="#f0c75e">طلایی</option>
                    </select>
                  </label>
                  <div className="sm:col-span-2 rounded-lg border border-white/10 bg-base/60 p-3">
                    <p className="text-sm" style={{ color: synopsisColor, fontSize: `${fontScale}px` }}>نمونه متن خلاصه داستان؛ تنظیمات اندازه و رنگ را همین‌جا ببین.</p>
                    <p className="mt-2 text-xs text-text-muted">فونت فعلی برنامه Vazirmatn است و اندازه متن عمومی با این گزینه تغییر می‌کند.</p>
                  </div>
                </div>
              </SettingsPanel>
            )}

            {activeSection === 'library' && (
              <SettingsPanel title="کتابخانه رسانه" desc="مدیریت پوشه‌ها، اسکن و سازماندهی فایل‌ها">
                <p className="text-sm leading-relaxed text-text-secondary">
                  کتابخانه رسانه اکنون فعال است. می‌توانید پوشه‌های فیلم اضافه کنید، کتابخانه را اسکن کنید،
                  فایل‌های نیازمند بررسی را ببینید و با پیش‌نمایش و تأیید، فایل‌ها را سازماندهی کنید.
                </p>
                <button
                  onClick={onNavigateLibrary}
                  className="btn-primary mt-4 text-sm"
                >
                  ورود به کتابخانه رسانه
                </button>
                <div className="mt-5 border-t border-white/5 pt-4">
                  <p className="text-xs leading-relaxed text-text-muted">
                    اسکن فایل‌سیستم واقعی ویندوز پس از اضافه شدن اتصال Electron فعال خواهد شد.
                    در محیط فعلی، یک سیستم فایل فرضی برای آزمایش استفاده می‌شود.
                  </p>
                </div>
              </SettingsPanel>
            )}
            {activeSection === 'sources' && (
              <MetadataSourcesPanel />
            )}
            {activeSection === 'ai' && (
              <AISettingsPanel />
            )}
            {activeSection === 'player' && <PlayerSettingsPanel />}
            {activeSection === 'lan' && (
              <SettingsPanel title="اتصال گوشی و کامپیوتر" desc="پخش فیلم‌های آرشیو روی گوشی از طریق Wi-Fi، بدون دانلود کامل">
                <LanSharingPanel />
              </SettingsPanel>
            )}
            {activeSection === 'offline' && (
              <SettingsPanel title="ذخیره‌سازی آفلاین" desc="دانلود و نگهداری داده و تصاویر برای استفاده بدون اتصال">
                <p className="text-sm leading-relaxed text-text-secondary">
                  اطلاعات متادیتا (عنوان، سال، خلاصه، بازیگران) و تصاویر (پوستر، پس‌زمینه، عکس بازیگران)
                  برای هر فیلم در پوشه کنار آن ذخیره می‌شوند. این داده‌ها حتی بدون اتصال اینترنت قابل مشاهده هستند.
                </p>
                <p className="mt-3 text-xs leading-relaxed text-text-muted">
                  برای صادرات اطلاعات یک فیلم، به بخش کتابخانه مراجعه کنید، فیلم مورد نظر را انتخاب و
                  دکمه «جستجوی اطلاعات» را بزنید. پس از دریافت اطلاعات، دکمه صادرات در صفحه بررسی اطلاعات در دسترس است.
                </p>
                <button
                  onClick={onNavigateLibrary}
                  className="btn-primary mt-4 text-sm"
                >
                  ورود به کتابخانه رسانه
                </button>
              </SettingsPanel>
            )}
            {activeSection === 'about' && (
              <SettingsPanel title="درباره فیلم باز" desc="اطلاعات نسخه و پروژه">
                <dl className="space-y-3 text-sm">
                  <InfoRow label="نام برنامه" value="فیلم باز (FILM BAZ)" />
                  <InfoRow label="شعار" value="آرشیو فیلم و سریال شما" />
                  <InfoRow label="نسخه" value="۰.۱.۰ (فاز رابط کاربری)" />
                  <InfoRow label="بستر" value="React + TypeScript + Vite" />
                </dl>
                <p className="mt-5 border-t border-white/5 pt-4 text-sm leading-relaxed text-text-secondary">
                  این نسخه پایه رابط کاربری و طراحی است. قابلیت‌هایی مانند اسکن فایل‌سیستم، پخش ویدئو،
                  تشخیص پخش‌کننده و بسته‌بندی به‌صورت EXE در فازهای بعدی اضافه خواهد شد.
                </p>
              </SettingsPanel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StyleControl({label,value,onChange,color,onColor}:{label:string;value:string;onChange:(v:string)=>void;color:string;onColor:(v:string)=>void}) {
  return <div className="grid grid-cols-2 gap-2"><label className="block"><span className="mb-2 block text-sm font-medium text-text-secondary">{label} (px)</span><select value={value} onChange={e=>onChange(e.target.value)} className="w-full rounded-lg border border-white/15 bg-base px-2 py-2.5 text-white">{['12','14','16','18','20','24','28','32','36','44','52','60','68'].map(v=><option key={v} value={v}>{v}</option>)}</select></label><label className="block"><span className="mb-2 block text-sm font-medium text-text-secondary">رنگ</span><input type="color" value={color} onChange={e=>onColor(e.target.value)} className="h-[42px] w-full cursor-pointer rounded-lg border border-white/15 bg-base p-1"/></label></div>;
}

function SettingsPanel({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="text-xl font-bold text-white">{title}</h2>
      <p className="mt-1 text-sm text-text-muted">{desc}</p>
      <div className="mt-5">{children}</div>
    </div>
  );
}

function ThemeOption({
  label,
  active,
  onClick,
  swatch,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  swatch: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-2 rounded-xl border-2 p-3 transition-all ${
        active ? 'border-gold bg-gold/5' : 'border-white/10 hover:border-white/20'
      }`}
      aria-pressed={active}
    >
      <div
        className="h-14 w-14 rounded-lg"
        style={{ background: swatch }}
        aria-hidden="true"
      />
      <div className="flex items-center gap-1.5">
        {active && <Check size={14} className="text-gold-bright" />}
        <span className="text-sm font-medium text-white">{label}</span>
      </div>
    </button>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-medium text-white">{value}</dd>
    </div>
  );
}
