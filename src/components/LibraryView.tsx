import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  FolderPlus,
  Folder,
  RefreshCw,
  Trash2,
  Film,
  Subtitles,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
  X,
  Sparkles,
  FileText,
  ChevronLeft,
  Globe,
  Check,
  Edit3,
  MoreVertical,
} from 'lucide-react';
import type { LibraryFolder, MediaItem, ScanProgress, ScanSummary } from '@/types/media-library';
import type { MovieMetadata } from '@/types/metadata';
import { getLibraryService } from '@/services/LibraryService';
import { getMetadataService } from '@/services/metadata/MetadataService';
import { isDesktopRuntime, pickLibraryFolders } from '@/services/filesystemFactory';
import { getFilesystemService } from '@/services/filesystemFactory';
import { formatFileSize, formatTimestamp, mediaTypeLabel, identificationLabel } from '@/lib/mediaFormat';
import { toPersianDigits } from '@/lib/movieUtils';
import MetadataMatchModal from '@/components/MetadataMatchModal';
import BatchRenameModal from '@/components/BatchRenameModal';
import { notifyLibraryUpdated } from '@/services/libraryEvents';

interface LibraryViewProps {
  onBack: () => void;
  onOrganize: (folderId: string) => void;
  onViewLog: () => void;
  onReviewMetadata: (item: MediaItem, metadata: MovieMetadata) => void;
}

type SortBy = 'name' | 'date' | 'size' | 'type';
type FilterType = 'all' | 'movie' | 'series' | 'episode' | 'unknown' | 'duplicates' | 'needs-review';

export default function LibraryView({ onBack, onOrganize, onViewLog, onReviewMetadata }: LibraryViewProps) {
  const service = getLibraryService();
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanningFolderId, setScanningFolderId] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<ScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newFolderPath, setNewFolderPath] = useState('');
  const [newFolderLabel, setNewFolderLabel] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [lookupItem, setLookupItem] = useState<MediaItem | null>(null);
  const [metadataCache, setMetadataCache] = useState<Record<string, MovieMetadata>>({});
  const [showBatchRename, setShowBatchRename] = useState(false);
  const [managementMenuItemId, setManagementMenuItemId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    await service.load();
    setFolders(service.getFolders());
    setItems(service.getItems());
    // Load cached metadata for items
    const metaService = getMetadataService();
    await metaService.load();
    const cache: Record<string, MovieMetadata> = {};
    for (const item of service.getItems()) {
      const meta = metaService.getMetadataForItem(item.id);
      if (meta) cache[item.id] = meta;
    }
    setMetadataCache(cache);
  }, [service]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const isMock = !isDesktopRuntime();

  const addFolders = async (paths: string[], label?: string) => {
    setError(null);
    try {
      const fs = getFilesystemService();
      for (const path of paths) {
        const exists = await fs.exists(path);
        if (!exists) {
          setError(`این مسیر یافت نشد: ${path}`);
          continue;
        }
        await service.addFolder(path, label || undefined);
      }
      setFolders(service.getFolders());
      setNewFolderPath('');
      setNewFolderLabel('');
      setShowAddForm(false);
      notifyLibraryUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در افزودن پوشه');
    }
  };

  const handleAddFolder = async () => {
    const path = newFolderPath.trim();
    if (!path) return;
    await addFolders([path], newFolderLabel.trim());
  };

  const handlePickFolders = async () => {
    try {
      const paths = await pickLibraryFolders();
      if (paths.length > 0) await addFolders(paths);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در انتخاب پوشه');
    }
  };

  const handleRemoveFolder = async (folderId: string) => {
    setError(null);
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return;
    if (!window.confirm(`پوشه «${folder.label}» از کتابخانه حذف شود؟ (محتوای پوشه پاک نمی‌شود)`)) return;
    await service.removeFolder(folderId);
    setFolders(service.getFolders());
    setItems(service.getItems());
    notifyLibraryUpdated();
  };

  const handleScan = async (folderId: string) => {
    setError(null);
    setScanningFolderId(folderId);
    setScanProgress(null);
    setLastSummary(null);
    try {
      const summary = await service.scanFolder(folderId, (p) => {
        setScanProgress({ ...p });
      });
      setLastSummary(summary);
      setItems(service.getItems());
      setFolders(service.getFolders());
      notifyLibraryUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در اسکن');
    } finally {
      setScanningFolderId(null);
      setScanProgress(null);
    }
  };

  const handleCancelScan = (folderId: string) => {
    service.cancelScan(folderId);
  };

  const handleRemoveItem = async (item: MediaItem) => {
    const title = item.titleGuess || item.fileName;
    if (!window.confirm(`«${title}» فقط از فهرست کتابخانه حذف شود؟ فایل اصلی از روی دیسک پاک نمی‌شود.`)) return;
    try {
      await service.removeItem(item.id);
      await getMetadataService().clearMetadataForItem(item.id);
      await loadAll();
      setManagementMenuItemId(null);
      notifyLibraryUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'حذف مورد از کتابخانه ناموفق بود');
    }
  };

  const handleLookupMatched = (metadata: MovieMetadata) => {
    if (lookupItem) {
      setMetadataCache((prev) => ({ ...prev, [lookupItem.id]: metadata }));
      notifyLibraryUpdated();
      onReviewMetadata(lookupItem, metadata);
    }
    setLookupItem(null);
  };

  // Filtered + sorted items
  const displayItems = useMemo(() => {
    let list = items;
    if (filterType === 'duplicates') {
      list = list.filter((i) => i.duplicateOfId);
    } else if (filterType === 'needs-review') {
      list = list.filter((i) => i.identification === 'needs-review');
    } else if (filterType !== 'all') {
      list = list.filter((i) => i.mediaType === filterType);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (i) =>
          i.fileName.toLowerCase().includes(q) ||
          (i.titleGuess || '').toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return (a.titleGuess || a.fileName).localeCompare(b.titleGuess || b.fileName, 'fa');
        case 'date':
          return (b.lastModified || 0) - (a.lastModified || 0);
        case 'size':
          return b.fileSize - a.fileSize;
        case 'type':
          return a.mediaType.localeCompare(b.mediaType);
        default:
          return 0;
      }
    });
    return sorted;
  }, [items, filterType, searchQuery, sortBy]);

  const videoCount = items.length;
  const duplicateCount = items.filter((i) => i.duplicateOfId).length;
  const needsReviewCount = items.filter((i) => i.identification === 'needs-review').length;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 lg:px-8 fade-in">
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-gold-bright"
      >
        <ChevronLeft size={18} className="rotate-180" />
        بازگشت به خانه
      </button>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white">کتابخانه رسانه</h1>
          <p className="mt-1 text-sm text-text-muted">مدیریت پوشه‌های فیلم و سریال، اسکن و سازماندهی فایل‌ها</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="btn-primary text-sm"
          >
            <FolderPlus size={18} />
            افزودن پوشه
          </button>
          <button
            onClick={() => setShowBatchRename(true)}
            disabled={Object.keys(metadataCache).length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2.5 text-sm font-semibold text-gold-bright transition-colors hover:bg-gold/20 disabled:opacity-40"
          >
            <Edit3 size={18} />
            تغییر نام گروهی
          </button>
          <button
            onClick={onViewLog}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:border-gold/40 hover:bg-white/10"
          >
            <FileText size={18} />
            گزارش عملیات
          </button>
        </div>
      </div>

      {/* Mock environment banner */}
      {isMock && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-ember/20 bg-ember/5 p-3.5">
          <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-ember" />
          <div>
            <p className="text-sm font-medium text-white">حالت نمایشی — محیط مرورگر</p>
            <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
              اسکن روی یک سیستم فایل فرضی انجام می‌شود. دسترسی به درایوهای واقعی ویندوز پس از اتصال Electron فعال خواهد شد.
              مسیر آزمایشی: <code className="rounded bg-white/10 px-1.5 py-0.5 text-gold-bright">C:\Films</code>
            </p>
          </div>
        </div>
      )}

      {/* Add folder form */}
      {showAddForm && (
        <div className="mt-4 rounded-xl border border-white/10 bg-surface-2 p-4 fade-in">
          <h3 className="mb-3 text-sm font-bold text-white">افزودن پوشه جدید به کتابخانه</h3>
          {isDesktopRuntime() && (
            <button
              onClick={handlePickFolders}
              className="mb-3 inline-flex items-center gap-2 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2.5 text-sm font-semibold text-gold-bright transition-colors hover:bg-gold/20"
            >
              <FolderPlus size={17} />
              انتخاب پوشه
            </button>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-text-muted">مسیر پوشه</label>
              <input
                type="text"
                value={newFolderPath}
                onChange={(e) => setNewFolderPath(e.target.value)}
                placeholder="C:\Films"
                dir="ltr"
                className="w-full rounded-lg border border-white/10 bg-base px-3 py-2 text-sm text-white placeholder:text-text-muted focus:border-gold/40 focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-text-muted">نام نمایشی (اختیاری)</label>
              <input
                type="text"
                value={newFolderLabel}
                onChange={(e) => setNewFolderLabel(e.target.value)}
                placeholder="فیلم‌های من"
                className="w-full rounded-lg border border-white/10 bg-base px-3 py-2 text-sm text-white placeholder:text-text-muted focus:border-gold/40 focus:outline-none"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddFolder} className="btn-primary text-sm">
                افزودن
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 fade-in">
          <XCircle size={18} className="flex-shrink-0 text-red-400" />
          <p className="text-sm text-red-300">{error}</p>
          <button onClick={() => setError(null)} className="mr-auto text-text-muted hover:text-white">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Summary stats */}
      {videoCount > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Film} label="ویدئو" value={toPersianDigits(videoCount)} />
          <StatCard icon={Subtitles} label="زیرنویس" value={toPersianDigits(items.reduce((sum, i) => sum + i.subtitles.length, 0))} />
          <StatCard icon={AlertTriangle} label="نیازمند بررسی" value={toPersianDigits(needsReviewCount)} highlight={needsReviewCount > 0} />
          <StatCard icon={AlertTriangle} label="احتمالی تکراری" value={toPersianDigits(duplicateCount)} highlight={duplicateCount > 0} />
        </div>
      )}

      {/* Folders list */}
      <div className="mt-6">
        <h2 className="mb-3 text-lg font-bold text-white">پوشه‌های کتابخانه</h2>
        {folders.length === 0 ? (
          <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 bg-surface/50">
            <div className="text-center">
              <Folder size={32} className="mx-auto mb-2 text-text-muted" />
              <p className="text-sm text-text-muted">هنوز پوشه‌ای اضافه نشده است</p>
              <p className="mt-1 text-xs text-text-muted">برای شروع، یک پوشه فیلم اضافه کنید</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {folders.map((folder) => {
              const isScanning = scanningFolderId === folder.id;
              const folderItems = items.filter((i) => i.folderId === folder.id);
              const summaryForFolder = lastSummary?.folderId === folder.id ? lastSummary : null;
              return (
                <div key={folder.id} className="rounded-xl border border-white/10 bg-surface-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-gold/10">
                        <Folder size={22} className="text-gold-bright" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-white">{folder.label}</h3>
                        <p className="mt-0.5 text-xs text-text-muted" dir="ltr">{folder.path}</p>
                        <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-text-secondary">
                          {folder.lastScannedAt && (
                            <span>آخرین اسکن: {formatTimestamp(folder.lastScannedAt)}</span>
                          )}
                          {folderItems.length > 0 && (
                            <span>{toPersianDigits(folderItems.length)} مورد</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleScan(folder.id)}
                        disabled={isScanning}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-white transition-colors hover:border-gold/40 hover:bg-white/10 disabled:opacity-50"
                      >
                        {isScanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        {isScanning ? 'در حال اسکن…' : 'اسکن مجدد'}
                      </button>
                      {folderItems.length > 0 && !isScanning && (
                        <button
                          onClick={() => onOrganize(folder.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs font-semibold text-gold-bright transition-colors hover:bg-gold/20"
                        >
                          <Sparkles size={14} />
                          سازماندهی
                        </button>
                      )}
                      <button
                        onClick={() => handleRemoveFolder(folder.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:border-red-500/40 hover:text-red-400"
                        aria-label="حذف پوشه"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Scan progress */}
                  {isScanning && scanProgress && (
                    <div className="mt-3 rounded-lg border border-white/5 bg-base/50 p-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-secondary">
                          در حال اسکن… {toPersianDigits(scanProgress.scanned)} فایل بررسی شد
                        </span>
                        <button
                          onClick={() => handleCancelScan(folder.id)}
                          className="text-red-400 hover:text-red-300"
                        >
                          لغو اسکن
                        </button>
                      </div>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
                        <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-l from-ember to-gold" />
                      </div>
                      {scanProgress.currentPath && (
                        <p className="mt-1.5 truncate text-[10px] text-text-muted" dir="ltr">
                          {scanProgress.currentPath}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Scan summary */}
                  {summaryForFolder && !isScanning && (
                    <div
                      className={`mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-xs ${
                        summaryForFolder.status === 'failed'
                          ? 'border-red-500/30 bg-red-500/5'
                          : summaryForFolder.status === 'cancelled'
                            ? 'border-amber-500/30 bg-amber-500/5'
                            : 'border-green-500/20 bg-green-500/5'
                      }`}
                    >
                      {summaryForFolder.status === 'completed' && (
                        <>
                          <CheckCircle2 size={16} className="text-green-400" />
                          <span className="text-text-secondary">
                            اسکن کامل شد: {toPersianDigits(summaryForFolder.videoCount)} ویدئو، {toPersianDigits(summaryForFolder.subtitleCount)} زیرنویس
                          </span>
                          {summaryForFolder.needsReviewCount > 0 && (
                            <span className="text-amber-400">
                              {toPersianDigits(summaryForFolder.needsReviewCount)} مورد نیازمند بررسی
                            </span>
                          )}
                          {summaryForFolder.duplicateCount > 0 && (
                            <span className="text-orange-400">
                              {toPersianDigits(summaryForFolder.duplicateCount)} مورد احتمالاً تکراری
                            </span>
                          )}
                        </>
                      )}
                      {summaryForFolder.status === 'cancelled' && (
                        <span className="text-amber-400">اسکن لغو شد</span>
                      )}
                      {summaryForFolder.status === 'failed' && (
                        <span className="text-red-400">اسکن ناموفق بود: {summaryForFolder.error}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Media list */}
      {videoCount > 0 && (
        <div className="mt-8">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">موارد کشف‌شده</h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="جستجو…"
                  className="w-44 rounded-lg border border-white/10 bg-surface-2 py-1.5 pr-8 pl-3 text-sm text-white placeholder:text-text-muted focus:border-gold/40 focus:outline-none"
                  aria-label="جستجوی موارد"
                />
              </div>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as FilterType)}
                className="rounded-lg border border-white/10 bg-surface-2 py-1.5 pr-3 pl-2 text-sm text-white focus:border-gold/40 focus:outline-none"
                aria-label="فیلتر بر اساس نوع"
              >
                <option value="all">همه</option>
                <option value="movie">فیلم</option>
                <option value="series">سریال</option>
                <option value="episode">قسمت</option>
                <option value="unknown">نامشخص</option>
                <option value="duplicates">تکراری‌ها</option>
                <option value="needs-review">نیازمند بررسی</option>
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="rounded-lg border border-white/10 bg-surface-2 py-1.5 pr-3 pl-2 text-sm text-white focus:border-gold/40 focus:outline-none"
                aria-label="مرتب‌سازی"
              >
                <option value="name">نام</option>
                <option value="date">تاریخ</option>
                <option value="size">اندازه</option>
                <option value="type">نوع</option>
              </select>
            </div>
          </div>

          {displayItems.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 bg-surface/50">
              <p className="text-sm text-text-muted">موردی یافت نشد</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10 bg-surface-2">
              <table className="w-full text-right text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-text-muted">
                    <th className="px-3 py-2.5 font-medium">نام فایل / عنوان</th>
                    <th className="px-3 py-2.5 font-medium">نوع</th>
                    <th className="px-3 py-2.5 font-medium">اندازه</th>
                    <th className="hidden px-3 py-2.5 font-medium sm:table-cell">زیرنویس</th>
                    <th className="px-3 py-2.5 font-medium">وضعیت</th>
                    <th className="px-3 py-2.5 font-medium">عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {displayItems.map((item) => (
                    <tr key={item.id} className="border-b border-white/5 transition-colors hover:bg-white/5">
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-white" dir="ltr">{item.fileName}</p>
                        {item.titleGuess && (
                          <p className="text-xs text-text-muted">
                            {item.titleGuess}
                            {item.yearGuess ? ` (${toPersianDigits(item.yearGuess)})` : ''}
                            {item.seasonGuess ? ` — فصل ${toPersianDigits(item.seasonGuess)}` : ''}
                            {item.episodeGuess ? ` قسمت ${toPersianDigits(item.episodeGuess)}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-text-secondary">{mediaTypeLabel(item.mediaType)}</td>
                      <td className="px-3 py-2.5 text-text-secondary">{formatFileSize(item.fileSize)}</td>
                      <td className="hidden px-3 py-2.5 sm:table-cell">
                        {item.subtitles.length > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs text-gold-bright">
                            <Subtitles size={14} />
                            {toPersianDigits(item.subtitles.length)}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs ${
                              item.identification === 'identified'
                                ? 'bg-green-500/10 text-green-400'
                                : item.identification === 'needs-review'
                                  ? 'bg-amber-500/10 text-amber-400'
                                  : 'bg-white/5 text-text-muted'
                            }`}
                          >
                            {identificationLabel(item.identification)}
                          </span>
                          {item.duplicateOfId && (
                            <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-xs text-orange-400">
                              احتمالاً تکراری
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {metadataCache[item.id] ? (
                            <>
                              <span className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-400">
                                <Check size={11} />
                                اطلاعات دارد
                              </span>
                              <button
                                onClick={() => onReviewMetadata(item, metadataCache[item.id])}
                                className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-white"
                                title="مشاهده/ویرایش اطلاعات"
                              >
                                <Sparkles size={14} />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setLookupItem(item)}
                              className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-gold/30 hover:text-gold-bright"
                            >
                              <Globe size={13} />
                              جستجوی اطلاعات
                            </button>
                          )}
                          <div className="relative">
                            <button
                              onClick={() => setManagementMenuItemId((current) => current === item.id ? null : item.id)}
                              className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-white"
                              title="مدیریت این عنوان"
                              aria-label={`مدیریت ${item.titleGuess || item.fileName}`}
                              aria-expanded={managementMenuItemId === item.id}
                            >
                              <MoreVertical size={16} />
                            </button>
                            {managementMenuItemId === item.id && (
                              <div className="absolute left-0 top-full z-30 mt-1 min-w-44 rounded-lg border border-white/10 bg-surface-2 p-1.5 shadow-xl">
                                <button
                                  onClick={() => { setLookupItem(item); setManagementMenuItemId(null); }}
                                  className="block w-full rounded px-3 py-2 text-right text-xs text-text-secondary hover:bg-white/10 hover:text-white"
                                >
                                  تغییر منبع مرجع اطلاعات
                                </button>
                                {metadataCache[item.id] && (
                                  <button
                                    onClick={() => { onReviewMetadata(item, metadataCache[item.id]); setManagementMenuItemId(null); }}
                                    className="block w-full rounded px-3 py-2 text-right text-xs text-text-secondary hover:bg-white/10 hover:text-white"
                                  >
                                    ویرایش مشخصات
                                  </button>
                                )}
                                <button
                                  onClick={() => void handleRemoveItem(item)}
                                  className="block w-full rounded px-3 py-2 text-right text-xs text-red-400 hover:bg-red-500/10"
                                >
                                  حذف از کتابخانه
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Metadata lookup modal */}
      {lookupItem && (
        <MetadataMatchModal
          item={lookupItem}
          onClose={() => setLookupItem(null)}
          onMatched={handleLookupMatched}
        />
      )}

      {/* Batch rename modal */}
      {showBatchRename && (
        <BatchRenameModal
          items={items}
          metadataByItem={metadataCache}
          onClose={() => setShowBatchRename(false)}
          onCompleted={() => { loadAll(); }}
        />
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${highlight ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 bg-surface-2'}`}>
      <div className="flex items-center gap-2 text-text-muted">
        <Icon size={16} className={highlight ? 'text-amber-400' : ''} />
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-1.5 text-xl font-bold text-white">{value}</p>
    </div>
  );
}
