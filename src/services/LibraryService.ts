// LibraryService — orchestrates scanning, duplicate detection, organization
// proposals, execution, undo, and persistence. Uses the FilesystemService for
// all file operations (mock in browser, real in Electron). UI never touches
// the filesystem directly.

import type {
  LibraryFolder,
  MediaItem,
  ScanProgress,
  ScanSummary,
  OrgProposal,
  OrgOperation,
  OrgExecutionResult,
  OperationLogEntry,
  LibraryPreferences,
  SubtitleFile,
} from '@/types/media-library';
import type { DirEntry } from '@/services/filesystem';
import { getFilesystemService } from '@/services/filesystemFactory';
import { idbGet, idbSet } from '@/services/idbStore';
import { getMetadataService } from '@/services/metadata/MetadataService';
import {
  isVideoFile,
  isSubtitleFile,
  parseFileName,
  buildFolderName,
  parseSubtitleLanguage,
  subtitleMatchesVideo,
  uid,
} from '@/lib/fileParsing';

const FOLDERS_KEY = 'film-baz:library-folders';
const ITEMS_KEY = 'film-baz:media-items';
const LOG_KEY = 'film-baz:operation-log';
const PREFS_KEY = 'film-baz:library-prefs';

export const DEFAULT_PREFERENCES: LibraryPreferences = {
  videoExtensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'm4v', 'webm', 'mpeg', 'mpg', 'ts'],
  subtitleExtensions: ['srt', 'ass', 'ssa', 'vtt', 'sub'],
  skipSymlinks: true,
  maxFilesPerScan: 20000,
};

class LibraryService {
  private folders: LibraryFolder[] = [];
  private items: MediaItem[] = [];
  private log: OperationLogEntry[] = [];
  private prefs: LibraryPreferences = DEFAULT_PREFERENCES;
  private loaded = false;
  private scanCancellers = new Map<string, { cancelled: boolean }>();

  async load(): Promise<void> {
    if (this.loaded) return;
    const [folders, items, log, prefs] = await Promise.all([
      idbGet<LibraryFolder[]>(FOLDERS_KEY),
      idbGet<MediaItem[]>(ITEMS_KEY),
      idbGet<OperationLogEntry[]>(LOG_KEY),
      idbGet<LibraryPreferences>(PREFS_KEY),
    ]);
    this.folders = folders ?? [];
    this.items = items ?? [];
    this.log = log ?? [];
    this.prefs = prefs ?? DEFAULT_PREFERENCES;
    this.loaded = true;
  }

  private async persistFolders(): Promise<void> {
    await idbSet(FOLDERS_KEY, this.folders);
  }
  private async persistItems(): Promise<void> {
    await idbSet(ITEMS_KEY, this.items);
  }
  private async persistLog(): Promise<void> {
    await idbSet(LOG_KEY, this.log);
  }
  private async persistPrefs(): Promise<void> {
    await idbSet(PREFS_KEY, this.prefs);
  }

  // --- Folders ---

  getFolders(): LibraryFolder[] {
    return [...this.folders];
  }

  async addFolder(path: string, label?: string): Promise<LibraryFolder> {
    await this.load();
    const existing = this.folders.find((f) => f.path === path);
    if (existing) return existing;
    const fs = getFilesystemService();
    const exists = await fs.exists(path);
    if (!exists) {
      throw new Error('مسیر پوشه یافت نشد');
    }
    const info = await fs.stat(path);
    if (!info.isDirectory) {
      throw new Error('مسیر انتخاب‌شده یک پوشه نیست');
    }
    const folder: LibraryFolder = {
      id: uid(),
      path,
      label: label || fs.baseName(path) || path,
      addedAt: Date.now(),
    };
    this.folders.push(folder);
    await this.persistFolders();
    return folder;
  }

  async removeFolder(folderId: string): Promise<void> {
    await this.load();
    this.folders = this.folders.filter((f) => f.id !== folderId);
    this.items = this.items.filter((i) => i.folderId !== folderId);
    await this.persistFolders();
    await this.persistItems();
  }

  // --- Preferences ---

  getPreferences(): LibraryPreferences {
    return { ...this.prefs };
  }

  async setPreferences(prefs: Partial<LibraryPreferences>): Promise<void> {
    await this.load();
    this.prefs = { ...this.prefs, ...prefs };
    await this.persistPrefs();
  }

  // --- Items ---

  getItems(): MediaItem[] {
    return [...this.items];
  }

  getItemsForFolder(folderId: string): MediaItem[] {
    return this.items.filter((i) => i.folderId === folderId);
  }

  /** Remove an inventory entry without deleting the underlying media file. */
  async removeItem(itemId: string): Promise<void> {
    await this.load();
    this.items = this.items.filter((item) => item.id !== itemId);
    await this.persistItems();
  }

  async renameItem(
    itemId: string,
    options: { mode: 'file' | 'folder' | 'both'; fileName?: string; folderName?: string },
  ): Promise<MediaItem> {
    await this.load();
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('فایل کتابخانه یافت نشد');

    const fs = getFilesystemService();
    const sourceItemPath = item.filePath;
    const sourceFolderPath = item.parentFolder;
    const libraryFolder = this.folders.find((folder) => folder.id === item.folderId);
    const renameFolder = options.mode === 'folder' || options.mode === 'both';
    const renameFile = options.mode === 'file' || options.mode === 'both';

    if (renameFolder && libraryFolder?.path === sourceFolderPath) {
      throw new Error('پوشه اصلی کتابخانه قابل تغییر نام نیست');
    }

    const fileName = renameFile ? validateRenameName(options.fileName, item.extension, 'نام فایل') : item.fileName;
    const folderName = renameFolder ? validateRenameName(options.folderName, '', 'نام پوشه') : fs.baseName(sourceFolderPath);
    const destinationFolder = renameFolder
      ? fs.joinPath(fs.parentPath(sourceFolderPath), folderName)
      : sourceFolderPath;
    const folderWillMove = renameFolder && destinationFolder !== sourceFolderPath;
    const destinationFile = fs.joinPath(destinationFolder, fileName);
    const videoPathAfterFolderMove = folderWillMove
      ? fs.joinPath(destinationFolder, item.fileName)
      : sourceItemPath;

    if (folderWillMove && await fs.exists(destinationFolder)) {
      throw new Error('پوشه مقصد از قبل وجود دارد');
    }
    if (!await fs.exists(sourceItemPath)) throw new Error('فایل اصلی یافت نشد');
    if (renameFolder && !await fs.exists(sourceFolderPath)) throw new Error('پوشه اصلی یافت نشد');
    if (renameFile && destinationFile !== videoPathAfterFolderMove && await fs.exists(destinationFile)) {
      throw new Error('فایل مقصد از قبل وجود دارد');
    }

    const removeExtension = (name: string) => {
      const dot = name.lastIndexOf('.');
      return dot > 0 ? name.slice(0, dot) : name;
    };
    const oldVideoBase = removeExtension(item.fileName);
    const newVideoBase = removeExtension(fileName);
    const oldFolderPrefix = sourceFolderPath.endsWith('\\') ? sourceFolderPath : sourceFolderPath + '\\';
    const rebaseFolderPath = (path: string) => {
      if (path === sourceFolderPath) return destinationFolder;
      if (path.startsWith(oldFolderPrefix)) {
        return destinationFolder + path.slice(sourceFolderPath.length);
      }
      return path;
    };

    // Preflight every subtitle before changing the folder or video. A subtitle
    // conflict or missing source must not leave a partially renamed group.
    const subtitlePlans = renameFile ? item.subtitles.map((subtitle) => {
      const oldSubtitleBase = removeExtension(subtitle.fileName);
      const suffix = oldSubtitleBase.toLowerCase().startsWith(oldVideoBase.toLowerCase())
        ? oldSubtitleBase.slice(oldVideoBase.length)
        : (oldSubtitleBase ? '.' + oldSubtitleBase : '');
      const subtitleExtension = subtitle.extension || subtitle.fileName.split('.').pop() || 'srt';
      const nextName = newVideoBase + suffix + '.' + subtitleExtension;
      const sourceAfterFolderMove = folderWillMove ? rebaseFolderPath(subtitle.filePath) : subtitle.filePath;
      return {
        originalPath: subtitle.filePath,
        sourcePath: sourceAfterFolderMove,
        destinationPath: fs.joinPath(destinationFolder, nextName),
        destinationName: nextName,
      };
    }) : [];

    for (const plan of subtitlePlans) {
      if (!await fs.exists(plan.originalPath)) {
        throw new Error('زیرنویس مبدأ یافت نشد: ' + fs.baseName(plan.originalPath));
      }
      if (plan.destinationPath !== plan.sourcePath && await fs.exists(plan.destinationPath)) {
        throw new Error('فایل زیرنویس مقصد از قبل وجود دارد: ' + plan.destinationName);
      }
    }

    let folderMoved = false;
    const movedSubtitles: Array<{ sourcePath: string; destinationPath: string }> = [];
    const rollback = async () => {
      const rollbackErrors: string[] = [];
      for (const moved of [...movedSubtitles].reverse()) {
        const result = await fs.moveFile(moved.destinationPath, moved.sourcePath);
        if (!result.success) rollbackErrors.push(fs.baseName(moved.destinationPath));
      }
      if (folderMoved) {
        const result = await fs.moveFile(destinationFolder, sourceFolderPath);
        if (!result.success) rollbackErrors.push(fs.baseName(destinationFolder));
      }
      return rollbackErrors;
    };

    if (folderWillMove) {
      const result = await fs.moveFile(sourceFolderPath, destinationFolder);
      if (!result.success) throw new Error(result.error || 'تغییر نام پوشه ناموفق بود');
      folderMoved = true;
    }

    // Rename subtitles first, then the video. If any step fails, restore all
    // already moved subtitles and the original folder name.
    for (const plan of subtitlePlans) {
      if (plan.destinationPath === plan.sourcePath) continue;
      const result = await fs.moveFile(plan.sourcePath, plan.destinationPath);
      if (!result.success) {
        const rollbackErrors = await rollback();
        const suffix = rollbackErrors.length ? '؛ بازگردانی کامل انجام نشد: ' + rollbackErrors.join('، ') : '';
        throw new Error((result.error || 'تغییر نام زیرنویس ناموفق بود') + suffix);
      }
      movedSubtitles.push({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath });
    }

    if (renameFile && destinationFile !== videoPathAfterFolderMove) {
      const result = await fs.moveFile(videoPathAfterFolderMove, destinationFile);
      if (!result.success) {
        const rollbackErrors = await rollback();
        const suffix = rollbackErrors.length ? '؛ بازگردانی کامل انجام نشد: ' + rollbackErrors.join('، ') : '';
        throw new Error((result.error || 'تغییر نام فایل ناموفق بود') + suffix);
      }
    }

    const renamedSubtitlePaths = new Map<string, string>();
    for (const plan of subtitlePlans) renamedSubtitlePaths.set(plan.originalPath, plan.destinationPath);

    for (const current of this.items) {
      const isInsideRenamedFolder = folderWillMove &&
        (current.parentFolder === sourceFolderPath || current.filePath.startsWith(oldFolderPrefix));
      if (isInsideRenamedFolder) {
        current.parentFolder = destinationFolder;
        current.filePath = current.filePath === sourceItemPath
          ? destinationFile
          : rebaseFolderPath(current.filePath);
        current.subtitles = current.subtitles.map((subtitle) => {
          const movedPath = renamedSubtitlePaths.get(subtitle.filePath);
          const nextPath = movedPath || rebaseFolderPath(subtitle.filePath);
          return { ...subtitle, filePath: nextPath, fileName: fs.baseName(nextPath) };
        });
      } else if (current.id === itemId) {
        if (renameFile) {
          current.filePath = destinationFile;
          current.fileName = fileName;
        }
        current.subtitles = current.subtitles.map((subtitle) => {
          const nextPath = renamedSubtitlePaths.get(subtitle.filePath) || subtitle.filePath;
          return { ...subtitle, filePath: nextPath, fileName: fs.baseName(nextPath) };
        });
      }
    }

    await this.persistItems();
    return { ...item, subtitles: item.subtitles.map((subtitle) => ({ ...subtitle })) };
  }

  async renameItemsBatch(
    plans: Array<{ itemId: string; mode: 'file' | 'folder' | 'both'; fileName?: string; folderName?: string }>,
  ): Promise<{ succeeded: Array<{ itemId: string }>; failed: Array<{ itemId: string; error: string }> }> {
    await this.load();
    const succeeded: Array<{ itemId: string }> = [];
    const failed: Array<{ itemId: string; error: string }> = [];
    for (const plan of plans) {
      try {
        await this.renameItem(plan.itemId, { mode: plan.mode, fileName: plan.fileName, folderName: plan.folderName });
        succeeded.push({ itemId: plan.itemId });
      } catch (e) {
        failed.push({ itemId: plan.itemId, error: e instanceof Error ? e.message : 'تغییر نام ناموفق بود' });
      }
    }
    return { succeeded, failed };
  }

  /**
   * Apply canonical folder/video/subtitle names to a set of successfully
   * organized items. Each video + its sidecar subtitles is treated as one
   * transaction; conflicts never overwrite existing files.
   */
  async renameOrganizedItemsBatch(
    itemIds: string[],
  ): Promise<{ succeeded: Array<{ itemId: string }>; failed: Array<{ itemId: string; error: string }> }> {
    await this.load();
    await getMetadataService().load();
    const succeeded: Array<{ itemId: string }> = [];
    const failed: Array<{ itemId: string; error: string }> = [];
    for (const itemId of [...new Set(itemIds)]) {
      try {
        await this.renameOrganizedItemCanonical(itemId);
        succeeded.push({ itemId });
      } catch (error) {
        failed.push({
          itemId,
          error: error instanceof Error ? error.message : 'تغییر نام گروه فایل ناموفق بود',
        });
      }
    }
    await this.persistItems();
    await this.persistLog();
    return { succeeded, failed };
  }

  private async renameOrganizedItemCanonical(itemId: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('فایل کتابخانه یافت نشد');

    const fs = getFilesystemService();
    const metadata = getMetadataService().getMetadataForItem(item.id);
    const canonicalTitle = metadata?.persianTitle?.trim() || metadata?.title?.trim() || item.titleGuess || stripExtension(item.fileName);
    const canonicalYear = metadata?.year || item.yearGuess;
    const folderName = buildFolderName(canonicalTitle, canonicalYear);
    const safeTitle = buildFolderName(canonicalTitle);
    const extension = item.extension || (item.fileName.includes('.') ? item.fileName.slice(item.fileName.lastIndexOf('.') + 1) : '');
    const fileBase = item.mediaType === 'episode' && item.seasonGuess && item.episodeGuess
      ? `${safeTitle} - S${String(item.seasonGuess).padStart(2, '0')}E${String(item.episodeGuess).padStart(2, '0')}`
      : folderName;
    const videoName = extension ? `${fileBase}.${extension}` : fileBase;

    const sourceFolder = item.parentFolder;
    const libraryFolder = this.folders.find((folder) => folder.id === item.folderId);
    if (libraryFolder?.path && normalizePath(libraryFolder.path) === normalizePath(sourceFolder)) {
      throw new Error('پوشه اصلی کتابخانه قابل تغییر نام نیست');
    }
    if (!(await fs.exists(sourceFolder))) throw new Error('پوشه فعلی فیلم یافت نشد');
    if (!(await fs.exists(item.filePath))) throw new Error('فایل ویدئویی یافت نشد');

    const destinationFolder = fs.joinPath(fs.parentPath(sourceFolder), folderName);
    const renameFolder = normalizePath(destinationFolder) !== normalizePath(sourceFolder);
    if (renameFolder && await fs.exists(destinationFolder)) {
      throw new Error('پوشه مقصد از قبل وجود دارد؛ برای جلوگیری از ادغام یا بازنویسی، تغییر نام انجام نشد');
    }

    const oldVideoBase = stripExtension(fs.baseName(item.filePath));
    const fileMoves: Array<{ sourcePath: string; targetPath: string }> = [];
    const targetVideoPath = fs.joinPath(sourceFolder, videoName);
    fileMoves.push({ sourcePath: item.filePath, targetPath: targetVideoPath });

    for (const subtitle of item.subtitles) {
      if (!(await fs.exists(subtitle.filePath))) {
        throw new Error(`زیرنویس مبدأ یافت نشد: ${subtitle.fileName}`);
      }
      const oldSubtitleBase = stripExtension(subtitle.fileName);
      const suffix = oldSubtitleBase.toLowerCase().startsWith(oldVideoBase.toLowerCase())
        ? oldSubtitleBase.slice(oldVideoBase.length)
        : (oldSubtitleBase ? `.${oldSubtitleBase}` : '');
      const subtitleExtension = subtitle.extension || subtitle.fileName.split('.').pop() || '';
      const subtitleName = subtitleExtension ? `${fileBase}${suffix}.${subtitleExtension}` : `${fileBase}${suffix}`;
      fileMoves.push({
        sourcePath: subtitle.filePath,
        targetPath: fs.joinPath(sourceFolder, subtitleName),
      });
    }

    const targetKeys = new Set<string>();
    for (const move of fileMoves) {
      const targetKey = normalizePath(move.targetPath);
      if (targetKeys.has(targetKey)) throw new Error('نام مقصد چند فایل یکسان شده است');
      targetKeys.add(targetKey);
      if (normalizePath(move.sourcePath) !== targetKey && await fs.exists(move.targetPath)) {
        throw new Error(`فایل مقصد از قبل وجود دارد: ${fs.baseName(move.targetPath)}`);
      }
    }

    const movedFiles: Array<{ sourcePath: string; targetPath: string }> = [];
    for (const move of fileMoves) {
      if (normalizePath(move.sourcePath) === normalizePath(move.targetPath)) continue;
      const result = await fs.moveFile(move.sourcePath, move.targetPath);
      if (!result.success) {
        const rollbackErrors: string[] = [];
        for (const moved of [...movedFiles].reverse()) {
          const rollback = await fs.moveFile(moved.targetPath, moved.sourcePath);
          if (!rollback.success) rollbackErrors.push(fs.baseName(moved.targetPath));
        }
        const rollbackNote = rollbackErrors.length
          ? `؛ بازگردانی این فایل‌ها هم ناموفق بود: ${rollbackErrors.join('، ')}`
          : '';
        throw new Error(`${result.error || 'تغییر نام فایل ناموفق بود'}${rollbackNote}`);
      }
      movedFiles.push(move);
    }

    if (renameFolder) {
      const folderResult = await fs.moveFile(sourceFolder, destinationFolder);
      if (!folderResult.success) {
        const rollbackErrors: string[] = [];
        for (const moved of [...movedFiles].reverse()) {
          const rollback = await fs.moveFile(moved.targetPath, moved.sourcePath);
          if (!rollback.success) rollbackErrors.push(fs.baseName(moved.targetPath));
        }
        const rollbackNote = rollbackErrors.length
          ? `؛ بازگردانی این فایل‌ها ناموفق بود: ${rollbackErrors.join('، ')}`
          : '';
        throw new Error(`${folderResult.error || 'تغییر نام پوشه ناموفق بود'}${rollbackNote}`);
      }
    }

    const replaceFolderPrefix = (filePath: string): string => {
      if (!renameFolder) return filePath;
      const normalizedPath = normalizePath(filePath);
      const normalizedFolder = normalizePath(sourceFolder);
      if (normalizedPath === normalizedFolder) return destinationFolder;
      if (normalizedPath.startsWith(`${normalizedFolder}/`)) {
        return `${destinationFolder}${filePath.slice(sourceFolder.length)}`;
      }
      return filePath;
    };
    const movedPathBySource = new Map<string, string>();
    for (const move of fileMoves) {
      const finalPath = renameFolder
        ? fs.joinPath(destinationFolder, fs.baseName(move.targetPath))
        : move.targetPath;
      movedPathBySource.set(normalizePath(move.sourcePath), finalPath);
    }

    for (const current of this.items) {
      const isInsideRenamedFolder = normalizePath(current.parentFolder) === normalizePath(sourceFolder)
        || normalizePath(current.filePath).startsWith(`${normalizePath(sourceFolder)}/`);
      if (!isInsideRenamedFolder && current.id !== itemId) continue;

      if (renameFolder) current.parentFolder = destinationFolder;
      if (current.id === itemId) {
        current.filePath = fs.joinPath(destinationFolder, videoName);
        current.fileName = videoName;
      } else {
        current.filePath = replaceFolderPrefix(current.filePath);
        current.fileName = fs.baseName(current.filePath);
      }
      current.subtitles = current.subtitles.map((subtitle) => {
        const movedPath = movedPathBySource.get(normalizePath(subtitle.filePath));
        const nextPath = movedPath || replaceFolderPrefix(subtitle.filePath);
        return { ...subtitle, filePath: nextPath, fileName: fs.baseName(nextPath) };
      });
    }

    // Keep Undo destinations valid after this folder/file rename. Also remap
    // log entries for sibling videos carried along by a shared series folder.
    for (const entry of this.log) {
      if (!entry.success || entry.type !== 'move') continue;
      const nextPath = movedPathBySource.get(normalizePath(entry.destPath))
        || replaceFolderPrefix(entry.destPath);
      if (nextPath !== entry.destPath) entry.destPath = nextPath;
    }
  }

  // --- Scanning ---

  async scanFolder(
    folderId: string,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<ScanSummary> {
    await this.load();
    const folder = this.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error('پوشه یافت نشد');

    // Set up cancellation handle
    const cancelToken = { cancelled: false };
    this.scanCancellers.set(folderId, cancelToken);

    const fs = getFilesystemService();
    const startedAt = Date.now();
    const progress: ScanProgress = {
      folderId,
      scanned: 0,
      status: 'scanning',
      foundVideos: 0,
      foundSubtitles: 0,
      duplicates: 0,
      currentPath: folder.path,
    };

    let allEntries: DirEntry[] = [];
    try {
      allEntries = await fs.scanDir(
        folder.path,
        (scanned, currentPath) => {
          if (cancelToken.cancelled) return;
          progress.scanned = scanned;
          progress.currentPath = currentPath;
          onProgress?.({ ...progress });
        },
        cancelToken,
      );
    } catch (e) {
      progress.status = 'failed';
      progress.error = e instanceof Error ? e.message : 'خطای ناشناخته';
      onProgress?.({ ...progress });
      this.scanCancellers.delete(folderId);
      return {
        folderId,
        startedAt,
        status: 'failed',
        videoCount: 0,
        subtitleCount: 0,
        duplicateCount: 0,
        needsReviewCount: 0,
        error: progress.error,
      };
    }

    if (cancelToken.cancelled) {
      progress.status = 'cancelled';
      onProgress?.({ ...progress });
      this.scanCancellers.delete(folderId);
      return {
        folderId,
        startedAt,
        status: 'cancelled',
        videoCount: 0,
        subtitleCount: 0,
        duplicateCount: 0,
        needsReviewCount: 0,
      };
    }

    // Filter by extension preferences (skip symlinks if configured)
    const videoEntries = allEntries.filter(
      (e) =>
        e.isFile &&
        isVideoFile(e.name, this.prefs.videoExtensions) &&
        (!this.prefs.skipSymlinks || !e.isSymlink),
    );
    const subtitleEntries = allEntries.filter(
      (e) => e.isFile && isSubtitleFile(e.name, this.prefs.subtitleExtensions),
    );

    // Incremental scan: retain unchanged records (and their IDs/metadata links),
    // update changed files in place, and add only genuinely new paths.
    const previousByPath = new Map(
      this.items.filter((item) => item.folderId === folderId).map((item) => [normalizePath(item.filePath), item]),
    );
    const scannedItems: MediaItem[] = [];
    let addedOrChangedCount = 0;
    const subtitlesByParent: Record<string, DirEntry[]> = {};
    for (const sub of subtitleEntries) {
      const parent = fs.parentPath(sub.path);
      if (!subtitlesByParent[parent]) subtitlesByParent[parent] = [];
      subtitlesByParent[parent].push(sub);
    }

    for (const vEntry of videoEntries) {
      const previous = previousByPath.get(normalizePath(vEntry.path));
      const unchanged = previous && previous.fileSize === vEntry.size && previous.lastModified === vEntry.lastModified;
      const parsed = parseFileName(vEntry.name);

      const parentDir = fs.parentPath(vEntry.path);

      // Find matching subtitles in the same folder
      const folderSubs = subtitlesByParent[parentDir] || [];
      const matchedSubs: SubtitleFile[] = folderSubs
        .filter((s) => subtitleMatchesVideo(s.name, vEntry.name))
        .map((s) => ({
          filePath: s.path,
          fileName: s.name,
          extension: s.name.split('.').pop() || '',
          language: parseSubtitleLanguage(s.name),
        }));

      if (!unchanged) addedOrChangedCount += 1;
      scannedItems.push({
        ...(previous || {} as MediaItem),
        id: previous?.id || uid(),
        folderId,
        filePath: vEntry.path,
        fileName: vEntry.name,
        extension: vEntry.name.split('.').pop() || '',
        parentFolder: parentDir,
        mediaType: parsed.mediaType,
        titleGuess: parsed.titleGuess,
        yearGuess: parsed.yearGuess,
        seasonGuess: parsed.seasonGuess,
        episodeGuess: parsed.episodeGuess,
        fileSize: vEntry.size,
        lastModified: vEntry.lastModified,
        subtitles: matchedSubs,
        identification: parsed.confident ? 'identified' : 'needs-review',
        scanStatus: 'completed',
      });
    }

    // Keep records that are still present, preserving metadata IDs; remove missing paths.
    // Duplicate detection runs across the complete folder inventory, not just new files.
    const otherFolderItems = this.items.filter((item) => item.folderId !== folderId);
    const mergedFolderItems = scannedItems;
    for (const item of mergedFolderItems) delete item.duplicateOfId;
    this.markDuplicates([...otherFolderItems, ...mergedFolderItems]);

    this.items = [...otherFolderItems, ...mergedFolderItems];
    folder.lastScannedAt = Date.now();
    await this.persistFolders();
    await this.persistItems();

    progress.status = 'completed';
    progress.foundVideos = addedOrChangedCount;
    progress.foundSubtitles = subtitleEntries.length;
    progress.duplicates = mergedFolderItems.filter((i) => i.duplicateOfId).length;
    onProgress?.({ ...progress });

    this.scanCancellers.delete(folderId);

    return {
      folderId,
      startedAt,
      finishedAt: Date.now(),
      status: 'completed',
      videoCount: addedOrChangedCount,
      subtitleCount: subtitleEntries.length,
      duplicateCount: mergedFolderItems.filter((i) => i.duplicateOfId).length,
      needsReviewCount: mergedFolderItems.filter((i) => i.identification === 'needs-review').length,
    };
  }

  cancelScan(folderId: string): void {
    const token = this.scanCancellers.get(folderId);
    if (token) token.cancelled = true;
  }

  isScanning(folderId: string): boolean {
    return this.scanCancellers.has(folderId);
  }

  private markDuplicates(items: MediaItem[]): void {
    // Group by normalized base name and size. Two files with the same name+size
    // are *potential* duplicates — never treated as definitely identical.
    const byKey = new Map<string, MediaItem[]>();
    for (const item of items) {
      const key = `${item.fileName.toLowerCase()}|${item.fileSize}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(item);
    }
    for (const group of byKey.values()) {
      if (group.length > 1) {
        // First one is the "original", rest point to it
        const original = group[0];
        for (let i = 1; i < group.length; i++) {
          group[i].duplicateOfId = original.id;
        }
      }
    }
  }

  getDuplicateCandidates(): MediaItem[] {
    return this.items.filter((i) => i.duplicateOfId);
  }

  // --- Organization proposals ---

  /**
   * Generate an organization proposal: identify loose video files (not in their
   * own dedicated folder) and propose moving each into a folder named
   * "Title (Year)". Never auto-execute.
   */
  async generateProposal(folderId: string): Promise<OrgProposal> {
    await this.load();
    const fs = getFilesystemService();
    const folder = this.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error('پوشه یافت نشد');

    const items = this.getItemsForFolder(folderId);
    await getMetadataService().load();
    const operations: OrgOperation[] = [];

    for (const item of items) {
      // A successful prior organization is authoritative: don't propose the same
      // already-moved file again on subsequent scans.
      const alreadyOrganized = this.log.some((entry) =>
        entry.success && entry.type === 'move' && normalizePath(entry.destPath) === normalizePath(item.filePath),
      );
      if (alreadyOrganized) continue;

      // Skip episodes inside a series season folder (already organized in their series)
      if (item.mediaType === 'episode' || item.mediaType === 'series') {
        // For series, check if the file is loose (parent is the library root)
        const relDepth = this.relativeDepth(folder.path, item.parentFolder);
        if (relDepth > 0) continue; // already nested
      }

      // Determine if the file is "loose" — its parent is the library root
      // or the same folder as many other files.
      const siblingsInSameFolder = items.filter(
        (i) => i.parentFolder === item.parentFolder && i.id !== item.id,
      );
      // If the file lives in a dedicated folder (folder name matches title), skip.
      const parentBaseName = fs.baseName(item.parentFolder).toLowerCase();
      const metadata = getMetadataService().getMetadataForItem(item.id);
      const knownTitles = [metadata?.persianTitle, metadata?.title, item.titleGuess]
        .map((value) => value?.trim().toLowerCase() || '')
        .filter(Boolean);
      const isDedicated =
        siblingsInSameFolder.length === 0 &&
        parentBaseName.length > 0 &&
        knownTitles.some((title) => parentBaseName.includes(title) || title.includes(parentBaseName));

      if (isDedicated) continue;

      // Prefer confirmed provider metadata; fall back to the conservative filename parser.
      const canonicalTitle = metadata?.persianTitle?.trim() || metadata?.title?.trim() || item.titleGuess || item.fileName;
      const canonicalYear = metadata?.year || item.yearGuess;
      const folderName = buildFolderName(canonicalTitle, canonicalYear);
      const safeTitle = buildFolderName(canonicalTitle);
      const extension = item.extension ? `.${item.extension}` : '';
      const canonicalBase = item.mediaType === 'episode' && item.seasonGuess && item.episodeGuess
        ? `${safeTitle} - S${String(item.seasonGuess).padStart(2, '0')}E${String(item.episodeGuess).padStart(2, '0')}`
        : folderName;
      const proposedFileName = `${canonicalBase}${extension}`;
      const destFolderPath = fs.joinPath(folder.path, folderName);
      const destFilePath = fs.joinPath(destFolderPath, proposedFileName);

      const destFolderExists = await fs.exists(destFolderPath);
      const destFileExists = await fs.exists(destFilePath);

      operations.push({
        id: uid(),
        itemId: item.id,
        type: 'move',
        sourcePath: item.filePath,
        destFolderPath,
        destFilePath,
        relatedSubtitles: item.subtitles,
        destFolderExists,
        destFileExists,
        uncertain: item.identification === 'needs-review',
        excluded: false,
      });
    }

    return {
      id: uid(),
      folderId,
      createdAt: Date.now(),
      operations,
      conflicts: operations.filter((o) => o.destFileExists).length,
      uncertainCount: operations.filter((o) => o.uncertain).length,
    };
  }

  private relativeDepth(rootPath: string, itemPath: string): number {
    const root = rootPath.replace(/\\+$/, '');
    const rel = itemPath.startsWith(root) ? itemPath.slice(root.length).replace(/^\\+/, '') : itemPath;
    return rel.split('\\').filter(Boolean).length;
  }

  /** Recalculate proposal after user edits/exclusions. */
  recalcProposal(proposal: OrgProposal): OrgProposal {
    const operations = proposal.operations.map((op) => ({ ...op }));
    return {
      ...proposal,
      operations,
      conflicts: operations.filter((o) => !o.excluded && o.destFileExists).length,
      uncertainCount: operations.filter((o) => !o.excluded && o.uncertain).length,
    };
  }

  /** Update a single operation's destination folder name (user edit). */
  updateOperationDest(
    proposal: OrgProposal,
    operationId: string,
    newFolderName: string,
  ): OrgProposal {
    const folder = this.folders.find((f) => f.id === proposal.folderId);
    if (!folder) return proposal;
    const fs = getFilesystemService();
    const operations = proposal.operations.map((op) => {
      if (op.id !== operationId || op.excluded) return op;
      const destFolderPath = fs.joinPath(folder.path, newFolderName);
      // Preserve the canonical filename already proposed by generateProposal.
      // Editing only the destination folder must not revert the video to its old name.
      const destFilePath = fs.joinPath(destFolderPath, fs.baseName(op.destFilePath));
      return {
        ...op,
        destFolderPath,
        destFilePath,
        destFileExists: false, // will be re-checked on execute
      };
    });
    return this.recalcProposal({ ...proposal, operations });
  }

  toggleExclude(proposal: OrgProposal, operationId: string): OrgProposal {
    const operations = proposal.operations.map((op) =>
      op.id === operationId ? { ...op, excluded: !op.excluded } : op,
    );
    return this.recalcProposal({ ...proposal, operations });
  }

  // --- Execution ---

  async executeProposal(proposal: OrgProposal): Promise<OrgExecutionResult> {
    await this.load();
    const fs = getFilesystemService();
    const succeeded: OrgOperation[] = [];
    const failed: { operation: OrgOperation; error: string }[] = [];

    for (const op of proposal.operations) {
      if (op.excluded) continue;

      // Re-check conflicts before each move (safety)
      if (await fs.exists(op.destFilePath)) {
        failed.push({ operation: op, error: 'فایل مقصد از قبل وجود دارد' });
        this.addLog({
          id: uid(),
          timestamp: Date.now(),
          type: 'move',
          sourcePath: op.sourcePath,
          destPath: op.destFilePath,
          success: false,
          error: 'فایل مقصد از قبل وجود دارد',
          proposalId: proposal.id,
        });
        continue;
      }

      // Ensure destination folder exists
      if (!op.destFolderExists && !(await fs.exists(op.destFolderPath))) {
        const mkdir = await fs.createDir(op.destFolderPath);
        if (!mkdir.success) {
          failed.push({ operation: op, error: mkdir.error || 'امکان ایجاد پوشه مقصد نبود' });
          this.addLog({
            id: uid(),
            timestamp: Date.now(),
            type: 'move',
            sourcePath: op.sourcePath,
            destPath: op.destFilePath,
            success: false,
            error: mkdir.error,
            proposalId: proposal.id,
          });
          continue;
        }
      }

      // Treat the video and its sidecar subtitles as one transaction.
      // Preflight every subtitle before moving anything: a missing source or an
      // occupied destination must never leave the video separated from its subs.
      const item = this.items.find((i) => i.id === op.itemId);
      const sourceVideoName = fs.baseName(op.sourcePath);
      const sourceVideoBase = sourceVideoName.slice(0, sourceVideoName.lastIndexOf('.'));
      const destinationVideoName = fs.baseName(op.destFilePath);
      const destinationVideoBase = destinationVideoName.slice(0, destinationVideoName.lastIndexOf('.'));
      const subtitleMoves = op.relatedSubtitles.map((sub) => {
        const sourceSubtitleName = fs.baseName(sub.filePath);
        const sourceSubtitleBase = sourceSubtitleName.slice(0, sourceSubtitleName.lastIndexOf('.'));
        const suffix = sourceSubtitleBase.toLowerCase().startsWith(sourceVideoBase.toLowerCase())
          ? sourceSubtitleBase.slice(sourceVideoBase.length)
          : '';
        const subDestName = `${destinationVideoBase}${suffix}.${sub.extension}`;
        return { sub, subDestName, subDestPath: fs.joinPath(op.destFolderPath, subDestName) };
      });

      let subtitlePreflightError: string | undefined;
      for (const move of subtitleMoves) {
        if (!(await fs.exists(move.sub.filePath))) {
          subtitlePreflightError = `زیرنویس مبدأ یافت نشد: ${fs.baseName(move.sub.filePath)}`;
          break;
        }
        if (await fs.exists(move.subDestPath)) {
          subtitlePreflightError = `فایل زیرنویس مقصد از قبل وجود دارد: ${move.subDestName}`;
          break;
        }
      }
      if (subtitlePreflightError) {
        failed.push({ operation: op, error: subtitlePreflightError });
        this.addLog({ id: uid(), timestamp: Date.now(), type: 'move', sourcePath: op.sourcePath, destPath: op.destFilePath, success: false, error: subtitlePreflightError, proposalId: proposal.id });
        continue;
      }

      const movedSubtitles: Array<{ sourcePath: string; destPath: string; subDestName: string }> = [];
      let subtitleMoveError: string | undefined;
      for (const move of subtitleMoves) {
        const subResult = await fs.moveFile(move.sub.filePath, move.subDestPath);
        if (!subResult.success) {
          subtitleMoveError = subResult.error || `انتقال زیرنویس ناموفق بود: ${move.subDestName}`;
          break;
        }
        movedSubtitles.push({ sourcePath: move.sub.filePath, destPath: move.subDestPath, subDestName: move.subDestName });
      }

      if (subtitleMoveError) {
        for (const moved of movedSubtitles.reverse()) {
          await fs.moveFile(moved.destPath, moved.sourcePath);
        }
        failed.push({ operation: op, error: subtitleMoveError });
        this.addLog({ id: uid(), timestamp: Date.now(), type: 'move', sourcePath: op.sourcePath, destPath: op.destFilePath, success: false, error: subtitleMoveError, proposalId: proposal.id });
        continue;
      }

      // Move the video only after all subtitles have moved successfully.
      const result = await fs.moveFile(op.sourcePath, op.destFilePath);
      if (!result.success) {
        for (const moved of movedSubtitles.reverse()) {
          await fs.moveFile(moved.destPath, moved.sourcePath);
        }
        failed.push({ operation: op, error: result.error || 'انتقال ناموفق بود' });
        this.addLog({ id: uid(), timestamp: Date.now(), type: 'move', sourcePath: op.sourcePath, destPath: op.destFilePath, success: false, error: result.error, proposalId: proposal.id });
        continue;
      }

      succeeded.push(op);
      this.addLog({ id: uid(), timestamp: Date.now(), type: 'move', sourcePath: op.sourcePath, destPath: op.destFilePath, success: true, proposalId: proposal.id });
      for (const moved of movedSubtitles) {
        this.addLog({ id: uid(), timestamp: Date.now(), type: 'move', sourcePath: moved.sourcePath, destPath: moved.destPath, success: true, proposalId: proposal.id });
        const tracked = item?.subtitles.find((entry) => entry.filePath === moved.sourcePath);
        if (tracked) { tracked.filePath = moved.destPath; tracked.fileName = moved.subDestName; }
      }

      // Update the in-memory item to reflect the new path only after the whole
      // video/subtitle group has completed successfully.
      if (item) {
        item.filePath = op.destFilePath;
        item.fileName = destinationVideoName;
        item.parentFolder = op.destFolderPath;
      }
    }

    await this.persistItems();
    await this.persistLog();

    return { proposalId: proposal.id, executedAt: Date.now(), succeeded, failed };
  }

  // --- Operation log & undo ---

  getOperationLog(): OperationLogEntry[] {
    return [...this.log].sort((a, b) => b.timestamp - a.timestamp);
  }

  private addLog(entry: OperationLogEntry): void {
    this.log.unshift(entry);
    if (this.log.length > 500) this.log = this.log.slice(0, 500);
  }

  /**
   * Undo a completed move operation: move the file back to its original
   * location, verifying the original location is free and won't overwrite.
   * Only succeeds for operations that completed successfully.
   */
  async undoOperation(entry: OperationLogEntry): Promise<{ success: boolean; error?: string }> {
    await this.load();
    if (!entry.success) return { success: false, error: 'این عملیات ناموفق بوده است' };
    const fs = getFilesystemService();

    // Verify the current (destination) file still exists
    if (!(await fs.exists(entry.destPath))) {
      return { success: false, error: 'فایل در محل فعلی یافت نشد — امکان بازگشت نیست' };
    }

    // Verify original location is available and won't overwrite
    if (await fs.exists(entry.sourcePath)) {
      return { success: false, error: 'محل اصلی اکنون اشغال شده است — برای جلوگیری از بازنویسی، بازگشت انجام نشد' };
    }

    // Ensure original parent folder exists
    const origParent = fs.parentPath(entry.sourcePath);
    if (!(await fs.exists(origParent))) {
      const mkdir = await fs.createDir(origParent);
      if (!mkdir.success) return { success: false, error: 'امکان بازسازی پوشه اصلی نبود' };
    }

    const result = await fs.moveFile(entry.destPath, entry.sourcePath);
    if (!result.success) return { success: false, error: result.error };

    this.addLog({
      id: uid(),
      timestamp: Date.now(),
      type: 'undo',
      sourcePath: entry.destPath,
      destPath: entry.sourcePath,
      success: true,
      proposalId: entry.proposalId,
    });

    // Update the in-memory item path
    const item = this.items.find((i) => i.filePath === entry.destPath);
    if (item) {
      item.filePath = entry.sourcePath;
      item.parentFolder = fs.parentPath(entry.sourcePath);
    }
    for (const current of this.items) {
      current.subtitles = current.subtitles.map((subtitle) => subtitle.filePath === entry.destPath
        ? { ...subtitle, filePath: entry.sourcePath, fileName: fs.baseName(entry.sourcePath) }
        : subtitle);
    }
    if (item || this.items.some((current) => current.subtitles.some((subtitle) => subtitle.filePath === entry.sourcePath))) {
      await this.persistItems();
    }

    await this.persistLog();
    return { success: true };
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function validateRenameName(value: string | undefined, extension: string, label: string): string {
  const name = value?.trim() || '';
  const hasControlCharacter = Array.from(name).some((character) => character.charCodeAt(0) < 32);
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*]/.test(name) || hasControlCharacter) {
    throw new Error(`${label} معتبر نیست`);
  }
  if (extension && !name.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    throw new Error('پسوند فایل باید حفظ شود');
  }
  if (name.length > 240) throw new Error(`${label} بیش از حد طولانی است`);
  return name;
}

// Singleton instance.
let serviceInstance: LibraryService | null = null;

export function getLibraryService(): LibraryService {
  if (!serviceInstance) {
    serviceInstance = new LibraryService();
  }
  return serviceInstance;
}
