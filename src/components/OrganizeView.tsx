import { useState, useEffect, useMemo } from 'react';
import {
  ChevronLeft,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Edit3,
  Check,
  X,
  Loader2,
  FolderTree,
  ArrowLeft,
} from 'lucide-react';
import type { OrgProposal, OrgOperation, OrgExecutionResult } from '@/types/media-library';
import { getLibraryService } from '@/services/LibraryService';
import { formatFileSize, mediaTypeLabel, identificationLabel } from '@/lib/mediaFormat';
import { toPersianDigits } from '@/lib/movieUtils';
import { getFilesystemService } from '@/services/filesystemFactory';
import { getMetadataService } from '@/services/metadata/MetadataService';
import { notifyLibraryUpdated } from '@/services/libraryEvents';

interface OrganizeViewProps {
  folderId: string;
  onBack: () => void;
  onViewLog: () => void;
}

export default function OrganizeView({ folderId, onBack, onViewLog }: OrganizeViewProps) {
  const service = getLibraryService();
  const fs = getFilesystemService();
  const [proposal, setProposal] = useState<OrgProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingOpId, setEditingOpId] = useState<string | null>(null);
  const [editFolderName, setEditFolderName] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<OrgExecutionResult | null>(null);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataProgress, setMetadataProgress] = useState({ completed: 0, total: 0, current: '', succeeded: 0, failed: 0 });
  const [metadataFailures, setMetadataFailures] = useState<Array<{ fileName: string; reason: string }>>([]);
  const [metadataSkipped, setMetadataSkipped] = useState(0);
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [finalizeProgress, setFinalizeProgress] = useState({
    completed: 0, total: 0, namesSynced: 0, nameFailures: 0, offlineSaved: 0, offlineFailures: 0,
  });
  const [finalizeFailures, setFinalizeFailures] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState<'all' | 'safe' | 'none'>('all');

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  async function generate() {
    setLoading(true);
    setError(null);
    setExecResult(null);
    try {
      const p = await service.generateProposal(folderId);
      setProposal(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ساخت پیشنهاد');
    } finally {
      setLoading(false);
    }
  }

  function handleExclude(opId: string) {
    if (!proposal) return;
    setProposal(service.toggleExclude(proposal, opId));
  }

  function selectOperations(mode: 'all' | 'safe' | 'none') {
    if (!proposal) return;
    const selected = proposal.operations.map((operation) => ({
      ...operation,
      excluded: mode === 'none' || (mode === 'safe' && (operation.destFileExists || operation.uncertain)),
    }));
    setProposal(service.recalcProposal({ ...proposal, operations: selected }));
    setSelectionMode(mode);
  }

  function startEdit(op: OrgOperation) {
    setEditingOpId(op.id);
    const folderName = fs.baseName(op.destFolderPath);
    setEditFolderName(folderName);
  }

  function applyEdit(opId: string) {
    if (!proposal || !editFolderName.trim()) return;
    setProposal(service.updateOperationDest(proposal, opId, editFolderName.trim()));
    setEditingOpId(null);
  }

  function cancelEdit() {
    setEditingOpId(null);
  }

  async function enrichWholeFolder() {
    if (metadataBusy) return;
    const items = service.getItemsForFolder(folderId);
    if (items.length === 0) { setError('فایلی برای تکمیل اطلاعات در این پوشه پیدا نشد.'); return; }
    setMetadataBusy(true); setMetadataFailures([]); setMetadataSkipped(0);
    try {
      const metadataService = getMetadataService();
      await metadataService.load();
      // A cached match means this exact library item was already enriched successfully.
      // Items without cached metadata (including previous failures) remain eligible for retry.
      const pendingItems = items.filter((item) => !metadataService.getMetadataForItem(item.id));
      const skipped = items.length - pendingItems.length;
      setMetadataSkipped(skipped);
      setMetadataProgress({ completed: 0, total: pendingItems.length, current: '', succeeded: 0, failed: 0 });
      if (pendingItems.length === 0) {
        notifyLibraryUpdated();
        return;
      }
      const result = await metadataService.enrichItems(pendingItems, setMetadataProgress);
      setMetadataFailures(result.failed);
      notifyLibraryUpdated();
    } catch (e) { setError(e instanceof Error ? e.message : 'تکمیل اطلاعات ناموفق بود'); }
    finally { setMetadataBusy(false); }
  }
  async function execute() {
    if (!proposal) return;
    const activeOps = proposal.operations.filter((o) => !o.excluded);
    if (activeOps.length === 0) return;

    const conflicts = activeOps.filter((o) => o.destFileExists);
    const uncertainMsg = activeOps.some((o) => o.uncertain);
    const warningParts = [];
    if (conflicts.length > 0) warningParts.push(`${conflicts.length} مورد تداخل دارند`);
    if (uncertainMsg) warningParts.push('برخی موارد نیازمند بررسی هستند');

    const message =
      `آیا از اجرای ${toPersianDigits(activeOps.length)} عملیات انتقال مطمئن هستید؟` +
      (warningParts.length > 0 ? `\n\nتوجه: ${warningParts.join(' و ')}.` : '') +
      '\n\nهیچ فایل بازنویسی یا حذف نمی‌شود.';
    if (!window.confirm(message)) return;

    setExecuting(true);
    setError(null);
    try {
      const result = await service.executeProposal(proposal);
      setExecResult(result);
      await enrichWholeFolder();
      // Recalc proposal to reflect any state changes
      const updated = service.recalcProposal(proposal);
      setProposal(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در اجرای عملیات');
    } finally {
      setExecuting(false);
    }
  }

  async function finalizeSuccessfulFiles() {
    if (!execResult || finalizeBusy || metadataBusy) return;
    const completed = execResult.succeeded;
    if (completed.length === 0) return;

    if (!window.confirm(
      'برای همه موارد موفق، نام پوشه، فیلم و زیرنویس‌ها با اطلاعات شناسایی‌شده هماهنگ شود و اطلاعات و تصاویر آفلاین کنار ویدئو ذخیره شود؟ فایل‌های مقصد موجود بازنویسی نمی‌شوند.'
    )) return;

    const metadataService = getMetadataService();
    setFinalizeBusy(true);
    setFinalizeFailures([]);
    setFinalizeProgress({
      completed: 0, total: completed.length, namesSynced: 0, nameFailures: 0, offlineSaved: 0, offlineFailures: 0,
    });

    let namesSynced = 0;
    let nameFailures = 0;
    let offlineSaved = 0;
    let offlineFailures = 0;
    const failures: string[] = [];

    try {
      await metadataService.load();
      // Rename only items whose organization completed successfully. The service
      // preflights and rolls back each video/subtitle group if any move fails.
      const renameResult = await service.renameOrganizedItemsBatch(
        completed.map((operation) => operation.itemId),
      );
      namesSynced = renameResult.succeeded.length;
      nameFailures = renameResult.failed.length;
      for (const failure of renameResult.failed) {
        const failedItem = service.getItems().find((entry) => entry.id === failure.itemId);
        failures.push((failedItem?.fileName || failure.itemId) + ': ' + failure.error);
      }

      for (let index = 0; index < completed.length; index += 1) {
        const operation = completed[index];
        let item = service.getItems().find((entry) => entry.id === operation.itemId);
        const metadata = metadataService.getMetadataForItem(operation.itemId);

        if (!item) {
          offlineFailures += 1;
          failures.push(fs.baseName(operation.destFilePath) + ': فایل در کتابخانه پیدا نشد');
        } else {
          // Refresh the item after the transactional batch rename so offline
          // metadata and artwork are saved beside the final video path.
          item = service.getItems().find((entry) => entry.id === operation.itemId);
          try {
            if (!item || !metadata) throw new Error('اطلاعات متادیتا برای این فایل موجود نیست');

            const videoName = fs.baseName(item.filePath);
            const dot = videoName.lastIndexOf('.');
            const base = dot > 0 ? videoName.slice(0, dot) : videoName;
            const jsonPath = fs.joinPath(item.parentFolder, base + '.film-baz.json');
            const sidecarAlreadyExists = await fs.exists(jsonPath);
            const savedImages: string[] = [];
            const images = [
              { label: 'poster', url: metadata.posterUrl },
              { label: 'backdrop', url: metadata.backdropUrl },
              ...metadata.cast.map((person, personIndex) => ({
                label: 'cast-' + String(personIndex + 1).padStart(2, '0'),
                url: person.photoUrl,
              })),
            ].filter((entry): entry is { label: string; url: string } => Boolean(entry.url));

            for (const image of images) {
              const extensionMatch = image.url.match(/\.(jpe?g|png|webp)(?:[?#]|$)/i);
              const extension = extensionMatch?.[1]?.toLowerCase() || 'jpg';
              const imagePath = fs.joinPath(item.parentFolder, base + '.' + image.label + '.' + extension);
              if (await fs.exists(imagePath)) {
                savedImages.push(fs.baseName(imagePath));
                continue;
              }
              const result = await fs.downloadFile(image.url, imagePath);
              if (result.success) savedImages.push(fs.baseName(imagePath));
              else failures.push(videoName + ': دانلود تصویر ' + image.label + ' ناموفق بود');
            }

            if (!sidecarAlreadyExists) {
              const sidecar = { ...metadata, offlineAssets: savedImages, exportedAt: new Date().toISOString() };
              await fs.writeTextFile(jsonPath, JSON.stringify(sidecar, null, 2));
            } else {
              failures.push(videoName + ': فایل اطلاعات آفلاین از قبل موجود بود و بازنویسی نشد');
            }
            offlineSaved += 1;
          } catch (error) {
            offlineFailures += 1;
            failures.push((item ? fs.baseName(item.filePath) : fs.baseName(operation.destFilePath)) + ': ' +
              (error instanceof Error ? error.message : 'خطای ذخیره‌سازی آفلاین'));
          }
        }

        setFinalizeProgress({
          completed: index + 1,
          total: completed.length,
          namesSynced,
          nameFailures,
          offlineSaved,
          offlineFailures,
        });
        setFinalizeFailures([...failures]);
      }
      notifyLibraryUpdated();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'خطای کلی در تکمیل فایل‌های موفق');
      setFinalizeFailures([...failures]);
    } finally {
      setFinalizeBusy(false);
    }
  }

  const activeOps = useMemo(() => (proposal ? proposal.operations.filter((o) => !o.excluded) : []), [proposal]);
  const excludedCount = proposal ? proposal.operations.length - activeOps.length : 0;

  if (loading) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-6 lg:px-8 fade-in">
        <BackButton onBack={onBack} />
        <div className="flex h-64 items-center justify-center">
          <Loader2 size={32} className="animate-spin text-gold-bright" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-6 lg:px-8 fade-in">
        <BackButton onBack={onBack} />
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <XCircle size={18} className="text-red-400" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 lg:px-8 fade-in">
      <BackButton onBack={onBack} />

      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold text-white">
          <Sparkles size={24} className="text-gold-bright" />
          سازماندهی فایل‌ها
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          همه موارد این پوشه به‌صورت گروهی و پشت‌سرهم سامان‌دهی می‌شوند؛ هیچ تغییری بدون تأیید شما انجام نمی‌شود
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={() => void enrichWholeFolder()} disabled={metadataBusy} className="btn-primary text-sm disabled:opacity-50">
            {metadataBusy ? <><Loader2 size={16} className="animate-spin" /> تکمیل اطلاعات…</> : <><Sparkles size={16} /> تکمیل اطلاعات تمام فیلم‌های پوشه</>}
          </button>
          <span className="text-xs text-text-muted">پوستر، داستان، بازیگران، کارگردان و ژانر از منابع فعال</span>
        </div>
        {metadataProgress.total > 0 && (
          <div className="mt-3 rounded-lg border border-white/10 bg-surface-2 p-3">
            <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-text-secondary">
              <span>پیشرفت تکمیل اطلاعات: {toPersianDigits(metadataProgress.completed)} از {toPersianDigits(metadataProgress.total)}</span>
              <span>{toPersianDigits(Math.round(metadataProgress.completed / metadataProgress.total * 100))}٪</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gold transition-all" style={{ width: (metadataProgress.completed / metadataProgress.total * 100) + '%' }} /></div>
            {metadataProgress.current && <p className="mt-2 truncate text-xs text-text-muted" dir="ltr">{metadataProgress.current}</p>}
            <p className="mt-1 text-xs text-text-muted">{toPersianDigits(metadataProgress.succeeded)} موفق · {toPersianDigits(metadataProgress.failed)} ناموفق</p>
            {metadataSkipped > 0 && <p className="mt-1 text-xs text-green-300">{toPersianDigits(metadataSkipped)} فیلم قبلاً با موفقیت تکمیل شده و از پردازش مجدد رد شد.</p>}
            {metadataProgress.total === 0 && metadataSkipped > 0 && <p className="mt-1 text-xs text-text-muted">همه فیلم‌های این پوشه قبلاً اطلاعات موفق داشته‌اند؛ مورد جدیدی برای پردازش نیست.</p>}
            {metadataFailures.length > 0 && <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">{metadataFailures.map((failure, index) => <p key={index} className="text-xs text-amber-300">{failure.fileName}: {failure.reason}</p>)}</div>}
          </div>
        )}
      </div>

      {proposal && proposal.operations.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-white/10 bg-surface/50">
          <div className="text-center">
            <CheckCircle2 size={32} className="mx-auto mb-2 text-green-400" />
            <p className="text-sm font-medium text-white">کتابخانه منظم است</p>
            <p className="mt-1 text-xs text-text-muted">فایل نیازمند سازماندهی‌ای یافت نشد</p>
          </div>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-surface-2 p-4">
            <FolderTree size={20} className="text-gold-bright" />
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-text-secondary">
                <span className="font-bold text-white">{toPersianDigits(activeOps.length)}</span> عملیات پیشنهادی
              </span>
              {excludedCount > 0 && (
                <span className="text-text-muted">{toPersianDigits(excludedCount)} مورد مستثنی</span>
              )}
              {proposal!.conflicts > 0 && (
                <span className="inline-flex items-center gap-1 text-orange-400">
                  <AlertTriangle size={14} />
                  {toPersianDigits(proposal!.conflicts)} تداخل
                </span>
              )}
              {proposal!.uncertainCount > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-400">
                  <AlertTriangle size={14} />
                  {toPersianDigits(proposal!.uncertainCount)} نیازمند بررسی
                </span>
              )}
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-surface-2 p-3">
            <div>
              <p className="text-sm font-semibold text-white">انتخاب گروهی عملیات</p>
              <p className="mt-1 text-xs text-text-muted">بدون کلیک روی تک‌تک فیلم‌ها، موارد را یک‌جا انتخاب کن.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => selectOperations('all')} className={`rounded-lg px-3 py-2 text-xs font-semibold ${selectionMode === 'all' ? 'bg-gold/20 text-gold-bright' : 'bg-white/5 text-text-secondary hover:bg-white/10'}`}>انتخاب همه</button>
              <button onClick={() => selectOperations('safe')} className={`rounded-lg px-3 py-2 text-xs font-semibold ${selectionMode === 'safe' ? 'bg-green-500/15 text-green-300' : 'bg-white/5 text-text-secondary hover:bg-white/10'}`}>فقط موارد امن</button>
              <button onClick={() => selectOperations('none')} className={`rounded-lg px-3 py-2 text-xs font-semibold ${selectionMode === 'none' ? 'bg-white/10 text-white' : 'bg-white/5 text-text-secondary hover:bg-white/10'}`}>لغو انتخاب</button>
            </div>
          </div>

          {/* Safety notice */}
          <div className="mb-5 flex items-start gap-3 rounded-lg border border-gold/15 bg-gold/5 p-3.5">
            <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-gold-bright" />
            <div>
              <p className="text-sm font-medium text-white">ایمنی فایل‌ها</p>
              <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                فایل‌ها جابه‌جا می‌شوند نه حذف. اگر فایل مقصد از قبل وجود داشته باشد، عملیات برای آن مورد انجام نمی‌شود.
                پس از اجرا، امکان بازگشت (Undo) برای هر عملیات موفق فراهم است.
              </p>
            </div>
          </div>

          {/* Execution result */}
          {execResult && (
            <div className="mb-5 rounded-xl border border-white/10 bg-surface-2 p-4 fade-in">
              <h3 className="mb-3 text-sm font-bold text-white">نتیجه اجرا</h3>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="inline-flex items-center gap-1 text-green-400">
                  <CheckCircle2 size={16} />
                  {toPersianDigits(execResult.succeeded.length)} موفق
                </span>
                {execResult.failed.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-red-400">
                    <XCircle size={16} />
                    {toPersianDigits(execResult.failed.length)} ناموفق
                  </span>
                )}
              </div>
              {execResult.failed.length > 0 && (
                <div className="mt-3 space-y-2">
                  {execResult.failed.map((f, idx) => (
                    <div key={idx} className="rounded-lg bg-red-500/5 p-2 text-xs">
                      <p className="text-red-300">{f.error}</p>
                      <p className="mt-0.5 truncate text-text-muted" dir="ltr">{f.operation.sourcePath}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 rounded-lg border border-gold/20 bg-gold/5 p-3">
                <p className="text-sm font-semibold text-white">تکمیل گروهی فایل‌های موفق</p>
                <p className="mt-1 text-xs leading-6 text-text-secondary">
                  با یک مرحله، نام پوشه و فیلم و زیرنویس‌ها هماهنگ می‌شود و اطلاعات، پوستر، پس‌زمینه و تصاویر بازیگران کنار ویدئو ذخیره می‌شوند. فایل‌های جانبی موجود بازنویسی نمی‌شوند.
                </p>
                <button onClick={() => void finalizeSuccessfulFiles()} disabled={finalizeBusy || metadataBusy || execResult.succeeded.length === 0} className="btn-primary mt-3 text-sm disabled:opacity-50">
                  {finalizeBusy ? <><Loader2 size={16} className="animate-spin" /> در حال تکمیل گروهی…</> : metadataBusy ? 'پس از تکمیل اطلاعات فعال می‌شود' : 'تغییر نام همه + ذخیره اطلاعات آفلاین'}
                </button>
                {finalizeProgress.total > 0 && (
                  <div className="mt-2 space-y-1 text-xs text-text-secondary">
                    <p>پیشرفت: {toPersianDigits(finalizeProgress.completed)} از {toPersianDigits(finalizeProgress.total)}</p>
                    <p>{toPersianDigits(finalizeProgress.namesSynced)} نام هماهنگ · {toPersianDigits(finalizeProgress.nameFailures)} خطای نام‌گذاری</p>
                    <p>{toPersianDigits(finalizeProgress.offlineSaved)} ذخیره آفلاین · {toPersianDigits(finalizeProgress.offlineFailures)} خطای ذخیره</p>
                  </div>
                )}
                {finalizeFailures.length > 0 && <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">{finalizeFailures.map((failure, index) => <p key={index} className="text-xs text-amber-300">{failure}</p>)}</div>}
              </div>
              <button
                onClick={onViewLog}
                className="mt-3 text-xs text-gold-bright hover:underline"
              >
                مشاهده گزارش کامل عملیات ←
              </button>
            </div>
          )}

          {/* Operations list */}
          <div className="space-y-2.5">
            {proposal!.operations.map((op) => {
              const item = service.getItems().find((i) => i.id === op.itemId);
              const isEditing = editingOpId === op.id;
              return (
                <div
                  key={op.id}
                  className={`rounded-xl border p-4 transition-all ${
                    op.excluded
                      ? 'border-white/5 bg-surface/30 opacity-50'
                      : op.destFileExists
                        ? 'border-orange-500/30 bg-orange-500/5'
                        : 'border-white/10 bg-surface-2'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Status icon */}
                    <div className="flex-shrink-0 pt-0.5">
                      {op.excluded ? (
                        <X size={18} className="text-text-muted" />
                      ) : op.destFileExists ? (
                        <AlertTriangle size={18} className="text-orange-400" />
                      ) : op.uncertain ? (
                        <AlertTriangle size={18} className="text-amber-400" />
                      ) : (
                        <ArrowLeft size={18} className="text-gold-bright" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-white" dir="ltr">
                            {fs.baseName(op.sourcePath)}
                          </p>
                          {item && (
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-muted">
                              <span>{mediaTypeLabel(item.mediaType)}</span>
                              <span>·</span>
                              <span>{formatFileSize(item.fileSize)}</span>
                              {item.identification === 'needs-review' && (
                                <>
                                  <span>·</span>
                                  <span className="text-amber-400">{identificationLabel(item.identification)}</span>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {!isEditing && !op.excluded && (
                            <button
                              onClick={() => startEdit(op)}
                              className="rounded p-1.5 text-text-muted transition-colors hover:bg-white/10 hover:text-white"
                              aria-label="ویرایش نام پوشه مقصد"
                              title="ویرایش نام پوشه"
                            >
                              <Edit3 size={15} />
                            </button>
                          )}
                          <button
                            onClick={() => handleExclude(op.id)}
                            className={`rounded p-1.5 transition-colors ${
                              op.excluded
                                ? 'text-green-400 hover:bg-green-500/10'
                                : 'text-text-muted hover:bg-white/10 hover:text-white'
                            }`}
                            aria-label={op.excluded ? 'بازگرداندن مورد' : 'مستثنی کردن مورد'}
                            title={op.excluded ? 'بازگرداندن' : 'مستثنی کردن'}
                          >
                            {op.excluded ? <Check size={15} /> : <X size={15} />}
                          </button>
                        </div>
                      </div>

                      {/* Path mapping */}
                      <div className="mt-3 rounded-lg bg-base/50 p-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="flex-shrink-0 text-text-muted">از:</span>
                          <span className="truncate text-text-secondary" dir="ltr">{op.sourcePath}</span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <span className="flex-shrink-0 text-text-muted">به:</span>
                          {isEditing ? (
                            <div className="flex flex-1 items-center gap-2">
                              <input
                                type="text"
                                value={editFolderName}
                                onChange={(e) => setEditFolderName(e.target.value)}
                                dir="ltr"
                                className="flex-1 rounded border border-gold/40 bg-base px-2 py-1 text-xs text-white focus:outline-none"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') applyEdit(op.id);
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                              />
                              <button
                                onClick={() => applyEdit(op.id)}
                                className="rounded bg-gold/20 p-1 text-gold-bright hover:bg-gold/30"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="rounded bg-white/5 p-1 text-text-muted hover:text-white"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <span className="truncate text-gold-bright" dir="ltr">{op.destFilePath}</span>
                          )}
                        </div>

                        {/* Related subtitles */}
                        {op.relatedSubtitles.length > 0 && !isEditing && (
                          <div className="mt-2 border-t border-white/5 pt-2">
                            <p className="text-text-muted">زیرنویس‌های همراه ({toPersianDigits(op.relatedSubtitles.length)}):</p>
                            {op.relatedSubtitles.map((sub, sidx) => (
                              <p key={sidx} className="mt-0.5 truncate text-text-secondary" dir="ltr">
                                {sub.fileName}
                                {sub.language && <span className="text-text-muted"> [{sub.language}]</span>}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Conflict/uncertain warnings */}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {op.destFileExists && (
                          <span className="inline-flex items-center gap-1 rounded bg-orange-500/10 px-2 py-0.5 text-xs text-orange-400">
                            <AlertTriangle size={12} />
                            تداخل: فایل مقصد وجود دارد — عملیات انجام نمی‌شود
                          </span>
                        )}
                        {op.uncertain && (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
                            <AlertTriangle size={12} />
                            شناسایی نامطمئن — نام پوشه را بررسی کنید
                          </span>
                        )}
                        {op.excluded && (
                          <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-text-muted">
                            مستثنی شده از اجرا
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Action bar */}
          {!execResult && (
            <div className="sticky bottom-4 mt-6 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-surface/95 p-4 shadow-cinematic backdrop-blur-md">
              <p className="text-sm text-text-secondary">
                {toPersianDigits(activeOps.length)} مورد آماده سامان‌دهی گروهی
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={onBack}
                  className="rounded-lg border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                >
                  لغو همه
                </button>
                <button
                  onClick={execute}
                  disabled={executing || metadataBusy || activeOps.length === 0}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {executing ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      در حال اجرا…
                    </>
                  ) : (
                    <>
                      <Check size={16} />
                      سامان‌دهی همه موارد
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-gold-bright"
    >
      <ChevronLeft size={18} className="rotate-180" />
      بازگشت
    </button>
  );
}
